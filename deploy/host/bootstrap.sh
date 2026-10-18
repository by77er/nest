#!/bin/bash
# Burst-host bootstrap (EC2 user-data, rendered by the cell stack in deploy/). It holds no secrets:
# the host proves itself with its signed instance identity document, reads its binaries from the
# cell's bucket through the instance role, and gets the Claude setup token per brain from the
# control plane. Until the burst image is built (Packer, see docs/compute/provisioning/), it
# installs everything at boot on stock Amazon Linux 2023.
set -euo pipefail
# Until logs ship elsewhere, the services also write to the serial console (`aws ec2 get-console-output`).
exec > >(tee -a /var/log/nest-bootstrap.log) 2>&1

BUCKET="@BUCKET@"
CELL="@CELL@"
REGION="@REGION@"
CONTROL_URL="@CONTROL_URL@"
CLAUDE_VERSION="2.1.301"
export HOME=/root

dnf install -y -q nftables iproute util-linux bubblewrap e2fsprogs zstd

install -d -m 0755 /opt/nest/bin /usr/lib/nest /etc/nest /etc/claude-code /var/lib/nest /run/nest /var/lib/nest/runner/cwd /run/nest/runner
aws s3 cp --region "$REGION" --recursive --only-show-errors "s3://$BUCKET/releases/current/" /opt/nest/release/
(cd /opt/nest/release && sha256sum -c --quiet SHA256SUMS)
install -m 0755 /opt/nest/release/{nestd,nest-proxy,nest-guest,nest-runner,nest} /opt/nest/bin/
# The managed settings' hooks run /usr/lib/nest/nest.
install -m 0755 /opt/nest/release/nest /usr/lib/nest/nest
install -m 0644 /opt/nest/release/managed-settings.json /etc/claude-code/managed-settings.json

# Sandboxes run in Firecracker when the instance has KVM (nested virtualization, set in the launch
# template); otherwise in the process driver, so a host never comes up unusable.
if [ -e /dev/kvm ] && [ -f /opt/nest/release/firecracker ]; then
  install -m 0755 /opt/nest/release/{firecracker,jailer} /opt/nest/bin/
  # The jailer hard-links the kernel and each disk into its chroot: same filesystem as /srv/jailer.
  install -d -m 0755 /var/lib/nest/images /var/lib/nest/kernel /srv/jailer
  install -m 0644 /opt/nest/release/vmlinux /var/lib/nest/kernel/vmlinux
  zstd -q -d -f /opt/nest/release/nest-base.ext4.zst -o "/var/lib/nest/images/nest-base:latest.ext4"
  rm -f /opt/nest/release/nest-base.ext4.zst
  id -u nest-fc >/dev/null 2>&1 || useradd --system --uid 900 --user-group --no-create-home --shell /sbin/nologin nest-fc
  # Guest memory is backed by 2 MiB hugepages, reserved up front (half the host's memory, so the
  # brain, nestd and the proxy keep the rest).
  echo $(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 2 / 2048 )) > /proc/sys/vm/nr_hugepages
  DRIVER='{"type": "firecracker", "firecracker_bin": "/opt/nest/bin/firecracker", "jailer_bin": "/opt/nest/bin/jailer",
    "jailer": {"uid": 900, "gid": 900, "chroot_base_dir": "/srv/jailer"},
    "kernel_image": "/var/lib/nest/kernel/vmlinux", "images_dir": "/var/lib/nest/images", "huge_pages": true}'
else
  echo "no /dev/kvm (or no firecracker in the release): using the process driver"
  DRIVER='{"type": "process", "guest_command": ["/opt/nest/bin/nest-guest", "--state-dir", "/var/lib/nest/guest",
    "--cgroup-root", "none", "--cli-socket", "none", "--run-as", "none"], "mount_disk": true}'
fi

# Claude Code, pinned (the installer checks the release's checksum).
curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_VERSION"
CLAUDE_BIN=/root/.local/bin/claude

cat >/etc/nest/nestd.json <<EOF
{
  "role": "burst",
  "cell": "$CELL",
  "control_url": "$CONTROL_URL",
  "enrollment": {"type": "aws_imds"},
  "driver": $DRIVER,
  "network": {"type": "netns", "persist_dir": "/run/nest/netns"},
  "storage": {"type": "s3", "bucket": "$BUCKET", "region": "$REGION"},
  "versions": {"nest_proxy": "$(cat /opt/nest/release/VERSION)", "agent_runner": "$(cat /opt/nest/release/VERSION)", "claude_code": "$CLAUDE_VERSION"}
}
EOF

cat >/etc/systemd/system/nest-proxy.service <<'EOF'
[Unit]
Description=nest egress proxy
After=network-online.target
[Service]
StandardOutput=journal+console
StandardError=journal+console
Environment=NEST_LOG=info
ExecStart=/opt/nest/bin/nest-proxy --nestd-sock /run/nest/proxy.sock
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/nestd.service <<'EOF'
[Unit]
Description=nest host daemon
After=network-online.target nest-proxy.service
Wants=network-online.target nest-proxy.service
[Service]
StandardOutput=journal+console
StandardError=journal+console
Environment=RUST_LOG=info
# /run is empty after a reboot; nestd resumes with the credentials saved under /var/lib/nest.
ExecStartPre=/bin/mkdir -p /run/nest/netns /run/nest/runner
ExecStart=/opt/nest/bin/nestd --config /etc/nest/nestd.json
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/nest-runner.service <<EOF
[Unit]
Description=nest agent runner (Claude Code brains)
After=nestd.service
Wants=nestd.service
[Service]
StandardOutput=journal+console
StandardError=journal+console
Environment=HOME=/root
Environment=RUST_LOG=info
Environment=NEST_RUNNER_NESTD_SOCK=/run/nest/runner.sock
Environment=NEST_RUNNER_HOOK_DGRAM=/run/nest/runner/hook.dgram
Environment=NEST_RUNNER_HOOK_SOCK=/run/nest/runner/hook.sock
Environment=NEST_RUNNER_MCP_SOCK=/run/nest/runner/mcp.sock
Environment=NEST_RUNNER_CLAUDE_BIN=$CLAUDE_BIN
Environment=NEST_RUNNER_NEST_BIN=/usr/lib/nest/nest
Environment=NEST_RUNNER_CWD=/var/lib/nest/runner/cwd
ExecStartPre=/bin/mkdir -p /run/nest/runner
ExecStartPre=/bin/sh -c 'for i in \$(seq 60); do [ -S /run/nest/runner.sock ] && exit 0; sleep 1; done; exit 1'
ExecStart=/opt/nest/bin/nest-runner
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now nest-proxy.service nestd.service nest-runner.service
