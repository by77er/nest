//! Exhaustive, bounded model checks of nestd's real cores (`nestd-core`) composed with models of
//! their peers. See `docs/verification/nestd/`.

pub mod fleet;
pub mod incarnation;
pub mod lease;
pub mod sentinel;
pub mod shadow;
pub mod shadow_slots;

use std::time::{Duration, Instant};

use stateright::{Checker, Expectation, HasDiscoveries, Model};

/// One exhaustive BFS of a model's reachable space within its bounds.
pub struct Outcome {
    pub unique_states: usize,
    pub elapsed: Duration,
    /// `always` and `eventually` properties with a counterexample.
    pub violations: Vec<&'static str>,
    /// `sometimes` properties with an example.
    pub examples: Vec<&'static str>,
}

impl Outcome {
    pub fn violated(&self, name: &str) -> bool {
        self.violations.contains(&name)
    }
}

fn threads() -> usize {
    std::env::var("CHECK_THREADS").ok().and_then(|t| t.parse().ok()).unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()).min(4))
}

/// Explore everything (a violated property doesn't stop the run, so the count is the whole space).
pub fn check<M>(model: M) -> Outcome
where
    M: Model + Send + Sync + 'static,
    M::State: Send + Sync + std::hash::Hash + Clone + std::fmt::Debug + PartialEq,
    M::Action: Send + Sync + Clone + std::fmt::Debug + PartialEq,
{
    let props = model.properties();
    let start = Instant::now();
    let mut builder = model.checker().threads(threads());
    if let Some(d) = std::env::var("CHECK_MAX_DEPTH").ok().and_then(|d| d.parse().ok()) {
        builder = builder.target_max_depth(d);
    }
    let checker = builder.spawn_bfs().join();
    let elapsed = start.elapsed();
    let mut violations = vec![];
    let mut examples = vec![];
    for p in props {
        if checker.discovery(p.name).is_some() {
            match p.expectation {
                Expectation::Sometimes => examples.push(p.name),
                _ => violations.push(p.name),
            }
        }
    }
    violations.sort();
    examples.sort();
    Outcome { unique_states: checker.unique_state_count(), elapsed, violations, examples }
}

pub type Path<M> = Vec<(<M as Model>::State, Option<<M as Model>::Action>)>;

fn find<M>(make: &dyn Fn() -> M, name: &'static str, depth: Option<usize>) -> Option<Path<M>>
where
    M: Model + Send + Sync + 'static,
    M::State: Send + Sync + std::hash::Hash + Clone + std::fmt::Debug + PartialEq,
    M::Action: Send + Sync + Clone + std::fmt::Debug + PartialEq,
{
    let mut b = make().checker().threads(threads()).finish_when(HasDiscoveries::AnyOf([name].into_iter().collect()));
    if let Some(d) = depth {
        b = b.target_max_depth(d);
    }
    b.spawn_bfs().join().discovery(name).map(|p| p.into_vec())
}

/// A shortest counterexample for `name`: a run reports some violating path, not the shortest, so
/// this narrows a depth bound below the length of the one found.
pub fn counterexample<M>(make: &dyn Fn() -> M, name: &'static str) -> Option<Path<M>>
where
    M: Model + Send + Sync + 'static,
    M::State: Send + Sync + std::hash::Hash + Clone + std::fmt::Debug + PartialEq,
    M::Action: Send + Sync + Clone + std::fmt::Debug + PartialEq,
{
    let mut best = find(make, name, None)?;
    let (mut lo, mut hi) = (1usize, best.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        match find(make, name, Some(mid + 1)) {
            Some(p) => {
                hi = p.len().min(mid);
                best = p;
            }
            None => lo = mid + 1,
        }
    }
    Some(best)
}
