// Platform tool registry, loaded from the canonical catalog.
import catalog from "../../../protocol/schemas/control/platform-tools.json";
import { ToolDef } from "../protocol/control";
import type { AgentRole } from "../protocol/model";

export const PLATFORM_TOOLS: readonly ToolDef[] = (catalog as unknown[]).map((t) => ToolDef.parse(t));
const BY_NAME = new Map(PLATFORM_TOOLS.map((t) => [t.name, t]));

export const toolDef = (name: string): ToolDef | undefined => BY_NAME.get(name);

/** Tools offered to an agent: role filter, then the agent's grant list (when it has one). */
export function toolsFor(role: AgentRole, grants?: readonly string[]): ToolDef[] {
  return PLATFORM_TOOLS.filter((t) => t.roles.includes(role) && (!grants || grants.includes(t.name)));
}
