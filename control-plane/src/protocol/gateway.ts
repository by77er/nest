// Brain ↔ sandbox gateway (docs/interfaces/gateway/). Mirrors crates/nest-protocol/src/gateway.rs.
// The control plane never speaks this boundary itself in this step; it signs the bindings the
// gateway verifies and hands clients the target. Fixtures: protocol/fixtures/gateway/.
import { z } from "zod";
import { Epoch, ErrorBody, SandboxId, TimestampMs } from "./model";

export const GATEWAY_PROTOCOL_VERSION = 1;
export const BINDING_VERSION = 1;
export const BINDING_PREFIX = "nbd_";
/** The signed bytes are this prefix followed by the base64url claims segment, exactly as in the token. */
export const BINDING_SIGN_DOMAIN = "nest-binding-v1:";
/** A binding lives an hour; `resolve` renews it. */
export const BINDING_LIFETIME_MS = 3_600_000;

/** The guest's protocol version and capabilities, as nestd reported them. */
export const GuestInfo = z.object({ protocol_version: z.number().int(), capabilities: z.array(z.string()).default([]) });
export type GuestInfo = z.output<typeof GuestInfo>;

/** A Cloudflare Access service token for the edge in front of a gateway (request headers, never a URL). */
export const EdgeAuth = z.object({ client_id: z.string(), client_secret: z.string() });
export type EdgeAuth = z.output<typeof EdgeAuth>;

/**
 * Everything a client needs to reach one sandbox's hands. Issued by SandboxDO's `resolve` and sent
 * to the runner only over the session channel (`hands_resolved`): the binding is a bearer token and
 * never passes through FleetDO, nestd or a command at rest.
 */
export const HandsTarget = z.object({
  url: z.string(),
  sandbox: SandboxId,
  epoch: Epoch,
  binding: z.string(),
  guest: GuestInfo,
  edge: EdgeAuth.optional(),
});
export type HandsTarget = z.output<typeof HandsTarget>;

export const BindingScope = z.enum(["hands", "pty", "ingress"]);
export type BindingScope = z.output<typeof BindingScope>;

/** The claims inside a binding token; `client` is the agent id, or a person's id for a terminal. */
export const BindingClaims = z.object({
  v: z.number().int(),
  kid: z.string(),
  sandbox: SandboxId,
  epoch: Epoch,
  client: z.string(),
  scope: BindingScope,
  exp_ms: TimestampMs,
});
export type BindingClaims = z.output<typeof BindingClaims>;

/** One verification key: `kid` = first 16 hex chars of SHA-256 over the raw P-256 point; `public_key` = that point, base64url. */
export const BindingKey = z.object({ kid: z.string(), public_key: z.string() });
export type BindingKey = z.output<typeof BindingKey>;

export const ClientMessageVariants = [
  z.object({ type: z.literal("bind"), binding: z.string(), protocol_version: z.number().int(), gateway_version: z.number().int() }),
] as const;
export const ClientMessage = z.discriminatedUnion("type", ClientMessageVariants);
export type ClientMessage = z.output<typeof ClientMessage>;

export const GatewayMessageVariants = [
  z.object({ type: z.literal("bound"), guest: GuestInfo, gateway_version: z.number().int() }),
  z.object({
    type: z.literal("error"), error: ErrorBody, executed: z.boolean().default(false),
    retry_after_ms: z.number().int().nonnegative().optional(),
  }),
] as const;
export const GatewayMessage = z.discriminatedUnion("type", GatewayMessageVariants);
export type GatewayMessage = z.output<typeof GatewayMessage>;

export const GatewayErrorCodes = {
  unauthorized: "unauthorized",
  unknownKey: "unknown_key",
  staleEpoch: "stale_epoch",
  moved: "moved",
  unsupportedVersion: "unsupported_version",
  busy: "busy",
  badRequest: "bad_request",
} as const;
