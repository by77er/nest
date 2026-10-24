#!/bin/bash
# Installs a burst host's software: packages, the release from the cell's bucket (host binaries,
# Firecracker, the guest kernel and image), the jail user, Claude Code and the systemd units. Run
# twice: by the host-image pipeline (EC2 Image Builder, see docs/compute/provisioning/), which bakes
# it into the host AMI, and by every host's bootstrap, where it only fills in what the AMI lacks
# (everything, on stock Amazon Linux 2023). It enables nothing and holds no secrets.
set -euo pipefail

BUCKET="@BUCKET@"
REGION="@REGION@"
CLAUDE_VERSION="2.1.301"
# cloudflared: the host's Cloudflare Tunnel, run by nestd when enrollment hands it a tunnel token.
# A GitHub release binary, pinned by version and checksum (never committed to the repo).
CLOUDFLARED_VERSION="2026.10.3"
CLOUDFLARED_SHA256="053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0"
PACKAGES="nftables iproute util-linux bubblewrap e2fsprogs zstd"
export HOME=/root

# shellcheck disable=SC2086
rpm -q $PACKAGES >/dev/null || dnf install -y -q $PACKAGES

install -d -m 0755 /opt/nest/bin /usr/lib/nest /etc/nest /etc/claude-code /var/lib/nest /var/lib/nest/runner/cwd
# The release: skipped when the bucket's checksums match what's installed. The marker is written
# last, so a partial install is redone.
STAGE=$(mktemp -d /var/lib/nest/release.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
aws s3 cp --region "$REGION" --only-show-errors "s3://$BUCKET/releases/current/SHA256SUMS" "$STAGE/SHA256SUMS"
if cmp -s "$STAGE/SHA256SUMS" /opt/nest/release.sha256sums; then
  echo "release $(cat /opt/nest/release/VERSION) is installed"
else
  aws s3 cp --region "$REGION" --recursive --only-show-errors "s3://$BUCKET/releases/current/" "$STAGE/"
  (cd "$STAGE" && sha256sum -c --quiet SHA256SUMS)
  install -m 0755 "$STAGE"/{nestd,nest-proxy,nest-gateway,nest-guest,nest-runner,nest} /opt/nest/bin/
  # The managed settings' hooks run /usr/lib/nest/nest.
  install -m 0755 "$STAGE/nest" /usr/lib/nest/nest
  install -m 0644 "$STAGE/managed-settings.json" /etc/claude-code/managed-settings.json
  if [ -f "$STAGE/firecracker" ]; then
    install -m 0755 "$STAGE"/{firecracker,jailer} /opt/nest/bin/
    # The jailer hard-links the kernel and each disk into its chroot: same filesystem as /srv/jailer.
    install -d -m 0755 /var/lib/nest/images /var/lib/nest/kernel /srv/jailer
    install -m 0644 "$STAGE/vmlinux" /var/lib/nest/kernel/vmlinux
    # Compressed: bootstrap expands it on each host's first boot. Blocks baked into an AMI load
    # lazily from its snapshot on first read, and sandbox disks are reflinked copies of the base,
    # so a baked expanded image made every first commit crawl (it timed out on EC2).
    install -m 0644 "$STAGE/nest-base.ext4.zst" /var/lib/nest/images/nest-base.ext4.zst
    rm -f "/var/lib/nest/images/nest-base:latest.ext4"
  fi
  install -d -m 0755 /opt/nest/release
  install -m 0644 "$STAGE/VERSION" /opt/nest/release/VERSION
  install -m 0644 "$STAGE/SHA256SUMS" /opt/nest/release.sha256sums
fi
id -u nest-fc >/dev/null 2>&1 || useradd --system --uid 900 --user-group --no-create-home --shell /sbin/nologin nest-fc
# cloudflared runs as its own user, not as nestd (root).
id -u nest-cf >/dev/null 2>&1 || useradd --system --uid 901 --user-group --no-create-home --shell /sbin/nologin nest-cf

# Claude Code, pinned (the installer checks the release's checksum).
CLAUDE_BIN=/root/.local/bin/claude
if [ "$("$CLAUDE_BIN" --version 2>/dev/null | awk '{print $1}')" != "$CLAUDE_VERSION" ]; then
  curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_VERSION"
fi
echo "$CLAUDE_VERSION" > /etc/nest/claude-version

# cloudflared, pinned: skipped when the installed binary already has the pinned checksum.
CLOUDFLARED_BIN=/opt/nest/bin/cloudflared
if ! echo "$CLOUDFLARED_SHA256  $CLOUDFLARED_BIN" | sha256sum -c --quiet --status 2>/dev/null; then
  curl -fsSL -o "$STAGE/cloudflared" "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-amd64"
  echo "$CLOUDFLARED_SHA256  $STAGE/cloudflared" | sha256sum -c --quiet
  install -m 0755 "$STAGE/cloudflared" "$CLOUDFLARED_BIN"
fi

# Until logs ship elsewhere, the services also write to the serial console (`aws ec2 get-console-output`).
cat >/etc/systemd/system/nest-proxy.service <<'EOF'
[Unit]
Description=nest egress proxy
After=network-online.target
[Service]
# Under memory pressure the kernel kills a guest VMM (score 0), never nest's own services.
OOMScoreAdjust=-900
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
# Under memory pressure the kernel kills a guest VMM (score 0), never nest's own services.
OOMScoreAdjust=-900
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

# The sandbox gateway: the only way hands reach a guest. It connects to nestd's gateway socket and
# listens on loopback, where cloudflared forwards the host's tunnel hostname; the loopback URL nestd
# advertises in its hello counts only for a host without a tunnel.
cat >/etc/systemd/system/nest-gateway.service <<'EOF'
[Unit]
Description=nest sandbox gateway (hands over WebSocket to the guests' vsock ports)
After=nestd.service
Wants=nestd.service
[Service]
# Under memory pressure the kernel kills a guest VMM (score 0), never nest's own services.
OOMScoreAdjust=-900
StandardOutput=journal+console
StandardError=journal+console
Environment=RUST_LOG=info
ExecStartPre=/bin/sh -c 'for i in $(seq 60); do [ -S /run/nest/gateway.sock ] && exit 0; sleep 1; done; exit 1'
ExecStart=/opt/nest/bin/nest-gateway --listen 127.0.0.1:18790 --nestd-sock /run/nest/gateway.sock
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/nest-runner.service <<EOF
[Unit]
Description=nest agent runner (Claude Code brains)
After=nestd.service
Wants=nestd.service
[Service]
# Under memory pressure the kernel kills a guest VMM (score 0), never nest's own services.
OOMScoreAdjust=-900
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
