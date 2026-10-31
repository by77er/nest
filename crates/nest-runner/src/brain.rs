//! One brain's decisions, with no I/O: which turn is running, when it ends, interrupts, the idle
//! exit, why the process ended, and replaying input that arrived while it was exiting. The actor
//! in [`crate::agent`] feeds it inputs and applies the effects it returns (stdin, signals,
//! events, nestd reports).
//!
//! Turns (`docs/agents/runner/`): AgentDO is the only source of turns. A turn is exactly one user
//! message on stdin, the `run_turn` text; inbox messages never go to stdin, the inbox mirror
//! hands them to the model through hooks ([`crate::mirror`]). So a `result` ends the turn that
//! is running, with two guards for Claude Code behaviour that is **unverified**:
//! - a `result` while the turn's last `Stop` hook answered `block` is taken for an intermediate
//!   one (the continuation is still owed), unless it is an error or the turn is being
//!   interrupted;
//! - a `result` with no turn running belongs to no turn and is ignored.

use std::time::Duration;

use nest_protocol::control::TurnInput;
use nest_protocol::host::claude::ResultMessage;
use nest_protocol::host::runner::{ExitReason, StopMode};
use nest_protocol::model::{AgentEventBody, AgentState, ErrorBody, TurnId};
use tokio::time::Instant;

use crate::stream;

#[derive(Clone, Debug)]
pub enum Input {
    RunTurn { turn: TurnId, input: TurnInput },
    /// An inbox message for the running turn. The mirror delivers it; only an interrupt acts here.
    Inbox { interrupt: bool },
    /// AgentDO's `interrupt`, for `turn` (`None`: whatever runs).
    Interrupt { turn: Option<TurnId> },
    /// The `Stop` hook answered: `blocked` means the turn goes on with inbox messages.
    StopHook { blocked: bool },
    Result(ResultMessage),
    /// `system/init` said whether the stream-json interrupt is supported.
    InterruptSupported(bool),
    Stop(StopMode),
    Kill(ExitReason),
    /// A deadline from [`Brain::next_deadline`] may have passed.
    Tick,
    /// The process exited; `killed` is a kill reason recorded outside the actor
    /// ([`crate::runtime::Agent::kill_now`]), whose own `Kill` input may not have arrived yet.
    Exited { killed: Option<ExitReason> },
    /// The answer to [`Effect::Respawn`].
    Respawned { ok: bool },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// The turn's text as a user message on stdin.
    WriteTurn { turn: TurnId, text: String },
    /// The stream-json interrupt control request on stdin.
    WriteInterrupt,
    /// Finish queued writes, then EOF (Claude Code finishes and exits).
    CloseStdin,
    AbortStdin,
    /// SIGINT to Claude Code alone.
    Sigint,
    /// SIGKILL to Claude Code's process group.
    KillGroup,
    CancelHands,
    Emit { body: AgentEventBody, turn: Option<TurnId> },
    /// Start Claude Code again on the same session; answer with [`Input::Respawned`].
    Respawn,
    /// Report the exit and stop.
    Exit(ExitReason),
}

#[derive(Clone, Copy, Debug)]
pub struct Timers {
    /// Close stdin this long after the last turn ended (or the start) with no turn since.
    pub idle_grace: Duration,
    /// After an interrupt request: SIGINT this long after it, SIGKILL as long again after that.
    pub interrupt_grace: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum InterruptStage {
    /// The control request went out; SIGINT at the deadline.
    Requested(Instant),
    /// SIGINT went out; SIGKILL at the deadline.
    Signalled(Instant),
}

#[derive(Debug)]
struct Turn {
    id: TurnId,
    /// The last `Stop` hook of this turn answered `block`: a continuation is owed.
    stop_blocked: bool,
    interrupt: Option<InterruptStage>,
}

#[derive(Debug)]
enum Ending {
    Running,
    /// stdin closed for idleness; a turn arriving meanwhile waits for a `--resume`d process.
    IdleClose { stash: Vec<(TurnId, TurnInput)> },
    /// The process exited idle with a turn stashed; waiting for [`Input::Respawned`].
    Respawning { stash: Vec<(TurnId, TurnInput)> },
    /// Stopped or killed: the first such reason is the exit's, whatever idleness said.
    Requested(ExitReason),
}

#[derive(Debug)]
pub struct Brain {
    timers: Timers,
    turn: Option<Turn>,
    idle_at: Option<Instant>,
    ending: Ending,
    interrupt_supported: bool,
}

impl Brain {
    /// A brain just spawned: the idle clock runs from the start, so a brain that never gets a
    /// turn still exits and its host can retire.
    pub fn new(timers: Timers, now: Instant) -> Self {
        Brain { timers, turn: None, idle_at: Some(now + timers.idle_grace), ending: Ending::Running, interrupt_supported: false }
    }

