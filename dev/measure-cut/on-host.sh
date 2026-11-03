#!/bin/bash
# Runs as the user data of one disposable test instance launched by dev/measure-cut/run.sh (never
# on a cell's sandbox hosts): measures what a checkpoint's reflink cut costs on the instance store
# (docs/sandbox/state/disk/: M2's clone, and M3''s options with m3.py beside this script). Prints one
# JSON document to the serial console between NEST-MEASURE-BEGIN and NEST-MEASURE-END, then powers
# off (the instance terminates on shutdown). Needs the host AMI: Firecracker, the guest kernel and
# nest-base are baked in.
# First of all: the instance powers off (and so terminates) by this deadline, whatever hangs below.
shutdown -h +@DEADLINE_MIN@ || shutdown -P +@DEADLINE_MIN@
set -uo pipefail
# Output reaches the console once, through cloud-init (a second copy written to /dev/console
# interleaved with it, 2026-11-03, and broke the results line).
J=/root/results.json
# Whatever happens, what was measured goes to the console in short `NEST-R` lines (a long line gets
# kernel timestamps spliced into it), then the instance powers off.
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
now_us() { python3 -c 'import time; print(int(time.time()*1e6))'; }
H=$(dirname "$(realpath "$0")")
# `m3 <key> <args>`: m3.py's JSON under `key`, or its error under `<key>_error`.
m3() {
  local key=$1 out
  shift
  if out=$(python3 "$H/m3.py" "$@" 2>/root/m3.err); then
    put "$key" "$out"
    log "$key: $out"
  else
    put "${key}_error" "$(tail -c 1500 /root/m3.err | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
    log "$key failed"
  fi
}

dnf install -y -q xfsprogs e2fsprogs zstd python3 util-linux >/dev/null 2>&1 || true
put kernel "\"$(uname -r)\""
put instance_type "\"$(curl -s -H "X-aws-ec2-metadata-token: $(curl -s -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/instance-type)\""

# 1. The instance store, formatted as bootstrap.sh formats it.
NVME=$(lsblk -dpno NAME,MODEL | awk '/Amazon EC2 NVMe Instance Storage/ {print $1; exit}')
[ -n "$NVME" ] || { put error '"no instance store"'; exit 1; }
# With the exchange-range feature if this xfsprogs has it (M3' option 3 needs it).
if mkfs.xfs -q -f -m reflink=1 -i exchange=1 -L nest-measure "$NVME" 2>/root/mkfs.err; then
  put mkfs_exchange true
else
  put mkfs_exchange "$(python3 -c 'import json,sys; print(json.dumps(open("/root/mkfs.err").read()[-500:]))')"
  mkfs.xfs -q -f -m reflink=1 -L nest-measure "$NVME"
fi
put xfsprogs "\"$(mkfs.xfs -V 2>&1 | head -1)\""
M=/mnt/measure
mkdir -p $M && mount "$NVME" $M
put instance_store "$(lsblk -bdno SIZE "$NVME")"
put xfs_info "$(xfs_info $M | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"

# 2. A 32 GiB sandbox disk: nest-base reflinked and grown, as nestd's boot makes one.
zstd -q -d -f /var/lib/nest/images/nest-base.ext4.zst -o $M/base.ext4
cp --reflink=always $M/base.ext4 $M/disk.img
truncate -s 32G $M/disk.img
resize2fs -f $M/disk.img >/dev/null 2>&1

# Clone time: five clones of `disk.img`, median and max, in ms, with its extent count.
clones() {
  local tag=$1 out=()
  sync
  for i in 1 2 3 4 5; do
    rm -f $M/cut.img
    local a b
    a=$(now_us); cp --reflink=always $M/disk.img $M/cut.img; b=$(now_us)
    out+=($(( (b - a) / 1000 )))
  done
  rm -f $M/cut.img
  local extents
  extents=$(filefrag $M/disk.img | awk '{print $2}')
  put "clone_$tag" "{\"extents\": $extents, \"ms\": [$(IFS=,; echo "${out[*]}")]}"
  log "clone $tag: $extents extents, ${out[*]} ms"
  # M3' option 1's in-pause cost: one FIEMAP walk of the whole map; and XFS's O(1) count.
  m3 "walk_$tag" walk $M/disk.img
}

