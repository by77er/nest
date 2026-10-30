//! nestd's pure state-machine cores (`docs/verification/nestd/`).
//!
//! Each core is a synchronous `step(state, input) -> effects` with no I/O: the shell in `nestd`
//! reads the clock and the wire, passes what it read in as an input, and performs the effects the
//! core returns, feeding every outcome back as another input. A core never touches the clock, the
//! filesystem, the network, processes, randomness or an async runtime; the `nestd-core-purity`
//! fence (`scripts/fences.toml`) fails CI if one does. That is what lets the model checker
//! (`verification/nestd/check/`), Kani and cargo-mutants run against the shipped code.
//!
//! The compiler enforces most of that: outside its own unit tests the crate is `no_std`, so `std`
//! (the filesystem, sockets, processes, threads, the environment, clocks, stdio, hashed maps) is
//! not linked and naming it fails to build; it has `core` and `alloc` only. It has no dependencies
//! either (`scripts/check-core-manifest.py`, which also requires the `no_std` line below).

#![cfg_attr(not(test), no_std)]
#![forbid(unsafe_code)]

extern crate alloc;

pub mod fleet;
pub mod incarnation;
pub mod invariant;
pub mod lease;
pub mod results;