    /// The turn running now.
    pub fn turn(&self) -> Option<&TurnId> {
        self.turn.as_ref().map(|t| &t.id)
    }

    /// Whether the inbox mirror may hand messages to the model now: a turn runs and is not being
    /// interrupted or ended.
    pub fn takes_inbox(&self) -> bool {
        matches!(self.ending, Ending::Running) && self.turn.as_ref().is_some_and(|t| t.interrupt.is_none())
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        let interrupt = self.turn.as_ref().and_then(|t| t.interrupt).map(|s| match s {
            InterruptStage::Requested(at) | InterruptStage::Signalled(at) => at,
        });
        [interrupt, self.idle_at].into_iter().flatten().min()
    }

    pub fn step(&mut self, input: Input, now: Instant) -> Vec<Effect> {
        match input {
            Input::RunTurn { turn, input } => self.run_turn(turn, input),
            Input::Inbox { interrupt: true } => self.interrupt(None, now),
            Input::Inbox { interrupt: false } => vec![],
            Input::Interrupt { turn } => self.interrupt(turn, now),
            Input::StopHook { blocked } => {
                if let Some(t) = &mut self.turn {
                    t.stop_blocked = blocked;
                }
                vec![]
            }
            Input::Result(r) => self.result(&r, now),
            Input::InterruptSupported(s) => {
                self.interrupt_supported = s;
                vec![]
            }
            Input::Stop(StopMode::Graceful) => {
                let mut fx = self.request_end(ExitReason::Stopped);
                fx.push(Effect::CloseStdin);
                fx
            }
            Input::Stop(StopMode::Kill) => self.kill(ExitReason::Stopped),
            Input::Kill(reason) => self.kill(reason),
            Input::Tick => self.tick(now),
            Input::Exited { killed } => self.exited(killed),
            Input::Respawned { ok } => self.respawned(ok, now),
        }
    }

    fn run_turn(&mut self, turn: TurnId, input: TurnInput) -> Vec<Effect> {
        match &mut self.ending {
            Ending::IdleClose { stash } | Ending::Respawning { stash } => {
                stash.push((turn, input));
                return vec![];
            }
            Ending::Requested(reason) => return vec![not_delivered(turn, *reason)],
            Ending::Running => {}
        }
        if let Some(current) = &self.turn {
            if current.id == turn {
                return vec![]; // the same turn again
            }
            // AgentDO sends a turn only once the previous one completed: never written, so it
            // can't merge into the running one.
            let error = ErrorBody {
                code: "turn_overlap".into(),
                message: format!("turn {} arrived while {} runs; not written", turn.0, current.id.0),
                retryable: false,
            };
            return vec![Effect::Emit { body: AgentEventBody::Error { error }, turn: Some(turn) }];
        }
        self.turn = Some(Turn { id: turn.clone(), stop_blocked: false, interrupt: None });
        self.idle_at = None;
        vec![
            Effect::Emit { body: AgentEventBody::TurnStarted { input_kind: input.kind }, turn: Some(turn.clone()) },
            Effect::Emit { body: AgentEventBody::StateChanged { state: AgentState::Working, detail: None }, turn: Some(turn.clone()) },
            Effect::WriteTurn { turn, text: input.text },
        ]
    }

    /// Interrupt the running turn (if `turn` names it): the control request when Claude Code
    /// supports it, else SIGINT at once.
    fn interrupt(&mut self, turn: Option<TurnId>, now: Instant) -> Vec<Effect> {
        let grace = self.timers.interrupt_grace;
        let Some(t) = &mut self.turn else { return vec![] };
        if turn.is_some_and(|id| id != t.id) || t.interrupt.is_some() {
            return vec![];
        }
        if self.interrupt_supported {
            t.interrupt = Some(InterruptStage::Requested(now + grace));
            vec![Effect::WriteInterrupt]
        } else {
            t.interrupt = Some(InterruptStage::Signalled(now + grace));
            vec![Effect::Sigint, Effect::CancelHands]
        }
    }

    fn result(&mut self, r: &ResultMessage, now: Instant) -> Vec<Effect> {
        let Some(t) = &self.turn else { return vec![] };
        if t.stop_blocked && !r.is_error && t.interrupt.is_none() {
            return vec![];
        }
        let turn = self.turn.take().map(|t| t.id);
        self.idle_at = Some(now + self.timers.idle_grace);
        let usage = stream::usage_from(&r.usage, Some(r.total_cost_usd));
        let stop_reason = r.stop_reason.clone().unwrap_or_else(|| r.subtype.clone());
        vec![
            Effect::Emit { body: AgentEventBody::TurnCompleted { stop_reason, usage: Some(usage) }, turn: turn.clone() },
            Effect::Emit { body: AgentEventBody::StateChanged { state: AgentState::Idle, detail: None }, turn },
        ]
    }

