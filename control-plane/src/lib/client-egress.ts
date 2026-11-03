// Egress rules an API client sets for its own sandboxes (docs/control-plane/api/clients/#egress): allow
// rules on top of the operator's policy, within its grant's `egress_hosts`. They compile into the policy
// nest-proxy already gets, as allow rules of the sandbox's layer: allow rules only add, and every guard
// and the hard deny of non-public addresses apply whatever allowed a host, so a client's rule never
// allows what the operator's policy refuses. Pure.
import { z } from "zod";
import type { AllowRule } from "../protocol/model";
import { InjectHost, injectHostAllowed } from "./client-secrets";

/**
 * A host a client may open (a grant's `egress_hosts`) or a rule names: the same names as injection's
 * (`InjectHost`: an exact DNS name of two or more labels, or `*.` and one, never a numeric host).
 */
export const EgressHost = InjectHost;

/** The ports a rule naming none covers (the operator's rules' default too). */
export const WEB_PORTS: readonly number[] = [80, 443];

/** One allow rule, in the operator layer's shape (`{host, ports?}`). */
export const EgressRule = z.strictObject({
  host: EgressHost,
  ports: z.array(z.number().int().min(1).max(65_535)).min(1).max(16).optional(),
});
export type EgressRule = z.output<typeof EgressRule>;

/** A client's egress layer: allow rules only (at most 64, each host once). */
export const ClientEgress = z.strictObject({
  allow: z.array(EgressRule).max(64).refine((r) => new Set(r.map((x) => x.host)).size === r.length, "a host is listed twice"),
});
export type ClientEgress = z.output<typeof ClientEgress>;

/** Whether a rule's host is inside a grant's `egress_hosts`: the same cover as injection's (`injectHostAllowed`). */
export const egressHostAllowed = injectHostAllowed;

/** The rules outside a grant's `egress_hosts`. Empty: within it. */
export function egressOutsideGrant(rules: readonly EgressRule[], egressHosts: readonly string[]): string[] {
  return rules.filter((r) => !egressHostAllowed(egressHosts, r.host)).map((r) => `egress host ${r.host}`);
}

/** The rules within the grant (what a sandbox applies when its client's grant narrowed). */
export const egressWithin = (rules: readonly EgressRule[], egressHosts: readonly string[]): EgressRule[] =>
  rules.filter((r) => egressHostAllowed(egressHosts, r.host));

/**
 * Attenuation: a spawn's `overrides.egress` replaces the template's only by narrowing it. Each rule
 * names one of the template's hosts, with a subset of its ports. Absent: the template's.
 */
export function narrowEgress(base: readonly EgressRule[], asked: readonly EgressRule[] | undefined):
  { ok: true; value: EgressRule[] } | { ok: false; error: string } {
  if (!asked) return { ok: true, value: base.map((r) => ({ ...r })) };
  for (const a of asked) {
    const b = base.find((x) => x.host === a.host);
    if (!b) return { ok: false, error: `can't widen egress with ${a.host}` };
    const have = b.ports ?? WEB_PORTS;
    const wider = (a.ports ?? have).filter((p) => !have.includes(p));
    if (wider.length) return { ok: false, error: `egress ${a.host}: can't add ports ${wider.join(", ")}` };
  }
  return { ok: true, value: asked.map((r) => ({ ...r })) };
}

/** The rules as nest-proxy reads them: allow rules of the sandbox's layer (wire name `workstream`). */
export const compileEgress = (rules: readonly EgressRule[]): AllowRule[] =>
  rules.map((r) => ({ host: r.host, ports: [...(r.ports ?? WEB_PORTS)], layer: "workstream" as const }));
