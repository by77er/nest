// Grants (docs/agents/tools/#grants): `(principal, action, resource, limits?, expires?, parent)`, held
// by the principal's AgentDO and checked online at every call by walking the chain of parents. The
// slice built is one action, `read_transcript`, on agents named by id or by a label selector. Pure but
// for `resolveChain`, whose only I/O is the two lookups it is given.
import { z } from "zod";
import { LabelKey, type Labels, LabelValue, MAX_LABELS } from "./clients";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

/** The actions a grant can name. Each is checked by its own tool; `list` shows what they cover. */
export const GRANT_ACTIONS = ["read_transcript"] as const;
export const GrantAction = z.enum(GRANT_ACTIONS);
export type GrantAction = z.output<typeof GrantAction>;

/** An agent id, as `newId("agt_")` and `keyedId("agt_", …)` make it. */
export const AGENT_ID = /^agt_[a-z0-9]+$/;

/**
 * What a grant covers: one agent by id, or every agent whose labels include all of `labels` (an empty
 * selector, `agent{}`, is every agent). Either way only within the grant's scope (`inScope`).
 */
export type Resource = { kind: "agent"; id: string } | { kind: "agent"; labels: [string, string][] };

/** A selector's value can't hold what delimits it, nor a control character. */
const SELECTOR_VALUE_BAD = /[,{}\u0000-\u001f\u007f]/;

/** `agt_<id>`, or `agent{k=v,…}` (keys as labels' keys; values without `,`, `{`, `}` or control characters). */
export function parseResource(s: string): Result<Resource> {
  if (AGENT_ID.test(s)) return ok({ kind: "agent", id: s });
  const m = /^agent\{(.*)\}$/s.exec(s);
  if (!m) return err(`a resource is an agent id (agt_…) or a label selector agent{key=value,…}, not ${JSON.stringify(s.slice(0, 80))}`);
  const body = m[1]!;
  const labels: [string, string][] = [];
  if (body.length) {
    for (const pair of body.split(",")) {
      const i = pair.indexOf("=");
      if (i <= 0) return err(`a selector's label is key=value, not ${JSON.stringify(pair.slice(0, 80))}`);
      const k = LabelKey.safeParse(pair.slice(0, i));
      if (!k.success) return err(k.error.issues[0]!.message);
      const v = LabelValue.safeParse(pair.slice(i + 1));
      if (!v.success) return err(v.error.issues[0]!.message);
      if (SELECTOR_VALUE_BAD.test(v.data)) return err("a selector's value has no ',', '{', '}' or control characters");
      if (labels.some(([x]) => x === k.data)) return err(`a selector names ${k.data} twice`);
      labels.push([k.data, v.data]);
    }
  }
  if (labels.length > MAX_LABELS) return err(`a selector names at most ${MAX_LABELS} labels`);
  labels.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return ok({ kind: "agent", labels });
}

/** The canonical text of a resource (a selector's labels sorted by key), as grants store it. */
export function formatResource(r: Resource): string {
  return "id" in r ? r.id : `agent{${r.labels.map(([k, v]) => `${k}=${v}`).join(",")}}`;
}

/**
 * How far a grant reaches. Each is a ceiling; absent, none. Strict: a limit this release doesn't know
 * must not be dropped silently (that would widen the grant), so it is refused, and a stored grant
 * holding one is unusable here (`storedGrant`).
 */
export const GrantLimits = z.strictObject({
  /** `read_transcript`: only entries at most this old (by their `timestamp`); an entry with none is withheld. */
  max_age_ms: z.number().int().min(1).optional(),
  /** `read_transcript`: at most this many entries per call. */
  max_entries: z.number().int().min(1).max(500).optional(),
});
export type GrantLimits = z.output<typeof GrantLimits>;

/** A grant as a spawn spec asks for it: the principal is the agent spawned, the parent its conferrer. */
export const GrantRequest = z.strictObject({
  action: GrantAction,
  resource: z.string().min(1).max(8192),
  limits: GrantLimits.optional(),
  /** When it lapses (ms since the epoch); absent: when its chain does. */
  expires_ms: z.number().int().min(0).optional(),
});
export type GrantRequest = z.output<typeof GrantRequest>;

/** At most this many grants per spawn spec. */
export const MAX_GRANTS = 16;

/** What a spawn spec's `grants` held before grants: tool names (refused since, so none is silently wider). */
export const LEGACY_GRANTS_ERROR = "grants is no longer a list of tool names: narrow the tools with overrides.tools";

