// A project's settings: whether ready tasks are assigned automatically, how many workers may run, and
// whether task PRs merge automatically once their review passes (with the repo's setting behind it),
// whether reviews of untrusted PRs wait for the owner (README.md#the-review-gate),
// and whether workers may change CI workflows (README.md#secrets). The Panels sit in one row with Save right under them at the bottom right; on a phone, one column,
// so Save comes right after the last field.

import { Anchor, Badge, Button, NumberInput, Select, Switch, Text, TextInput } from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { Settings as SettingsSchema } from "../../../requests";
import { ApiError } from "../../api/client";
import { useRetryRepoAutoMerge, useSecrets, useUpdateSettings } from "../../api/queries";
import { LiveAgents } from "../project/LiveAgents";
import type { Settings } from "../../api/types";
import { ago, exact } from "../../common/time";
import { FieldGroup, MetaItem, Notice, Panel, Row, Section, SectionGrid, Stack, Toolbar, weight } from "../../layout";
import { MERGE_METHODS, type MergeMethod, type RepoAutoMerge } from "../../../automerge";

const METHOD_LABEL: Record<MergeMethod, string> = { squash: "Squash and merge", merge: "Merge commit", rebase: "Rebase and merge" };

const values = (s: Settings) => ({
  auto_assign: s.auto_assign, max_workers: s.max_workers, auto_merge: s.auto_merge, merge_method: s.merge_method, workers_edit_workflows: s.workers_edit_workflows,
  comments_from_login: s.comments_from?.login ?? null,
  // "Use the repo owner": the server takes the repo's owner by id, never this login.
  comments_from_repo_owner: false,
});

/** The editable settings as Panels in a row, saved together by the one Save right under them. */
export function SettingsForm({ projectId, settings, onDone }: { projectId: string; settings: Settings; onDone?: () => void }) {
  const update = useUpdateSettings(projectId);
  const form = useForm({
    initialValues: values(settings),
    validate: schemaResolver(SettingsSchema, { sync: true }),
  });
  // The review gate (README.md#the-review-gate): held unless the project opted out. Sent only when changed.
  const held = settings.untrusted_reviews !== "review";
  const [hold, setHold] = useState(held);

  return (
    <form
      onSubmit={form.onSubmit(({ comments_from_login, comments_from_repo_owner, ...v }) =>
        // Whose comments count is sent only when changed: an id with no login known shows as an empty field.
        update.mutate({
          ...v,
          ...(hold !== held ? { untrusted_reviews: hold ? ("hold" as const) : ("review" as const) } : {}),
          ...(comments_from_repo_owner ? { comments_from_repo_owner: true as const }
            : form.isDirty("comments_from_login") ? { comments_from_login: comments_from_login?.trim() || null } : {}),
        }, {
          onSuccess: (s) => {
            form.setInitialValues(values(s));
            notifications.show({ color: "success", message: "Settings saved" });
            onDone?.();
          },
        }))}
    >
      <Stack gap="xl">
        <SectionGrid>
          <Panel>
            <Section title="Workers" order={4} region={false}>
              <FieldGroup>
                <Switch
                  label="Assign ready tasks automatically"
                  description="In board order, while the project's live workers are fewer than the cap."
                  {...form.getInputProps("auto_assign", { type: "checkbox" })}
                />
                <NumberInput
                  label="Max workers"
                  description="Caps auto-assign and the manager's assigning. Your own assigning isn't capped."
                  min={0}
                  max={20}
                  allowDecimal={false}
                  clampBehavior="strict"
                  {...form.getInputProps("max_workers")}
                />
              </FieldGroup>
            </Section>
          </Panel>
          <Panel>
            <Section title="Auto-merge" order={4} region={false}>
              <FieldGroup>
                <Switch
                  label="Auto-merge when review passes"
                  description="Each task's PR merges once the review check and the branch's other rules pass. Turns on the repo's “Allow auto-merge”."
                  {...form.getInputProps("auto_merge", { type: "checkbox" })}
                />
                <Select
                  label="Merge method"
                  data={MERGE_METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] }))}
                  allowDeselect={false}
                  disabled={!form.getValues().auto_merge}
                  {...form.getInputProps("merge_method")}
                />
                <RepoAutoMergeStatus projectId={projectId} status={settings.repo_auto_merge} />
              </FieldGroup>
            </Section>
          </Panel>
          <Panel>
            <Section title="CI workflows" order={4} region={false}>
              <FieldGroup>
                <WorkflowsSetting projectId={projectId} {...form.getInputProps("workers_edit_workflows", { type: "checkbox" })} />
              </FieldGroup>
            </Section>
          </Panel>
          <Panel>
            <Section title="Reviews" order={4} region={false}>
              <FieldGroup>
                <Switch
                  label="Hold reviews of PRs from forks and authors the project doesn't know"
                  description="A held PR's review waits for your approval, per commit, in Needs you. Known authors: the PR comments user, the repo's owner and nest's own bot."
                  checked={hold}
                  onChange={(e) => setHold(e.currentTarget.checked)}
                />
                {!hold && (
                  <Notice tone="warning" title="A reviewer agent will run on anyone's code">
                    <Text fz="sm">With this off, every PR starts a review by itself: on a public repo, anyone's pull request spends your subscription and hosts, and its text reaches an agent.</Text>
                  </Notice>
                )}
              </FieldGroup>
            </Section>
          </Panel>
          <Panel>
            <Section title="PR comments" order={4} region={false}>
              <CommentsFrom
                settings={settings}
                draft={form.getValues().comments_from_login}
                ownerPicked={form.getValues().comments_from_repo_owner}
                dirty={form.isDirty("comments_from_login") || form.getValues().comments_from_repo_owner}
                onUse={(login) => {
                  form.setFieldValue("comments_from_login", login);
                  form.setFieldValue("comments_from_repo_owner", true);
                }}
              >
                <TextInput
                  label="GitHub user"
                  description="Their GitHub login, stored as their account id (a rename doesn't change it)."
                  placeholder={settings.comments_from && !settings.comments_from.login ? `User id ${settings.comments_from.id} (login not seen yet)` : undefined}
                  value={form.getValues().comments_from_login ?? ""}
                  onChange={(e) => {
                    form.setFieldValue("comments_from_login", e.currentTarget.value || null);
                    form.setFieldValue("comments_from_repo_owner", false);
                  }}
                  error={update.error instanceof ApiError && /GitHub|organization|a bot/.test(update.error.message) ? update.error.message : undefined}
                  autoComplete="off"
                  spellCheck={false}
                />
              </CommentsFrom>
            </Section>
          </Panel>
        </SectionGrid>
        <Toolbar>
          {onDone && (
            <Button variant="subtle" color="danger" onClick={onDone}>
              Cancel
            </Button>
          )}
          <Button type="submit" loading={update.isPending} disabled={!form.isDirty() && hold === held}>
            Save settings
          </Button>
        </Toolbar>
        {/* After Save: what's live, not part of what's edited. */}
        <LiveWorkers projectId={projectId} saved={settings.workers_edit_workflows === true} />
      </Stack>
    </form>
  );
}

