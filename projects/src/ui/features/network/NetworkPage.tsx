// A project's network (README.md#network): per role, the hosts its agents' sandboxes may reach on top
// of the operator's policy, from presets or typed in, each checked against the grant's egress_hosts as
// it's added (outside it: the operator must widen the grant). Saved, the rules reach new agents at their
// sandbox's create and live ones through their sandbox's client layer, each shown applied, pending or
// failed. The operator's base rules are shown read-only.

import { ActionIcon, Badge, Button, Select, Text, TextInput } from "@mantine/core";
import { IconPlus, IconWorld, IconX } from "@tabler/icons-react";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { NETWORK_PRESETS, NETWORK_ROLES, type NetworkRole, normalizeRules, rulesProblems } from "../../../network";
import { useNetwork, useSetNetwork } from "../../api/queries";
import type { EgressRule, LayerStatus, NetworkView, RoleRules } from "../../api/types";
import { ago, exact } from "../../common/time";
import { ErrorState, icon, LoadingState, MetaItem, MetaRow, Panel, Row, Section, Stack, Toolbar } from "../../layout";
import { ProjectFrame } from "../project/ProjectFrame";

const ROLE: Record<NetworkRole, { title: string; description: string }> = {
  worker: { title: "Workers", description: "Every task's worker: what it installs and downloads while it builds and tests." },
  manager: { title: "Manager", description: "The project's manager, which reads the repo and specs tasks." },
};
const STATE: Record<LayerStatus["state"], { label: string; color: "success" | "warning" | "danger" }> = {
  applied: { label: "Applied", color: "success" },
  pending: { label: "Pending", color: "warning" },
  failed: { label: "Failed", color: "danger" },
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

function RoleRulesEditor({ role, rules, egressHosts, onChange }: { role: NetworkRole; rules: EgressRule[]; egressHosts: string[] | null; onChange: (r: EgressRule[]) => void }) {
  const [preset, setPreset] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [ports, setPorts] = useState("");
  const [error, setError] = useState<string | null>(null);
  const problems = rulesProblems(rules, egressHosts);
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
      <Section title={ROLE[role].title} dense count={rules.length} region={false}>
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
              {rules.map((r) => (
                <Row key={r.host} role="listitem" justify="space-between" wrap="nowrap" data-host={r.host}>
                  <Stack gap="2xs">
                    <Text fz="sm" ff="monospace">
                      {r.host}
                    </Text>
                    <Text fz="xs" c={problems[r.host] ? "danger" : "dimmed"}>
                      {problems[r.host] ?? portsText(r)}
                    </Text>
                  </Stack>
                  <ActionIcon variant="subtle" color="gray" aria-label={`Remove ${r.host}`} onClick={() => onChange(rules.filter((x) => x.host !== r.host))}>
                    <IconX size={icon.md} />
                  </ActionIcon>
                </Row>
              ))}
            </Stack>
          )}
          <Row gap="sm" align="flex-end">
            <Select
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
            />
            {custom && (
              <>
                <TextInput label="Host" placeholder="downloads.example.com" value={host} onChange={(e) => setHost(e.currentTarget.value)} />
                <TextInput label="Ports" description="Blank: 80 and 443" placeholder="443" value={ports} onChange={(e) => setPorts(e.currentTarget.value)} />
              </>
            )}
            <Button variant="default" leftSection={<IconPlus size={icon.sm} />} disabled={!preset || (custom && !host.trim())} onClick={addPicked}>
              Add
            </Button>
          </Row>
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

function LiveAgents({ agents }: { agents: LayerStatus[] }) {
  if (agents.length === 0) {
    return (
      <Text fz="sm" c="dimmed">
        No live agents. New ones get these rules when their sandbox is made.
      </Text>
    );
  }
  return (
    <Panel dense>
      <Stack gap="md" role="list" aria-label="Live agents' network">
        {agents.map((a) => (
          <Row key={a.agent} role="listitem" justify="space-between" align="flex-start" wrap="nowrap" data-agent={a.agent}>
            <Stack gap="2xs">
              <Text fz="sm" ff="monospace">
                {a.agent}
              </Text>
              <Text fz="xs" c="dimmed" title={a.at_ms ? exact(a.at_ms) : undefined}>
                {a.role === "worker" ? "Worker" : "Manager"}
                {a.at_ms ? ` · updated ${ago(a.at_ms)}` : ""}
              </Text>
              {a.error && (
                <Text fz="xs" c={a.state === "failed" ? "danger" : "dimmed"}>
                  {a.error}
                </Text>
              )}
            </Stack>
            <Badge variant="light" color={STATE[a.state].color} data-slot="state">
              {STATE[a.state].label}
            </Badge>
          </Row>
        ))}
      </Stack>
    </Panel>
  );
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
  const invalid = useMemo(() => NETWORK_ROLES.some((r) => Object.keys(rulesProblems(draft[r], view.egress_hosts)).length > 0), [draft, view.egress_hosts]);
  return (
    <Stack gap="2xl">
      {NETWORK_ROLES.map((role) => (
        <RoleRulesEditor key={role} role={role} rules={draft[role]} egressHosts={view.egress_hosts} onChange={(r) => setDraft((d) => ({ ...d, [role]: r }))} />
      ))}
      <Toolbar>
        <Button variant="default" disabled={!dirty || save.isPending} onClick={() => setDraft(view.rules)}>
          Discard changes
        </Button>
        <Button disabled={!dirty || invalid} loading={save.isPending} onClick={() => save.mutate(draft)}>
          Save
        </Button>
      </Toolbar>
    </Stack>
  );
}

export function NetworkPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/network" });
  const net = useNetwork(projectId);
  return (
    <ProjectFrame projectId={projectId} measure="form">
      {() => (
        <Section title="Network">
          {net.isPending ? (
            <LoadingState label="Loading the network rules" />
          ) : net.isError ? (
            <ErrorState title="The network rules couldn't be loaded" error={net.error} onRetry={() => void net.refetch()} />
          ) : (
            <Stack gap="2xl">
              <Stack gap="md">
                <Text fz="md">
                  Agents&apos; sandboxes reach only what the operator&apos;s policy allows. Add hosts a role needs (a package registry, a download site) on top
                  of it, within the hosts the operator lets this app open.
                </Text>
                <MetaRow>
                  <MetaItem icon={IconWorld}>
                    {net.data.egress_hosts === null
                      ? "The grant couldn't be read"
                      : net.data.egress_hosts.length
                        ? `This app may open ${net.data.egress_hosts.join(", ")}`
                        : "This app may open no hosts yet: the operator sets the grant's egress_hosts"}
                  </MetaItem>
                </MetaRow>
              </Stack>
              <NetworkForm projectId={projectId} view={net.data} />
              <Section title="The operator's policy" dense region={false}>
                {net.data.base === null ? (
                  <Text fz="sm" c="dimmed">
                    Shown once the manager&apos;s sandbox runs.
                  </Text>
                ) : (
                  <Panel dense>
                    <Stack gap="xs">
                      <Text fz="sm" c="dimmed">
                        Always allowed, for every role, set by the operator.
                      </Text>
                      <Text fz="sm" ff="monospace" data-slot="base">
                        {net.data.base.map((r) => r.host).join(", ") || "No hosts"}
                      </Text>
                    </Stack>
                  </Panel>
                )}
              </Section>
              <Section title="Live agents" dense count={net.data.agents.length} region={false}>
                <LiveAgents agents={net.data.agents} />
              </Section>
            </Stack>
          )}
        </Section>
      )}
    </ProjectFrame>
  );
}
