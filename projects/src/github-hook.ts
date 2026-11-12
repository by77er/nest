// `POST /hooks/github`: the GitHub App's webhook (README.md#built-the-review-pipeline). It answers fast: it checks the
// signature, deduplicates the delivery, routes it by repo to its project, and hands it to the project's
// Durable Objects, which only record it; their alarms do the work.
// - Signature: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>`, compared in constant
//   time (https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
// - Deduplicated by `X-GitHub-Delivery` (DirectoryDO's seen ids, 7 days). GitHub doesn't redeliver a
//   failed delivery by itself (unverified: its docs offer manual redelivery only), so a lost
//   `pull_request` leaves the head without the required check, which blocks merging until the next push.
// - Events (https://docs.github.com/en/webhooks/webhook-events-and-payloads): `pull_request`
//   (`opened`, `reopened`, `synchronize`, `closed`) and `check_run` `rerequested` for the app's own
//   check; the owner's comments on a PR (README.md#pr-comments): `issue_comment` `created` on a PR,
//   `pull_request_review` `submitted` (with text, or requesting changes) and `pull_request_review_comment`
//   `created`; `issues` (README.md#triage: opened, reopened, edited, closed, deleted, transferred), never a
//   PR's; `ping` and anything else is acknowledged and ignored, as is a repo no project is attached to.

import { followInstallation } from "./binding";
import { issueEventOf, type PrComment } from "./do/project";
import { directory, type Env, project, review } from "./env";
import { appBotId, CHECK_NAME, verifyGithubSignature } from "./github";
import { nestFrom } from "./nest";
import type { TrustedIds } from "./review-trust";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const SHA = /^[0-9a-f]{40}$/;
const TASK_BRANCH = /^task\/(tsk_[a-z0-9]+)$/;
const DELIVERY = /^[A-Za-z0-9-]{1,100}$/;
const NODE = /^[A-Za-z0-9_=-]{1,200}$/;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const prNumber = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

const COMMENT_EVENTS = new Set(["issue_comment", "pull_request_review", "pull_request_review_comment"]);
/** A `check_run` `completed` with one of these (GitHub's REST spelling) nudges the PR read (README.md#pr-upkeep). */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);
const ISSUE_ACTIONS = new Set(["opened", "reopened", "edited", "closed", "deleted", "transferred"]);
/** A comment's text kept from the event; the message cuts it further (PR_COMMENT_MAX). */
const BODY_MAX = 20_000;

/**
 * A comment's author, if it may be the project's GitHub user: a person (`user.type` `User`) writing as
 * themself, not through an App (`performed_via_github_app` set: an App acting with a user's token).
 * Whether it is that user is ProjectDO's to say, by id (README.md#pr-comments).
 */
export function personAuthor(by: unknown, viaApp: unknown): { id: number; login: string } | null {
  const u = obj(by);
  const login = str(u.login);
  const id = prNumber(u.id);
  if (viaApp !== null && viaApp !== undefined) return null;
  return u.type === "User" && login && id !== null ? { id, login } : null;
}

/** A GitHub repo's id from a payload, or null. */
const repoId = (v: unknown): number | null => {
  const id = obj(v).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
};

/**
 * Whether a PR's head is in the event's own repo, not a fork: by GitHub's ids when the payload carries
 * both (a renamed repo is still itself), else by the name the project was created with.
 */
export function sameRepo(headRepo: unknown, repository: unknown, name: string): boolean {
  const a = repoId(headRepo);
  const b = repoId(repository);
  if (a !== null && b !== null) return a === b;
  return str(obj(headRepo).full_name)?.toLowerCase() === name;
}

/**
 * The owner's comment on a PR from one of the comment events, or null: another author, an action it
 * doesn't act on (an edit, a delete, a review with no text that isn't requesting changes), a comment
 * on an issue that isn't a PR, or a malformed payload.
 */
