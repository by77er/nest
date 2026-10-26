#!/usr/bin/env bash
# Runs the verification pilots and checks each result against its expected outcome.
#
#   verification/run.sh                  # the CI tier: TLC configs marked `ci`, the Lean build, Stateright tests
#   verification/run.sh --all            # every TLC config (some take 10+ minutes)
#   verification/run.sh --only tla|lean|stateright
#   verification/run.sh --only tla --spec sandbox-lease   # one spec directory
#
# TLC configs are listed in verification/tla/<spec>/expect.tsv, one per line:
#   <Spec.tla> <config.cfg> <holds|violates:<Name>> <ci|full>
# `violates:<Name>` passes only if TLC reports a violation naming <Name> (an invariant or an action
# property), or, for a temporal property or `Deadlock`, TLC's unnamed temporal-violation or
# deadlock line (v1.7.4 doesn't name the temporal property, so such a config is matched loosely).
# A config expected to hold passes only if TLC finishes with no error.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="$ROOT/.tools"
STATES="$ROOT/.tlc-states"
# TLA+ tools v1.7.4 (the latest non-prerelease), pinned by digest.
TLA_URL="https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar"
TLA_SHA256="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
JAR="$TOOLS/tla2tools-1.7.4.jar"

tier="ci"
only=""
spec_only=""
while [ $# -gt 0 ]; do
  case "$1" in
    --all) tier="full" ;;
    --only) only="$2"; shift ;;
    --spec) spec_only="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

fail=0

want() { [ -z "$only" ] || [ "$only" = "$1" ]; }

fetch_tla() {
  mkdir -p "$TOOLS"
  if [ ! -f "$JAR" ]; then
    curl -fsSL -o "$JAR.part" "$TLA_URL"
    mv "$JAR.part" "$JAR"
  fi
  echo "$TLA_SHA256  $JAR" | sha256sum -c --quiet - || { echo "tla2tools.jar digest mismatch" >&2; exit 1; }
}

run_tla() {
  fetch_tla
  local workers="${TLC_WORKERS:-auto}"
  for manifest in "$ROOT"/tla/*/expect.tsv; do
    local dir
    dir="$(dirname "$manifest")"
    if [ -n "$spec_only" ] && [ "${dir##*/}" != "$spec_only" ]; then continue; fi
    while read -r spec cfg expect level _; do
      case "$spec" in ''|'#'*) continue ;; esac
      if [ "$tier" = "ci" ] && [ "$level" != "ci" ]; then continue; fi
      local name="${dir##*/}/$cfg"
      local meta="$STATES/${dir##*/}-${cfg%.cfg}"
      rm -rf "$meta"
      mkdir -p "$meta"
      local out
      set +e
      out="$(cd "$dir" && java -XX:+UseParallelGC ${TLC_JAVA_OPTS:-} -cp "$JAR" tlc2.TLC -workers "$workers" \
        -metadir "$meta" -config "$cfg" "$spec" 2>&1)"
      local code=$?
      set -e
      rm -rf "$meta"
      # TLC v1.7.4 writes a trace spec next to the model on a violation.
      rm -f "$dir"/*_TTrace_*
      local states
      states="$(printf '%s\n' "$out" | grep -E 'distinct states found' | tail -1 | sed -E 's/.* ([0-9,]+) distinct states found.*/\1/')"
      if [ "$expect" = "holds" ]; then
        if [ $code -eq 0 ] && printf '%s\n' "$out" | grep -q 'No error has been found'; then
          echo "ok    $name holds (${states:-?} states)"
        else
          echo "FAIL  $name expected to hold (TLC exit $code)"; printf '%s\n' "$out" | tail -40; fail=1
        fi
      else
        local prop="${expect#violates:}"
        # TLC names a violated invariant or action property; v1.7.4 prints a temporal (liveness)
        # violation without its name, so that line is matched for any expected temporal property.
        if [ $code -ne 0 ] && printf '%s\n' "$out" | grep -E -q "Invariant $prop is violated|Action property $prop is violated|$prop is violated|Temporal properties were violated|Deadlock reached"; then
          echo "ok    $name violates $prop, as expected"
        else
          echo "FAIL  $name expected a violation of $prop (TLC exit $code)"; printf '%s\n' "$out" | tail -40; fail=1
        fi
      fi
    done < "$manifest"
  done
}

run_lean() {
  (cd "$ROOT/lean" && lake build) || fail=1
  if grep -rn --include='*.lean' -E '\bsorry\b|\badmit\b|native_decide' "$ROOT/lean/Nest" "$ROOT/lean/Nest.lean"; then
    echo "FAIL  lean: sorry, admit or native_decide found"; fail=1
  else
    echo "ok    lean: built, no sorry"
  fi
}

run_stateright() {
  (cd "$ROOT/stateright" && cargo test --release --locked) || fail=1
}

want tla && run_tla
want lean && run_lean
want stateright && run_stateright

exit $fail
