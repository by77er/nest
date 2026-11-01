// The five test tools: their definitions as tools/list shows them, argument checks against the same
// schemas, and what each does against the durable store.

export interface Store {
  notePut(key: string, value: string): void;
  noteGet(key: string): string | null;
  counterAdd(name: string, n: number): number;
}

/** A tools/call result: text blocks, with isError for a tool execution error. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
}

type Prop =
  | { type: "string"; description: string; minLength?: number; maxLength: number }
  | { type: "integer"; description: string; minimum: number; maximum: number };

interface Schema {
  type: "object";
  properties: Record<string, Prop>;
  required: string[];
  additionalProperties: false;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export const MAX_SLOW_MS = 30_000;
const MAX_TEXT = 65_536;
const MAX_NAME = 256;
const MAX_N = 1_000_000_000;

const str = (description: string, maxLength: number, minLength?: number): Prop =>
  minLength === undefined ? { type: "string", description, maxLength } : { type: "string", description, minLength, maxLength };
const int = (description: string, minimum: number, maximum: number): Prop => ({ type: "integer", description, minimum, maximum });
const schema = (properties: Record<string, Prop>): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

// Every tool states all three hints, so no client has to apply the spec's defaults to know them.
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function tool(name: string, title: string, description: string, inputSchema: Schema, hints: Omit<Tool["annotations"], "title">): Tool {
  return { name, title, description, inputSchema, annotations: { title, ...hints } };
}

/** An added tool's name (`POST /tools?name=`): `extra_` and lowercase letters, digits or `_`. */
export const EXTRA_TOOL = /^extra_[a-z0-9_]{1,32}$/;

/** A tool added at run time (the list changing): read-only, echoes its text. */
export const extraTool = (name: string): Tool =>
  tool(name, name, "An added tool: returns the text it is given, prefixed with its name.", schema({ text: str("Text to return", MAX_TEXT) }), readOnly);

export const TOOLS: Tool[] = [
  tool("echo", "Echo", "Returns the text it is given.", schema({ text: str("Text to return", MAX_TEXT) }), readOnly),
  tool(
    "note_put",
    "Put note",
    "Stores a value under a key, replacing any value already there.",
    schema({ key: str("Note key", MAX_NAME, 1), value: str("Value to store", MAX_TEXT) }),
    // Replacing a value is a destructive update; storing the same value twice changes nothing more.
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  ),
  tool("note_get", "Get note", "Returns the value stored under a key, or an error if there is none.", schema({ key: str("Note key", MAX_NAME, 1) }), readOnly),
  tool(
    "counter_add",
    "Add to counter",
    "Adds n to a named counter (starting at 0) and returns the new total.",
    schema({ name: str("Counter name", MAX_NAME, 1), n: int("Amount to add", -MAX_N, MAX_N) }),
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  ),
  tool("slow", "Slow", `Waits ms milliseconds (at most ${MAX_SLOW_MS}), then answers.`, schema({ ms: int("Milliseconds to wait", 0, MAX_SLOW_MS) }), readOnly),
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
export const findTool = (name: string, extra: readonly string[] = []): Tool | undefined =>
  byName.get(name) ?? (extra.includes(name) ? extraTool(name) : undefined);

/** Checks arguments against a tool's schema (the subset of JSON Schema these schemas use). */
export function checkArguments(s: Schema, args: Record<string, unknown>): string | null {
  for (const key of Object.keys(args)) if (!(key in s.properties)) return `unexpected argument: ${key}`;
  for (const key of s.required) if (!(key in args)) return `missing argument: ${key}`;
  for (const [key, prop] of Object.entries(s.properties)) {
    const v = args[key];
    if (v === undefined) continue;
    if (prop.type === "string") {
      if (typeof v !== "string") return `${key} must be a string`;
      if (prop.minLength !== undefined && v.length < prop.minLength) return `${key} must be at least ${prop.minLength} characters`;
      if (v.length > prop.maxLength) return `${key} must be at most ${prop.maxLength} characters`;
    } else {
      if (typeof v !== "number" || !Number.isInteger(v)) return `${key} must be an integer`;
      if (v < prop.minimum || v > prop.maximum) return `${key} must be between ${prop.minimum} and ${prop.maximum}`;
    }
  }
  return null;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], isError });

/**
 * Runs a known tool. Bad arguments are a tool execution error (isError), not a protocol error, as
 * the 2025-11-25 tools spec says, so a model can correct itself.
 */
export async function runTool(t: Tool, args: Record<string, unknown>, store: Store, sleep: (ms: number) => Promise<void>): Promise<ToolResult> {
  const bad = checkArguments(t.inputSchema, args);
  if (bad !== null) return text(`invalid arguments: ${bad}`, true);
  if (EXTRA_TOOL.test(t.name)) return text(`${t.name}: ${args.text as string}`);
  switch (t.name) {
    case "echo":
      return text(args.text as string);
    case "note_put":
      store.notePut(args.key as string, args.value as string);
      return text(`stored ${args.key as string}`);
    case "note_get": {
      const value = store.noteGet(args.key as string);
      return value === null ? text(`note not found: ${args.key as string}`, true) : text(value);
    }
    case "counter_add":
      return text(String(store.counterAdd(args.name as string, args.n as number)));
    case "slow":
      await sleep(args.ms as number);
      return text(`waited ${args.ms as number} ms`);
    default:
      throw new Error(`no handler for tool ${t.name}`);
  }
}