/** A spawn spec's `grants`: at most `MAX_GRANTS` requests, each checked (`checkRequest`) and in canonical form. */
export function parseGrantRequests(raw: unknown, now: number): Result<{ req: GrantRequest; resource: Resource }[]> {
  if (raw === undefined) return ok([]);
  if (Array.isArray(raw) && raw.some((x) => typeof x === "string")) return err(LEGACY_GRANTS_ERROR);
  const p = z.array(GrantRequest).max(MAX_GRANTS).safeParse(raw);
  if (!p.success) return err(`grants: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const out: { req: GrantRequest; resource: Resource }[] = [];
  for (const [i, req] of p.data.entries()) {
    const c = checkRequest(req, now);
    if (!c.ok) return err(`grants.${i}: ${c.error}`);
    out.push(c.value);
  }
  return ok(out);
}

/** Who conferred a grant: the operator (the root), an API client (over its subtree), or an agent's own grant it attenuated. */
export type GrantParent = { kind: "operator" } | { kind: "client"; client: string } | { kind: "agent"; agent: string; grant: string };

/** A grant as its principal's AgentDO holds it (the `grants` table, one JSON row each). Fixed once conferred. */
export interface HeldGrant {
  id: string;
  action: GrantAction;
  /** Canonical (`formatResource`). */
  resource: string;
  limits?: GrantLimits;
  expires_ms?: number;
  /**
   * The subtree it is confined to: the API client whose subtree the principal is in, or null for the
   * operator's own agents. It never reaches an agent of another subtree, whatever its labels.
   */
  scope: string | null;
  parent: GrantParent;
  conferred_ms: number;
}

const GrantParentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator") }),
  z.object({ kind: z.literal("client"), client: z.string().startsWith("cli_") }),
  z.object({ kind: z.literal("agent"), agent: z.string().regex(AGENT_ID), grant: z.string().min(1) }),
]);
const StoredGrant = z.object({
  id: z.string().min(1),
  action: GrantAction,
  resource: z.string(),
  limits: GrantLimits.optional(),
  expires_ms: z.number().optional(),
  scope: z.string().nullable(),
  parent: GrantParentSchema,
  conferred_ms: z.number(),
});

/**
 * A stored row as a grant, or null when this release can't read all of it (an action or limit it
 * doesn't know, a resource it can't parse): such a grant authorizes nothing here.
 */
export function storedGrant(json: string): HeldGrant | null {
  try {
    const p = StoredGrant.safeParse(JSON.parse(json));
    if (!p.success || !parseResource(p.data.resource).ok) return null;
    return p.data as HeldGrant;
  } catch {
    return null;
  }
}

// --- Coverage ------------------------------------------------------------------------------------------

/** What a grant is checked against: the target agent's record (its client and labels are fixed at creation). */
export interface Target {
  agent: string;
  /** The API client whose subtree it is in; null for the operator's. */
  client: string | null;
  labels: Labels;
}

/**
 * The confinement check: a grant scoped to a subtree reaches only agents in that subtree. A client's
 * agent can never reach another client's agents or the operator's, nor the operator's own agents a
 * client's, whatever the labels say.
 */
export const inScope = (scope: string | null, target: Pick<Target, "client">): boolean => target.client === scope;

/** Whether the resource names the target (scope aside). */
export function covers(r: Resource, t: Pick<Target, "agent" | "labels">): boolean {
  if ("id" in r) return r.id === t.agent;
  return r.labels.every(([k, v]) => Object.hasOwn(t.labels, k) && t.labels[k] === v);
}

/**
 * Whether `child` is within `parent` without looking anything up: the same id, or a selector that asks
 * for every label the parent's does (and maybe more). `"lookup"`: a child id under a parent selector,
 * decided by the target's labels (`covers`). An id never contains a selector.
 */
export function narrows(child: Resource, parent: Resource): boolean | "lookup" {
  if ("id" in parent) return "id" in child && child.id === parent.id;
  if ("id" in child) return "lookup";
  return parent.labels.every(([k, v]) => child.labels.some(([ck, cv]) => ck === k && cv === v));
}

/** Each limit the tighter of the two; a limit only one names stays. */
export function intersectLimits(a: GrantLimits | undefined, b: GrantLimits | undefined): GrantLimits {
  const min = (x: number | undefined, y: number | undefined) => (x === undefined ? y : y === undefined ? x : Math.min(x, y));
  const max_age_ms = min(a?.max_age_ms, b?.max_age_ms);
  const max_entries = min(a?.max_entries, b?.max_entries);
  return { ...(max_age_ms !== undefined ? { max_age_ms } : {}), ...(max_entries !== undefined ? { max_entries } : {}) };
}

/** Whether `child`'s limits are each at most `parent`'s: a limit the parent names must be named, no looser. */
export function limitsWithin(child: GrantLimits | undefined, parent: GrantLimits | undefined): boolean {
  for (const k of ["max_age_ms", "max_entries"] as const) {
    const p = parent?.[k];
    if (p === undefined) continue;
    const c = child?.[k];
    if (c === undefined || c > p) return false;
  }
  return true;
}

/** Whether `child` lapses no later than `parent` (absent: never, so a child of an expiring parent must name one). */
export const expiresWithin = (child: number | undefined, parent: number | undefined): boolean =>
  parent === undefined || (child !== undefined && child <= parent);

/** The earlier of two expiries. */
const earlier = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

// --- The chain -----------------------------------------------------------------------------------------

/** A grant whose chain holds now: every link's resource, the subtree, and the limits and expiry intersected down it. */
export interface ResolvedGrant {
  grant: HeldGrant;
  resources: Resource[];
  scope: string | null;
  limits: GrantLimits;
  expires_ms?: number;
}

export interface ChainLookups {
  /**
   * An agent's grant `grant`, whether that agent has ended (from the moment its end is asked for), and
   * its subtree; null when the agent is gone (pruned, never made) or can't say.
   */
  agentGrant(agent: string, grant: string): Promise<{ grant: HeldGrant | null; ended: boolean; client: string | null } | null>;
  /** Whether the client exists and isn't deleted. */
  clientLive(client: string): Promise<boolean>;
}

/** Spawn depth is at most 3, plus the client or operator at the root. */
const MAX_CHAIN = 8;

/**
 * The grant `g`, held by an agent in subtree `holderClient`, if its whole chain is valid at `now`:
 * every link unexpired, of the same action and subtree, and its conferrer still there (an agent that
 * hasn't ended and still holds the parent grant; a client not deleted; the operator always). Revoking
 * a link, or its conferrer ending, revokes every grant derived from it.
 */
export async function resolveChain(g: HeldGrant, holderClient: string | null, now: number, io: ChainLookups): Promise<ResolvedGrant | null> {
  const resources: Resource[] = [];
  let limits: GrantLimits = {};
  let expires: number | undefined;
  let cur = g;
  for (let hop = 0; hop < MAX_CHAIN; hop++) {
    if (cur.action !== g.action) return null;
    if (cur.scope !== holderClient) return null;
    if (cur.expires_ms !== undefined && cur.expires_ms <= now) return null;
    const r = parseResource(cur.resource);
    if (!r.ok) return null;
    resources.push(r.value);
    limits = intersectLimits(limits, cur.limits);
    expires = earlier(expires, cur.expires_ms);
    const p = cur.parent;
    if (p.kind === "operator") return { grant: g, resources, scope: holderClient, limits, ...(expires !== undefined ? { expires_ms: expires } : {}) };
    if (p.kind === "client") {
      // A client confers only over its own subtree.
      if (p.client !== holderClient || !(await io.clientLive(p.client))) return null;
      return { grant: g, resources, scope: holderClient, limits, ...(expires !== undefined ? { expires_ms: expires } : {}) };
    }
    const up = await io.agentGrant(p.agent, p.grant);
    if (!up || up.ended || !up.grant || up.client !== holderClient) return null;
    cur = up.grant;
  }
  return null;
}

/** Whether a resolved grant reaches the target: the explicit subtree check, then every link's resource. */
export const reaches = (r: ResolvedGrant, t: Target): boolean => inScope(r.scope, t) && r.resources.every((x) => covers(x, t));

// --- Conferring ----------------------------------------------------------------------------------------

/** A request checked on its own: its resource parsed, its expiry still ahead. */
export function checkRequest(req: GrantRequest, now: number): Result<{ req: GrantRequest; resource: Resource }> {
  const r = parseResource(req.resource);
  if (!r.ok) return err(r.error);
  if (req.expires_ms !== undefined && req.expires_ms <= now) return err("expires_ms is in the past");
  return ok({ req: { ...req, resource: formatResource(r.value) }, resource: r.value });
}

/**
 * Whether an agent holding `parent` (resolved) may confer `req` from it: the same action, a resource
 * within every link's (`lookup` gives an id's target, for an id under a selector), limits and expiry no
 * wider than the chain's.
 */
export function attenuates(req: GrantRequest, resource: Resource, parent: ResolvedGrant, target: Target | null): boolean {
  if (req.action !== parent.grant.action) return false;
  for (const p of parent.resources) {
    const n = narrows(resource, p);
    if (n === false) return false;
    if (n === "lookup" && (!target || !reaches({ ...parent, resources: [p] }, target))) return false;
  }
  if ("id" in resource && target && !inScope(parent.scope, target)) return false;
  return limitsWithin(req.limits, parent.limits) && expiresWithin(req.expires_ms, parent.expires_ms);
}

// --- Transcript entries --------------------------------------------------------------------------------

/** A transcript entry's time: its JSON `timestamp` (ISO text or ms); undefined when it has none. */
export function entryTimeMs(line: string): number | undefined {
  try {
    const v = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const ms = Date.parse(v);
      return Number.isNaN(ms) ? undefined : ms;
    }
  } catch {
    // Not JSON: no time.
  }
  return undefined;
}

/** Whether an entry is inside a window starting at `notBefore` (an entry with no time isn't). */
export const entryWithin = (line: string, notBefore: number | undefined): boolean => {
  if (notBefore === undefined) return true;
  const t = entryTimeMs(line);
  return t !== undefined && t >= notBefore;
};
