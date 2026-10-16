#!/bin/bash
# Burst-host bootstrap (EC2 user-data, rendered by the cell stack in deploy/). It holds no secrets:
# the host proves itself with its signed instance identity document, and reads its binaries from
# the cell's bucket through the instance role. Until the burst image is built (Packer, see
# docs/compute/provisioning/), it installs everything at boot on stock Amazon Linux 2023.
set -euo pipefail
exec > >(tee -a /var/log/nest-bootstrap.log) 2>&1

BUCKET="@BUCKET@"
CELL="@CELL@"
REGION="@REGION@"
CONTROL_URL="@CONTROL_URL@"

dnf install -y -q nftables iproute util-linux

install -d -m 0755 /opt/nest/bin /etc/nest /var/lib/nest /run/nest
aws s3 cp --region "$REGION" --recursive --only-show-errors "s3://$BUCKET/releases/current/" /opt/nest/bin/
chmod 0755 /opt/nest/bin/*

cat >/etc/nest/nestd.json <<EOF
{
  "role": "burst",
  "cell": "$CELL",
  "control_url": "$CONTROL_URL",
  "enrollment": {"type": "aws_imds"},
  "driver": {"type": "process", "guest_command": ["/opt/nest/bin/nest-guest", "--state-dir", "/var/lib/nest/guest",
    "--cgroup-root", "none", "--cli-socket", "none", "--run-as", "none"]},
  "network": {"type": "netns", "persist_dir": "/run/nest/netns"},
  "versions": {"nest_proxy": "$(cat /opt/nest/bin/VERSION 2>/dev/null || echo unknown)", "agent_runner": "none", "claude_code": "none"}
}
EOF

cat >/etc/systemd/system/nest-proxy.service <<'EOF'
[Unit]
Description=nest egress proxy
After=network-online.target
[Service]
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
Environment=RUST_LOG=info
ExecStart=/opt/nest/bin/nestd --config /etc/nest/nestd.json
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now nest-proxy.service nestd.service
