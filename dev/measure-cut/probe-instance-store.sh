#!/bin/bash
# A short probe on one disposable instance-store instance, launched by run.sh with
# MEASURE_SCRIPT=probe-instance-store.sh (MEASURE_DEADLINE_MIN=20): does a process confined as the
# gateway's unit confines it (its user, ProtectSystem, InaccessiblePaths) reach a VM's vsock socket in
# a jailer chroot, in bootstrap's instance-store layout (`/srv/nest`, the 2026-11-05 fix) and in the
# old one (`/var/lib/nest/data`, which failed every hands call on 2026-11-04)? The unit's own
# properties are read from the AMI's /etc/systemd/system/nest-gateway.service. No nestd, no
# enrollment, nothing of the control plane. Prints one JSON document to the console, then powers off.
shutdown -h +@DEADLINE_MIN@ || shutdown -P +@DEADLINE_MIN@
set -uo pipefail
exec > >(tee /dev/console) 2>&1
J=/root/results.json
trap 'echo NEST-MEASURE-BEGIN; cat "$J"; echo; echo NEST-MEASURE-END; sync; sleep 5; shutdown -h now' EXIT
put() { python3 - "$J" "$1" "$2" <<'PY'
import json, sys
p, k, v = sys.argv[1:]
d = json.load(open(p))
d[k] = json.loads(v)
json.dump(d, open(p, "w"))
PY
}
echo '{}' > "$J"
put kernel "\"$(uname -r)\""
put instance_type "\"$(curl -s -H "X-aws-ec2-metadata-token: $(curl -s -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/instance-type)\""
UNIT=/etc/systemd/system/nest-gateway.service
UNIT_HIDDEN=$(sed -n 's/^InaccessiblePaths=//p' "$UNIT" | tr '\n' ' ')
put unit_inaccessible "\"$UNIT_HIDDEN\""
id nest-gw >/dev/null 2>&1 || { put error '"no nest-gw user on this AMI"'; exit 1; }
GW_GID=$(id -g nest-gw)

# The instance store, as bootstrap formats and mounts it.
NVME=$(lsblk -dpno NAME,MODEL | awk '/Amazon EC2 NVMe Instance Storage/ {print $1; exit}')
[ -n "$NVME" ] || { put error '"no instance store"'; exit 1; }
mkfs.xfs -q -f -K -m reflink=1 -L nest-data "$NVME"
install -d -m 0755 /srv/nest && mount "$NVME" /srv/nest
put mounted "\"$(findmnt -no SOURCE,FSTYPE /srv/nest | tr -s ' ')\""

# A jail as nestd makes one (each directory 0711, the root 0710 to the gateway's group) with a listening
# vsock-like socket (0660, the gateway's group), under `base`; then a client confined as the gateway.
probe() {
  local key=$1 base=$2 hidden=$3
  local root=$base/firecracker/sbx_probe/root
  install -d -m 0711 "$base" "$base/firecracker" "$base/firecracker/sbx_probe"
  install -d -m 0710 -g "$GW_GID" "$root"
  python3 - "$root/vsock.sock" "$GW_GID" <<'PY' &
import os, socket, sys
path, gid = sys.argv[1], int(sys.argv[2])
try: os.unlink(path)
except FileNotFoundError: pass
s = socket.socket(socket.AF_UNIX); s.bind(path); os.chown(path, 0, gid); os.chmod(path, 0o660); s.listen(1)
c, _ = s.accept(); c.sendall(b"hello"); c.close()
PY
  sleep 1
  local out
  out=$(systemd-run --wait --pipe --quiet -p User=nest-gw -p Group=nest-gw -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes \
    -p "InaccessiblePaths=$hidden" python3 -c "
import socket, sys
s = socket.socket(socket.AF_UNIX)
try:
    s.connect(sys.argv[1]); print('connected', s.recv(5).decode())
except OSError as e:
    print('failed', e)
" "$root/vsock.sock" 2>&1)
  put "$key" "\"$(echo "$out" | tr -d '"\n')\""
  kill %1 2>/dev/null
}
# The fix: the store at /srv/nest, the gateway's unit plus bootstrap's drop-in (state, kernel, images hidden).
install -d -m 0700 /srv/nest/state /srv/nest/kernel /srv/nest/images
probe new_layout /srv/nest/jailer "$UNIT_HIDDEN -/srv/nest/state -/srv/nest/kernel -/srv/nest/images"
# The old layout: the chroots under /var/lib/nest/data (expected to fail: the unit hides /var/lib/nest).
probe old_layout /var/lib/nest/data/jailer "$UNIT_HIDDEN"
# And the state stays hidden from the gateway under the fix.
out=$(systemd-run --wait --pipe --quiet -p User=nest-gw -p ProtectSystem=strict -p "InaccessiblePaths=$UNIT_HIDDEN -/srv/nest/state -/srv/nest/kernel -/srv/nest/images" ls /srv/nest/state 2>&1)
put state_from_gateway "\"$(echo "$out" | tr -d '"\n')\""
put done true