export function prCommentOf(event: string, payload: Obj, repo: string): PrComment | null {
  const action = str(payload.action);
  const headOf = (pr: Obj) => {
    const head = obj(pr.head);
    const fork = !sameRepo(head.repo, payload.repository, repo);
    return { fork, headTask: fork ? null : (TASK_BRANCH.exec(str(head.ref) ?? "")?.[1] ?? null) };
  };
  const text = (v: unknown) => (str(v) ?? "").slice(0, BODY_MAX);
  if (event === "issue_comment") {
    const issue = obj(payload.issue);
    if (action !== "created" || !issue.pull_request) return null;
    const c = obj(payload.comment);
    const author = personAuthor(c.user, c.performed_via_github_app);
    const pr = prNumber(issue.number);
    const url = str(c.html_url);
    if (!author || pr === null || !url) return null;
    // The event doesn't name the head: the PR's task is the one it's attached to.
    return { pr, fork: null, headTask: null, kind: "comment", author: author.login, author_id: author.id, url, body: text(c.body) };
  }
  const pr = obj(payload.pull_request);
  const number = prNumber(pr.number);
  if (number === null) return null;
  if (event === "pull_request_review") {
    const r = obj(payload.review);
    const state = str(r.state)?.toLowerCase() ?? null;
    const body = text(r.body);
    if (action !== "submitted" || (!body.trim() && state !== "changes_requested")) return null;
    const author = personAuthor(r.user, r.performed_via_github_app);
    const url = str(r.html_url);
    if (!author || !url) return null;
    return { pr: number, ...headOf(pr), kind: "review", author: author.login, author_id: author.id, url, body, review_state: state };
  }
  const c = obj(payload.comment);
  if (action !== "created") return null;
  const author = personAuthor(c.user, c.performed_via_github_app);
  const url = str(c.html_url);
  if (!author || !url) return null;
  const line = prNumber(c.line) ?? prNumber(c.original_line);
  return { pr: number, ...headOf(pr), kind: "review_comment", author: author.login, author_id: author.id, url, body: text(c.body), path: (str(c.path) ?? "").slice(0, 500) || null, line };
}

/**
 * A PR's author from the signed `pull_request` event: its GitHub id (what trust is decided by), its login
 * (text to show), and whether GitHub says it's a bot.
 */
export function prAuthor(pr: Obj): { id: number | null; login: string | null; bot: boolean } {
  const u = obj(pr.user);
  return { id: prNumber(u.id), login: (str(u.login) ?? "").slice(0, 100) || null, bot: u.type === "Bot" };
}

/**
 * The repo's owner as the signed event names it (`repository.owner`, which GitHub puts in every event about a
 * repo), whatever its kind (`User`, `Organization`); null when it names none. It is the owner as of the event:
 * once a repo is transferred, its events name the new owner, so the account it left is no longer trusted by
 * being its owner (README.md#the-review-gate). Never a copy kept from before.
 */
function eventOwner(payload: Obj): { id: number; login: string; type: string } | null {
  const o = obj(obj(payload.repository).owner);
  const id = prNumber(o.id);
  const login = str(o.login);
  return id !== null && login ? { id, login: login.slice(0, 100), type: str(o.type) ?? "" } : null;
}

/**
 * The GitHub ids a project trusts to have their PRs reviewed unasked (src/review-trust.ts): its comments user
 * (the owner's choice), the repo's owner as this event names it (`owner`), and the App's bot. The App's
 * bot is looked up when a bot's PR from the repo itself doesn't match the id kept (none yet, or a stale
 * one), and kept; a lookup that fails leaves what was kept, so that PR is held (the safe side) and the
 * next one looks again.
 */
async function trustedIds(env: Env, projectId: string, repo: string, botAuthor: number | null, owner: number | null): Promise<TrustedIds> {
  const s = await project(env, projectId).getSettings();
  const dir = directory(env);
  let bot = await dir.githubAppBotId();
  const nest = nestFrom(env);
  // `botAuthor`: a bot's PR from the repo itself. One the stored id doesn't match is looked up again
  // before it's held (the App was replaced, or the id recorded was stale).
  if (botAuthor !== null && bot !== botAuthor && nest) {
    try {
      bot = await appBotId(nest, repo);
      if (bot !== null) await dir.recordGithubAppBotId(bot);
    } catch (e) {
      console.warn(`the App's bot couldn't be looked up; a bot's PR is held meanwhile: ${String(e).slice(0, 200)}`);
    }
  }
  return { comments_from: s.ok ? (s.value.comments_from?.id ?? null) : null, repo_owner: owner, app_bot: bot };
}

