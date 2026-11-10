// A project's network (README.md#network): per role, the hosts its agents' sandboxes may reach on top
// of the operator's policy, from presets or typed in, each checked against the grant's egress_hosts as
// it's added (outside it: the operator must add it). Saved, the rules reach new agents at their
// sandbox's create and live ones through their sandbox's client layer, each shown applied, pending or
// failed. The operator's base rules are shown read-only.
//
// A host the operator has since taken out of the grant stays in the rules, marked "outside the grant"
// and not applied, so the owner can still save other changes. A rule nest's defaults already cover says
// so. Removing a host by keyboard leaves focus on the next row's Remove (or the Add select). A refused
// save says why under Save, the named host's row in the danger shade.

import { ActionIcon, Button, Select, Text, TextInput, useMantineTheme } from "@mantine/core";
import { IconPlus, IconWorld, IconX } from "@tabler/icons-react";
import { useParams } from "@tanstack/react-router";
import { useMediaQuery } from "@mantine/hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { hostAllowed, NETWORK_PRESETS, NETWORK_ROLES, type NetworkRole, normalizeRules, type OperatorRule, OUTSIDE, rulesProblems } from "../../../network";
import { ApiError } from "../../api/client";
import { useNetwork, useSetNetwork } from "../../api/queries";
import type { EgressRule, LayerStatus, NetworkView, RoleRules } from "../../api/types";
import { ErrorState, icon, LoadingState, Measure, MetaItem, MetaRow, Panel, Row, Section, SectionGrid, Stack, Toolbar, weight } from "../../layout";
import { LiveAgents } from "../project/LiveAgents";
import { FailedStops } from "./FailedStops";
import { ProjectFrame } from "../project/ProjectFrame";

const ROLE: Record<NetworkRole, { title: string; description: string }> = {
  worker: { title: "Workers", description: "Every task's worker: what it installs and downloads while it builds and tests." },
  manager: { title: "Manager", description: "The project's manager, which reads the repo and specs tasks." },
};
const portsText = (r: EgressRule) => (r.ports ? `ports ${r.ports.join(", ")}` : "ports 80, 443");

/** "443, 8443" as ports, or the reason it isn't. Empty: the web ports. */
function parsePorts(s: string): { ok: true; ports?: number[] } | { ok: false; error: string } {
  const t = s.trim();
  if (!t) return { ok: true };
  const parts = t.split(/[\s,]+/).filter(Boolean);
  const ports = parts.map(Number);
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65_535)) return { ok: false, error: "Ports are whole numbers, 1 to 65535" };
  return { ok: true, ports };
}

/** Whether nest's defaults (or the operator's rules) already let a rule's host through on its ports. */
function coveredBy(r: EgressRule, base: OperatorRule[] | null): boolean {
  const ports = r.ports ?? [80, 443];
  return !!base?.some((b) => hostAllowed(r.host, [b.host]) && ports.every((p) => b.ports.includes(p)));
}

