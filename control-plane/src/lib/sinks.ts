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

/**
 * An answer to an approval approves only when it is nothing but an approving word (an optional `.` or
 * `!` after it); anything else denies, including an answer that starts with one ("ok, no: not that
 * host", "yes but deny").
 */
export function approves(answer: string): boolean {
  return /^(approve[ds]?|allow(ed)?|yes|y|ok(ay)?)[.!]?$/i.test(answer.trim());
}

/** The arguments that decide a call, in the order the runner's rules read them (`rules::subject`). */
export const DECISIVE_KEYS = ["command", "file_path", "url", "pattern", "path", "action"] as const;
/** How much of each other argument a question shows (the whole input is the ask's `input`). */
export const ARG_SHOWN = 300;
/** How much of an argument's name a question shows. */
export const KEY_SHOWN = 100;
/** How many arguments besides the deciding one a question lists; the rest are counted. */
export const ARGS_LISTED = 20;
/** The most of a held call's input an ask keeps (canonical JSON); past it, `input` is left out. */
export const INPUT_KEPT_BYTES = 32 * 1024;
/** The longest deciding line a question shows whole (escaped); past it, the question says so instead. */
export const DECISIVE_SHOWN = 64 * 1024;

/**
 * Every code point that can hide or reorder what's shown, or show as something else: controls (Cc, DEL
 * and C1 included), format characters (Cf: the bidi embeddings, overrides and isolates, zero-width
 * ones, the BOM, tag characters), the line and paragraph separators (Zl, Zp), the default-ignorable
 * ones (variation selectors, U+034F, the Hangul fillers, U+180B…), private use (Co) and unassigned
 * (Cn) code points. Escaping too much is safe; too little isn't.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cn}]/gu;
/** The bidi controls (Trojan Source, CVE-2021-42574): text that holds one is flagged as well as escaped. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/**
 * Text as a question may show it: each `INVISIBLE` code point as `\uXXXX` (per UTF-16 unit), so what is
 * shown is what is there, in that order. Applied to JSON, it leaves valid JSON of the same value. Pure.
 */
export function visible(text: string): string {
  return text.replace(INVISIBLE, (c) => [...Array(c.length).keys()].map((i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""));
}

/**
 * What a deciding argument's look-alike letters could hide: for a `url`, the host the WHATWG parser
 * resolves it to (punycode), when the text's authority isn't exactly that; for any other argument, a flag
 * when it holds non-ASCII characters that `visible` leaves as they are (letters that may look like
 * others). Empty when there is nothing to add. Pure.
 */
function lookalike(key: string, value: string): string {
  if (key === "url") {
    let host: string | undefined;
    try {
      host = new URL(value).hostname;
    } catch {
      return /[^\x00-\x7f]/.test(visible(value)) ? "  [holds non-ASCII characters, and isn't a URL nest can parse: check for look-alikes]" : "";
    }
    // Shown unless the text's authority is exactly that host (a port aside): not for look-alike letters,
    // a user part (`docs.rs@evil.test`) or a backslash the parser reads as a slash (`evil.test\@docs.rs`).
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1]?.toLowerCase().replace(/:\d*$/, "");
    return authority === host ? "" : `  (host: ${visible(host)})`;
  }
  // What's left non-ASCII once the invisible ones are escaped: letters that may look like others.
  return /[^\x00-\x7f]/.test(visible(value)) ? "  [holds non-ASCII characters: check for look-alikes]" : "";
}

/**
 * A held call's arguments as the operator's question shows them: one argument a line, the deciding one
 * (`DECISIVE_KEYS`, as the rules read it) first and whole (up to `DECISIVE_SHOWN`), then at most
 * `ARGS_LISTED` others, each name cut at `KEY_SHOWN` and each value at `ARG_SHOWN` characters, and a
 * count of any left. Every value is JSON (a string quoted and escaped), an unusual name is quoted, and
 * every character that can hide or reorder text is escaped (`visible`), a bidi control also flagged on
 * its line, so no argument can fake another line, a harmless-looking end, or text that displays in
 * another order than it runs. Against look-alike letters, a deciding `url` also shows its host as the
 * WHATWG URL parser reads it (punycode) when that isn't what the text shows, and any other deciding
 * argument with non-ASCII characters is flagged. Bounded: the deciding line up to 64 KiB plus 20 short
 * ones, under 80 KiB whatever the input (tested). Pure.
 */
export function describeArgs(args: unknown): string {
  const cut = (s: string, n: number) => s.length > n ? `${s.slice(0, n)}… (${s.length} characters in all)` : s;
  const flag = (raw: string) => BIDI.test(raw) ? "  [holds bidirectional-text controls, shown escaped: what runs may not read as shown]" : "";
  const shown = (v: unknown, n: number) => {
    const raw = JSON.stringify(v) ?? "null";
    return `${cut(visible(raw), n)}${flag(raw)}`;
  };
  if (!args || typeof args !== "object" || Array.isArray(args)) return `  arguments: ${shown(args ?? null, ARG_SHOWN)}`;
  const o = args as Record<string, unknown>;
  const name = (k: string) => /^[A-Za-z0-9_.-]{1,100}$/.test(k) ? k : shown(k, KEY_SHOWN);
  const decisive = DECISIVE_KEYS.find((k) => typeof o[k] === "string");
  const lines: string[] = [];
  if (decisive) {
    const raw = JSON.stringify(o[decisive]);
    const v = visible(raw);
    lines.push(v.length > DECISIVE_SHOWN
      ? `  ${decisive}: (${v.length} characters once escaped: too long to show here; deny unless you have read it in full ` +
        `elsewhere: the ask's input holds it only up to ${INPUT_KEPT_BYTES / 1024} KiB of input, and past that only the transcript does)`
      : `  ${decisive}: ${v}${flag(raw)}${lookalike(decisive, o[decisive] as string)}`);
  }
  const rest = Object.keys(o).filter((k) => k !== decisive).sort();
  for (const k of rest.slice(0, ARGS_LISTED)) lines.push(`  ${name(k)}: ${shown(o[k], ARG_SHOWN)}`);
  if (rest.length > ARGS_LISTED) lines.push(`  … ${rest.length - ARGS_LISTED} more arguments: see the ask's input`);
  return lines.length ? lines.join("\n") : "  (no arguments)";
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