# Random 4 KiB writes over the first `span` GiB of the disk, as a guest's churn: `n` writes.
churn() { churn_file "$M/disk.img" "$1" "$2"; }
churn_file() {
  python3 - "$1" "$2" "$3" <<'PY'
import os, random, sys
path, span, n = sys.argv[1], int(sys.argv[2]) << 30, int(sys.argv[3])
fd = os.open(path, os.O_WRONLY)
buf = os.urandom(4096)
for _ in range(n):
    os.pwrite(fd, buf, random.randrange(span // 4096) * 4096)
os.fsync(fd)
PY
}

clones fresh
# 1 GiB of churn after a cut, so every write copies on write (the base cut holds the old blocks).
cp --reflink=always $M/disk.img $M/base-cut.img
churn 16 262144
clones churn_1gib
rm -f $M/base-cut.img
# A month of turn ends: a cut, a turn's worth of scattered writes, the previous cut dropped, 300 times.
for r in $(seq 300); do
  cp --reflink=always $M/disk.img $M/cut-$r.img
  churn 16 2000
  rm -f $M/cut-$((r - 1)).img
done
rm -f $M/cut-*.img
clones month

# M3' option 1 with no VM, on the month-aged disk: a shadow cut once (an M2 clone), then a turn's
# writes and the pre-copy, then the last writes and the in-pause step; again after 1 GiB.
cp --reflink=always $M/disk.img $M/shadow.img
m3 opt1_turn opt1 $M/disk.img $M/shadow.img 2000 50 16
m3 opt1_1gib opt1 $M/disk.img $M/shadow.img 262144 50 16

# M3' option 3: a CoW extent size hint, on fresh disks with the same 1 GiB of churn after a cut.
for hint in 0 1m 4m; do
  cp --reflink=always $M/base.ext4 $M/h.img
  truncate -s 32G $M/h.img
  resize2fs -f $M/h.img >/dev/null 2>&1
  [ "$hint" = 0 ] || xfs_io -c "cowextsize $hint" $M/h.img
  hinted=$(xfs_io -c cowextsize $M/h.img 2>&1 | tr -d '[]\n ')
  cp --reflink=always $M/h.img $M/h-cut.img
  churn_file $M/h.img 16 262144
  sync
  hms=()
  for i in 1 2 3; do
    rm -f $M/h-c.img
    a=$(now_us); cp --reflink=always $M/h.img $M/h-c.img; b=$(now_us)
    hms+=($(( (b - a) / 1000 )))
  done
  ext=$(filefrag $M/h.img | awk '{print $2}')
  put "hint_$hint" "{\"set\": \"$hinted\", \"extents\": $ext, \"ms\": [$(IFS=,; echo "${hms[*]}")]}"
  log "hint $hint ($hinted): $ext extents, ${hms[*]} ms"
  rm -f $M/h.img $M/h-cut.img $M/h-c.img
done

# M3' option 3's defragmentation needs exchange-range: one exchange while a writer runs.
mkdir -p $M/x && m3 exchange exchange $M/x
rm -rf $M/x

# Chunking throughput: reading a cut cold (the store's read of it; hashing is ~4 GiB/s per core).
cp --reflink=always $M/disk.img $M/cut.img
sync; echo 3 > /proc/sys/vm/drop_caches
a=$(now_us); bytes=$(python3 - $M/cut.img <<'PY'
import os, sys
fd, n, off = os.open(sys.argv[1], os.O_RDONLY), 0, 0
size = os.fstat(fd).st_size
while off < size:
    try:
        d = os.lseek(fd, off, os.SEEK_DATA)
    except OSError:
        break
    h = os.lseek(fd, d, os.SEEK_HOLE)
    while d < h:
        b = os.pread(fd, min(4 << 20, h - d), d)
        n += len(b); d += len(b)
    off = h
print(n)
PY
); b=$(now_us)
put read_cut "{\"bytes\": $bytes, \"ms\": $(( (b - a) / 1000 ))}"
rm -f $M/cut.img

# 3. Guest write stalls during the pause: a VM on the month-aged disk whose init writes 4 KiB
# O_DSYNC records (dd) and prints, every second, its slowest write. The host pauses it every 5 s:
# six M2 cuts (pause, whole clone, resume), then six M3' option 1 cuts (pre-copy while it runs,
# then pause, residue, resume). A shell writer: the guest needs no python.
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
# The aged disk's filesystem is wrecked by the scattered writes (its guest can't mount it: the
# 2026-11-03 run's kernel panicked), so the VM boots a fresh base copy and writes the aged disk raw,
# as its second drive: that file is the one cut.
cp --reflink=always $M/base.ext4 $M/root.img
debugfs -w -R "write /root/init.sh /nest-measure-init" $M/root.img >/dev/null 2>&1
debugfs -w -R "sif /nest-measure-init mode 0100755" $M/root.img >/dev/null 2>&1
put vm_files "$(ls -l /opt/nest/bin/firecracker /var/lib/nest/kernel/vmlinux /dev/kvm 2>&1 | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
API=/run/fc-measure.sock
rm -f $API
/opt/nest/bin/firecracker --api-sock $API > /root/vm.log 2>&1 &
FC=$!
sleep 1
call() { curl -s --unix-socket $API -X "$1" "http://localhost$2" -H 'Content-Type: application/json' -d "$3"; }
R=()
R+=("$(call PUT /machine-config '{"vcpu_count": 2, "mem_size_mib": 1024, "smt": false}')")
R+=("$(call PUT /boot-source '{"kernel_image_path": "/var/lib/nest/kernel/vmlinux", "boot_args": "console=ttyS0 reboot=k panic=1 pci=off init=/nest-measure-init"}')")
R+=("$(call PUT /drives/rootfs "{\"drive_id\": \"rootfs\", \"path_on_host\": \"$M/root.img\", \"is_root_device\": true, \"is_read_only\": false}")")
R+=("$(call PUT /drives/aged "{\"drive_id\": \"aged\", \"path_on_host\": \"$M/disk.img\", \"is_root_device\": false, \"is_read_only\": false}")")
R+=("$(call PUT /actions '{"action_type": "InstanceStart"}')")
put fc_api "$(printf '%s\n' "${R[@]}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
sleep 20
# Whether the VM is up, and its console's tail either way (2026-11-03's run had no guest lines).
if kill -0 $FC 2>/dev/null; then put vm_running true; else put vm_running false; fi
PAUSES=()
for k in $(seq 6); do
  sync -f $M/disk.img 2>/dev/null || sync
  a=$(now_us)
  call PATCH /vm '{"state": "Paused"}'
  cp --reflink=always $M/disk.img $M/cut.img
  call PATCH /vm '{"state": "Resumed"}'
  b=$(now_us)
  PAUSES+=("[$((a / 1000)), $(( (b - a) / 1000 ))]")
  rm -f $M/cut.img
  sleep 5
done
put cut_while_writing_m2 "{\"pauses_ms\": [$(IFS=,; echo "${PAUSES[*]}")]}"
m3 cut_while_writing_opt1 opt1vm $M/disk.img $M/shadow.img $API 6
sleep 2
kill $FC
put vm_log "$(tail -c 3000 /root/vm.log | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
put guest_stalls "[$(grep -o 'NEST-STALL [0-9]* [0-9]* [0-9]*' /root/vm.log | awk '{printf "%s[%s, %s, %s]", (n++ ? "," : ""), $2, $3, $4}')]"
put done true
