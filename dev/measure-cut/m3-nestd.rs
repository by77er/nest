//! M3' option 1 as nestd ships it (the code `extract-cut.py` takes from a revision), on a real disk
//! with a VM writing it: for each cut, what `cut_checkpoint` does around `pre_copy` and `cut_shadow`
//! (write back, pre-copy while the VM runs, pause, the in-pause step, resume), alternating the two
//! shadows with the real `Shadows`; then M2 (pause, whole reflink, resume) and M1 (pause, read the
//! disk's data, resume) on the same disk. One JSON document on stdout.
//!
//!     m3-nestd <disk> <shadow dir> <firecracker api socket> <cuts> <interval s> <m2 cuts> <m1 cuts>
mod cut;

use cut::nestd_core::shadow::{Shadows, Slot};
use cut::{CutMode, cut_shadow, pre_copy, storage};
use std::io::{Read, Write};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

fn vm(api: &str, state: &str) {
    let body = format!("{{\"state\": \"{state}\"}}");
    let mut s = std::os::unix::net::UnixStream::connect(api).expect("api");
    write!(s, "PATCH /vm HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    let mut buf = [0u8; 1024];
    let n = s.read(&mut buf).unwrap();
    let head = String::from_utf8_lossy(&buf[..n]);
    assert!(head.starts_with("HTTP/1.1 204"), "PATCH /vm {state}: {head}");
}

/// `s` as a JSON string.
fn jstr(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 1e6).round() / 1e3
}

fn epoch_ms() -> u128 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis()
}

fn pct(v: &[f64]) -> String {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let at = |p: f64| s[((s.len() as f64 - 1.0) * p).round() as usize];
    format!("{{\"n\": {}, \"p50\": {}, \"p99\": {}, \"max\": {}}}", s.len(), at(0.5), at(0.99), s[s.len() - 1])
}

