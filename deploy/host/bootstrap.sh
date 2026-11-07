#!/bin/bash
# Host bootstrap (EC2 user-data, rendered by the cell stack in deploy/, one per launch template).
# It holds no secrets: the host proves itself with its signed instance identity document and gets
# the Claude setup token per brain from the control plane. Both kinds boot the one host AMI (EC2
# Image Builder bakes install.sh's work) and run install.sh here too, reading the release from the
# cell's bucket (a brain host's role may read `releases/` only), so a host on an AMI behind the
# release, or on stock Amazon Linux 2023, catches up and every host runs the current release.
#
# ROLE is the template's, in the previous release's names this release (`burst` for a sandbox
# host, `controller` for a brain host; nestd reads both, and a control plane rolled back to the
# previous release accepts them; expand/contract, dev/deploy.md). Each kind enables only its own
# units; install.sh writes every unit and enables none.
set -euo pipefail
exec > >(tee -a /var/log/nest-bootstrap.log) 2>&1

ROLE="@ROLE@"
CELL="@CELL@"
BUCKET="@BUCKET@"
REGION="@REGION@"
CONTROL_URL="@CONTROL_URL@"

install -d -m 0755 /opt/nest
cat >/opt/nest/install.sh <<'NEST_INSTALL'
@INSTALL@
NEST_INSTALL
bash /opt/nest/install.sh
install -d -m 0755 /run/nest /run/nest/runner
VERSION=$(cat /opt/nest/release/VERSION)

# A brain host: nestd's supervisor duties and the agent runner, nothing that serves a sandbox (no
# driver, netns, proxy, gateway, tunnel or S3 store; nestd refuses those settings).
if [ "$ROLE" = controller ]; then
  cat >/etc/nest/nestd.json <<EOF
{
  "role": "$ROLE",
  "cell": "$CELL",
  "control_url": "$CONTROL_URL",
  "enrollment": {"type": "aws_imds"},
  "versions": {"nest_proxy": "none", "agent_runner": "$VERSION", "claude_code": "$(cat /etc/nest/claude-version)"}
}
EOF
  # Never the sandbox units (nothing enabled them: install.sh enables nothing, and nestd.service
  # doesn't want nest-proxy).
  systemctl enable --now nestd.service nest-runner.service
  exit 0
fi

# A sandbox host runs its sandboxes in Firecracker under the jailer, or not at all. Without /dev/kvm
# (nested virtualization) or without firecracker and the jailer in the release, it refuses the
# sandbox role: it writes no config, enables nothing, never enrolls, and shuts down (the launch
# template terminates on shutdown; FleetDO's enroll timeout ends the launch either way). There is
# no fallback: the process driver runs every guest, and agents' Bash with it, as root on the host.
# It is for development and e2e only, and nestd refuses it unless its config opts in.
modprobe kvm_intel 2>/dev/null || modprobe kvm_amd 2>/dev/null || true
if [ ! -e /dev/kvm ] || [ ! -x /opt/nest/bin/firecracker ] || [ ! -x /opt/nest/bin/jailer ]; then
  echo "refusing the sandbox role: no /dev/kvm (nested virtualization), or no firecracker or jailer in the release; this host enables nothing, never enrolls, and shuts down" >&2
  shutdown -h now || true
  exit 1
fi

# Sandbox state on the instance-store NVMe, where the instance type has one (c8id): formatted XFS
# with reflink at first boot (fstab mounts it again after a reboot; a stop wipes it, as the root
# volume's sandbox state dies with a spot host anyway). A checkpoint then cuts a disk with a reflink
# in a brief pause; without one, nestd says so at start and pauses VMs for whole reads
# (docs/sandbox/state/disk/). The kernel, base images and the jailer's chroots go there too: the
# jailer hard-links them next to each disk, which only works within one filesystem.
# Mounted outside /var/lib/nest: the gateway's unit hides /var/lib/nest, and it must reach each VM's
# vsock socket inside its chroot (2026-11-04: a host with the store under /var/lib/nest/data failed
# every hands call). Kernel and images are root's alone (0700); the state is traversable but not
# listable (0711), since nestd runs cloudflared as nest-cf with its home in it; the gateway's drop-in
# hides all three. The gateway sees only the chroots, as on the root volume's /srv/jailer.
DATA=/srv/nest
STATE_DIR=/var/lib/nest
KERNEL_DIR=/var/lib/nest/kernel
IMAGES_DIR=/var/lib/nest/images
JAILER_BASE=/srv/jailer
NVME=$(lsblk -dpno NAME,MODEL 2>/dev/null | awk '/Amazon EC2 NVMe Instance Storage/ {print $1; exit}')
# Any step failing (an AMI without xfsprogs, a disk that won't format or mount) leaves the state on the
# root volume: the host still comes up.
instance_store() {
  if ! command -v mkfs.xfs >/dev/null || ! command -v xfs_info >/dev/null; then echo "no mkfs.xfs or xfs_info"; return 1; fi
  # -K: no discard of the whole device first (a large store would stretch boot); a fresh instance store reads as zeros.
  blkid -o value -s TYPE "$NVME" 2>/dev/null | grep -qx xfs || mkfs.xfs -q -f -K -m reflink=1 -L nest-data "$NVME" || return 1
  install -d -m 0755 "$DATA" || return 1
  # `nofail` so a boot without it still comes up, and a short device timeout: a store left blank by
  # a stop and start never shows its label. The units that use it require it (below).
  grep -q '^LABEL=nest-data ' /etc/fstab 2>/dev/null || echo "LABEL=nest-data $DATA xfs defaults,noatime,nofail,x-systemd.device-timeout=10s 0 2" >> /etc/fstab || return 1
  mountpoint -q "$DATA" || mount "$DATA" || return 1
  xfs_info "$DATA" 2>/dev/null | grep -q 'reflink=1' || { echo "the instance store at $DATA has no reflink"; return 1; }
}
if [ -n "$NVME" ]; then
  if instance_store; then
    STATE_DIR=$DATA/state KERNEL_DIR=$DATA/kernel IMAGES_DIR=$DATA/images JAILER_BASE=$DATA/jailer
    install -d -m 0711 "$STATE_DIR"
    install -d -m 0700 "$KERNEL_DIR" "$IMAGES_DIR"
    install -d -m 0755 "$JAILER_BASE"
    if [ -f /var/lib/nest/kernel/vmlinux ] && [ ! -f "$KERNEL_DIR/vmlinux" ]; then cp /var/lib/nest/kernel/vmlinux "$KERNEL_DIR/vmlinux"; fi
    # After a reboot nestd must not start before the store is mounted (it would write into the bare
    # directory the mount then hides), and after a stop and start (the store comes back blank, and
    # user data doesn't run again) it must not start at all: the host fails loudly and never
    # enrolls, and nestd refuses to start without its kernel and images besides.
    for unit in nestd.service nest-proxy.service nest-gateway.service; do
      install -d -m 0755 "/etc/systemd/system/$unit.d"
      printf '[Unit]\nRequiresMountsFor=%s\n' "$DATA" > "/etc/systemd/system/$unit.d/instance-store.conf"
    done
    # The gateway sees the store's chroots and nothing else of it, as it sees /srv/jailer and not
    # /var/lib/nest on the root volume.
    printf '[Service]\nInaccessiblePaths=-%s -%s -%s\n' "$STATE_DIR" "$KERNEL_DIR" "$IMAGES_DIR" >> /etc/systemd/system/nest-gateway.service.d/instance-store.conf
    systemctl daemon-reload
    echo "sandbox state on the instance store at $DATA (XFS, reflink)"
  else
    echo "the instance store isn't usable: sandbox state stays on the root volume, and checkpoints pause VMs for whole reads"
  fi
