#!/bin/bash
# M3' option 1 as nestd ships it, on one disposable instance-store instance (run.sh with
# MEASURE_SCRIPT=on-host-m3-nestd.sh MEASURE_FILES="m3-nestd.tgz"): builds the cut extracted from a
# nestd revision (extract-cut.py, m3-nestd.rs), ages a 32 GiB disk, boots a VM writing it, and runs
# m3-nestd: shadow cuts, then M2 and M1 on the same disk. NEST-R lines on the console, then power off.
shutdown -h +@DEADLINE_MIN@ || shutdown -P +@DEADLINE_MIN@
set -uo pipefail
J=/root/results.json
trap 'echo NEST-MEASURE-BEGIN; python3 -c "import sys; t=open(sys.argv[1]).read(); [print(\"NEST-R \" + t[i:i+400]) for i in range(0, len(t), 400)]" "$J"; echo NEST-MEASURE-END; sync; sleep 5; shutdown -h now' EXIT
log() { echo "measure: $*"; }
echo '{}' > "$J"
put() { python3 - "$J" "$1" "$2" <<'PY'
import json, sys
p, k, v = sys.argv[1:]
d = json.load(open(p))
d[k] = json.loads(v)
json.dump(d, open(p, "w"))
PY
}
jstr() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[-1500:]))'; }
H=$(dirname "$(realpath "$0")")
t_start=$(date +%s)
put kernel "\"$(uname -r)\""
put instance_type "\"$(curl -s -H "X-aws-ec2-metadata-token: $(curl -s -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/instance-type)\""
dnf install -y -q xfsprogs e2fsprogs zstd python3 gcc >/dev/null 2>&1 || true

# The build, in the background while the disk ages: a pinned toolchain, the crate from the pack.
mkdir -p /root/m3 && tar -xzf "$H/m3-nestd.tgz" -C /root/m3
( export HOME=/root CARGO_HOME=/root/.cargo RUSTUP_HOME=/root/.rustup
  curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal --default-toolchain 1.97.0 >/root/build.log 2>&1 &&
  cd /root/m3 && /root/.cargo/bin/cargo build --release -q >>/root/build.log 2>&1 && echo ok >>/root/build.log ) &
BUILD=$!

NVME=$(lsblk -dpno NAME,MODEL | awk '/Amazon EC2 NVMe Instance Storage/ {print $1; exit}')
[ -n "$NVME" ] || { put error '"no instance store"'; exit 1; }
mkfs.xfs -q -f -m reflink=1 -L nest-measure "$NVME"
M=/mnt/measure
mkdir -p $M && mount "$NVME" $M
[ "$(findmnt -no SOURCE $M)" = "$NVME" ] || { put error '"not the instance store"'; exit 1; }

# A 32 GiB disk from nest-base, aged: twice, a cut held while 400 k random 4 KiB writes copy on write
# over its first 16 GiB, then dropped (about a month of turn ends' records, cheaper than 300 cuts).
zstd -q -d -f /var/lib/nest/images/nest-base.ext4.zst -o $M/base.ext4
cp --reflink=always $M/base.ext4 $M/disk.img
truncate -s 32G $M/disk.img
resize2fs -f $M/disk.img >/dev/null 2>&1
a=$(date +%s)
for r in 1 2; do
  cp --reflink=always $M/disk.img $M/held.img
  python3 - $M/disk.img <<'PY'
import os, random, sys
fd, span = os.open(sys.argv[1], os.O_WRONLY), 16 << 30
buf = os.urandom(4096)
for _ in range(400000):
    os.pwrite(fd, buf, random.randrange(span // 4096) * 4096)
os.fsync(fd)
PY
  rm -f $M/held.img
done
put aging "{\"s\": $(( $(date +%s) - a )), \"filefrag\": \"$(filefrag $M/disk.img | awk '{print $2}')\"}"

wait $BUILD
put build "$(tail -c 1500 /root/build.log | jstr)"
[ -x /root/m3/target/release/m3-nestd ] || { put error '"the build failed"'; exit 1; }

# The VM: a fresh root, and the aged disk as its second drive, written raw by a 4 KiB O_DSYNC writer
# that prints its slowest write each second (as on-host.sh's stall measurement).
cat > /root/init.sh <<'SH'
#!/bin/sh
mount -o remount,rw /
i=0; w=0; t0=$(date +%s)
while :; do
  s=$(date +%s%N)
  dd if=/dev/zero of=/dev/vdb bs=4096 count=1 seek=$(( (i * 7919) % 4194304 )) oflag=direct,dsync conv=notrunc 2>/dev/null
  e=$(date +%s%N)
  d=$(( (e - s) / 1000 ))
  [ "$d" -gt "$w" ] && w=$d
  i=$((i + 1))
  t=$(date +%s)
  if [ "$t" != "$t0" ]; then echo "NEST-STALL $((e / 1000000)) $w $i"; w=0; t0=$t; fi
done
SH
cp --reflink=always $M/base.ext4 $M/root.img
debugfs -w -R "write /root/init.sh /nest-measure-init" $M/root.img >/dev/null 2>&1
debugfs -w -R "sif /nest-measure-init mode 0100755" $M/root.img >/dev/null 2>&1
API=/run/fc-measure.sock
rm -f $API
/opt/nest/bin/firecracker --api-sock $API > /root/vm.log 2>&1 &
FC=$!
sleep 1
call() { curl -s --unix-socket $API -X "$1" "http://localhost$2" -H 'Content-Type: application/json' -d "$3"; }
call PUT /machine-config '{"vcpu_count": 2, "mem_size_mib": 1024, "smt": false}'
call PUT /boot-source '{"kernel_image_path": "/var/lib/nest/kernel/vmlinux", "boot_args": "console=ttyS0 reboot=k panic=1 pci=off init=/nest-measure-init"}'
call PUT /drives/rootfs "{\"drive_id\": \"rootfs\", \"path_on_host\": \"$M/root.img\", \"is_root_device\": true, \"is_read_only\": false}"
call PUT /drives/aged "{\"drive_id\": \"aged\", \"path_on_host\": \"$M/disk.img\", \"is_root_device\": false, \"is_read_only\": false}"
call PUT /actions '{"action_type": "InstanceStart"}'
sleep 20
if kill -0 $FC 2>/dev/null; then put vm_running true; else put vm_running false; fi

mkdir -p $M/shadows
if out=$(/root/m3/target/release/m3-nestd $M/disk.img $M/shadows $API "${M3_CUTS:-30}" 5 5 1 2>/root/m3.err); then
  # Kept whole as a string if it isn't valid JSON (2026-11-06's first run lost its results so).
  put m3 "$out" || put m3_raw "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
else
  put m3_error "$(cat /root/m3.err | jstr)"
fi
kill $FC
put m3_log "$(grep -c '^measure: cut' /root/m3.err)"
put guest_stalls "[$(grep -o 'NEST-STALL [0-9]* [0-9]* [0-9]*' /root/vm.log | awk '{printf "%s[%s, %s, %s]", (n++ ? "," : ""), $2, $3, $4}')]"
put total_s "$(( $(date +%s) - t_start ))"
put done true