/// The disk's data, read as M1's scan reads it (data extents only), in 4 MiB reads.
fn read_data(path: &Path) -> u64 {
    let f = std::fs::File::open(path).unwrap();
    let fd = std::os::fd::AsRawFd::as_raw_fd(&f);
    let size = f.metadata().unwrap().len() as i64;
    let (mut off, mut n, mut buf) = (0i64, 0u64, vec![0u8; 4 << 20]);
    while off < size {
        let d = unsafe { libc::lseek(fd, off, libc::SEEK_DATA) };
        if d < 0 {
            break;
        }
        let h = unsafe { libc::lseek(fd, d, libc::SEEK_HOLE) };
        let mut at = d;
        while at < h {
            let len = ((h - at) as usize).min(buf.len());
            f.read_exact_at(&mut buf[..len], at as u64).unwrap();
            n += len as u64;
            at += len as i64;
        }
        off = h;
    }
    n
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (disk, dir, api) = (PathBuf::from(&a[1]), PathBuf::from(&a[2]), a[3].as_str());
    let (cuts, interval, m2, m1): (usize, u64, usize, usize) = (a[4].parse().unwrap(), a[5].parse().unwrap(), a[6].parse().unwrap(), a[7].parse().unwrap());
    let mut shadows = Shadows::new();
    let (mut rows, mut pauses, mut execs, mut residue, mut steady_pauses, mut steady_execs) = (vec![], vec![], vec![], vec![], vec![], vec![]);
    for k in 0..cuts {
        std::thread::sleep(Duration::from_secs(interval));
        let at = epoch_ms();
        let t0 = Instant::now();
        // cut_checkpoint: write back while the VM runs (the guard's extent count is O(1) on XFS).
        storage::sync_data(&disk).unwrap();
        let slot = shadows.target().expect("a free shadow");
        let path = dir.join(if slot == Slot::A { "shadow-a.img" } else { "shadow-b.img" });
        let make = !path.exists();
        let pre = pre_copy(CutMode::Shadow, &disk, &path, make, 4096);
        let t1 = Instant::now();
        vm(api, "Paused");
        let t2 = Instant::now();
        let c = cut_shadow(CutMode::Shadow, &disk, &path, pre.as_ref().ok().map(|p| p.base.clone()), false).expect("cut");
        let t3 = Instant::now();
        vm(api, "Resumed");
        let t4 = Instant::now();
        shadows.cut(slot);
        shadows.release(slot); // its commit, read at once here
        let (pause, exec) = (ms(t4 - t1), ms(t4 - t0));
        pauses.push(pause);
        execs.push(exec);
        residue.push(c.bytes as f64);
        if !make {
            steady_pauses.push(pause);
            steady_execs.push(exec);
        }
        let p = pre.as_ref().map_err(|e| e.to_string());
        rows.push(format!(
            "{{\"k\": {k}, \"at_ms\": {at}, \"slot\": \"{slot:?}\", \"made\": {make}, \"precopy_ms\": {}, \"precopy_ranges\": {}, \"precopy_bytes\": {}, \"precopy_error\": {}, \"pause_ms\": {pause}, \"in_pause_ms\": {}, \"walk_ms\": {}, \"records\": {}, \"ranges\": {}, \"bytes\": {}, \"whole\": {}, \"executor_ms\": {exec}}}",
            ms(t1 - t0), p.as_ref().map_or(0, |p| p.ranges), p.as_ref().map_or(0, |p| p.bytes), p.as_ref().err().map_or("null".into(), |e| jstr(e)),
            ms(t3 - t2), c.walk_ms, c.records, c.ranges, c.bytes, c.whole
        ));
        eprintln!("measure: cut {k} {}", rows.last().unwrap());
    }
    // Check the last shadow against the disk, paused: the cut's bytes are the disk's.
    let last = dir.join(if shadows.last() == Some(Slot::A) { "shadow-a.img" } else { "shadow-b.img" });
    let slot = shadows.target().unwrap();
    let path = dir.join(if slot == Slot::A { "shadow-a.img" } else { "shadow-b.img" });
    let pre = pre_copy(CutMode::Shadow, &disk, &path, !path.exists(), 4096).ok().map(|p| p.base);
    vm(api, "Paused");
    let t = Instant::now();
    let c = cut_shadow(CutMode::Shadow, &disk, &path, pre, true);
    let verify = format!("{{\"equal\": {}, \"ms\": {}, \"error\": {}}}", c.is_ok(), ms(t.elapsed()), c.err().map_or("null".into(), |e| jstr(&e.to_string())));
    vm(api, "Resumed");
    let _ = last;
    // M2: pause, write back, a whole reflink, resume (`storage::reflink`, as M2 cuts).
    let mut m2_pauses = vec![];
    for _ in 0..m2 {
        std::thread::sleep(Duration::from_secs(interval));
        storage::sync_data(&disk).unwrap();
        let cutf = dir.join("cut.img");
        let _ = std::fs::remove_file(&cutf);
        let t = Instant::now();
        vm(api, "Paused");
        storage::sync_data(&disk).unwrap();
        storage::reflink(&disk, &cutf).unwrap();
        vm(api, "Resumed");
        m2_pauses.push(ms(t.elapsed()));
        std::fs::remove_file(&cutf).unwrap();
    }
    // M1: pause, read the disk's data (the scan, without hashing or uploads), resume; cold.
    let mut m1_rows = vec![];
    for _ in 0..m1 {
        std::thread::sleep(Duration::from_secs(interval));
        storage::sync_data(&disk).unwrap();
        std::fs::write("/proc/sys/vm/drop_caches", "3").unwrap();
        let t = Instant::now();
        vm(api, "Paused");
        let n = read_data(&disk);
        vm(api, "Resumed");
        m1_rows.push(format!("{{\"bytes\": {n}, \"pause_ms\": {}}}", ms(t.elapsed())));
    }
    println!(
        "{{\"cuts\": [{}], \"pause_ms\": {}, \"executor_ms\": {}, \"residue_bytes\": {}, \"steady_pause_ms\": {}, \"steady_executor_ms\": {}, \"verify\": {verify}, \"m2_pause_ms\": {}, \"m2_pauses\": {:?}, \"m1\": [{}]}}",
        rows.join(", "), pct(&pauses), pct(&execs), pct(&residue), pct(&steady_pauses), pct(&steady_execs), pct(&m2_pauses), m2_pauses, m1_rows.join(", ")
    );
}
