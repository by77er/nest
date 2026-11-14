// A project's settings: whether ready tasks are assigned automatically, how many workers may run, and
// whether task PRs merge automatically once their review passes (with the repo's setting behind it),
// whether reviews of untrusted PRs wait for the owner (README.md#the-review-gate),
// and whether workers may change CI workflows (README.md#secrets). The Panels sit in one row with Save right under them at the bottom right; on a phone, one column,
// so Save comes right after the last field.

import { MAX_UNTRIAGED_ISSUES } from "../../../issues";
import { issuesFromWho, names } from "../triage/words";
import { Anchor, Badge, Button, NumberInput, Select, Switch, Text, TextInput } from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { Settings as SettingsSchema } from "../../../requests";
import { ApiError } from "../../api/client";
import { useRetryRepoAutoMerge, useSecrets, useUpdateSettings } from "../../api/queries";
import { LiveAgents } from "../project/LiveAgents";
import type { Settings } from "../../api/types";
import { ago, exact } from "../../common/time";
import { FieldGroup, MetaItem, Notice, Panel, Row, Section, SectionGrid, Stack, Toolbar, weight } from "../../layout";
import { MERGE_METHODS, type MergeMethod, type RepoAutoMerge } from "../../../automerge";
import { MODELS, modelLabel, modelProblem } from "../../../models";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { type RefObject, useEffect, useRef, useState } from "react";

const CUSTOM = "custom";

/** A pending switch of the running manager, in words: "Running Fable 5.2; switches to Sonnet 5.5 after this turn." */
export function switchText(s: { from: string | null; to: string; after_turn: boolean }): string {
  const to = modelLabel(s.to);
  const when = s.after_turn ? `switches to ${to} after this turn.` : `switching to ${to}…`;
  return s.from ? `Running ${modelLabel(s.from)}; ${when}` : `${when.charAt(0).toUpperCase()}${when.slice(1)}`;
}

/**
 * A role's model (README.md#models): one of the listed ones, or "Custom" and the id typed. A value that
 * isn't listed shows as Custom with its id.
 */
export function ModelField({ label, description, value, onChange, error }: { label: string; description: string; value: string; onChange: (v: string) => void; error?: React.ReactNode }) {
  const listed = MODELS.some((m) => m.id === value);
  const [custom, setCustom] = useState(!listed);
  const problem = custom ? modelProblem(value) : null;
  return (
    <FieldGroup>
      <Select
        label={label}
        description={description}
        data={[...MODELS.map((m) => ({ value: m.id, label: m.label })), { value: CUSTOM, label: "Custom…" }]}
        allowDeselect={false}
        value={custom ? CUSTOM : value}
        onChange={(v) => {
          if (v === null) return;
          setCustom(v === CUSTOM);
          if (v !== CUSTOM) onChange(v);
        }}
        error={custom ? undefined : error}
      />
      {custom && (
        <TextInput
          label="Model id"
          aria-label={`${label}: model id`}
          description="An id or alias Claude Code's --model takes, such as claude-opus-5-5."
          // The id in the mono face (an identifier, read character by character); its label and help stay as they are.
          styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value.trim())}
          error={value && problem ? `A model id is ${problem}` : error}
        />
      )}
    </FieldGroup>
  );
}

const METHOD_LABEL: Record<MergeMethod, string> = { squash: "Squash and merge", merge: "Merge commit", rebase: "Rebase and merge" };

const values = (s: Settings) => ({
  auto_assign: s.auto_assign, max_workers: s.max_workers, auto_merge: s.auto_merge, merge_method: s.merge_method, workers_edit_workflows: s.workers_edit_workflows,
  manager_model: s.manager_model, worker_model: s.worker_model, issues_from: s.issues_from,
  comments_from_login: s.comments_from?.login ?? null,
  // "Use the repo owner": the server takes the repo's owner by id, never this login.
  comments_from_repo_owner: false,
});

/** The editable settings as Panels in a row, saved together by the one Save right under them. */
/**
 * Arriving at a Panel by its `#id` (the Triage page's Open Settings, Needs you's Choose someone…): focus moves
 * to its heading (`targets`, given to its Section as `headingRef`, so it takes the theme's ring), so keyboard
 * and screen-reader users land there too; and the Panel is scrolled to the top of the view once the router's
 * own scroll restoration is done (two frames on), since focusing alone leaves a page opened at its top.
 */
function useFocusLinkTarget(targets: Record<string, RefObject<HTMLHeadingElement | null>>) {
  const hash = useLocation({ select: (l) => l.hash });
  const navigate = useNavigate();
  useEffect(() => {
    if (!hash) return;
    const heading = targets[hash]?.current;
    const panel = document.getElementById(hash);
    if (!heading || !panel) return;
    heading.focus({ preventScroll: true });
    // Not cancelled when the hash leaves the URL (below), which re-runs this effect; the Panel looked up again then.
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView?.({ block: "start" })));
    // Once per arrival: the hash leaves the URL, so a remount of the form (a Save of some settings) doesn't
    // move focus there again.
    void navigate({ to: ".", hash: "", replace: true });
    // `targets` holds refs: stable.
  }, [hash, navigate]);
}

