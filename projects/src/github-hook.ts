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
//   check; `ping` and anything else is acknowledged and ignored, as is a repo no project is attached to.

import { directory, type Env, project, review } from "./env";
import { CHECK_NAME, verifyGithubSignature } from "./github";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const SHA = /^[0-9a-f]{40}$/;
const TASK_BRANCH = /^task\/(tsk_[a-z0-9]+)$/;
const DELIVERY = /^[A-Za-z0-9-]{1,100}$/;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const prNumber = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

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
  if (event !== "pull_request" && event !== "check_run") return json({ ignored: event ?? "no event" });

  const dir = directory(env);
  const seenId = `github:${delivery}`;
  if (await dir.seen(seenId)) return json({ duplicate: true });
  const repo = str(obj(payload.repository).full_name)?.toLowerCase() ?? null;
  const p = repo ? await dir.projectByRepo(repo) : null;
  if (!p) {
    await dir.markSeen(seenId);
    return json({ ignored: "no project for this repo" });
  }
  const of = { project: p.id, repo: p.repo };
  const action = str(payload.action);

  if (event === "pull_request") {
    const pr = obj(payload.pull_request);
    const number = prNumber(pr.number) ?? prNumber(payload.number);
    const head = obj(pr.head);
    const sha = str(head.sha);
    if (number === null || !sha || !SHA.test(sha)) return json({ error: "not a pull_request payload" }, 400);
    const updated_at = str(pr.updated_at) ?? new Date().toISOString();
    // The task its branch names, only for a branch of the repo itself (a fork may name any branch).
    const fromRepo = str(obj(head.repo).full_name)?.toLowerCase() === p.repo;
    const task = fromRepo ? (TASK_BRANCH.exec(str(head.ref) ?? "")?.[1] ?? null) : null;
    if (action === "opened" || action === "reopened" || action === "synchronize") {
      await review(env, p.id).onHead(of, {
        pr: number, sha, base: (str(obj(pr.base).ref) ?? "").slice(0, 255), title: (str(pr.title) ?? "").slice(0, 1000), updated_at,
      });
      if (action !== "synchronize") await project(env, p.id).onPullRequest({ pr: number, task, action: "opened", merged: false });
    } else if (action === "closed") {
      await review(env, p.id).onClosed(of, { pr: number, updated_at });
      await project(env, p.id).onPullRequest({ pr: number, task, action: "closed", merged: pr.merged === true });
    }
  } else if (action === "rerequested") {
    const run = obj(payload.check_run);
    const id = prNumber(run.id);
    const sha = str(run.head_sha);
    if (str(run.name) === CHECK_NAME && id !== null && sha && SHA.test(sha)) {
      const prs = (Array.isArray(run.pull_requests) ? run.pull_requests : []).map((x) => prNumber(obj(x).number)).filter((n): n is number => n !== null);
      await review(env, p.id).onRerequest(of, { check_run: id, sha, prs });
    }
  }
  await dir.markSeen(seenId);
  return json({ ok: true });
}
