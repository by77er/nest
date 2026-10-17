//! The host's credentials across nestd restarts.
//!
//! An AWS instance enrolls exactly once (its identity document can't be replayed), so a nestd that
//! restarts reconnects with what that enrollment gave it: the host id, the current host token
//! (rotated over the fleet channel, so it's always fresh while connected), the fleet URL and the
//! proxy intermediate. They're kept root-only in `<state_dir>/host-credentials.json` and updated
//! on every rotation and renewal. The fleet channel accepts a token up to 24 h past its expiry and
//! rotates it at hello, so a nestd that was down for less than a day rejoins; after that the host
//! has to be replaced.

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use nest_protocol::control::CaCertificate;
use nest_protocol::model::{HostId, Secret, TimestampMs};
use serde::{Deserialize, Serialize};

use crate::enroll::Enrolled;

/// How long past expiry a saved token is still worth resuming with (the fleet channel's grace is
/// 24 h; an hour of margin).
const RESUME_GRACE_MS: i64 = 23 * 3_600_000;

#[derive(Clone, Serialize, Deserialize)]
struct Saved {
    control_url: String,
    cell: String,
    host: HostId,
    host_token: String,
    host_token_expires_ms: TimestampMs,
    fleet_ws_url: String,
    #[serde(default)]
    proxy_ca: Option<CaCertificate>,
    #[serde(default)]
    proxy_ca_key: Option<String>,
}

fn read(path: &Path) -> Option<Saved> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn write(path: &Path, saved: &Saved) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::OpenOptions::new().create(true).write(true).truncate(true).mode(0o600).open(&tmp)?;
    f.write_all(&serde_json::to_vec(saved)?)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Credentials saved by an earlier nestd of this host, if they're for this control plane and cell
/// and the token is still good.
pub fn load(path: &Path, control_url: &str, cell: &str, now_ms: TimestampMs) -> Option<Enrolled> {
    let s = read(path)?;
    if s.control_url != control_url || s.cell != cell || s.host_token_expires_ms + RESUME_GRACE_MS <= now_ms {
        return None;
    }
    Some(Enrolled {
        host: s.host,
        host_token: Secret(s.host_token),
        host_token_expires_ms: s.host_token_expires_ms,
        fleet_ws_url: s.fleet_ws_url,
        proxy_ca: s.proxy_ca.zip(s.proxy_ca_key.map(Secret)),
    })
}

/// Record a fresh enrollment.
pub fn save(path: &Path, control_url: &str, cell: &str, e: &Enrolled) -> anyhow::Result<()> {
    write(
        path,
        &Saved {
            control_url: control_url.into(),
            cell: cell.into(),
            host: e.host.clone(),
            host_token: e.host_token.expose().into(),
            host_token_expires_ms: e.host_token_expires_ms,
            fleet_ws_url: e.fleet_ws_url.clone(),
            proxy_ca: e.proxy_ca.as_ref().map(|(c, _)| c.clone()),
            proxy_ca_key: e.proxy_ca.as_ref().map(|(_, k)| k.expose().into()),
        },
    )
}

/// The fleet channel rotated the host token.
pub fn update_token(path: &Path, token: &str, expires_ms: TimestampMs) {
    if let Some(mut s) = read(path) {
        s.host_token = token.into();
        s.host_token_expires_ms = expires_ms;
        if let Err(e) = write(path, &s) {
            tracing::warn!("saving the rotated host token failed: {e:#}");
        }
    }
}

/// A new proxy intermediate was installed.
pub fn update_proxy_ca(path: &Path, ca: &CaCertificate, key_pem: &str) {
    if let Some(mut s) = read(path) {
        s.proxy_ca = Some(ca.clone());
        s.proxy_ca_key = Some(key_pem.into());
        if let Err(e) = write(path, &s) {
            tracing::warn!("saving the proxy intermediate failed: {e:#}");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn enrolled(exp: i64) -> Enrolled {
        Enrolled {
            host: HostId("hst_saved".into()),
            host_token: Secret("tok1".into()),
            host_token_expires_ms: exp,
            fleet_ws_url: "wss://cp/v1/fleet".into(),
            proxy_ca: Some((CaCertificate { cert_pem: "CERT".into(), chain_pem: "CHAIN".into(), expires_ms: 9 }, Secret("KEY".into()))),
        }
    }

    #[test]
    fn saves_root_only_and_resumes_only_what_still_applies() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("host-credentials.json");
        save(&p, "https://cp", "use1", &enrolled(1_000_000)).unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        let e = load(&p, "https://cp", "use1", 0).unwrap();
        assert_eq!((e.host.0.as_str(), e.host_token.expose()), ("hst_saved", "tok1"));
        assert_eq!(e.proxy_ca.unwrap().1.expose(), "KEY");
        // Another control plane or cell: enroll afresh instead.
        assert!(load(&p, "https://other", "use1", 0).is_none());
        assert!(load(&p, "https://cp", "use2", 0).is_none());
        // Expired, but within the fleet channel's grace: resume; long past it: don't.
        assert!(load(&p, "https://cp", "use1", 1_000_000 + 3_600_000).is_some());
        assert!(load(&p, "https://cp", "use1", 1_000_000 + RESUME_GRACE_MS).is_none());
        // Rotations and renewals are kept.
        update_token(&p, "tok2", 5_000_000);
        update_proxy_ca(&p, &CaCertificate { cert_pem: "CERT2".into(), chain_pem: "CHAIN2".into(), expires_ms: 10 }, "KEY2");
        let e = load(&p, "https://cp", "use1", 2_000_000).unwrap();
        assert_eq!(e.host_token.expose(), "tok2");
        let (ca, key) = e.proxy_ca.unwrap();
        assert_eq!((ca.cert_pem.as_str(), key.expose()), ("CERT2", "KEY2"));
    }
}
