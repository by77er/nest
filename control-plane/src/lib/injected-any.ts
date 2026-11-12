// `injected: "*"` in a request guard's matcher (docs/sandbox/networking/egress/policy/#any-injected-credential):
// a credential nest injected was substituted, whichever binding's. A host whose fleet hello lacks
// `guard_injected_any` reads `*` as a binding's name, which no binding has, so there the matcher matches
// nothing: in an exception the guard only refuses more (fail closed), in a scope it refuses less (fail
// open; crates/nest-proxy/tests/guard_equivalence.rs shows both). So a guard newly naming it is refused
// while any sandbox host of the cell lacks the flag, and FleetDO places a sandbox whose guards name it in
// a scope only on a host with it. Pure.
import { ErrorCodes, INJECTED_ANY } from "../protocol/model";
import { NestError } from "./util";

type Matchers = readonly { injected?: string }[] | undefined;

/** Whether any of `guards` names `injected: "*"`: in a scope (`"scope"`), or anywhere (`"any"`). */
export function namesInjectedAny(guards: readonly { scope: Matchers; allow?: Matchers }[], where: "scope" | "any"): boolean {
  const any = (ms: Matchers) => (ms ?? []).some((m) => m.injected === INJECTED_ANY);
  return guards.some((g) => any(g.scope) || (where === "any" && any(g.allow)));
}

/** Those of `guards` that name `*` and aren't in `held` (compared whole): what a write newly brings. */
export function freshInjectedAny<G extends { scope: Matchers; allow?: Matchers }>(guards: readonly G[], held: readonly unknown[]): G[] {
  const known = new Set(held.map((h) => JSON.stringify(h)));
  return guards.filter((g) => namesInjectedAny([g], "any") && !known.has(JSON.stringify(g)));
}

/** The refusal (409) of guards naming `*` while sandbox hosts of the cell (`old`) read it as a name. */
export function injectedAnyConflict(cell: string, guards: readonly string[], old: readonly string[]): NestError {
  return new NestError(ErrorCodes.CONFLICT, `guard(s) ${guards.slice(0, 3).join(", ")} name injected "${INJECTED_ANY}" (any credential nest injected), which needs every `
    + `sandbox host of cell ${cell} to read it so; ${old.length} host(s) don't yet (${old.slice(0, 3).join(", ")}): retry once they are replaced`, 409);
}