    fn tick(&mut self, now: Instant) -> Vec<Effect> {
        let grace = self.timers.interrupt_grace;
        if let Some(t) = &mut self.turn {
            match t.interrupt {
                Some(InterruptStage::Requested(at)) if at <= now => {
                    t.interrupt = Some(InterruptStage::Signalled(now + grace));
                    return vec![Effect::Sigint, Effect::CancelHands];
                }
                Some(InterruptStage::Signalled(at)) if at <= now => {
                    t.interrupt = None;
                    return self.kill(ExitReason::Crashed);
                }
                _ => {}
            }
        }
        if self.idle_at.is_some_and(|at| at <= now) {
            self.idle_at = None;
            if self.turn.is_none() && matches!(self.ending, Ending::Running) {
                self.ending = Ending::IdleClose { stash: Vec::new() };
                return vec![Effect::CloseStdin];
            }
        }
        vec![]
    }

    /// Stop or kill: the first explicit reason sticks; a turn waiting for a respawn never gets one.
    fn request_end(&mut self, reason: ExitReason) -> Vec<Effect> {
        if matches!(self.ending, Ending::Requested(_)) {
            return vec![];
        }
        match std::mem::replace(&mut self.ending, Ending::Requested(reason)) {
            Ending::IdleClose { stash } | Ending::Respawning { stash } => dropped(stash, reason),
            _ => vec![],
        }
    }

    fn kill(&mut self, reason: ExitReason) -> Vec<Effect> {
        let mut fx = self.request_end(reason);
        fx.extend([Effect::AbortStdin, Effect::CancelHands, Effect::KillGroup]);
        fx
    }

    fn exited(&mut self, killed: Option<ExitReason>) -> Vec<Effect> {
        if let Some(r) = killed {
            let mut fx = self.request_end(r);
            fx.extend(self.finish());
            return fx;
        }
        if let Ending::IdleClose { stash } = &mut self.ending
            && !stash.is_empty()
        {
            self.ending = Ending::Respawning { stash: std::mem::take(stash) };
            return vec![Effect::Respawn];
        }
        self.finish()
    }

    fn respawned(&mut self, ok: bool, now: Instant) -> Vec<Effect> {
        let Ending::Respawning { stash } = &mut self.ending else { return vec![] };
        let stash = std::mem::take(stash);
        if !ok {
            self.ending = Ending::Requested(ExitReason::Crashed);
            let mut fx = dropped(stash, ExitReason::Crashed);
            fx.extend(self.finish());
            return fx;
        }
        *self = Brain { interrupt_supported: self.interrupt_supported, ..Brain::new(self.timers, now) };
        stash.into_iter().flat_map(|(turn, input)| self.run_turn(turn, input)).collect()
    }

