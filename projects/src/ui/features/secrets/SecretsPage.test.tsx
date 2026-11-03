// The Secrets page (README.md#secrets): the table of what the app keeps (never a value); the form, whose
// value is masked and write-once and whose variable follows the service, checked against nest's rules and
// the grant before it's sent; live agents' layers; deleting names who loses it; agents' requests in
// "Needs you"; the workflows setting's note and grant.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

const now = Date.now();
const secret = (o: Record<string, unknown> = {}) => ({
  name: "npm_token", description: "npm publish", hosts: ["registry.npmjs.org"], locations: [{ type: "authorization_bearer" as const }], roles: ["worker" as const], env: "NPM_TOKEN",
  size: 36, created_ms: now - 86_400_000, updated_ms: now - 3_600_000, holders: [{ agent: "agt_w1", role: "worker" }], last_injected_ms: now - 60_000, in_nest: true, ...o,
});
/** Mantine's Select labels its input and its hidden value field: the input is the one shown. */
const service = (d: HTMLElement) => within(d).getAllByLabelText("Service").find((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type !== "hidden")!;
const sheet = () => screen.getByRole("dialog", { name: /secret|Edit/ });

describe("the Secrets page", () => {
  it("lists each secret's name, hosts, format, roles and times, never a value", async () => {
    const api = new FakeApi();
    api.secrets = [secret()];
    renderApp("/projects/prj_one/secrets", api);
    const row = (await screen.findByText("npm_token")).closest("[data-secret]") as HTMLElement;
    for (const t of ["$NPM_TOKEN", "npm publish", "registry.npmjs.org", "Bearer", "Workers", "1 hour ago", "1 minute ago"]) expect(row).toHaveTextContent(t);
    expect(screen.getByText(/0 of 10 secrets used/)).toBeInTheDocument();
  });

  it("adds one from a preset: the value masked and sent once, with its hosts, format and roles", async () => {
    const api = new FakeApi();
    const { user } = renderApp("/projects/prj_one/secrets", api);
    await user.click(await screen.findByRole("button", { name: "Add the first secret" }));
    const d = sheet();
    // Cloudflare is the first preset: its host, bearer and the variable its tools read.
    expect(within(d).getByText("api.cloudflare.com")).toBeInTheDocument();
    await user.type(within(d).getByLabelText(/^Name/), "cf_token");
    expect(within(d).getByLabelText(/^Variable/)).toHaveValue("CLOUDFLARE_API_TOKEN");
    const value = within(d).getByLabelText(/^Value/);
    expect(value).toHaveAttribute("type", "password");
    await user.type(value, "s3cr3t-value");
    await user.click(within(d).getByRole("button", { name: "Add the secret" }));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    expect(api.writes[0]).toEqual({
      method: "PUT", path: "/api/projects/prj_one/secrets/cf_token",
      body: { value: "s3cr3t-value", description: "", hosts: ["api.cloudflare.com"], locations: [{ type: "authorization_bearer" }], roles: ["worker"], env: "CLOUDFLARE_API_TOKEN" },
    });
  });

  it("a custom secret's variable follows its name until typed; one nest sets, or another secret's, is refused", async () => {
    const api = new FakeApi();
    api.secrets = [secret()];
    const { user } = renderApp("/projects/prj_one/secrets", api);
    await user.click(await screen.findByRole("button", { name: "Add a secret" }));
    const d = sheet();
    await user.click(service(d));
    await user.click(await screen.findByRole("option", { name: "Custom" }));
    await user.type(within(d).getByLabelText(/^Name/), "cf_token");
    const variable = within(d).getByLabelText(/^Variable/);
    expect(variable).toHaveValue("CF_TOKEN");
    await user.type(within(d).getByLabelText(/^Value/), "v");
    await user.type(within(d).getAllByLabelText(/^Hosts/).find((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type !== "hidden")!, "api.cloudflare.com{enter}");
    for (const [typed, problem] of [["NPM_TOKEN", "Another secret uses NPM_TOKEN"], ["GITHUB_TOKEN", "GITHUB_TOKEN is set by nest or the sandbox"], ["NEST_X", "NEST_X is set by nest or the sandbox"]] as const) {
      await user.clear(variable);
      await user.type(variable, typed);
      await user.click(within(d).getByRole("button", { name: "Add the secret" }));
      expect(await within(d).findByText(problem)).toBeInTheDocument();
    }
    expect(api.writes).toEqual([]);
    await user.clear(variable);
    await user.type(variable, "CF_API");
    await user.click(within(d).getByRole("button", { name: "Add the secret" }));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    expect((api.writes[0]!.body as { env: string }).env).toBe("CF_API");
  });

  it("shows each live agent's layer, with the variables it has, and a save makes them pending", async () => {
    const api = new FakeApi();
    api.secrets = [secret()];
    api.network = { ...api.network, agents: [
      { agent: "agt_w1", role: "worker", sandbox: "sbx_1", state: "applied", error: null, rev: 1, at_ms: now - 60_000 },
      { agent: "agt_m", role: "manager", sandbox: "sbx_2", state: "failed", error: "inject hosts outside the grant", rev: 0, at_ms: now - 60_000 },
    ] };
    const { user } = renderApp("/projects/prj_one/secrets", api);
    const list = await screen.findByRole("list", { name: "Live agents' secrets" });
    const w = within(list).getByText("agt_w1").closest("[data-agent]") as HTMLElement;
    expect(w).toHaveTextContent("Has $NPM_TOKEN");
    expect(w.querySelector("[data-slot=state]")).toHaveTextContent("Applied");
    const m = within(list).getByText("agt_m").closest("[data-agent]") as HTMLElement;
    expect(m).toHaveTextContent("Has none");
    expect(m).toHaveTextContent("inject hosts outside the grant");
    expect(m.querySelector("[data-slot=state]")).toHaveTextContent("Failed");
    await user.click(screen.getByRole("button", { name: "Edit npm_token" }));
    await user.click(within(sheet()).getByLabelText("The manager"));
    await user.click(within(sheet()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Live agents' secrets" })).getAllByText("Pending")).toHaveLength(2));
  });

  it("an edit sends no value unless a new one is set", async () => {
    const api = new FakeApi();
    api.secrets = [secret()];
    const { user } = renderApp("/projects/prj_one/secrets", api);
    await user.click(await screen.findByRole("button", { name: "Edit npm_token" }));
    const d = sheet();
    expect(within(d).queryByLabelText(/Value/)).toBeNull();
    await user.click(within(d).getByLabelText("The manager"));
    await user.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    expect(api.writes[0]!.body).not.toHaveProperty("value");
    expect((api.writes[0]!.body as { roles: string[] }).roles.sort()).toEqual(["manager", "worker"]);
    await user.click(await screen.findByRole("button", { name: "Edit npm_token" }));
    await user.click(within(sheet()).getByRole("button", { name: "Set a new value" }));
    expect(within(sheet()).getByLabelText(/New value/)).toHaveAttribute("type", "password");
  });

  it("refuses a host outside the grant before sending, saying the operator must widen it", async () => {
    const api = new FakeApi();
    const { user } = renderApp("/projects/prj_one/secrets", api);
    await user.click(await screen.findByRole("button", { name: "Add the first secret" }));
    const d = sheet();
    await user.click(service(d));
    await user.click(await screen.findByRole("option", { name: "Custom" }));
    await user.type(within(d).getByLabelText(/^Name/), "stripe_key");
    await user.type(within(d).getByLabelText(/^Value/), "v");
    await user.type(within(d).getAllByLabelText(/^Hosts/).find((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type !== "hidden")!, "api.stripe.com{enter}");
    await user.click(within(d).getByRole("button", { name: "Add the secret" }));
    expect(await within(d).findByText(/api\.stripe\.com is outside the hosts this app may inject into .*the operator must widen the grant's inject_hosts/)).toBeInTheDocument();
    expect(api.writes).toEqual([]);
  });

  it("steers away from the GitHub API preset: nest brokers GitHub already", async () => {
    const api = new FakeApi();
    const { user } = renderApp("/projects/prj_one/secrets", api);
    await user.click(await screen.findByRole("button", { name: "Add the first secret" }));
    await user.click(service(sheet()));
    await user.click(await screen.findByRole("option", { name: "GitHub API" }));
    expect(within(sheet()).getByText(/nest already brokers GitHub/)).toBeInTheDocument();
  });

  it("deleting confirms, naming the agents that lose it", async () => {
    const api = new FakeApi();
    api.secrets = [secret()];
    const { user } = renderApp("/projects/prj_one/secrets", api);
    await user.click(await screen.findByRole("button", { name: "Delete npm_token" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete npm_token?" });
    expect(confirm).toHaveTextContent("It leaves agt_w1 (worker) now, with its variable.");
    expect(api.writes).toEqual([]);
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "DELETE", path: "/api/projects/prj_one/secrets/npm_token", body: undefined }]));
  });
});

describe("a request for a secret", () => {
  const req = (o: Record<string, unknown>) => ({ id: "srq_1", type: "ci" as const, name: "NPM_TOKEN", purpose: "publish from CI", hosts: null, agent: "agt_w1", role: "worker", task: null, tainted: false, at_ms: now - 60_000, ...o });

  it("for CI links to the repo's Actions secrets form, and is marked added", async () => {
    const api = new FakeApi();
    api.secretRequests = [req({})];
    const { user } = renderApp("/projects/prj_one/board", api);
    const item = (await screen.findByText("publish from CI")).closest("[data-secret-request]") as HTMLElement;
    expect(within(item).getByRole("link", { name: "Add NPM_TOKEN on GitHub" })).toHaveAttribute("href", "https://github.com/owner/widgets/settings/secrets/actions/new");
    await user.click(within(item).getByRole("button", { name: "Mark added" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects/prj_one/secret-requests/srq_1/done", body: undefined }]));
  });

  it("to inject opens the Secrets form with its name and hosts", async () => {
    const api = new FakeApi();
    api.secretRequests = [req({ type: "injected", name: "cf_token", hosts: ["api.cloudflare.com"] })];
    const { user } = renderApp("/projects/prj_one/board", api);
    await user.click(await screen.findByRole("link", { name: "Set it up" }));
    const d = await waitFor(sheet);
    expect(within(d).getByLabelText(/^Name/)).toHaveValue("cf_token");
    expect(within(d).getByText("api.cloudflare.com")).toBeInTheDocument();
  });
});

describe("workers changing CI workflows", () => {
  it("shows the security note when on, and can't be turned on when the grant doesn't allow it", async () => {
    const api = new FakeApi();
    const { user } = renderApp("/projects/prj_one/settings", api);
    const toggle = await screen.findByRole("switch", { name: /Workers may change CI workflows/ });
    expect(screen.queryByText("A pushed workflow runs before anyone reviews it")).toBeNull();
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    expect(screen.getByText("A pushed workflow runs before anyone reviews it")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "GitHub: environments" })).toHaveAttribute("href", expect.stringContaining("managing-environments-for-deployment"));
    const denied = new FakeApi();
    denied.grant = { ...denied.grant!, workflows: false };
    renderApp("/projects/prj_one/settings", denied);
    await waitFor(() => expect(screen.getAllByRole("switch", { name: /Workers may change CI workflows/ }).at(-1)).toBeDisabled());
    expect(screen.getByText(/The app's grant doesn't allow it/)).toBeInTheDocument();
  });
});
