#!/usr/bin/env bash
# nest local end-to-end harness. See e2e/README.md.
exec python3 "$(dirname "$0")/run.py" "$@"
