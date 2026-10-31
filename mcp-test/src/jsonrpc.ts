// JSON-RPC 2.0 as MCP uses it (no batches since 2025-06-18), and the protocol versions this server speaks.

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const;
export const LATEST_VERSION = PROTOCOL_VERSIONS[0];

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export type Id = string | number;
export type Params = Record<string, unknown>;

export type Message =
  | { kind: "request"; id: Id; method: string; params: Params | undefined }
  | { kind: "notification"; method: string; params: Params | undefined }
  | { kind: "response"; id: Id };

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// MCP ids are strings or integers, never null.
const isId = (v: unknown): v is Id => typeof v === "string" || (typeof v === "number" && Number.isInteger(v));

/** Classifies one parsed JSON body, or says why it is not a JSON-RPC message MCP accepts. */
export function classify(body: unknown): Message | RpcError {
  if (Array.isArray(body)) return { code: INVALID_REQUEST, message: "JSON-RPC batches are not supported" };
  if (!isObject(body) || body.jsonrpc !== "2.0") return { code: INVALID_REQUEST, message: "not a JSON-RPC 2.0 message" };
  const { id, method, params } = body;
  if (params !== undefined && !isObject(params)) return { code: INVALID_REQUEST, message: "params must be an object" };
  if (typeof method === "string") {
    if (id === undefined) return { kind: "notification", method, params };
    if (!isId(id)) return { code: INVALID_REQUEST, message: "id must be a string or an integer" };
    return { kind: "request", id, method, params };
  }
  if (method === undefined && isId(id) && ("result" in body || "error" in body)) return { kind: "response", id };
  return { code: INVALID_REQUEST, message: "neither a request, a notification nor a response" };
}

export const isRpcError = (v: Message | RpcError): v is RpcError => "code" in v;

export const success = (id: Id, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
// An error with no request to answer (a parse error, a rejected HTTP request) carries no id, as the
// Streamable HTTP transport says.
export const failure = (id: Id | undefined, error: RpcError) =>
  id === undefined ? { jsonrpc: "2.0" as const, error } : { jsonrpc: "2.0" as const, id, error };
