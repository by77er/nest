# Control-host schemas

- `platform-tools.json`: the canonical platform tool catalog (`ToolDef[]`). The control plane loads it as its tool registry, and nest-mcp exposes it through `tools/list`.

Message shapes are defined by `nest_protocol::control` / `nest_protocol::model` and pinned by the fixtures in `../../fixtures/control/`. Spec: `docs/interfaces/control-host/`.