function RoleRulesEditor({ role, rules, stored, egressHosts, base, refused, onChange }: {
  role: NetworkRole; rules: EgressRule[];
  /** The role's rules as saved: a host among them that's since gone from the grant is kept, not refused. */
  stored: EgressRule[];
  egressHosts: string[] | null; base: OperatorRule[] | null;
  /** The last save's refusals, by host. */
  refused: Record<string, string>;
  onChange: (r: EgressRule[]) => void;
}) {
  const [preset, setPreset] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [ports, setPorts] = useState("");
  const [error, setError] = useState<string | null>(null);
  const problems = rulesProblems(rules, egressHosts);
  const kept = new Set(stored.map((r) => r.host));
  // Host, Ports and Add on one row from `sm` up.
  const wide = useMediaQuery(`(min-width: ${useMantineTheme().breakpoints.sm})`);
  // Focus after a Remove: the next row's Remove, else the previous one's, else the Add select.
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const addSelect = useRef<HTMLInputElement>(null);
  const [focusAfter, setFocusAfter] = useState<{ host: string | null } | null>(null);
  useEffect(() => {
    if (!focusAfter) return;
    (focusAfter.host ? removeButtons.current.get(focusAfter.host) : addSelect.current)?.focus();
    setFocusAfter(null);
  }, [focusAfter]);
  const remove = (i: number) => {
    const next = rules.filter((_, k) => k !== i);
    onChange(next);
    setFocusAfter({ host: (next[i] ?? next[i - 1])?.host ?? null });
  };
  const add = (next: EgressRule[]) => {
    const have = new Set(rules.map((r) => r.host));
    const fresh = normalizeRules(next).filter((r) => !have.has(r.host));
    const why = Object.values(rulesProblems(fresh, egressHosts))[0];
    if (why) {
      setError(why);
      return false;
    }
    setError(null);
    onChange([...rules, ...fresh]);
    return true;
  };
  const addPicked = () => {
    if (preset && preset !== "custom") {
      const p = NETWORK_PRESETS.find((x) => x.value === preset)!;
      if (add(p.hosts.map((h) => ({ host: h })))) setPreset(null);
      return;
    }
    const parsed = parsePorts(ports);
    if (!parsed.ok) return setError(parsed.error);
    if (add([{ host, ...(parsed.ports ? { ports: parsed.ports } : {}) }])) {
      setHost("");
      setPorts("");
    }
  };
  const custom = preset === "custom";
  return (
    <Panel data-role={role}>
      <Section title={ROLE[role].title} order={4} count={rules.length} region={false}>
        <Stack gap="md">
          <Text fz="sm" c="dimmed">
            {ROLE[role].description}
          </Text>
          {rules.length === 0 ? (
            <Text fz="sm" c="dimmed" data-slot="none">
              No hosts beyond the operator&apos;s policy.
            </Text>
          ) : (
            <Stack gap="xs" role="list" aria-label={`${ROLE[role].title}' hosts`} data-slot="rules">
              {rules.map((r, i) => {
                const why = refused[r.host] ?? problems[r.host];
                // Saved before the operator narrowed the grant: kept, not applied (not an error to fix first).
                const revoked = !refused[r.host] && why?.endsWith(OUTSIDE) && kept.has(r.host);
                const note = revoked
                  ? "Outside the grant now: kept, not applied until the operator adds it again"
                  : why ?? (coveredBy(r, base) ? `${portsText(r)} · already allowed by the operator's policy` : portsText(r));
                return (
                  <Row key={r.host} role="listitem" justify="space-between" wrap="nowrap" tabIndex={-1} data-host={r.host} data-problem={why && !revoked ? "true" : undefined}>
                    <Stack gap="2xs">
                      <Text fz="sm" ff="monospace" c={why && !revoked ? "danger" : undefined}>
                        {r.host}
                      </Text>
                      <Text fz="xs" c={why && !revoked ? "danger" : revoked ? "warning" : "dimmed"}>
                        {note}
                      </Text>
                    </Stack>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label={`Remove ${r.host}`}
                      ref={(el) => {
                        if (el) removeButtons.current.set(r.host, el);
                        else removeButtons.current.delete(r.host);
                      }}
                      onClick={() => remove(i)}
                    >
                      <IconX size={icon.md} />
                    </ActionIcon>
                  </Row>
                );
              })}
            </Stack>
          )}
          {/* The picker on its row (with Add, for a preset); a custom host's Host, Ports and Add on one row
              from `sm` up. */}
          <Row gap="sm" align="flex-end" wrap="nowrap">
            <Select
              ref={addSelect}
              label="Add hosts"
              placeholder="A preset, or custom"
              data={[...NETWORK_PRESETS.map((p) => ({ value: p.value, label: `${p.label} (${p.hosts.join(", ")})` })), { value: "custom", label: "Custom host" }]}
              value={preset}
              onChange={(v) => {
                setPreset(v);
                setError(null);
              }}
              allowDeselect
              comboboxProps={{ withinPortal: true }}
              flex={1}
            />
            {!custom && (
              <Button variant="default" leftSection={<IconPlus size={icon.sm} />} disabled={!preset || (custom && !host.trim())} onClick={addPicked}>
                Add
              </Button>
            )}
          </Row>
          {custom && (
            <Row gap="sm" align="flex-end" wrap={wide ? "nowrap" : "wrap"}>
              <TextInput label="Host" placeholder="downloads.example.com" value={host} onChange={(e) => setHost(e.currentTarget.value)} flex={1} />
              <TextInput label="Ports" placeholder="Blank: 80, 443" value={ports} onChange={(e) => setPorts(e.currentTarget.value)} />
              <Button variant="default" leftSection={<IconPlus size={icon.sm} />} disabled={!preset || (custom && !host.trim())} onClick={addPicked}>
                Add
              </Button>
            </Row>
          )}
          {error && (
            <Text fz="xs" c="danger" role="alert" data-slot="add-error">
              {error}
            </Text>
          )}
        </Stack>
      </Section>
    </Panel>
  );
}

