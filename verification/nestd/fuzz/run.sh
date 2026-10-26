#!/usr/bin/env bash
# Run one fuzz target for a bounded time: run.sh <target> <seconds> [extra libFuzzer args...]
# Corpus grows in corpus/<target>/ (gitignored), starting from seeds/<target>/; crashes land in
# artifacts/<target>/.
set -euo pipefail
cd "$(dirname "$0")"
target=$1
secs=$2
shift 2
case $target in
  proxy_events) max_len=131072 ;; # past MAX_PACKET_FROM_PROXY, below the default socket buffer
  vsock_handshake) max_len=256 ;;
  *) max_len=65536 ;;             # one 64 KiB socket read
esac
# rust-toolchain.toml pins the nightly; a RUSTUP_TOOLCHAIN in the environment would override it.
unset RUSTUP_TOOLCHAIN
mkdir -p "corpus/$target"
exec cargo fuzz run --fuzz-dir . "$target" "corpus/$target" "seeds/$target" -- \
  -max_total_time="$secs" -rss_limit_mb=2048 -malloc_limit_mb=2048 -max_len="$max_len" -timeout=10 -print_final_stats=1 "$@"