export function SettingsForm({ projectId, settings, onDone }: { projectId: string; settings: Settings; onDone?: () => void }) {
  const prCommentsHeading = useRef<HTMLHeadingElement>(null);
  const triageHeading = useRef<HTMLHeadingElement>(null);
  useFocusLinkTarget({ "pr-comments": prCommentsHeading, triage: triageHeading });
  const update = useUpdateSettings(projectId);
  const form = useForm({
    initialValues: values(settings),
    validate: schemaResolver(SettingsSchema, { sync: true }),
  });
  // The review gate (README.md#the-review-gate): held unless the project opted out. Sent only when changed.
  const held = settings.untrusted_reviews !== "review";
  const [hold, setHold] = useState(held);
  // Who "you" is for issues, as saved (README.md#triage).
  const who = issuesFromWho(settings);

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
            <Section title="Models" order={4} region={false}>
              <FieldGroup>
                <ModelField
                  label="Manager's model"
                  description="A change applies now: the running manager switches between turns, keeping its conversation."
                  value={form.getValues().manager_model}
                  onChange={(v) => form.setFieldValue("manager_model", v)}
                  error={form.errors.manager_model}
                />
                {settings.manager_switch && (
                  <Text fz="sm" c="dimmed" data-slot="manager-switch" role="status">
                    {switchText(settings.manager_switch)}
                  </Text>
                )}
                {settings.manager_switch_given_up === form.getValues().manager_model && (
                  <Text fz="sm" c="dimmed" data-slot="manager-switch" role="status">
                    Couldn&apos;t switch the running manager: takes effect when it next starts.
                  </Text>
                )}
                <ModelField
                  label="Workers' model"
                  description="A change applies to workers started from now on; running ones keep theirs."
                  value={form.getValues().worker_model}
                  onChange={(v) => form.setFieldValue("worker_model", v)}
                  error={form.errors.worker_model}
                />
                <Text fz="sm" c="dimmed">
                  Reviewers and routine runs keep nest&apos;s default model.
                </Text>
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
          <Panel id="pr-comments">
            <Section title="PR comments" order={4} region={false} headingRef={prCommentsHeading}>
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
          {/* The Triage page's "No one's issues come in yet" links here. */}
          <Panel id="triage">
            <Section title="Triage" order={4} region={false} headingRef={triageHeading}>
              <FieldGroup>
                <Select
                  label="Issues from"
                  description="Which GitHub issues come into Triage, by who opened them: the PR comments user and the repo's owner (by GitHub id), or anyone."
                  data={[{ value: "trusted", label: who.length ? `You only (${names(who)})` : "You only (no one yet)" }, { value: "anyone", label: "Anyone" }]}
                  allowDeselect={false}
                  {...form.getInputProps("issues_from")}
                />
                {!who.length && form.getValues().issues_from === "trusted" && (
                  <Text fz="sm" c="warning" data-tone="warning" data-slot="issues-no-one">
                    No one yet: set the PR comments user, or choose Anyone.
                  </Text>
                )}
                <Text fz="sm" c="dimmed">
                  Issues already waiting stay until you accept or decline them. At most {MAX_UNTRIAGED_ISSUES} wait at once.
                </Text>
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
 * "Workers may change CI workflows" (README.md#secrets): off by default; on, the project's push token gets
 * `workflows: write`, which the GitHub App's installation must grant, live workers' too (they share the
 * token), each shown with whether it has it. With the security note: a pushed workflow runs with the repo's
 * Actions secrets before anyone reviews it.
 */
function WorkflowsSetting({ projectId, checked, onChange, error }: { projectId: string; checked?: boolean; onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void; error?: React.ReactNode }) {
  const secrets = useSecrets(projectId);
  const refused = secrets.data?.workflows_refused ?? null;
  return (
    <Stack gap="sm">
      <Switch
        label="Workers may change CI workflows"
        description={
          <>
            Their pushes may add or change files under .github/workflows/; off, GitHub refuses those pushes. The GitHub App's installation must grant workflows: write. Saved, it reaches live workers in a moment too.
            {/* Part of the description, so it reads as one: its size and line height. */}
            {checked && refused && (
              <Text component="span" inherit display="block" mt="xs" c="warning" data-slot="workflows-refused">
                Not in effect: {refused}. Give the GitHub App Workflows: read and write in its settings if it lacks it, then accept it in its installation settings on GitHub; the app asks for it again at the next token.
              </Text>
            )}
          </>
        }
        checked={checked}
        onChange={onChange}
        error={error}
      />
      {checked && (
        <Notice tone="warning" title="A pushed workflow runs before anyone reviews it">
          <Text fz="sm" lh="lg">
            It runs with the repo's Actions secrets as soon as it's pushed. Keep CI secrets in an environment with required reviewers, so a job that reads them waits for a person.{" "}
            <Anchor href="https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment" target="_blank" rel="noreferrer" inherit c="bright" underline="always" lh="lg" data-inline>
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
  const refused = saved ? (secrets.data?.workflows_refused ?? null) : null;
  if (!workers.length) return null;
  // A token that disagrees with the saved setting is out of date, whatever its layer's last state: never Applied.
  // One the App's installation refuses won't catch up by waiting: Failed, with why, whatever its layer's state (its
  // own error line kept).
  const shown = workers.map((a) => (can.has(a.agent) === saved ? a
    : refused ? { ...a, state: "failed" as const }
    : a.state === "applied" ? { ...a, state: "pending" as const } : a));
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
            const why = refused ?? (saved && !allowed ? "nest's grant doesn't allow it" : "until it catches up");
            return (
              <Text component="span" fz="xs" c="warning" data-slot="workflows" data-matches="false">
                {has ? "Still may change workflows" : refused ? "Can't change workflows" : "Can't change workflows yet"} · {why}
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