const STATE: Record<Exclude<RepoAutoMerge["state"], "none">, { label: string; color: string }> = {
  applied: { label: "Applied", color: "success" },
  pending: { label: "Pending", color: "primary" },
  error: { label: "Error", color: "danger" },
  drifted: { label: "Changed on GitHub", color: "warning" },
};

/** The repo's "Allow auto-merge" as the app last wrote or read it, with a retry when it isn't as set. */
export function RepoAutoMergeStatus({ projectId, status }: { projectId: string; status: RepoAutoMerge }) {
  const retry = useRetryRepoAutoMerge(projectId);
  if (status.state === "none") return null;
  const s = STATE[status.state];
  const allows = status.repo === null ? null : status.repo ? "allows" : "doesn't allow";
  const action = (label: string) => (
    <Row>
      <Button size="xs" variant="default" loading={retry.isPending} onClick={() => retry.mutate()}>
        {label}
      </Button>
    </Row>
  );
  return (
    <Stack gap="sm" aria-live="polite">
      <Row gap="sm">
        <Text size="sm" fw={weight.medium}>
          Repo setting
        </Text>
        <Badge color={s.color} variant="light">
          {s.label}
        </Badge>
        {allows && status.at_ms !== null && (
          <MetaItem title={exact(status.at_ms)}>
            The repo {allows} auto-merge, {ago(status.at_ms)}
          </MetaItem>
        )}
      </Row>
      {status.state === "error" && (
        <Notice tone="danger" title="GitHub refused the repo setting">
          <Stack gap="sm">
            <Text size="sm">{status.error}</Text>
            {action("Try again")}
          </Stack>
        </Notice>
      )}
      {status.state === "drifted" && (
        <Notice tone="warning" title="Changed on GitHub">
          <Stack gap="sm">
            <Text size="sm">Someone changed the repo's “Allow auto-merge” since the app set it.</Text>
            {action(status.want ? "Allow it again" : "Disallow it again")}
          </Stack>
        </Notice>
      )}
      {status.state === "pending" && status.error && <MetaItem>Retrying: {status.error}</MetaItem>}
    </Stack>
  );
}

/**
 * "Workers may change CI workflows" (README.md#secrets): off by default; on, workers' push tokens get
 * `workflows: write`, which the grant must allow, live workers' too (through their sandbox's client
 * layer), each shown applied, pending or failed with whether it has it. With the security note: a
 * pushed workflow runs with the repo's Actions secrets before anyone reviews it.
 */
