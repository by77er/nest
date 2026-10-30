//! What the sandbox gateway may reach of a VM. The gateway runs as its own unprivileged user
//! (`nest-gw` on a host) and dials each VM's hybrid-vsock socket, so nestd (root) gives that
//! socket, and the directories it must cross, to the gateway's group (`sockets.gateway_gid`):
//! the socket `0660`, a jail root search-only (`0710`). Nothing else of the VM is the gateway's.
//!
//! A jailed VMM owns its chroot and could replace a file there with a symlink to a host file at
//! any moment, so every change here goes through a descriptor opened with `O_PATH | O_NOFOLLOW`,
//! and only after checking that it is the expected kind of file with the expected owner. The
//! change is then made through `/proc/self/fd/<n>`, which names the opened inode itself
//! (`fchmod`/`fchown` refuse an `O_PATH` descriptor).

use std::fs::{File, OpenOptions, Permissions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

/// The file kind a grant expects to find at its path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Socket,
    Dir,
}

/// Set `path`'s mode to `mode` and, with `gid`, its group, provided it is a `kind` owned by
/// `owner` and not a symlink (which is never followed). Refused otherwise, nothing changed.
pub fn restrict(path: &Path, kind: Kind, owner: u32, gid: Option<u32>, mode: u32) -> io::Result<()> {
    let f = open_nofollow(path)?;
    let meta = f.metadata()?;
    let ft = meta.file_type();
    let is_kind = match kind {
        Kind::Socket => ft.is_socket(),
        Kind::Dir => ft.is_dir(),
    };
    if !is_kind {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{}: expected a {kind:?}, found {ft:?}", path.display())));
    }
    if meta.uid() != owner {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, format!("{}: owned by uid {}, expected {owner}", path.display(), meta.uid())));
    }
    let via = Path::new("/proc/self/fd").join(f.as_raw_fd().to_string());
    // Group first: a chown can clear mode bits, never add them.
    if let Some(gid) = gid {
        std::os::unix::fs::chown(&via, None, Some(gid))?;
    }
    std::fs::set_permissions(&via, Permissions::from_mode(mode))
}

/// Let the gateway's group connect to a VM's vsock socket (`0660`, group `gid`).
pub fn grant_socket(path: &Path, owner: u32, gid: u32) -> io::Result<()> {
    restrict(path, Kind::Socket, owner, Some(gid), 0o660)
}

fn open_nofollow(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).custom_flags(libc::O_PATH | libc::O_NOFOLLOW).open(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    fn me() -> (u32, u32) {
        (nix::unistd::geteuid().as_raw(), nix::unistd::getegid().as_raw())
    }

    fn mode(p: &Path) -> u32 {
        std::fs::symlink_metadata(p).unwrap().mode() & 0o7777
    }

    /// The vsock socket ends `0660` in the gateway's group: before, it had the VMM's umask mode
    /// (`0755` under systemd), which no other user can `connect` to.
    #[test]
    fn a_socket_is_granted_to_the_group() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("vsock.sock");
        let _l = UnixListener::bind(&sock).unwrap();
        std::fs::set_permissions(&sock, Permissions::from_mode(0o755)).unwrap();
        let (uid, gid) = me();
        grant_socket(&sock, uid, gid).unwrap();
        assert_eq!(mode(&sock), 0o660);
        assert_eq!(std::fs::metadata(&sock).unwrap().gid(), gid);
    }

    /// A symlink where the socket should be (a jailed VMM owns that directory) is refused, and
    /// the file it points to is left alone.
    #[test]
    fn a_symlink_is_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("host-file");
        std::fs::write(&target, b"secret").unwrap();
        std::fs::set_permissions(&target, Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join("vsock.sock");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let (uid, gid) = me();
        let e = grant_socket(&link, uid, gid).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::InvalidInput, "{e}");
        assert_eq!(mode(&target), 0o600, "the symlink's target was changed");
        // A symlink to a socket is refused too: only the socket itself is ever changed.
        let real = dir.path().join("real.sock");
        let _l = UnixListener::bind(&real).unwrap();
        std::fs::set_permissions(&real, Permissions::from_mode(0o700)).unwrap();
        let link2 = dir.path().join("vsock2.sock");
        std::os::unix::fs::symlink(&real, &link2).unwrap();
        assert!(grant_socket(&link2, uid, gid).is_err());
        assert_eq!(mode(&real), 0o700);
    }

    /// The wrong kind of file, or one with another owner, is refused unchanged.
    #[test]
    fn kind_and_owner_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("vsock.sock");
        std::fs::write(&file, b"").unwrap();
        std::fs::set_permissions(&file, Permissions::from_mode(0o600)).unwrap();
        let (uid, gid) = me();
        assert!(grant_socket(&file, uid, gid).is_err());
        assert_eq!(mode(&file), 0o600);
        let sub = dir.path().join("root");
        std::fs::create_dir(&sub).unwrap();
        let e = restrict(&sub, Kind::Dir, uid.wrapping_add(1), Some(gid), 0o710).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::PermissionDenied, "{e}");
        restrict(&sub, Kind::Dir, uid, Some(gid), 0o710).unwrap();
        assert_eq!(mode(&sub), 0o710);
        assert!(restrict(&dir.path().join("missing"), Kind::Socket, uid, None, 0o600).is_err());
    }
}