    /// The exit's reason: a requested one, else idleness, else a crash.
    fn finish(&mut self) -> Vec<Effect> {
        let reason = match &self.ending {
            Ending::Requested(r) => *r,
            Ending::IdleClose { .. } | Ending::Respawning { .. } => ExitReason::Idle,
            Ending::Running => ExitReason::Crashed,
        };
        self.turn = None;
        self.idle_at = None;
        vec![Effect::Exit(reason)]
    }
}

/// Stashed turns that will never run: each gets an error event (AgentDO keeps it queued).
fn dropped(stash: Vec<(TurnId, TurnInput)>, why: ExitReason) -> Vec<Effect> {
    stash.into_iter().map(|(turn, _)| not_delivered(turn, why)).collect()
}

fn not_delivered(turn: TurnId, why: ExitReason) -> Effect {
    let error = ErrorBody { code: "agent_stopping".into(), message: format!("turn not delivered: the brain is {}", why.as_str()), retryable: true };
    Effect::Emit { body: AgentEventBody::Error { error }, turn: Some(turn) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nest_protocol::model::TurnInputKind;

    const GRACE: Duration = Duration::from_secs(120);
    const INT: Duration = Duration::from_secs(10);

    fn brain() -> (Brain, Instant) {
        let now = Instant::now();
        (Brain::new(Timers { idle_grace: GRACE, interrupt_grace: INT }, now), now)
    }

    fn run(id: &str) -> Input {
        Input::RunTurn { turn: TurnId(id.into()), input: TurnInput { kind: TurnInputKind::User, text: format!("go {id}") } }
    }

    fn result(is_error: bool) -> Input {
        Input::Result(
            serde_json::from_value(serde_json::json!({"type": "result", "subtype": if is_error { "error_during_execution" } else { "success" },
                "is_error": is_error, "num_turns": 1, "duration_ms": 1, "total_cost_usd": 0.5,
                "usage": {"input_tokens": 3, "output_tokens": 1}, "stop_reason": "end_turn", "session_id": "s"}))
            .unwrap(),
        )
    }

    /// `(turn, kind)` of every event, and the other effects by name.
    fn shape(fx: &[Effect]) -> Vec<String> {
        fx.iter()
            .map(|e| match e {
                Effect::Emit { body, turn } => {
                    let kind = match body {
                        AgentEventBody::TurnStarted { .. } => "turn_started",
                        AgentEventBody::TurnCompleted { .. } => "turn_completed",
                        AgentEventBody::StateChanged { state: AgentState::Idle, .. } => "idle",
                        AgentEventBody::StateChanged { state: AgentState::Working, .. } => "working",
                        AgentEventBody::Error { error } => return format!("error {} {}", error.code, turn.as_ref().map(|t| t.0.as_str()).unwrap_or("-")),
                        _ => "other",
                    };
                    format!("{kind} {}", turn.as_ref().map(|t| t.0.as_str()).unwrap_or("-"))
                }
                Effect::WriteTurn { turn, .. } => format!("write {}", turn.0),
                Effect::Exit(r) => format!("exit {}", r.as_str()),
                other => format!("{other:?}"),
            })
            .collect()
    }

    #[test]
    fn a_turn_is_one_message_and_its_result_ends_it() {
        let (mut b, now) = brain();
        assert_eq!(shape(&b.step(run("t1"), now)), ["turn_started t1", "working t1", "write t1"]);
        assert!(b.takes_inbox());
        // An inbox message mid-turn writes nothing: the mirror's hooks deliver it.
        assert_eq!(b.step(Input::Inbox { interrupt: false }, now), []);
        assert_eq!(shape(&b.step(result(false), now)), ["turn_completed t1", "idle t1"]);
        assert_eq!((b.turn(), b.takes_inbox()), (None, false));
        match &b.step(run("t2"), now)[..] {
            [_, _, Effect::WriteTurn { text, .. }] => assert_eq!(text, "go t2"),
            fx => panic!("{fx:?}"),
        }
    }

    #[test]
    fn a_result_after_a_stop_hook_block_is_not_the_end_of_the_turn() {
        let (mut b, now) = brain();
        b.step(run("t1"), now);
        b.step(Input::StopHook { blocked: true }, now);
        // UNVERIFIED that Claude Code emits a `result` before a blocked stop's continuation; if
        // it does, that one is intermediate.
        assert_eq!(b.step(result(false), now), []);
        assert_eq!(b.turn().map(|t| t.0.as_str()), Some("t1"));
        b.step(Input::StopHook { blocked: false }, now);
        assert_eq!(shape(&b.step(result(false), now)), ["turn_completed t1", "idle t1"]);
        // A stray `result` with no turn running completes nothing, not the next turn either.
        assert_eq!(b.step(result(false), now), []);
        b.step(run("t2"), now);
        assert_eq!(shape(&b.step(result(false), now)), ["turn_completed t2", "idle t2"]);
    }

    #[test]
    fn an_error_result_ends_the_turn_even_with_a_continuation_owed() {
        let (mut b, now) = brain();
        b.step(run("t1"), now);
        b.step(Input::StopHook { blocked: true }, now);
        assert_eq!(shape(&b.step(result(true), now)), ["turn_completed t1", "idle t1"]);
    }

    #[test]
    fn an_inbox_message_with_no_turn_running_does_nothing() {
        let (mut b, now) = brain();
        assert_eq!(b.step(Input::Inbox { interrupt: false }, now), []);
        assert_eq!(b.step(Input::Inbox { interrupt: true }, now), []);
        assert_eq!(b.turn(), None);
    }

    #[test]
    fn an_interrupt_for_another_turn_is_ignored_and_one_for_this_turn_escalates() {
        let (mut b, now) = brain();
        b.step(Input::InterruptSupported(true), now);
        b.step(run("t1"), now);
        assert_eq!(b.step(Input::Interrupt { turn: Some(TurnId("t0".into())) }, now), []);
        assert_eq!(b.step(Input::Interrupt { turn: Some(TurnId("t1".into())) }, now), [Effect::WriteInterrupt]);
        assert!(!b.takes_inbox(), "a turn being interrupted takes no more inbox");
        assert_eq!(b.step(Input::Interrupt { turn: None }, now), [], "once");
        assert_eq!(b.next_deadline(), Some(now + INT));
        assert_eq!(b.step(Input::Tick, now + INT), [Effect::Sigint, Effect::CancelHands]);
        assert_eq!(shape(&b.step(Input::Tick, now + INT * 2)), ["AbortStdin", "CancelHands", "KillGroup"]);
        assert_eq!(shape(&b.step(Input::Exited { killed: None }, now)), ["exit crashed"]);
    }

    #[test]
    fn without_the_control_request_an_interrupt_is_a_sigint() {
        let (mut b, now) = brain();
        b.step(run("t1"), now);
        assert_eq!(b.step(Input::Inbox { interrupt: true }, now), [Effect::Sigint, Effect::CancelHands]);
        // The interrupted turn's result ends it, a block notwithstanding.
        b.step(Input::StopHook { blocked: true }, now);
        assert_eq!(shape(&b.step(result(false), now)), ["turn_completed t1", "idle t1"]);
    }

    #[test]
    fn the_idle_clock_runs_from_the_start_and_stops_while_a_turn_runs() {
        let (mut b, now) = brain();
        assert_eq!(b.next_deadline(), Some(now + GRACE));
        b.step(run("t1"), now);
        assert_eq!(b.next_deadline(), None);
        b.step(result(false), now);
        let later = now + Duration::from_secs(5);
        assert_eq!(b.step(Input::Tick, later), []);
        assert_eq!(b.step(Input::Tick, now + GRACE), [Effect::CloseStdin]);
        assert_eq!(shape(&b.step(Input::Exited { killed: None }, now)), ["exit idle"]);
    }

    #[test]
    fn a_turn_during_an_idle_exit_resumes_the_process_and_runs_there() {
        let (mut b, now) = brain();
        b.step(Input::Tick, now + GRACE);
        assert_eq!(b.step(run("t1"), now), [], "stashed");
        assert_eq!(b.step(Input::Exited { killed: None }, now), [Effect::Respawn]);
        assert_eq!(shape(&b.step(Input::Respawned { ok: true }, now)), ["turn_started t1", "working t1", "write t1"]);
        // A failed resume reports the stashed turn and exits.
        let (mut b, now) = brain();
        b.step(Input::Tick, now + GRACE);
        b.step(run("t1"), now);
        b.step(Input::Exited { killed: None }, now);
        assert_eq!(shape(&b.step(Input::Respawned { ok: false }, now)), ["error agent_stopping t1", "exit crashed"]);
    }

    /// R5: an explicit stop or kill during an idle exit is the exit's reason, and a stashed turn
    /// never resumes the process against it.
    #[test]
    fn a_stop_or_kill_during_an_idle_exit_wins_over_idleness() {
        for (input, reason) in [(Input::Kill(ExitReason::Fenced), "fenced"), (Input::Stop(StopMode::Graceful), "stopped")] {
            let (mut b, now) = brain();
            b.step(Input::Tick, now + GRACE);
            b.step(run("t1"), now);
            assert_eq!(shape(&b.step(input, now))[0], "error agent_stopping t1", "the stashed turn is reported");
            assert_eq!(shape(&b.step(Input::Exited { killed: None }, now)), [format!("exit {reason}")]);
        }
        // A kill recorded outside the actor (its Kill input still queued) counts too.
        let (mut b, now) = brain();
        b.step(Input::Tick, now + GRACE);
        b.step(run("t1"), now);
        assert_eq!(shape(&b.step(Input::Exited { killed: Some(ExitReason::Stopped) }, now)), ["error agent_stopping t1", "exit stopped"]);
    }

    #[test]
    fn the_first_requested_reason_sticks_and_later_turns_are_refused() {
        let (mut b, now) = brain();
        b.step(Input::Stop(StopMode::Graceful), now);
        b.step(Input::Kill(ExitReason::Fenced), now);
        assert_eq!(shape(&b.step(run("t1"), now)), ["error agent_stopping t1"]);
        assert_eq!(shape(&b.step(Input::Exited { killed: Some(ExitReason::Fenced) }, now)), ["exit stopped"]);
    }

    #[test]
    fn a_second_turn_while_one_runs_is_never_written() {
        let (mut b, now) = brain();
        b.step(run("t1"), now);
        assert_eq!(b.step(run("t1"), now), [], "a duplicate");
        assert_eq!(shape(&b.step(run("t2"), now)), ["error turn_overlap t2"]);
        assert_eq!(b.turn().map(|t| t.0.as_str()), Some("t1"));
    }
}
