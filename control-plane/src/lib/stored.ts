// Closed enums read back from Durable Object storage. SQLite columns are free TEXT (a CHECK
// constraint would need a table rebuild on live data; docs/data/), so every write goes through a
// TypeScript union and every read is checked here: a value outside the union is logged as an
// error, never passed on silently. It is still returned as read, so one bad row cannot stop a DO.

/** Anything with zod's `safeParse` (a `z.enum`). */
interface EnumSchema<T extends string> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
}

/** Values already reported, so a bad row read on every tick logs once per isolate. */
const reported = new Set<string>();

/** `value` as `T`, read from `where` (`table.column`); logged as an error unless `schema` admits it. */
export function storedEnum<T extends string>(schema: EnumSchema<T>, value: unknown, where: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const key = `${where}=${String(value)}`;
  if (!reported.has(key)) {
    reported.add(key);
    console.error(`stored value outside its enum: ${where} = ${JSON.stringify(value)}`);
  }
  return value as T;
}

/** As {@link storedEnum}, for a nullable column: null passes. */
export function storedEnumOrNull<T extends string>(schema: EnumSchema<T>, value: unknown, where: string): T | null {
  return value === null || value === undefined ? null : storedEnum(schema, value, where);
}

/** A SQL list of quoted literals for `IN (...)`, built from typed members. */
export function sqlIn<T extends string>(members: readonly T[]): string {
  return members.map((m) => `'${m.replace(/'/g, "''")}'`).join(", ");
}

/** The closed enum of a discriminated union's `type` literals (zod variants), for a `type` column. */
export function typeEnum<T extends string>(variants: readonly { shape: { type: { value: T } } }[]): EnumSchema<T> {
  const known = new Set<string>(variants.map((v) => v.shape.type.value));
  return {
    safeParse: (v: unknown) => (typeof v === "string" && known.has(v) ? { success: true, data: v as T } : { success: false }),
  };
}
