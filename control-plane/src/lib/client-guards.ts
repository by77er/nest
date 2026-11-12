// API clients' request guards (docs/control-plane/api/clients/#request-guards): rules a client writes for
// its own sandboxes in the generic shape the operator's guards have (`RequestGuard`, evaluated by nest-proxy:
// docs/sandbox/networking/egress/policy/#request-guards), so an app expresses a service's rules (a push
// allowlist, a read-only API) as data, with no constructor in the kernel.
//
// A guard can only refuse. nest-proxy refuses a request when any guard refuses it, and a guard's `allow`
// exceptions are consulted only for that guard's own scope (`refusing` in crates/nest-proxy/src/guard.rs),
// so a client's exception never exempts a request from the operator's guards or another layer's. On the
// wire a client's guard is named `client:<name>`, and its `injected` matchers name the client's own
// bindings (`client:<binding>`), never an operator's by name; an exception's `*` holds for any binding
// nest injected, which only narrows when that exception holds. Pure.
import { z } from "zod";
import { hostPatternMatches, INJECTED_ANY, type RequestGuard, type RequestMatch } from "../protocol/model";
import { namesInjectedAny } from "./injected-any";
import { EgressHost } from "./client-egress";
import { CLIENT_BINDING_PREFIX, InjectionName } from "./client-secrets";

/** A client guard's name on the wire (and in the 403 and the audit): apart from the operator's and the constructed ones. */
export const CLIENT_GUARD_PREFIX = "client:";

/** A guard's name: unique in its list, at most 48 characters so `client:<name>` fits the proxy's 64-character audit field. */
export const GuardName = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/, "a guard name is 1-48 lowercase letters, digits, '_' and '-', starting with a letter");

/** Printable ASCII without spaces: what a method, a query name or value, or a path literal is compared as. */
const PRINTABLE = /^[\x21-\x7e]*$/;
const Method = z.string().regex(/^[A-Za-z]{1,16}$/, "a method is 1-16 letters");
const Methods = z.array(Method).min(1).max(8);

/** At most this many segments in a path pattern. */
export const MAX_PATH_SEGMENTS = 16;
/** At most this many segments after a pattern's `**`. */
export const MAX_SEGMENTS_AFTER_ANY = 4;

/**
 * A path pattern, bounded so its cost in nest-proxy stays linear in the request's path: nest-proxy tries
 * every split of the path at a `**` (`glob` in guard.rs), so two would cost the square of a path's length.
 * - `/`-separated segments, starting with `/`: a literal, `*` (one segment) or `**` (any number).
 * - At most 16 segments, at most one `**`, and at most 4 segments after it. No empty segment (`//`)
 *   except the root (`/`), and no whitespace, `?` or `#`.
 */
export const PathPattern = z.string().max(256).superRefine((p, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: "custom", message: `path ${JSON.stringify(p)}: ${message}` });
  if (!p.startsWith("/")) return bad("a pattern starts with /");
  if (!PRINTABLE.test(p) || /[?#\\]/.test(p)) return bad("printable ASCII without spaces, ?, # or \\");
  if (p === "/") return;
  const segs = p.slice(1).split("/");
  if (segs.some((s) => s === "")) return bad("no empty segment");
  if (segs.length > MAX_PATH_SEGMENTS) return bad(`at most ${MAX_PATH_SEGMENTS} segments`);
  const any = segs.flatMap((s, i) => (s === "**" ? [i] : []));
  if (any.length > 1) return bad("at most one **");
  if (any.length === 1 && segs.length - 1 - any[0]! > MAX_SEGMENTS_AFTER_ANY) return bad(`at most ${MAX_SEGMENTS_AFTER_ANY} segments after **`);
});

const QueryText = (max: number) => z.string().max(max).regex(PRINTABLE, "printable ASCII without spaces");

/** One matcher, the operator's `RequestMatch` with bounds: every field given must match (none: anything). */
export const ClientRequestMatch = z.strictObject({
  methods: Methods.optional(),
  methods_except: Methods.optional(),
  path: PathPattern.optional(),
  query: z.array(z.strictObject({ name: QueryText(64).min(1), values: z.array(QueryText(128)).max(16).optional() })).min(1).max(4).optional(),
  body_json: z.strictObject({
    pointer: z.string().max(128).regex(/^(?:\/[^/]*)*$/, "an RFC 6901 pointer: empty, or /-separated tokens"),
    values: z.array(z.string().max(128)).min(1).max(16),
  }).optional(),
  /**
   * One of the client's own bindings (its name, as in its `inject`): on the wire `client:<name>`. Or `*`
   * (`INJECTED_ANY`), in an exception only: any credential nest injected, an operator binding's included.
   * It only narrows when the exception holds; in a scope a previous release would fail open (`ClientGuard`).
   */
  injected: z.string().refine((v) => v === INJECTED_ANY || InjectionName.safeParse(v).success,
    `a binding name (1-32 lowercase letters, digits and '_', starting with a letter), or "${INJECTED_ANY}" for any`).optional(),
});
export type ClientRequestMatch = z.output<typeof ClientRequestMatch>;