export async function githubHook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!env.GITHUB_WEBHOOK_SECRET) return new Response(null, { status: 503 });
  // The raw bytes, as signed: never decoded and re-encoded before the check.
  const raw = await request.arrayBuffer();
  if (!(await verifyGithubSignature(env.GITHUB_WEBHOOK_SECRET, request.headers.get("x-hub-signature-256"), raw))) return new Response(null, { status: 401 });
  const delivery = request.headers.get("x-github-delivery");
  if (!delivery || !DELIVERY.test(delivery)) return json({ error: "no X-GitHub-Delivery" }, 400);
  const event = request.headers.get("x-github-event");
  let payload: Obj;
  try {
    payload = obj(JSON.parse(new TextDecoder().decode(raw)));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (event !== "pull_request" && event !== "check_run" && event !== "issues" && !COMMENT_EVENTS.has(event ?? "")) return json({ ignored: event ?? "no event" });

  const dir = directory(env);
  const seenId = `github:${delivery}`;
  // Claimed before it's handled, in one step: a concurrent copy of the delivery is a duplicate.
  if (!(await dir.claim(seenId))) return json({ duplicate: true });
  try {
    const res = await handle(env, event!, payload, seenId);
    // Handled: the claim is confirmed (it no longer lapses).
    if (res.status < 300) await dir.markSeen(seenId);
    return res;
  } catch (e) {
    // Failed: the claim goes, so a redelivery is handled.
    await dir.release(seenId);
    throw e;
  }
}

