// Versioned schema migrations for a Durable Object's SQLite storage: each step runs once, in order,
// with the version it brings the schema to stored in the same transaction. Expand only (new tables,
// nullable columns), so a rollback's code still reads what a newer release wrote.

export type Migration = readonly string[];

/** Apply the steps past the stored version; answers the version now stored. */
export function migrate(storage: DurableObjectStorage, steps: readonly Migration[]): number {
  const sql = storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
  const row = sql.exec<{ v: number }>("SELECT v FROM schema_version").toArray()[0];
  let have = row?.v ?? 0;
  if (!row) sql.exec("INSERT INTO schema_version (v) VALUES (0)");
  for (; have < steps.length; have++) {
    const step = steps[have]!;
    storage.transactionSync(() => {
      for (const stmt of step) sql.exec(stmt);
      sql.exec("UPDATE schema_version SET v = ?", have + 1);
    });
  }
  return have;
}

/** A DO method's answer: a value, or an HTTP status and message the Worker passes on. */
export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(status: number, error: string): Result<T> => ({ ok: false, status, error });
