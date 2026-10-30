#!/bin/bash
# Builds the host binaries and publishes them as the cell's current release (s3://<bucket>/releases/current/),
# which every host installs at boot (deploy/host/install.sh). Firecracker, the jailer, the guest
# kernel and the guest image are carried over from the current release: they change by hand
# (images/guest/build-on-ec2.sh). Run by deploy.yml with the deploy role; see dev/deploy.md.
#
#   scripts/publish-release.sh <bucket> <version>
#
# Prints `changed=true|false` for $GITHUB_OUTPUT: false when every file but VERSION matches the
# current release, so a merge that touches no host code doesn't make hosts download anything.
set -euo pipefail
BUCKET=$1 VERSION=$2
REGION=${AWS_REGION:-us-east-1}
CURRENT="s3://$BUCKET/releases/current"
TARGET=x86_64-unknown-linux-musl
BINS=(nestd nest-guest nest-proxy nest-gateway nest-runner nest)
CARRIED=(firecracker jailer vmlinux nest-base.ext4.zst)

# Static binaries: hosts run Amazon Linux 2023, whose glibc is older than the runner's.
rustup target add "$TARGET" >&2
CC_x86_64_unknown_linux_musl=musl-gcc cargo build --locked --release --target "$TARGET" \
  -p nestd -p nest-guest -p nest-proxy -p nest-gateway -p nest-runner -p nest-cli >&2

# Hosts decide how to run the gateway from `nestd --features` (deploy/host/install.sh): the
# binary that ships must say `gateway-user`, or every host falls back to a root gateway.
NESTD_FEATURES=$("target/$TARGET/release/nestd" --features)
if ! grep -qx gateway-user <<<"$NESTD_FEATURES"; then
  echo "target/$TARGET/release/nestd --features doesn't list gateway-user" >&2
  exit 1
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
for b in "${BINS[@]}"; do install -m 0755 "target/$TARGET/release/$b" "$STAGE/$b"; done
install -m 0644 protocol/claude-code/managed-settings.json "$STAGE/managed-settings.json"
aws s3 cp --region "$REGION" --only-show-errors "$CURRENT/SHA256SUMS" "$STAGE/current.sha256sums"
for f in "${CARRIED[@]}"; do
  aws s3 cp --region "$REGION" --only-show-errors "$CURRENT/$f" "$STAGE/$f" >&2
done

cd "$STAGE"
sha256sum "${BINS[@]}" managed-settings.json "${CARRIED[@]}" | sort -k2 > new.sha256sums
# The carried files must be the ones the current release vouches for.
for f in "${CARRIED[@]}"; do
  if [ "$(awk -v f="$f" '$2 == f' current.sha256sums)" != "$(awk -v f="$f" '$2 == f' new.sha256sums)" ]; then
    echo "$f doesn't match the current release's SHA256SUMS" >&2
    exit 1
  fi
done
if diff -q <(grep -v '  VERSION$' current.sha256sums | sort -k2) new.sha256sums >/dev/null; then
  echo "release unchanged; not publishing" >&2
  echo "changed=false"
  exit 0
fi

echo "$VERSION" > VERSION
sha256sum "${BINS[@]}" managed-settings.json VERSION "${CARRIED[@]}" > SHA256SUMS
for f in "${BINS[@]}" managed-settings.json VERSION; do
  aws s3 cp --region "$REGION" --only-show-errors "$f" "$CURRENT/$f" >&2
done
# Last: a host verifies everything against it (and installs nothing on a mismatch).
aws s3 cp --region "$REGION" --only-show-errors SHA256SUMS "$CURRENT/SHA256SUMS" >&2
echo "published release $VERSION" >&2
echo "changed=true"
