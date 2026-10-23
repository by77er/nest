#!/bin/bash
# Deploys nest-control-plane for the use1 cell: run by deploy.yml, or by hand (dev/deploy.md).
# Worker secrets persist across versions; `--var`s don't, so every deploy passes them again. They
# live in SSM next to the secrets (/nest/control-plane/vars/*). Needs CLOUDFLARE_* and AWS_* in env.
set -euo pipefail
cd "$(dirname "$0")/../control-plane"
var() { aws ssm get-parameter --region us-east-1 --name "/nest/control-plane/vars/$1" --query Parameter.Value --output text 2>/dev/null; }
# Optional overrides (tests): passed only when the parameter exists.
optional=()
for name in SANDBOX_SUSPEND_IDLE_MS; do
  if value=$(var "$name"); then optional+=(--var "$name:$value"); fi
done
# The tunnel API token (Account: Cloudflare Tunnel: Edit, Zone: DNS: Edit) is a Worker secret, written
# here from the deploy environment when present; secrets persist across versions, so it can be absent.
if [ -n "${CLOUDFLARE_TUNNEL_API_TOKEN:-}" ]; then
  printf '%s' "$CLOUDFLARE_TUNNEL_API_TOKEN" | npx wrangler secret put CLOUDFLARE_TUNNEL_API_TOKEN
fi
# NEST_DOMAIN names the nest label and the zone (nest.bitcru.sh: label `nest`, zone `bitcru.sh`) for the
# per-host tunnel hostnames; the account id is where the tunnels are created.
npx wrangler deploy --message "$(git rev-parse --short HEAD) ${1:-manual}" \
  --var "PUBLIC_BASE_URL:$(var PUBLIC_BASE_URL)" --var PREVIEW_DOMAIN:preview.nest.bitcru.sh --var CELLS:use1 \
  --var NEST_DOMAIN:nest.bitcru.sh --var "CLOUDFLARE_ACCOUNT_ID:$(var CLOUDFLARE_ACCOUNT_ID)" \
  --var "AWS_CELLS:$(var AWS_CELLS)" --var "ROOT_CA_KMS_KEY_ID:$(var ROOT_CA_KMS_KEY_ID)" "${optional[@]}"
