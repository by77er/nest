#!/bin/bash
# Builds the host binaries and publishes them as the cell's current release (s3://<bucket>/releases/current/),
# which every host installs at boot (deploy/host/install.sh). Firecracker and the jailer come from
# upstream's release archive, pinned below by version and SHA-256 (verified before unpacking): a
# Firecracker upgrade is a PR changing those two lines. The guest kernel and the guest image are
# carried over from the current release: they change by hand (images/guest/build-on-ec2.sh). Run by
# deploy.yml with the deploy role; see dev/deploy.md.
#
#   scripts/publish-release.sh <bucket> <version>
#
# Prints `changed=true|false` for $GITHUB_OUTPUT (and nothing else on stdout): false when every
# file but VERSION matches the current release, so a merge that touches no host code doesn't make
# hosts download anything.
set -euo pipefail
BUCKET=$1 VERSION=$2
REGION=${AWS_REGION:-us-east-1}
CURRENT="s3://$BUCKET/releases/current"
TARGET=x86_64-unknown-linux-musl
BINS=(nestd nest-guest nest-proxy nest-gateway nest-runner nest)
CARRIED=(vmlinux nest-base.ext4.zst)
# Firecracker and the jailer: a GitHub release archive, pinned by version and checksum (never
# committed to the repo). The checksum is upstream's firecracker-<version>-x86_64.tgz.sha256.txt.
FIRECRACKER_VERSION="v1.17.0"
FIRECRACKER_SHA256="06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558"
PINNED=(firecracker jailer)

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# The pinned archive first, so a bad pin fails before the build. Unpacked only once its checksum
# matches; sha256sum's report goes to stderr (stdout is $GITHUB_OUTPUT).
echo "Firecracker $FIRECRACKER_VERSION (pinned)" >&2
FC_ARCHIVE="firecracker-$FIRECRACKER_VERSION-x86_64.tgz"
FC_DIR="release-$FIRECRACKER_VERSION-x86_64"
curl -fsSL --retry 3 -o "$STAGE/$FC_ARCHIVE" \
  "https://github.com/firecracker-microvm/firecracker/releases/download/$FIRECRACKER_VERSION/$FC_ARCHIVE"
echo "$FIRECRACKER_SHA256  $STAGE/$FC_ARCHIVE" | sha256sum -c --quiet >&2
mkdir "$STAGE/upstream"
tar -xzf "$STAGE/$FC_ARCHIVE" -C "$STAGE/upstream" \
  "$FC_DIR/firecracker-$FIRECRACKER_VERSION-x86_64" "$FC_DIR/jailer-$FIRECRACKER_VERSION-x86_64"
for f in "${PINNED[@]}"; do
  install -m 0755 "$STAGE/upstream/$FC_DIR/$f-$FIRECRACKER_VERSION-x86_64" "$STAGE/$f"
done

# Static binaries: hosts run Amazon Linux 2023, whose glibc is older than the runner's.
rustup target add "$TARGET" >&2
CC_x86_64_unknown_linux_musl=musl-gcc cargo build --locked --release --target "$TARGET" \
  -p nestd -p nest-guest -p nest-proxy -p nest-gateway -p nest-runner -p nest-cli >&2

# nestd's file-access tests on the target that ships: musl's libc differs from the glibc that CI tests
# against (std dropped O_PATH from custom flags under musl, and no glibc run could show it).
CC_x86_64_unknown_linux_musl=musl-gcc cargo test --locked --release --target "$TARGET" -p nestd --lib driver::access >&2

# Hosts decide how to run the gateway from `nestd --features` (deploy/host/install.sh): the
# binary that ships must say `gateway-user`, or every host falls back to a root gateway.
NESTD_FEATURES=$("target/$TARGET/release/nestd" --features)
if ! grep -qx gateway-user <<<"$NESTD_FEATURES"; then
  echo "target/$TARGET/release/nestd --features doesn't list gateway-user" >&2
  exit 1
fi

for b in "${BINS[@]}"; do install -m 0755 "target/$TARGET/release/$b" "$STAGE/$b"; done
install -m 0644 protocol/claude-code/managed-settings.json "$STAGE/managed-settings.json"
aws s3 cp --region "$REGION" --only-show-errors "$CURRENT/SHA256SUMS" "$STAGE/current.sha256sums" >&2
for f in "${CARRIED[@]}"; do
  aws s3 cp --region "$REGION" --only-show-errors "$CURRENT/$f" "$STAGE/$f" >&2
done

cd "$STAGE"
sha256sum "${BINS[@]}" managed-settings.json "${PINNED[@]}" "${CARRIED[@]}" | sort -k2 > new.sha256sums
# The carried files must be the ones the current release vouches for.
for f in "${CARRIED[@]}"; do
  if [ "$(awk -v f="$f" '$2 == f' current.sha256sums)" != "$(awk -v f="$f" '$2 == f' new.sha256sums)" ]; then
    echo "$f doesn't match the current release's SHA256SUMS" >&2
    exit 1
  fi
done
# The pinned binaries the current release doesn't already ship.
FC_CHANGED=()
for f in "${PINNED[@]}"; do
  if [ "$(awk -v f="$f" '$2 == f' current.sha256sums)" != "$(awk -v f="$f" '$2 == f' new.sha256sums)" ]; then
    FC_CHANGED+=("$f")
  fi
done
if [ ${#FC_CHANGED[@]} -eq 0 ]; then
  echo "Firecracker: the current release already ships $FIRECRACKER_VERSION's firecracker and jailer" >&2
else
  echo "Firecracker: changes to $FIRECRACKER_VERSION (${FC_CHANGED[*]})" >&2
fi
if diff -q <(grep -v '  VERSION$' current.sha256sums | sort -k2) new.sha256sums >/dev/null; then
  echo "release unchanged; not publishing" >&2
  echo "changed=false"
  exit 0
fi

echo "$VERSION" > VERSION
sha256sum "${BINS[@]}" managed-settings.json VERSION "${PINNED[@]}" "${CARRIED[@]}" > SHA256SUMS
for f in "${BINS[@]}" managed-settings.json VERSION "${FC_CHANGED[@]}"; do
  aws s3 cp --region "$REGION" --only-show-errors "$f" "$CURRENT/$f" >&2
done
# Last: a host verifies everything against it (and installs nothing on a mismatch).
aws s3 cp --region "$REGION" --only-show-errors SHA256SUMS "$CURRENT/SHA256SUMS" >&2
echo "published release $VERSION" >&2
echo "changed=true"
