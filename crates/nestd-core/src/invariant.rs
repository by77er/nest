//! Runtime assertions for the cores' invariants.
//!
//! A violated invariant panics when built with `debug_assertions` (every test build, and the model
//! checker's), so a test or a checker run fails on it. A release build never aborts a host over
//! one, and a core never calls into the shell to report it:
//! - **Inside a step** ([`holds`]): the core reports the violation as one of the step's effects
//!   (the fleet link's `Log::InvariantViolated`), and the shell logs it like any other.
//! - **Outside a step** ([`check`], e.g. `ResultCache::insert`): there is no effect to return, so
//!   it is counted in a process-wide counter. nestd polls [`violations`] and logs when the count
//!   rises (`crates/nestd/src/main.rs`, `watch_invariants`).

use core::sync::atomic::{AtomicU64, Ordering};

static VIOLATIONS: AtomicU64 = AtomicU64::new(0);

/// Violations of invariants checked outside a step ([`check`]) counted by this process (release
/// builds; a debug build panics first). Those checked inside a step come back as effects instead.
pub fn violations() -> u64 {
    VIOLATIONS.load(Ordering::Relaxed)
}

/// Assert the invariant `name` inside a step. Panics in a debug build; in release returns `ok`, so
/// the caller reports a violation as an effect (and can take its safe path). Not counted.
#[track_caller]
pub fn holds(ok: bool, name: &'static str) -> bool {
    if !ok && cfg!(debug_assertions) {
        panic!("invariant violated: {name}");
    }
    ok
}

/// Assert the invariant `name` outside a step, where no effect can carry it: a violation is counted
/// (see [`violations`]) and then treated as [`holds`] treats it.
#[track_caller]
pub fn check(ok: bool, name: &'static str) -> bool {
    if !ok {
        VIOLATIONS.fetch_add(1, Ordering::Relaxed);
    }
    holds(ok, name)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_holding_invariant_is_silent() {
        assert!(super::check(true, "holds"));
        assert!(super::holds(true, "holds"));
    }

    /// The panic a debug build raises on a violation; `None` in release, where the check returns
    /// false instead.
    fn outcome(f: impl FnOnce() -> bool + std::panic::UnwindSafe) -> Option<String> {
        match std::panic::catch_unwind(f) {
            Ok(held) => {
                if cfg!(debug_assertions) {
                    panic!("a debug build panics");
                }
                assert!(!held, "a violation returns false");
                None
            }
            Err(panic) => Some(panic.downcast_ref::<String>().cloned().unwrap_or_default()),
        }
    }

    /// Counted before the panic, so a release build (which only counts) has the total.
    #[test]
    fn a_violation_outside_a_step_fails_a_debug_build_and_is_counted() {
        let before = super::violations();
        let panic = outcome(|| super::check(false, "broken"));
        assert_eq!(panic.is_some(), cfg!(debug_assertions));
        assert!(panic.is_none_or(|p| p == "invariant violated: broken"));
        assert!(super::violations() > before);
    }

    /// One inside a step panics in a debug build too; in release its step's effect reports it.
    #[test]
    fn a_violation_inside_a_step_fails_a_debug_build() {
        let panic = outcome(|| super::holds(false, "in_step"));
        assert_eq!(panic.is_some(), cfg!(debug_assertions));
        assert!(panic.is_none_or(|p| p == "invariant violated: in_step"));
    }
}
