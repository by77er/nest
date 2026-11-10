// The models a project's manager and its workers run on (README.md#models): the owner's choice per
// project, applied through nest's generic client interface. A client's spawn can't override a template's
// launch (nest refuses it: a different launch is a template in the client's namespace), so each choice is
// a template of the app's own, named by the project, the role and the model, with `launch.model`: what
// Claude Code gets as `--model`. Pure, so the names and the rules are tested on their own.

export type ModelRole = "manager" | "worker";

/** The models offered by name; any other id is the owner's own to type ("Custom"). */
export const MODELS = [
  { id: "claude-fable-5-2", label: "Fable 5.2" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
] as const;

/** The owner's defaults (2026-11-09): the manager on Fable 5.2, workers on Opus 5.5. */
export const DEFAULT_MODEL: Record<ModelRole, string> = { manager: "claude-fable-5-2", worker: "claude-opus-5-5" };

/**
 * A model id as Claude Code's `--model` takes one: an id or an alias (`claude-opus-5-5`, `opus`,
 * `claude-opus-5-5[1m]`, a provider's `us.anthropic.…`). It becomes one argument of a command, so it
 * starts with a letter or digit (never `-`: an option) and holds no space or control character.
 */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/\[\]-]{0,99}$/;

/** Why `model` isn't one, or null. */
export function modelProblem(model: string): string | null {
  if (!model) return "a model id, such as claude-opus-5-5";
  if (model.length > 100) return "at most 100 characters";
  if (!MODEL_ID.test(model)) return "letters, digits and . _ : @ / [ ] - only, starting with a letter or digit";
  return null;
}

/** A model's name as the owner reads it: the listed label, or the id itself. */
export const modelLabel = (id: string): string => MODELS.find((m) => m.id === id)?.label ?? id;

/** FNV-1a, as 8 hex digits: tells apart ids whose slugs would be the same (not a secret, not security). */
function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

const SLUG_MAX = 28;

/**
 * The catalog entry (in the app's namespace) for a project's role on a model: `<role>-<project>-<model>`,
 * within nest's entry names (`[a-z][a-z0-9-]{0,62}`). A model id that isn't already such a name (capitals,
 * dots, brackets, too long) is cut down and told apart by a hash of the whole id, so two ids never share
 * an entry.
 */
export function modelTemplateEntry(role: ModelRole, project: string, model: string): string {
  const p = project.replace(/^prj_/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 16);
  const plain = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(model) && model.length <= SLUG_MAX;
  const slug = plain ? model : `${model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SLUG_MAX - 9) || "m"}-${hash8(model)}`;
  return `${role}-${p}-${slug}`;
}
