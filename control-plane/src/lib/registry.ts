// Platform tool registry, loaded from the canonical catalog. Which tools an agent gets is its spec's
// (lib/spec.ts): the registry knows no roles.
import catalog from "../../../protocol/schemas/control/platform-tools.json";
import { ToolDef } from "../protocol/control";

export const PLATFORM_TOOLS: readonly ToolDef[] = (catalog as unknown[]).map((t) => ToolDef.parse(t));
/** Every platform tool's name, in catalog order (the order specs list tools in). */
export const PLATFORM_TOOL_NAMES: readonly string[] = PLATFORM_TOOLS.map((t) => t.name);
const BY_NAME = new Map(PLATFORM_TOOLS.map((t) => [t.name, t]));

export const toolDef = (name: string): ToolDef | undefined => BY_NAME.get(name);

/**
 * The definitions of `names` (an agent's spec), for `tools_list`. Each carries `roles: []` for one
 * release: runners of the previous release require the field (and ignore it).
 */
export function toolDefs(names: readonly string[]): ToolDef[] {
  return PLATFORM_TOOLS.filter((t) => names.includes(t.name)).map((t) => ({ ...t, roles: [] }));
}
