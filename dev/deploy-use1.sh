#!/bin/bash
# Deploys nest-control-plane for the use1 cell: run by deploy.yml, or by hand (dev/deploy.md).
# Worker secrets persist across versions; `--var`s don't, so every deploy passes them again. They
# live in SSM next to the secrets (/nest/control-plane/vars/*), written by hand, except AWS_CELLS:
# each cell stack (deploy/lean/Cell/Stack.lean, applied just before this runs) writes its own entry
# under /nest/control-plane/aws-cells/, and this script merges them. Needs CLOUDFLARE_* and AWS_* in env.
set -euo pipefail
cd "$(dirname "$0")/../control-plane"
var() { aws ssm get-parameter --region us-east-1 --name "/nest/control-plane/vars/$1" --query Parameter.Value --output text 2>/dev/null; }
# Optional: passed only when the parameter exists. SANDBOX_SUSPEND_IDLE_MS is a test override;
# ROOT_CA_KMS_KEY_ID is the legacy KMS key, for one release, for a cell whose AWS_CELLS entry has none.
optional=()
for name in SANDBOX_SUSPEND_IDLE_MS ROOT_CA_KMS_KEY_ID; do
  if value=$(var "$name"); then optional+=(--var "$name:$value"); fi
done
# Required: a missing or empty parameter fails the deploy here, since a `$(var …)` inside an argument
# would pass an empty value (and, for CLOUDFLARE_ACCOUNT_ID, silently deploy a Worker with no tunnels).
required=()
for name in PUBLIC_BASE_URL CLOUDFLARE_ACCOUNT_ID; do
  if ! value=$(var "$name") || [ -z "$value" ]; then
    echo "deploy: SSM parameter /nest/control-plane/vars/$name is missing or empty" >&2
    exit 1
  fi
  required+=(--var "$name:$value")
done
# AWS_CELLS: every cell's entry (each parameter is `{"<cell>": {...}}`), merged into one object. No
# entry fails the deploy: without one FleetDO would neither scale nor find its KMS key.
entries=$(aws ssm get-parameters-by-path --region us-east-1 --path /nest/control-plane/aws-cells/ \
  --query 'Parameters[].Value' --output json)
aws_cells=$(node -e '
  const entries = JSON.parse(require("fs").readFileSync(0, "utf8")).map((v) => JSON.parse(v));
  if (!entries.length) { console.error("deploy: no SSM parameter under /nest/control-plane/aws-cells/"); process.exit(1); }
  process.stdout.write(JSON.stringify(Object.assign({}, ...entries)));
' <<<"$entries")
required+=(--var "AWS_CELLS:$aws_cells")
# The tunnel API token (Account: Cloudflare One Connector: cloudflared: Edit; Zone: DNS: Edit) is a Worker
# secret, written here from the deploy environment when present; secrets persist across versions, so it
# can be absent.
if [ -n "${CLOUDFLARE_TUNNEL_API_TOKEN:-}" ]; then
  printf '%s' "$CLOUDFLARE_TUNNEL_API_TOKEN" | npx wrangler secret put CLOUDFLARE_TUNNEL_API_TOKEN
fi
# NEST_DOMAIN names the nest label and the zone (nest.bitcru.sh: label `nest`, zone `bitcru.sh`) for the
# per-host tunnel, preview and share hostnames; the account id is where the tunnels are created.
npx wrangler deploy --message "$(git rev-parse --short HEAD) ${1:-manual}" \
  --var CELLS:use1 --var NEST_DOMAIN:nest.bitcru.sh \
  "${required[@]}" "${optional[@]}"