/**
 * After a failed layer's error, a way to the rule it names: the host's row in its role's list, focused,
 * its tint flashed once, where it can be fixed.
 */
function RuleLink({ error, rules }: { error: string | null; rules: RoleRules }) {
  const host = error ? NETWORK_ROLES.flatMap((role) => rules[role].map((r) => r.host)).find((h) => error.includes(h)) : undefined;
  if (!host) return null;
  // Its own line, a button (a 44 px target on touch), under the error it follows.
  return (
    <div>
      <Button
        variant="subtle"
        size="compact-xs"
        onClick={() => {
          // The row itself (focusable, not in the tab order), its tint flashed once (global.css).
          const row = document.querySelector<HTMLElement>(`[data-host="${CSS.escape(host)}"]`);
          if (!row) return;
          row.scrollIntoView({ block: "center" });
          row.focus();
          row.removeAttribute("data-flash");
          void row.offsetWidth;
          row.setAttribute("data-flash", "");
          window.setTimeout(() => row.removeAttribute("data-flash"), 1000);
        }}
      >
        Go to its rule
      </Button>
    </div>
  );
}

/** What nest's defaults and the operator let every sandbox reach, in a line. */
function defaultsSummary(base: OperatorRule[]): string {
  const n = new Set(base.map((b) => b.host)).size;
  const named = [...new Set(base.filter((b) => b.source === "base").map((b) => b.host))].slice(0, 3);
  return n === 0 ? "Nothing is allowed by default" : `Allowed by default: ${named.join(", ")}${n > named.length ? ` and ${n - named.length} more` : ""} (the operator's policy, below)`;
}

/** A refused save's problems, by role then host (the API's `problems`: `role.host` keys). */
function refusals(e: unknown): Record<NetworkRole, Record<string, string>> {
  const out: Record<NetworkRole, Record<string, string>> = { worker: {}, manager: {} };
  const problems = e instanceof ApiError ? (e.body as { problems?: Record<string, string> } | undefined)?.problems : undefined;
  for (const [k, v] of Object.entries(problems ?? {})) {
    const dot = k.indexOf(".");
    const role = k.slice(0, dot) as NetworkRole;
    if (role in out) out[role][k.slice(dot + 1)] = v;
  }
  return out;
}

function NetworkForm({ projectId, view }: { projectId: string; view: NetworkView }) {
  const save = useSetNetwork(projectId);
  const [draft, setDraft] = useState<RoleRules>(view.rules);
  // A save (or another tab's) that changed the stored rules resets the draft to them.
  // On a new revision only: a poll returns the same rules as new objects, which mustn't undo an edit.
  const rev = view.rev;
  const stored = view.rules;
  useEffect(() => setDraft(stored), [rev]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.rules);
  // Only what the owner adds can be refused: a saved host since gone from the grant is kept.
  const invalid = useMemo(
    () => NETWORK_ROLES.some((r) => {
      const had = new Set(view.rules[r].map((x) => x.host));
      return Object.entries(rulesProblems(draft[r], view.egress_hosts)).some(([host, why]) => !(why.endsWith(OUTSIDE) && had.has(host)));
    }),
    [draft, view.rules, view.egress_hosts],
  );
  const refused = refusals(save.error);
  const pending = view.agents.some((a) => a.state === "pending");
  return (
    <Stack gap="xl">
      <SectionGrid>
        {NETWORK_ROLES.map((role) => (
          <RoleRulesEditor
            key={role}
            role={role}
            rules={draft[role]}
            stored={view.rules[role]}
            egressHosts={view.egress_hosts}
            base={view.base}
            refused={save.isError ? refused[role] : {}}
            onChange={(r) => {
              save.reset();
              setDraft((d) => ({ ...d, [role]: r }));
            }}
          />
        ))}
      </SectionGrid>
      <Stack gap="xs" align="flex-end">
        <Toolbar>
          <Button variant="default" disabled={!dirty || save.isPending} onClick={() => { save.reset(); setDraft(view.rules); }}>
            Discard changes
          </Button>
          <Button disabled={!dirty || invalid} loading={save.isPending} onClick={() => save.mutate(draft)}>
            Save
          </Button>
        </Toolbar>
        {save.isError ? (
          <Text fz="sm" c="danger" role="alert" data-slot="save-error">
            The rules weren&apos;t saved: {save.error.message}
          </Text>
        ) : save.isSuccess && !dirty ? (
          <Text fz="sm" c="dimmed" role="status" data-slot="saved">
            {pending ? "Saved · reaching live agents" : "Saved · every live agent has them"}
          </Text>
        ) : null}
      </Stack>
    </Stack>
  );
}