function WorkflowsSetting({ projectId, checked, onChange, error }: { projectId: string; checked?: boolean; onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void; error?: React.ReactNode }) {
  const secrets = useSecrets(projectId);
  const allowed = secrets.data?.grant?.workflows;
  return (
    <Stack gap="sm">
      <Switch
        label="Workers may change CI workflows"
        description="Their pushes may add or change files under .github/workflows/; off, GitHub refuses those pushes. Saved, it reaches live workers in a moment too, through their sandbox."
        checked={checked}
        onChange={onChange}
        error={error}
        disabled={allowed === false && !checked}
      />
      {allowed === false && (
        <Text fz="xs" c="dimmed">
          The app's grant doesn't allow it: the operator sets github_push.workflows in its grant first.
        </Text>
      )}
      {checked && (
        <Notice tone="warning" title="A pushed workflow runs before anyone reviews it">
          <Text fz="sm">
            It runs with the repo's Actions secrets as soon as it's pushed. Keep CI secrets in an environment with required reviewers, so a job that reads them waits for a person.{" "}
            <Anchor href="https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment" target="_blank" rel="noreferrer" inherit>
              GitHub: environments
            </Anchor>
          </Text>
        </Notice>
      )}
    </Stack>
  );
}

/**
 * The live workers' push tokens, against the saved setting: each worker's layer (applied, pending or
 * failed) and, as last applied, whether its pushes may change workflows. One that differs from the
 * setting says so, until its layer applies (or, applied, why: the grant doesn't allow it).
 */
function LiveWorkers({ projectId, saved }: { projectId: string; saved: boolean }) {
  const secrets = useSecrets(projectId);
  const workers = (secrets.data?.agents ?? []).filter((a) => a.role === "worker");
  const can = new Set(secrets.data?.workflow_workers ?? []);
  const allowed = secrets.data?.grant?.workflows !== false;
  if (!workers.length) return null;
  // A token that disagrees with the saved setting is out of date, whatever its layer's last state: never Applied.
  const shown = workers.map((a) => (can.has(a.agent) !== saved && a.state === "applied" ? { ...a, state: "pending" as const } : a));
  return (
    <Panel data-slot="live-workers">
      <Section title="Live workers" order={4} count={workers.length} region={false}>
        <LiveAgents
          framed={false}
          agents={shown}
          label="Live workers' push tokens"
          empty=""
          detail={(a) => {
            const has = can.has(a.agent);
            if (has === saved) return <span data-slot="workflows" data-matches="true">{has ? "Its pushes may change workflows" : "Its pushes may not change workflows"}</span>;
            const why = saved && !allowed ? "the grant doesn't allow it" : "until its layer applies";
            return (
              <Text component="span" fz="xs" c="warning" data-slot="workflows" data-matches="false">
                {has ? "Still may change workflows" : "Can't change workflows yet"} · {why}
              </Text>
            );
          }}
        />
      </Section>
    </Panel>
  );
}

/**
 * Whose PR comments reach workers (README.md#pr-comments): what's saved, in a status line; the field;
 * what the draft would change, if it differs; "Use the repo owner" when the owner is a user and isn't
 * the one saved; and, with someone set, the warning that their credentials can comment as them.
 */
function CommentsFrom({ settings, draft, ownerPicked, dirty, onUse, children }: {
  settings: Settings; draft: string | null; ownerPicked: boolean; dirty: boolean; onUse: (login: string) => void; children: React.ReactNode;
}) {
  const saved = settings.comments_from;
  const owner = settings.repo_owner;
  return (
    <FieldGroup>
      {saved ? (
        <Text fz="sm" lh="lg" data-slot="comments-status">
          Comments from{" "}
          {saved.login ? (
            <>
              {/* Its profile, to check it's the right account (the id is what counts). */}
              <Anchor href={`https://github.com/${saved.login}`} target="_blank" rel="noreferrer" inherit lh="lg" fw={weight.medium} data-inline>
                {saved.login}
              </Anchor>{" "}
              (user id {saved.id})
            </>
          ) : (
            <>user id {saved.id} (login not seen yet)</>
          )}{" "}
          reach a task's worker.
        </Text>
      ) : (
        <Stack gap="2xs" data-slot="comments-status">
          <Text fz="sm" fw={weight.medium}>
            No one's PR comments reach workers yet.
          </Text>
          <Text fz="sm" c="dimmed">
            Set the GitHub user whose comments on a task's PR should reach its worker. It's unset on an organization's repo, and until you set it.
          </Text>
        </Stack>
      )}
      {children}
      {dirty && (
        <Text fz="sm" c="dimmed" data-slot="comments-draft">
          Not saved yet: {ownerPicked ? "comments from the repo's owner, as GitHub names it when you save" : draft?.trim() ? `comments from ${draft.trim()} (looked up on GitHub when you save)` : "no one's comments"}.
        </Text>
      )}
      {owner && owner.id !== saved?.id && owner.login !== draft?.trim() && (
        <Row>
          <Button variant="default" size="xs" onClick={() => onUse(owner.login)}>
            Use the repo owner ({owner.login})
          </Button>
        </Row>
      )}
      {saved && (
        <Notice tone="warning" title="Their credentials can comment as them">
          <Text fz="sm">Anything holding this account's GitHub credentials (a token in an agent's sandbox, a CI secret) can comment as it, and those comments count. Keep its tokens out of agents and CI.</Text>
        </Notice>
      )}
    </FieldGroup>
  );
}
