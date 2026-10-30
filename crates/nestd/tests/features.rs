//! `nestd --features`, which the host install scripts run before configuring nestd.

/// The built binary prints `FEATURES`, one per line, and exits 0 without reading a config; the
/// scripts look for `gateway-user` (deploy/host/install.sh, bootstrap.sh).
#[test]
fn features_lists_what_the_scripts_check() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_nestd"))
        .arg("--features")
        .arg("--config")
        .arg("/nonexistent/nestd.json")
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    let stdout = String::from_utf8(out.stdout).unwrap();
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines, nestd::FEATURES);
    assert!(lines.contains(&"gateway-user"), "{stdout}");
}
