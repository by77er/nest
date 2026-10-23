#!/bin/bash
# Installs what `inframe` needs in CI (see dev/ci.md and dev/deploy.md): elan (Lean's toolchain
# manager; Lake reads the toolchain from deploy/lean/lean-toolchain) and the inframe CLI, both
# pinned. OpenTofu comes from its setup action. Idempotent, so cached tools are reused.
set -euo pipefail
ELAN=v4.2.4
# The CLI the stack was last applied with; the Lean library is pinned separately in
# deploy/inframe.toml and deploy/lean/lakefile.toml.
INFRAME_REV=ea3880b268cdbd43addaaa92e3b3c7176204f1b9

if [ ! -x "$HOME/.elan/bin/elan" ]; then
  curl -fsSL "https://raw.githubusercontent.com/leanprover/elan/$ELAN/elan-init.sh" -o "$RUNNER_TEMP/elan-init.sh"
  sh "$RUNNER_TEMP/elan-init.sh" -y --no-modify-path --default-toolchain none
fi
echo "$HOME/.elan/bin" >> "$GITHUB_PATH"

if [ "$(cat "$HOME/.cargo/bin/.inframe-rev" 2>/dev/null)" != "$INFRAME_REV" ]; then
  cargo install --locked --force --git https://github.com/by77er/inframe --rev "$INFRAME_REV" inframe-cli
  echo "$INFRAME_REV" > "$HOME/.cargo/bin/.inframe-rev"
fi