else
  echo "no instance store: sandbox state stays on the root volume, and checkpoints pause VMs for whole reads"
fi

# Sandboxes run in Firecracker under the jailer (KVM was checked above).
BASE=$IMAGES_DIR/nest-base:latest.ext4
[ -f "$BASE" ] || { zstd -q -d -f /var/lib/nest/images/nest-base.ext4.zst -o "$BASE.tmp" && mv "$BASE.tmp" "$BASE"; }
# Guest memory is regular pages, demand-paged and overcommitted: a guest costs what it touches,
# and the control plane packs by MemAvailable (docs/sandbox/state/memory/). No hugepage pool:
# one would be a reservation that caps occupancy at pool / declared size. The jailer caps each
# VM's cgroup at its declared memory plus a VMM overhead, and nest's services carry a low OOM
# score, so a guest that outgrows its declaration dies alone.
rm -f /etc/sysctl.d/90-nest-hugepages.conf
sysctl -q -w vm.nr_hugepages=0 || true
DRIVER='{"type": "firecracker", "firecracker_bin": "/opt/nest/bin/firecracker", "jailer_bin": "/opt/nest/bin/jailer",
  "jailer": {"uid": 900, "gid": 900, "chroot_base_dir": "'"$JAILER_BASE"'"},
  "kernel_image": "'"$KERNEL_DIR"'/vmlinux", "images_dir": "'"$IMAGES_DIR"'", "huge_pages": false}'

# The gateway runs as nest-gw (install.sh made it; its ids are the AMI's, read back here): nestd
# lets only that uid on gateway.sock and gives its group the socket and each VM's vsock socket. A
# previous-release nestd can't (install.sh left that gateway root's): the default, root only.
NESTD_FEATURES=$(/opt/nest/bin/nestd --features 2>/dev/null || true)
if grep -qx gateway-user <<<"$NESTD_FEATURES"; then
  GW_UID=$(id -u nest-gw)
  GW_GID=$(id -g nest-gw)
  SOCKETS="{\"gateway_gid\": $GW_GID, \"gateway_uids\": [$GW_UID]}"
else
  SOCKETS='{}'
fi

cat >/etc/nest/nestd.json <<EOF
{
  "role": "$ROLE",
  "cell": "$CELL",
  "control_url": "$CONTROL_URL",
  "enrollment": {"type": "aws_imds"},
  "state_dir": "$STATE_DIR",
  "driver": $DRIVER,
  "sockets": $SOCKETS,
  "network": {"type": "netns", "persist_dir": "/run/nest/netns"},
  "delegated_cgroup": true,
  "gateway_url": "ws://127.0.0.1:18790",
  "cloudflared_bin": "/opt/nest/bin/cloudflared",
  "cloudflared_user": "nest-cf",
  "storage": {"type": "s3", "bucket": "$BUCKET", "region": "$REGION"},
  "versions": {"nest_proxy": "$VERSION", "agent_runner": "$VERSION", "claude_code": "$(cat /etc/nest/claude-version)"}
}
EOF

# A sandbox host: nest-proxy, nestd and the gateway. The agent runner stays enabled this release
# only (expand/contract): this Worker never sends a sandbox host a brain, but a Worker rolled back
# to the previous release starts workers' brains on their sandbox's host. The next release drops it.
systemctl enable --now nest-proxy.service nestd.service nest-gateway.service nest-runner.service
