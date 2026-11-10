//! nestd's pure state-machine cores (`docs/verification/nestd/`).
//!
//! Each core is a synchronous `step(state, input) -> effects` with no I/O: the shell in `nestd`
//! reads the clock and the wire, passes what it read in as an input, and performs the effects the
//! core returns, feeding every outcome back as another input. A core never touches the clock, the
//! filesystem, the network, processes, randomness or an async runtime; the `nestd-core-purity`
//! fence (`scripts/fences.toml`) fails CI if one does. That is what lets the model checker
//! (`verification/nestd/check/`), Kani and cargo-mutants run against the shipped code.
//!
//! What enforces that: CI builds the library for `x86_64-unknown-none`, a target with no `std`
//! (the filesystem, sockets, processes, threads, the environment, clocks, stdio, hashed maps), so
//! code that uses `std` there fails to build; it has `core` and `alloc` only. (`no_std` alone
//! wouldn't: naming the std crate explicitly still links it on the host.) Code compiled only off
//! that target would escape it, so `scripts/check-core-manifest.py` rejects any `cfg` on a
//! `target_*` key, any `extern crate` but `alloc`, path attributes and the include macro (in
//! source with comments stripped and literals emptied), any dependency or build script, and a
//! missing `no_std` line.

#![cfg_attr(not(test), no_std)]
#![forbid(unsafe_code)]

extern crate alloc;

pub mod ca;
pub mod checkpoint;
pub mod detach;
pub mod fleet;
pub mod incarnation;
pub mod invariant;
pub mod lease;
pub mod lifecycle;
pub mod results;
pub mod shadow;
pub mod tree;
