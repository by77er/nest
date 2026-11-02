// ReviewDO, one per project (README.md#pieces): the review queue, one job per PR head, with its reviewer
// agent, its check run and its verdict. This release has only its schema; the review pipeline (GitHub's
// webhooks, check runs, reviewers, retries) fills it in.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { migrate } from "../sql";

const MIGRATIONS = [
  [
    `CREATE TABLE jobs (pr INTEGER NOT NULL, sha TEXT NOT NULL, state TEXT NOT NULL, agent TEXT, check_run INTEGER, verdict TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, PRIMARY KEY (pr, sha))`,
    "CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  ],
] as const;

export class ReviewDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage, MIGRATIONS);
  }

  /** The queue's jobs, newest first: always empty until the review pipeline lands. */
  async jobs(): Promise<unknown[]> {
    return this.ctx.storage.sql.exec("SELECT pr, sha, state, agent, check_run, created_ms, updated_ms FROM jobs ORDER BY created_ms DESC LIMIT 100").toArray();
  }
}