/**
 * A client's request guard: on its hosts, a request a `scope` matcher covers is refused unless an `allow`
 * matcher covers it too. Hosts are named as for egress rules (`EgressHost`), and needn't be in any grant:
 * a guard only takes away.
 */
export const ClientGuard = z.strictObject({
  name: GuardName,
  hosts: z.array(EgressHost).min(1).max(8),
  scope: z.array(ClientRequestMatch).min(1).max(8),
  allow: z.array(ClientRequestMatch).max(64).optional(),
  /** Shown in the 403. */
  reason: z.string().max(300).regex(/^[^\x00-\x1f\x7f]*$/, "no control characters").optional(),
  /** Path literals and query names and values compare without ASCII case. */
  ignore_case: z.boolean().optional(),
}).superRefine((g, ctx) => {
  if (new Set(g.hosts).size !== g.hosts.length) ctx.addIssue({ code: "custom", message: `guard ${g.name}: a host is listed twice` });
  // A previous release's Worker (after a rollback) sends a client's `*` as the binding `client:*`, and a
  // previous release's nest-proxy reads `*` as a name: either way it matches nothing. In an exception that
  // refuses more; in a scope the guard would stop refusing, so a client names `*` in exceptions only.
  if (namesInjectedAny([g], "scope")) {
    ctx.addIssue({ code: "custom", message: `guard ${g.name}: injected "${INJECTED_ANY}" (any credential nest injected) is for exceptions (allow), not scope` });
  }
});
export type ClientGuard = z.output<typeof ClientGuard>;

/** One list's (a template's, a spawn's, a sandbox's own layer) bound on its guards' JSON. */
export const MAX_LIST_BYTES = 16 * 1024;
/** One list's bound on its guards. */
export const MAX_LIST_GUARDS = 16;

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** A list of guards: at most 16, each name once, at most 16 KiB of JSON. */
export const ClientGuards = z.array(ClientGuard).max(MAX_LIST_GUARDS).superRefine((l, ctx) => {
  if (new Set(l.map((g) => g.name)).size !== l.length) ctx.addIssue({ code: "custom", message: "a guard name is listed twice" });
  if (bytes(l) > MAX_LIST_BYTES) ctx.addIssue({ code: "custom", message: `guards are at most ${MAX_LIST_BYTES} bytes of JSON` });
});

/**
 * What one sandbox applies of every client guard (its own layer's and its attached agents'), at most:
 * the policy goes to nest-proxy in one packet, and its guards are evaluated on every request to their
 * hosts, on workers the proxy shares with every sandbox on the host.
 */
export const SANDBOX_MAX_GUARDS = 32;
export const SANDBOX_MAX_SCOPE_MATCHERS = 64;
export const SANDBOX_MAX_GUARD_BYTES = 64 * 1024;
/**
 * The matcher work a sandbox's client guards may ask of the proxy per request ({@link matcherWork}).
 * nest-proxy bounds the request (`MAX_GUARDED_*` in crates/nest-proxy/src/guard.rs), and this bounds
 * the matchers, so what a sandbox's guards cost the proxy per request is bounded too
 * (crates/nest-proxy/tests/guard_cost.rs measures the worst shapes at this bound).
 */
export const SANDBOX_MAX_GUARD_WORK = 512;

/** Why a sandbox's own layer alone is more than it applies (its create's, before any agent attaches); null when within. */
export const layerOverLimit = (guards: readonly ClientGuard[]): string | null => sandboxGuardsOverLimit(distinctGuards(guards.map(wireGuard)));

/**
 * One matcher's work: 1, plus for each query parameter it names 1 and 1 per value (each compared with
 * every pair of the request's query), doubled in a scope (compared as sent and decoded), plus for a
 * body field 1 and 1 per value.
 */
export function matcherWork(m: RequestMatch, scope: boolean): number {
  const query = (m.query ?? []).reduce((n, q) => n + 1 + (q.values?.length ?? 0), 0);
  return 1 + (scope ? 2 : 1) * query + (m.body_json ? 1 + m.body_json.values.length : 0);
}

/** A guard's matcher work: its scope's and its exceptions'. */
export function guardWork(g: Pick<RequestGuard, "scope" | "allow">): number {
  return g.scope.reduce((n, m) => n + matcherWork(m, true), 0) + (g.allow ?? []).reduce((n, m) => n + matcherWork(m, false), 0);
}

