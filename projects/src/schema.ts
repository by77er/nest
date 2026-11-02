// A tiny JSON Schema check for the tools' inputs (src/tools.ts): the subset those schemas use (objects
// with `additionalProperties: false` and `required`, strings with `maxLength` or an `enum`, arrays of strings with
// `maxItems`, integers with `minimum`, booleans), so each tool has one schema, listed and enforced.

type Schema = Record<string, unknown>;

/** Why `value` doesn't match `schema`, or null when it does. */
export function invalid(schema: Schema, value: unknown, at = "arguments"): string | null {
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${at} must be an object`;
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      const v = value as Record<string, unknown>;
      for (const r of (schema.required ?? []) as string[]) if (v[r] === undefined) return `${at}.${r} is required`;
      for (const [k, x] of Object.entries(v)) {
        const p = props[k];
        if (!p) {
          if (schema.additionalProperties === false) return `${at}.${k} is not an argument`;
          continue;
        }
        const e = invalid(p, x, `${at}.${k}`);
        if (e) return e;
      }
      return null;
    }
    case "string":
      if (typeof value !== "string") return `${at} must be a string`;
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${at} is longer than ${schema.maxLength}`;
      if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(", ")}`;
      return null;
    case "array": {
      if (!Array.isArray(value)) return `${at} must be an array`;
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${at} has more than ${schema.maxItems} items`;
      for (let i = 0; i < value.length; i++) {
        const e = invalid((schema.items ?? {}) as Schema, value[i], `${at}[${i}]`);
        if (e) return e;
      }
      return null;
    }
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return `${at} must be an integer`;
      if (typeof schema.minimum === "number" && value < schema.minimum) return `${at} must be at least ${schema.minimum}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : `${at} must be a boolean`;
    default:
      return null;
  }
}