/** One line of the operator's policy: its rules' hosts, a port shown only where it isn't the web's. */
function PolicyLine({ label, slot, rules }: { label: string; slot: string; rules: OperatorRule[] }) {
  const text = rules.map((r) => (r.ports.every((p) => p === 80 || p === 443) ? r.host : `${r.host}:${r.ports.join(",")}`)).join(", ");
  return (
    <Stack gap="2xs">
      <Text fz="xs" fw={weight.medium}>
        {label}
      </Text>
      <Text fz="sm" ff="monospace" data-slot={slot}>
        {text || "None"}
      </Text>
    </Stack>
  );
}

export function NetworkPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/network" });
  const net = useNetwork(projectId);
  return (
    <ProjectFrame projectId={projectId}>
      {() => (
        <Section title="Network">
          {net.isPending ? (
            <LoadingState label="Loading the network rules" />
          ) : net.isError ? (
            <ErrorState title="The network rules couldn't be loaded" error={net.error} onRetry={() => void net.refetch()} />
          ) : (
            <Stack gap="2xl">
              <FailedStops projectId={projectId} stops={net.data.failed_stops ?? []} />
              <Measure type="reading">
                <Stack gap="md">
                  <Text fz="md">
                    Agents&apos; sandboxes reach only what the operator&apos;s policy allows. Add hosts a role needs (a package registry, a download site) on top
                    of it, within the hosts the operator lets this app open.
                  </Text>
                  <MetaRow>
                    {net.data.base && (
                      <MetaItem icon={IconWorld} title={net.data.base.map((b) => b.host).join(", ")}>
                        {defaultsSummary(net.data.base)}
                      </MetaItem>
                    )}
                    <MetaItem icon={IconWorld}>
                      {net.data.egress_hosts === null
                        ? "The grant couldn't be read"
                        : net.data.egress_hosts.length
                          ? `This app may open ${net.data.egress_hosts.join(", ")}`
                          : "This app may open no hosts yet: the operator sets the grant's egress_hosts"}
                    </MetaItem>
                  </MetaRow>
                </Stack>
              </Measure>
              <NetworkForm projectId={projectId} view={net.data} />
              <SectionGrid>
                <Panel data-slot="policy">
                  <Section title="The operator's policy" order={4} region={false}>
                    {net.data.base === null ? (
                      <Text fz="sm" c="dimmed">
                        Shown once the manager&apos;s sandbox runs.
                      </Text>
                    ) : (
                      <Stack gap="sm">
                        <Text fz="sm" c="dimmed">
                          Always allowed, for every role.
                        </Text>
                        <PolicyLine label="nest's defaults" slot="base" rules={net.data.base.filter((r) => r.source === "base")} />
                        <PolicyLine label="The operator's rules" slot="operator" rules={net.data.base.filter((r) => r.source === "operator")} />
                        {net.data.base.some((r) => r.source === "repos") && (
                          <PolicyLine label="The operator's rules, from its repo allowlists" slot="repos" rules={net.data.base.filter((r) => r.source === "repos")} />
                        )}
                      </Stack>
                    )}
                  </Section>
                </Panel>
                <Panel data-slot="live-agents">
                  <Section title="Live agents" order={4} count={net.data.agents.length} region={false}>
                    <LiveAgents
                      framed={false}
                      agents={net.data.agents}
                      label="Live agents' network"
                      empty="No live agents. New ones get these rules when their sandbox is made."
                      onError={(a) => <RuleLink error={a.error} rules={net.data.rules} />}
                    />
                  </Section>
                </Panel>
              </SectionGrid>
            </Stack>
          )}
        </Section>
      )}
    </ProjectFrame>
  );
}