/** Why `guards` (wire form) are more than one sandbox applies; null when within. */
export function sandboxGuardsOverLimit(guards: readonly RequestGuard[]): string | null {
  if (guards.length > SANDBOX_MAX_GUARDS) return `a sandbox applies at most ${SANDBOX_MAX_GUARDS} client guards (this would be ${guards.length})`;
  const scope = guards.reduce((n, g) => n + g.scope.length, 0);
  if (scope > SANDBOX_MAX_SCOPE_MATCHERS) return `a sandbox applies at most ${SANDBOX_MAX_SCOPE_MATCHERS} client guard scope matchers (this would be ${scope})`;
  const work = guards.reduce((n, g) => n + guardWork(g), 0);
  if (work > SANDBOX_MAX_GUARD_WORK) {
    return `a sandbox's client guards ask at most ${SANDBOX_MAX_GUARD_WORK} matcher work (a matcher 1, plus 1 per query parameter, body field and value, a scope's query twice; this would be ${work})`;
  }
  if (bytes(guards) > SANDBOX_MAX_GUARD_BYTES) return `a sandbox applies at most ${SANDBOX_MAX_GUARD_BYTES} bytes of client guards`;
  return null;
}

/**
 * A guard as a spec keeps it: whose it is (the client of the namespace that wrote it; null: the operator's).
 * A sandbox applies an attached agent's guards only when they are its own client's or the operator's, so
 * a guard's `injected` never names another client's binding.
 */
export interface HeldGuard extends ClientGuard {
  client: string | null;
}

export const holdGuards = (client: string | null, list: readonly ClientGuard[]): HeldGuard[] => list.map((g) => ({ ...copyGuard(g), client }));

/** A held guard back in the shape a client writes. */
export function unheld(g: HeldGuard): ClientGuard {
  const { client: _c, ...rest } = g;
  return copyGuard(rest);
}

const copyMatch = (m: ClientRequestMatch): ClientRequestMatch => structuredClone(m);
const copyGuard = (g: ClientGuard): ClientGuard => ({
  name: g.name, hosts: [...g.hosts], scope: g.scope.map(copyMatch),
  ...(g.allow ? { allow: g.allow.map(copyMatch) } : {}), ...(g.reason !== undefined ? { reason: g.reason } : {}),
  ...(g.ignore_case !== undefined ? { ignore_case: g.ignore_case } : {}),
});

/**
 * A matcher on the wire: `injected` names the client's own binding (`client:<name>`), whatever it was
 * written as; `*` stays `*` (any binding's: it names none).
 */
function wireMatch(m: ClientRequestMatch): RequestMatch {
  const { injected, ...rest } = copyMatch(m);
  if (injected === undefined) return rest;
  return { ...rest, injected: injected === INJECTED_ANY ? INJECTED_ANY : `${CLIENT_BINDING_PREFIX}${injected}` };
}

/** A client's guard as nest-proxy gets it: an ordinary `RequestGuard` named `client:<name>` (no host change). */
export function wireGuard(g: ClientGuard): RequestGuard {
  return {
    name: `${CLIENT_GUARD_PREFIX}${g.name}`,
    hosts: [...g.hosts],
    scope: g.scope.map(wireMatch),
    ...(g.allow?.length ? { allow: g.allow.map(wireMatch) } : {}),
    ...(g.reason ? { reason: g.reason } : {}),
    ...(g.ignore_case ? { ignore_case: true } : {}),
  };
}

/**
 * The guards with no host the operator routes around inspection (`routed`: its passthrough entries and
 * its TCP exceptions' hosts), and a guard left with no host dropped. nest-proxy inspects every guarded
 * host, never splices it and refuses its TCP exceptions, so a client's guard there would change how the
 * operator routes it (and make an operator binding on a spliced host injectable); the operator's choice
 * stands, as for a client's egress rules.
 */
export function outsideOperatorRouting(guards: readonly RequestGuard[], routed: readonly string[]): RequestGuard[] {
  const spliced = (h: string) => routed.some((p) => p === h || hostPatternMatches(p, h) || hostPatternMatches(h, p));
  return guards.flatMap((g) => {
    const hosts = g.hosts.filter((h) => !spliced(h));
    if (!hosts.length) return [];
    return [hosts.length === g.hosts.length ? g : { ...g, hosts }];
  });
}

/** Each guard once (the same guard from two sources is evaluated once; two guards under one name both stay). */
export function distinctGuards(guards: readonly RequestGuard[]): RequestGuard[] {
  const seen = new Set<string>();
  return guards.filter((g) => {
    const k = JSON.stringify(g);
    return !seen.has(k) && !!seen.add(k);
  });
}
