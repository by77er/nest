#!/bin/bash
# Burst-host bootstrap (EC2 user-data, rendered by the cell stack in deploy/). It holds no secrets:
# the host proves itself with its signed instance identity document, reads its binaries from the
# cell's bucket through the instance role, and gets the Claude setup token per brain from the
# control plane. The host AMI (EC2 Image Builder) has install.sh's work baked in; install.sh runs
# here too, so a host on an AMI behind the release, or on stock Amazon Linux 2023, catches up.
set -euo pipefail
exec > >(tee -a /var/log/nest-bootstrap.log) 2>&1

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

# Sandboxes run in Firecracker when the instance has KVM (nested virtualization, set in the launch
# template); otherwise in the process driver, so a host never comes up unusable.
if [ -e /dev/kvm ] && [ -x /opt/nest/bin/firecracker ]; then
  BASE=/var/lib/nest/images/nest-base:latest.ext4
  [ -f "$BASE" ] || { zstd -q -d -f /var/lib/nest/images/nest-base.ext4.zst -o "$BASE.tmp" && mv "$BASE.tmp" "$BASE"; }
  # Guest memory is regular pages, demand-paged and overcommitted: a guest costs what it touches,
  # and the control plane packs by MemAvailable (docs/sandbox/state/memory/). No hugepage pool:
  # one would be a reservation that caps occupancy at pool / declared size. The jailer caps each
  # VM's cgroup at its declared memory plus a VMM overhead, and nest's services carry a low OOM
  # score, so a guest that outgrows its declaration dies alone.
  rm -f /etc/sysctl.d/90-nest-hugepages.conf
  sysctl -q -w vm.nr_hugepages=0 || true
  DRIVER='{"type": "firecracker", "firecracker_bin": "/opt/nest/bin/firecracker", "jailer_bin": "/opt/nest/bin/jailer",
    "jailer": {"uid": 900, "gid": 900, "chroot_base_dir": "/srv/jailer"},
    "kernel_image": "/var/lib/nest/kernel/vmlinux", "images_dir": "/var/lib/nest/images", "huge_pages": false}'
else
  echo "no /dev/kvm (or no firecracker in the release): using the process driver"
  DRIVER='{"type": "process", "guest_command": ["/opt/nest/bin/nest-guest", "--state-dir", "/var/lib/nest/guest",
    "--cgroup-root", "none", "--cli-socket", "none", "--run-as", "none"], "mount_disk": true}'
fi

VERSION=$(cat /opt/nest/release/VERSION)
cat >/etc/nest/nestd.json <<EOF
{
  "role": "burst",
  "cell": "$CELL",
  "control_url": "$CONTROL_URL",
  "enrollment": {"type": "aws_imds"},
  "driver": $DRIVER,
  "network": {"type": "netns", "persist_dir": "/run/nest/netns"},
  "gateway_url": "ws://127.0.0.1:18790",
  "cloudflared_bin": "/opt/nest/bin/cloudflared",
  "cloudflared_user": "nest-cf",
  "storage": {"type": "s3", "bucket": "$BUCKET", "region": "$REGION"},
  "versions": {"nest_proxy": "$VERSION", "agent_runner": "$VERSION", "claude_code": "$(cat /etc/nest/claude-version)"}
}
EOF

systemctl enable --now nest-proxy.service nestd.service nest-gateway.service nest-runner.service
