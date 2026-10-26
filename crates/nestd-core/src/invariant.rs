//! Runtime assertions for the cores' invariants.
//!
//! A violated invariant panics when built with `debug_assertions` (every test build, and the model
//! checker's), so a test or a checker run fails on it. A release build never aborts a host over
//! one: it counts the violation and hands its name to the hook the shell installed (nestd logs it
//! as an error), so it shows up in production without taking the host down.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

static VIOLATIONS: AtomicU64 = AtomicU64::new(0);
static HOOK: OnceLock<fn(&'static str)> = OnceLock::new();

/// Install the shell's reporter (once; later calls are ignored).
pub fn set_hook(hook: fn(&'static str)) {
    let _ = HOOK.set(hook);
}

/// Invariant violations counted by this process (release builds; a debug build panics first).
pub fn violations() -> u64 {
    VIOLATIONS.load(Ordering::Relaxed)
}

/// Assert the invariant `name`; returns `ok` so a caller can also take its safe path.
#[track_caller]
pub fn check(ok: bool, name: &'static str) -> bool {
    if !ok {
        violated(name);
    }
    ok
}

/// The invariant `name` does not hold.
#[track_caller]
pub fn violated(name: &'static str) {
    VIOLATIONS.fetch_add(1, Ordering::Relaxed);
    if cfg!(debug_assertions) {
        panic!("invariant violated: {name}");
    }
    if let Some(hook) = HOOK.get() {
        hook(name);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_holding_invariant_is_silent() {
        assert!(super::check(true, "holds"));
    }

    /// Counted before the panic, so a release build (which only counts and reports) has the total.
    #[test]
    fn a_violation_fails_a_debug_build_and_is_counted() {
        let before = super::violations();
        let panic = std::panic::catch_unwind(|| super::check(false, "broken")).expect_err("a debug build panics");
        assert_eq!(panic.downcast_ref::<String>().map(String::as_str), Some("invariant violated: broken"));
        assert!(super::violations() > before);
    }
}
