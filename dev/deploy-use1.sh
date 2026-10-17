#!/bin/bash
# Deploys nest-control-plane for the use1 cell by hand, until deploy.yml exists (dev/deploy.md).
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
npx wrangler deploy --message "$(git rev-parse --short HEAD) ${1:-manual}" \
  --var "PUBLIC_BASE_URL:$(var PUBLIC_BASE_URL)" --var PREVIEW_DOMAIN:preview.nest.bitcru.sh --var CELLS:use1 \
  --var "AWS_CELLS:$(var AWS_CELLS)" "${optional[@]}"
