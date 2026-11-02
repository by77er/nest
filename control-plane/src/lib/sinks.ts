// The sink gate (docs/agents/tools/#taint-and-sinks): one rule for every sink, whatever kind of call it
// is (a remote MCP tool, a brokered action, widening a sandbox's egress). Pure: AgentDO keeps the
// approvals (`CallLedger`) and asks the operator.

/** What a sink call from a tainted session needs: the operator's approval, or nothing. */
export type WhenTainted = "approve" | "allow";

/**
 * Whether a call waits for the operator: a sink, from a tainted session, under `approve`. A call key
 * that already went out once (its redelivery) is never gated again: the caller passes `sent`.
 */
export function gated(c: { sink: boolean; when_tainted: WhenTainted; tainted: boolean; sent?: boolean }): boolean {
  return c.sink && c.tainted && c.when_tainted === "approve" && !c.sent;
}

/**
 * One sink call as the gate sees it: `name` is what an approval is bound to (with the arguments'
 * digest), `tool` the model-facing tool to call again once approved, and `what` how the operator's
 * question describes it.
 */
export interface SinkCall {
  name: string;
  tool: string;
  what: string;
  args: unknown;
}

/** An approval binds to exactly these arguments: SHA-256 of their canonical JSON (keys sorted). */
export async function argsDigest(args: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(args))));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON with every object's keys sorted, so the same arguments give the same text. */
export function canonicalJson(v: unknown): string {
  const canon = (x: unknown): unknown => Array.isArray(x) ? x.map(canon)
    : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(canon(v));
}

/** An answer to an approval approves only when it says so; anything else denies. */
export function approves(answer: string): boolean {
  return /^(approve[ds]?|allow(ed)?|yes|y|ok(ay)?)\b/i.test(answer.trim());
}

/** Claude Code built-ins whose results are untrusted (web). */
const TAINTING_BUILTINS = ["WebFetch", "WebSearch"];

/**
 * An agent session's taint, as far as the platform tracks it today: per-call taint isn't built, so
 * an agent that can see untrusted content is assumed to have (it has hands, or a web built-in), and
 * `read_tainted` is AgentDO's sticky bit, set when another agent's text reaches the session and
 * that agent is (or may be) tainted (an inbox post, a spawn's task, another agent's
 * transcript) or an untrusted MCP server's text does. What it guarantees: no text from an agent that
 * may be tainted, and nothing from a sandbox or the web, reaches a session that then calls a sink
 * ungated. The operator's text (`user`) never taints. It over-taints freely (any hands agent, for life).
 */
export function sessionTaint(a: { hands: boolean; builtin_tools: readonly string[]; read_tainted: boolean }): boolean {
  return a.hands || a.read_tainted || a.builtin_tools.some((t) => TAINTING_BUILTINS.includes(t));
}
