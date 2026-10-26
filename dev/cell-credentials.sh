#!/bin/bash
# Checks the Worker secret AWS_CELL_CREDENTIALS with the control plane's own schema
# (control-plane/src/lib/cells.ts, parseCellCredentials), and with `put` writes it to the Worker.
# The JSON comes on stdin, never as an argument, so it stays out of shell history:
#   dev/cell-credentials.sh check < creds.json
#   dev/cell-credentials.sh put < creds.json      # needs CLOUDFLARE_API_TOKEN / wrangler login
# Shape: {"<cell>": {"access_key_id": "...", "secret_access_key": "..."}}. Prints cell names only.
set -euo pipefail
mode=${1:-}
if [ "$mode" != check ] && [ "$mode" != put ]; then
  echo "usage: $0 check|put < creds.json" >&2
  exit 2
fi
cd "$(dirname "$0")/../control-plane"
json=$(node --experimental-strip-types --no-warnings -e '
  import("./src/lib/cells.ts").then(({ parseCellCredentials }) => {
    try {
      const creds = parseCellCredentials(require("fs").readFileSync(0, "utf8"));
      console.error(`AWS_CELL_CREDENTIALS: valid, cells: ${Object.keys(creds).join(", ")}`);
      process.stdout.write(JSON.stringify(creds));
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  });
')
if [ "$mode" = put ]; then
  printf '%s' "$json" | npx wrangler secret put AWS_CELL_CREDENTIALS
fi
