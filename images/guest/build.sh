#!/bin/bash
# Builds a Firecracker guest image for nest: the guest kernel and `nest-base`, an ext4 root
# filesystem with nest-guest as the agent. Runs as root on a disposable Linux builder (it chroots to
# install packages). Inputs are pinned: the Firecracker CI artifacts by build id and digest.
#
#   images/guest/build.sh <nest-guest binary> <out dir> [<proxy root CA certificate PEM>]
#
# Writes <out>/vmlinux and <out>/nest-base.ext4.zst (a sparse 4 GiB ext4, compressed; nestd grows
# each sandbox's copy to its disk size).
#
# Safety: everything mounted for the chroot lives in a private mount namespace, so it disappears
# with the build however it exits, and the chroot's /dev is its own tmpfs, never the builder's.
set -euo pipefail
if [ "${NEST_IMAGE_BUILD_NS:-}" != 1 ]; then
  exec env NEST_IMAGE_BUILD_NS=1 unshare --mount --propagation private -- "$0" "$@"
fi
GUEST_BIN=$(realpath "$1")
OUT=$(realpath -m "$2")
ROOT_CA=${3:+$(realpath "$3")}
HERE=$(dirname "$(realpath "$0")")
CI=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/20261016-5732b8331e1e-0/x86_64
KERNEL=vmlinux-6.18.54
KERNEL_SHA256=445b3d0ed9650869e854656308d60e6cca773190526b037b45941cbf61910f0d
ROOTFS=ubuntu-24.04.squashfs
ROOTFS_SHA256=40eaeb2ccd067314d75977784835884c22f19190b757456662df13134f58956e
# Over HTTPS: builders may have no port-80 egress.
MIRROR=${NEST_UBUNTU_MIRROR:-https://mirrors.edge.kernel.org/ubuntu}
SIZE=4G

mkdir -p "$OUT"
WORK=$(mktemp -d)
R="$WORK/root"
cleanup() {
  umount -R "$R/proc" "$R/dev" "$R/tmp" 2>/dev/null || true
  # Never cross into anything still mounted.
  rm -rf --one-file-system "$WORK"
}
trap cleanup EXIT

fetch() { curl -fsSL -o "$2" "$CI/$1"; echo "$3  $2" | sha256sum -c --quiet; }
fetch "$KERNEL" "$OUT/vmlinux" "$KERNEL_SHA256"
fetch "$ROOTFS" "$WORK/rootfs.squashfs" "$ROOTFS_SHA256"
unsquashfs -q -d "$R" "$WORK/rootfs.squashfs"

# Packages agents expect, installed by the guest's own apt.
mount -t proc proc "$R/proc"
mkdir -p "$R/tmp" && mount -t tmpfs -o mode=1777 tmpfs "$R/tmp"
mount -t tmpfs -o mode=0755 tmpfs "$R/dev"
for n in null zero full random urandom tty; do
  touch "$R/dev/$n"
  mount --bind "/dev/$n" "$R/dev/$n"
done
cat > "$R/etc/apt/sources.list.d/ubuntu.sources" <<SRC
Types: deb
URIs: $MIRROR
Suites: noble noble-updates noble-security
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
SRC
rm -f "$R/etc/apt/sources.list"
# Firecracker's CI rootfs is stripped of apt's and dpkg's working directories.
mkdir -p "$R/var/cache/apt/archives/partial" "$R/var/lib/apt/lists/partial" "$R/var/log/apt" \
  "$R/var/lib/dpkg/updates" "$R/var/lib/dpkg/info" "$R/var/cache/debconf"
cp -L /etc/resolv.conf "$R/etc/resolv.conf"
# IPv4 only (the builder's subnet has no IPv6 route, and a mirror that resolves AAAA first failed the whole
# update), with retries; an index that can't be fetched fails the build instead of installing nothing.
chroot "$R" env DEBIAN_FRONTEND=noninteractive \
  bash -c 'APT="-o Acquire::ForceIPv4=true -o Acquire::Retries=3" && apt-get $APT update -q -o APT::Update::Error-Mode=any && apt-get $APT install -y -q --no-install-recommends git gh openssh-client less jq unzip xz-utils make build-essential python3 python3-venv python3-pip && apt-get clean && rm -rf /var/lib/apt/lists/*'
umount -R "$R/dev" "$R/proc" "$R/tmp"
chmod 1777 "$R/tmp"

# The agent user (nest-guest runs commands as 1000:1000), init, nest-guest.
# (The CI rootfs may already have a uid-1000 user; that one is the agent's then.)
chroot "$R" bash -c 'getent passwd 1000 >/dev/null || useradd -m -u 1000 -U -s /bin/bash nest'
# Its home must be its own: Firecracker's CI rootfs ships /home/ubuntu as root's (0750), so git and gh
# couldn't read their configuration under $HOME.
chroot "$R" bash -c 'h=$(getent passwd 1000 | cut -d: -f6); mkdir -p "$h" && chown -R 1000:1000 "$h" && [ "$(stat -c %u "$h")" = 1000 ]'
install -m 0755 "$GUEST_BIN" "$R/usr/local/bin/nest-guest"
install -m 0755 "$HERE/init" "$R/sbin/nest-init"
ln -sf /sbin/nest-init "$R/sbin/init"
# GitHub through nest-proxy's injection (docs/sandbox/networking/egress/injection/#github): git's credential
# helper and `gh`'s GITHUB_TOKEN carry the placeholder; the proxy substitutes the sandbox's own token,
# minted for its push allowlist. Keep the placeholder in step with GITHUB_PLACEHOLDER in
# control-plane/src/lib/rules/github.ts.
install -m 0755 "$HERE/git-credential-nest" "$R/usr/local/bin/git-credential-nest"
chroot "$R" git config --system credential.https://github.com.helper nest
echo "GITHUB_TOKEN=nest-ph-github" >> "$R/etc/environment"
# Sandboxes trust nest-proxy's root: TLS to the outside is re-signed by the host's intermediate.
if [ -n "$ROOT_CA" ]; then
  install -m 0644 "$ROOT_CA" "$R/usr/local/share/ca-certificates/nest-proxy-root.crt"
  chroot "$R" update-ca-certificates >/dev/null
  # Node ignores the system store unless told.
  echo "NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/nest-proxy-root.crt" >> "$R/etc/environment"
fi
# DNS goes to the gateway (nest-proxy's resolver); there is no other route out.
rm -f "$R/etc/resolv.conf"
echo "nameserver 172.16.0.1" > "$R/etc/resolv.conf"
echo nest > "$R/etc/hostname"
rm -f "$R"/etc/ssh/ssh_host_*

rm -f "$OUT/nest-base.ext4"
truncate -s "$SIZE" "$OUT/nest-base.ext4"
mkfs.ext4 -q -F -L nest-root -E lazy_itable_init=1,lazy_journal_init=1 -d "$R" "$OUT/nest-base.ext4"
zstd -q -f -T0 -6 --rm "$OUT/nest-base.ext4" -o "$OUT/nest-base.ext4.zst"
echo "built $OUT/vmlinux and $OUT/nest-base.ext4.zst"
