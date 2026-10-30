#!/usr/bin/env bash
# Run one fuzz target for a bounded time, or replay its seeds and corpus once:
# run.sh <target> <seconds|replay> [extra libFuzzer args...]
# Corpus grows in corpus/<target>/ (gitignored), starting from seeds/<target>/; crashes land in
# artifacts/<target>/.
set -euo pipefail
cd "$(dirname "$0")"
target=$1
secs=$2
shift 2
case $target in
  # Past MAX_PACKET_FROM_PROXY, below the default socket buffer; without -len_control=0 libFuzzer
  # grows inputs too slowly to reach the truncation path in a short run.
  proxy_events) max_len=131072; set -- -len_control=0 "$@" ;;
  vsock_handshake) max_len=256 ;;
  *) max_len=65536 ;;             # one 64 KiB socket read
esac
# rust-toolchain.toml pins the nightly; a RUSTUP_TOOLCHAIN in the environment would override it.
unset RUSTUP_TOOLCHAIN
# The seeds are built from protocol/fixtures/ (the source of truth) at every run, never committed.
python3 -I gen_seeds.py >/dev/null
mkdir -p "corpus/$target"
if [ "$secs" = replay ]; then
  # Run every seed and corpus input once and stop: deterministic, for the PR gate.
  limit=(-runs=0)
else
  limit=(-max_total_time="$secs")
fi
exec cargo fuzz run --fuzz-dir . "$target" "corpus/$target" "seeds/$target" -- \
  "${limit[@]}" -rss_limit_mb=2048 -malloc_limit_mb=2048 -max_len="$max_len" -timeout=60 -print_final_stats=1 "$@"
