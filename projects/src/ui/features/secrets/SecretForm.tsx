// Adding or editing a secret (README.md#secrets), in a Sheet: a service preset (its hosts, how the value
// is sent and the variable its tools read), the name, the variable, a description, the value (masked and
// write-once: it goes to nest when saved and is never shown again; an edit replaces it only through "Set
// a new value"), the hosts, the format and the roles. Checked as nest and the grant will, before it's sent.

import { Button, Checkbox, PasswordInput, Select, TagsInput, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { envName, SECRET_PRESETS, type SecretGrant, type SecretLocation, secretProblems, type SecretRole, valueProblem } from "../../../secrets";
import { ApiError } from "../../api/client";
import { usePutSecret } from "../../api/queries";
import type { SecretView } from "../../api/types";
import { FieldGroup, Notice, Row, Stack } from "../../layout";

type Format = "authorization_bearer" | "authorization_basic_password" | "header";

const FORMATS: { value: Format; label: string }[] = [
  { value: "authorization_bearer", label: "Authorization: Bearer" },
  { value: "authorization_basic_password", label: "Basic auth password" },
  { value: "header", label: "A header of its own" },
];
const ROLES: { value: SecretRole; label: string }[] = [
  { value: "worker", label: "Workers" },
  { value: "manager", label: "The manager" },
  { value: "reviewer", label: "Reviewers" },
];

/** Which preset a secret's hosts and format match, if any. */
const presetOf = (hosts: string[], loc: SecretLocation | undefined) =>
  SECRET_PRESETS.find((p) => p.value !== "custom" && p.hosts.join() === hosts.join() && p.location.type === loc?.type)?.value ?? "custom";

export interface SecretFormProps {
  projectId: string;
  grant: SecretGrant | null;
  /** The secret edited; absent for a new one. */
  editing?: SecretView;
  /** A new one's start: an agent's request (its name, and the hosts it asked for). */
  initial?: { name?: string; hosts?: string[] };
  /** The variables the project's other secrets use. */
  takenEnv?: string[];
  onDone: () => void;
}

export function SecretForm({ projectId, grant, editing, initial, takenEnv = [], onDone }: SecretFormProps) {
  const save = usePutSecret(projectId);
  const first = editing?.locations[0];
  const [preset, setPreset] = useState<string>(editing ? presetOf(editing.hosts, first) : initial?.hosts?.length ? "custom" : "cloudflare");
  const start = SECRET_PRESETS.find((p) => p.value === preset)!;
  const [name, setName] = useState(editing?.name ?? initial?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState(!editing);
  const [hosts, setHosts] = useState<string[]>(editing?.hosts ?? initial?.hosts ?? [...start.hosts]);
  const [format, setFormat] = useState<Format>(first?.type ?? start.location.type);
  const [header, setHeader] = useState(first?.type === "header" ? first.name : "");
  const [roles, setRoles] = useState<SecretRole[]>(editing?.roles ?? ["worker"]);
  // The variable follows the service picked (not a later edit of its hosts), else the name, until it's typed in.
  const [envTyped, setEnvTyped] = useState<string | null>(editing?.env ?? null);
  const [suggested, setSuggested] = useState<string | null>(start.env);
  const env = envTyped ?? suggested ?? envName(name);
  const [tried, setTried] = useState(false);

  const location: SecretLocation = format === "header" ? { type: "header", name: header.trim() } : { type: format };
  const problems: Record<string, string> = { ...secretProblems({ name, hosts, locations: [location], roles, env }, grant, takenEnv), ...(replacing ? (valueProblem(value, grant) ? { value: valueProblem(value, grant)! } : {}) : {}) };
  const server = ((save.error instanceof ApiError ? save.error.body : null) as { problems?: Record<string, string> } | null)?.problems ?? {};
  const shown = (k: string) => (tried ? problems[k] : undefined) ?? server[k];
  const note = SECRET_PRESETS.find((p) => p.value === preset)?.note;

  const pickPreset = (v: string | null) => {
    if (!v) return;
    setPreset(v);
    const p = SECRET_PRESETS.find((x) => x.value === v)!;
    setSuggested(p.env);
    if (p.value !== "custom") {
      setHosts([...p.hosts]);
      setFormat(p.location.type);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (Object.keys(problems).length) return;
        save.mutate(
          { name, body: { ...(replacing ? { value } : {}), description: description.trim(), hosts, locations: [location], roles, env } },
          // The value leaves the page with the request: nothing keeps it.
          { onSuccess: () => { setValue(""); onDone(); } },
        );
      }}
    >
      <FieldGroup
        actions={
          <>
            <Button variant="default" onClick={onDone}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {editing ? "Save" : "Add the secret"}
            </Button>
          </>
        }
      >
        <Select label="Service" data={SECRET_PRESETS.map((p) => ({ value: p.value, label: p.label }))} value={preset} onChange={pickPreset} allowDeselect={false} />
        {note && (
          <Notice tone={preset === "github" ? "warning" : "info"}>
            <Text fz="sm">{note}</Text>
          </Notice>
        )}
        <TextInput
          label="Name"
          description="Lowercase, like cloudflare_api_token: the app's name for it."
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          disabled={!!editing}
          error={shown("name")}
          required
        />
        <TextInput
          label="Variable"
          description="The environment variable that holds its placeholder in agents' sandboxes, as their tools expect it."
          value={env}
          onChange={(e) => setEnvTyped(e.currentTarget.value.trim())}
          error={shown("env")}
          required
        />
        <TextInput label="Description" description="What it's for: agents read this in their brief." value={description} onChange={(e) => setDescription(e.currentTarget.value)} maxLength={200} />
        {replacing ? (
          <PasswordInput
            label={editing ? "New value" : "Value"}
            description="Sent to nest when you save; never stored by the app, and never shown again."
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            autoComplete="new-password"
            data-1p-ignore
            error={shown("value")}
            required
          />
        ) : (
          <Stack gap="xs">
            <Text fz="sm" fw="medium">
              Value
            </Text>
            <Text fz="sm" c="dimmed">
              Set{editing?.size ? `, ${editing.size} bytes` : ""}. It can't be read back, only replaced.
            </Text>
            <Row>
              <Button variant="default" size="xs" onClick={() => setReplacing(true)}>
                Set a new value
              </Button>
            </Row>
          </Stack>
        )}
        <TagsInput
          label="Hosts"
          description={grant ? `The app may inject into: ${grant.inject_hosts.join(", ") || "none"}. Another needs the operator to widen the grant.` : "Exact names, or *. and a domain."}
          value={hosts}
          onChange={(v) => {
            setHosts(v.map((h) => h.trim().toLowerCase()).filter(Boolean));
            setPreset("custom");
          }}
          maxTags={16}
          error={shown("hosts")}
          clearable
        />
        <Select label="Sent as" data={FORMATS} value={format} onChange={(v) => v && setFormat(v as Format)} allowDeselect={false} />
        {format === "header" && <TextInput label="Header name" value={header} onChange={(e) => setHeader(e.currentTarget.value)} placeholder="X-Api-Key" error={shown("locations")} />}
        <Checkbox.Group label="Given to" description="Live workers and the manager get it in a moment; reviewers at their next start." value={roles} onChange={(v) => setRoles(v as SecretRole[])} error={shown("roles")}>
          <Stack gap="xs">
            {ROLES.map((r) => (
              <Checkbox key={r.value} value={r.value} label={r.label} />
            ))}
          </Stack>
        </Checkbox.Group>
        {save.isError && !Object.keys(server).length && (
          <Notice tone="danger" title="It wasn't saved">
            {save.error.message}
          </Notice>
        )}
      </FieldGroup>
    </form>
  );
}
