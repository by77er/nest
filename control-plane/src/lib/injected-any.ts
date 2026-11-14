// `injected: "*"` and `at` in a request guard's matcher (docs/sandbox/networking/egress/policy/#any-injected-credential):
// `*` is a credential nest injected, whichever binding's; `at` names the header such a credential must
// have been written whole into. A host whose fleet hello lacks `guard_injected_any` reads `*` as a
// binding's name (which the operator's schema refuses, so no binding has it) and ignores `at`. Where that
// fails closed and where open is proven in crates/nest-proxy/tests/guard_equivalence.rs. So a guard newly
// naming either is refused while any sandbox host of the cell lacks the flag, and FleetDO places a sandbox
// whose guards hold a fail-open position (`failsOpenOnOldProxy`) only on a host with it. Pure.
import { ErrorCodes, INJECTED_ANY } from "../protocol/model";
import { NestError } from "./util";

type Matcher = { injected?: string; at?: string };
type Matchers = readonly Matcher[] | undefined;
type Guardish = { scope: Matchers; allow?: Matchers };

/** Whether any of `guards` names `injected: "*"` in a scope. */
export function scopeNamesInjectedAny(guards: readonly Guardish[]): boolean {
  return guards.some((g) => (g.scope ?? []).some((m) => m.injected === INJECTED_ANY));
}

/** Whether a guard uses what a previous release's nest-proxy doesn't know: `injected: "*"` or `at`, anywhere. */
export function usesInjectedMatchers(g: Guardish): boolean {
  return [...(g.scope ?? []), ...(g.allow ?? [])].some((m) => m.injected === INJECTED_ANY || m.at !== undefined);
}

/**
 * Whether any of `guards` holds a position where a previous release's nest-proxy fails open (can let
 * through what this release refuses): in a scope, `*`, or `at` with a binding named (it compares the name
 * with the last binding substituted, not the header's writer); in an exception, `at` without `*` (it drops
 * the header condition). `*` in an exception, and `at` with no binding in a scope, fail closed there.
 */
export function failsOpenOnOldProxy(guards: readonly Guardish[]): boolean {
  return guards.some((g) =>
    (g.scope ?? []).some((m) => m.injected === INJECTED_ANY || (m.at !== undefined && m.injected !== undefined))
    || (g.allow ?? []).some((m) => m.at !== undefined && m.injected !== INJECTED_ANY));
}

/** Whether any of `guards` uses `at`, in a scope or an exception. */
export function usesAt(guards: readonly Guardish[]): boolean {
  return guards.some((g) => [...(g.scope ?? []), ...(g.allow ?? [])].some((m) => m.at !== undefined));
}

/**
 * Whether any of `inject` has a Basic password location: such a binding needs a nest-proxy with
 * `guard_basic_user`, at placement and at every write that adds one, whether or not a guard uses `at` now.
 * A proxy without it keeps the request's username and takes any Basic substitution as written whole, so a
 * username the sandbox chose (a credential of its own) would satisfy an `at` that arrives later by a path
 * no write gates: an agent's detach, a narrowing, a release whose guards add one.
 */
export function hasBasicBinding(inject: readonly { locations: readonly { type: string }[] }[]): boolean {
  return inject.some((b) => b.locations.some((l) => l.type === "authorization_basic_password"));
}

/** Those of `guards` that use `*` or `at` and aren't in `held` (compared whole): what a write newly brings. */
export function freshInjectedAny<G extends Guardish>(guards: readonly G[], held: readonly unknown[]): G[] {
  const known = new Set(held.map((h) => JSON.stringify(h)));
  return guards.filter((g) => usesInjectedMatchers(g) && !known.has(JSON.stringify(g)));
}

/** The refusal (409) of guards using `*` or `at` while sandbox hosts of the cell (`old`) don't know them. */
export function injectedAnyConflict(cell: string, guards: readonly string[], old: readonly string[]): NestError {
  return new NestError(ErrorCodes.HOSTS_NOT_READY, `guard(s) ${guards.slice(0, 3).join(", ")} name injected "${INJECTED_ANY}" or "at" (where a credential nest injected `
    + `must be), which needs every sandbox host of cell ${cell} to know them; ${old.length} host(s) don't yet (${old.slice(0, 3).join(", ")}): retry once they are replaced`, 409);
}