async function handle(env: Env, event: string, payload: Obj, seenId: string): Promise<Response> {
  const dir = directory(env);
  // By the repo's id (README.md#built-the-review-pipeline): a rename or a transfer changes the name, never the id.
  // And by the App installation the event came from, once the project's is known (README.md#the-repos-binding).
  const installation = repoId(payload.installation);
  const route = () => dir.projectForRepo(repoId(payload.repository), str(obj(payload.repository).full_name) ?? null, installation);
  let routed = await route();
  // Another installation than the binding's: the binding is read again, to follow the installation nest mints
  // the repo's tokens from now (a reinstalled App), and the event routed again if the binding's changed.
  const nest = nestFrom(env);
  if (routed && "refused" in routed && installation !== null && nest) {
    let followed = false;
    try {
      followed = await followInstallation(env, nest, routed.project_id);
    } catch (e) {
      console.warn(`the binding of ${routed.project_id} couldn't be read again: ${String(e).slice(0, 200)}`);
    }
    if (followed) routed = await route();
  }
  if (!routed) return json({ ignored: "no project for this repo" });
  if ("refused" in routed) {
    console.warn(`github event refused: ${routed.refused}`);
    return json({ ignored: routed.refused });
  }
  const p = routed.project;
  // Still being created (README.md#creating-a-project): its objects aren't whole, so nothing reaches them;
  // an import or a later event catches up.
  if (p.state === "pending") return json({ ignored: "the project is still being created" });
  // The repo's owner, from the event only when it was routed by the id read from GitHub (`anchored`): one
  // routed by its name alone may be another account's repo under that name now, whose owner is nobody's to
  // trust (README.md#the-review-gate).
  const owner = routed.anchored ? eventOwner(payload) : null;
  const repoOwner = owner?.type === "User" ? owner.id : null;
  // A default comments user that isn't the owner any more goes, before anything is decided by it (README.md#pr-comments).
  if (owner) await project(env, p.id).repoOwnerSeen({ id: owner.id, login: owner.login });
  const of = { project: p.id, repo: p.repo };
  const action = str(payload.action);

  if (event === "pull_request") {
    const pr = obj(payload.pull_request);
    const number = prNumber(pr.number) ?? prNumber(payload.number);
    const head = obj(pr.head);
    const sha = str(head.sha);
    if (number === null || !sha || !SHA.test(sha)) {
      await dir.release(seenId);
      return json({ error: "not a pull_request payload" }, 400);
    }
    const updated_at = str(pr.updated_at) ?? new Date().toISOString();
    // The task its branch names, only for a branch of the repo itself (a fork may name any branch).
    const fromRepo = sameRepo(head.repo, payload.repository, p.repo);
    const task = fromRepo ? (TASK_BRANCH.exec(str(head.ref) ?? "")?.[1] ?? null) : null;
    if (action === "opened" || action === "reopened" || action === "synchronize") {
      // Whose PR, from where (README.md#the-review-gate): one the project doesn't trust is held, not reviewed.
      const author = prAuthor(pr);
      const trust = await trustedIds(env, p.id, p.repo, fromRepo && author.bot ? author.id : null, repoOwner);
      await review(env, p.id).onHead(of, {
        pr: number, sha, base: (str(obj(pr.base).ref) ?? "").slice(0, 255), title: (str(pr.title) ?? "").slice(0, 1000), updated_at,
        fork: !fromRepo, author_id: author.id, author: author.login,
      }, trust);
      // Its node id, for GraphQL's auto-merge on a task's PR.
      const node = str(pr.node_id);
      if (action !== "synchronize") {
        await project(env, p.id).onPullRequest({
          pr: number, task, action: "opened", merged: false, node: node && NODE.test(node) ? node : null, fork: !fromRepo, title: (str(pr.title) ?? "").slice(0, 300),
          updated_at: str(pr.updated_at) ?? null, reopened: action === "reopened",
        });
      }
    } else if (action === "closed") {
      await review(env, p.id).onClosed(of, { pr: number, updated_at });
      await project(env, p.id).onPullRequest({ pr: number, task, action: "closed", merged: pr.merged === true, updated_at: str(pr.updated_at) ?? null });
    }
  } else if (event === "issues") {
    // The repo's own issues only (an event names its repo: a fork's goes to no project). Anyone may file;
    // the text is kept as data, shown escaped, and reaches no agent before the owner accepts it.
    const e = issueEventOf(payload.issue);
    // The sender (who acted) by id: a declined issue comes back only when someone the owner trusts reopens it.
    const sender = obj(payload.sender).id;
    // The repo's owner as this event names it, never a copy (a transfer leaves none trusted that shouldn't be).
    if (e && action && ISSUE_ACTIONS.has(action)) await project(env, p.id).onIssue({ action, ...e, sender: typeof sender === "number" ? sender : null, repo_owner: repoOwner });
  } else if (COMMENT_EVENTS.has(event!)) {
    const c = prCommentOf(event!, payload, p.repo);
    if (c) await project(env, p.id).onPrComment(c);
  } else if (event === "check_run" && action === "completed") {
    // A check on one of the repo's PRs failed: a nudge to read the PRs sooner (README.md#pr-upkeep). What a
    // worker is told is decided from that read, never from this event.
    const run = obj(payload.check_run);
    const prs = (Array.isArray(run.pull_requests) ? run.pull_requests : []).map((x) => prNumber(obj(x).number)).filter((n): n is number => n !== null);
    // Only a PR a live worker owns brings the read forward (ProjectDO decides which).
    if (prs.length && FAILED_CONCLUSIONS.has(str(run.conclusion) ?? "")) await project(env, p.id).nudgePrRead(prs);
  } else if (action === "rerequested") {
    const run = obj(payload.check_run);
    const id = prNumber(run.id);
    const sha = str(run.head_sha);
    if (str(run.name) === CHECK_NAME && id !== null && sha && SHA.test(sha)) {
      const prs = (Array.isArray(run.pull_requests) ? run.pull_requests : []).map((x) => prNumber(obj(x).number)).filter((n): n is number => n !== null);
      await review(env, p.id).onRerequest(of, { check_run: id, sha, prs });
    }
  }
  return json({ ok: true });
}
