#!/bin/bash
# Runs as the user data of one disposable test instance launched by dev/measure-cut/run.sh (never
# on a cell's sandbox hosts): measures what a checkpoint's reflink cut costs on the instance store
# (docs/sandbox/state/disk/, M2 with the owner's option 1: a brief pause for the clone). Prints one
# JSON document to the serial console between NEST-MEASURE-BEGIN and NEST-MEASURE-END, then powers
# off (the instance terminates on shutdown). Needs the host AMI: Firecracker, the guest kernel and
# nest-base are baked in.
set -uo pipefail
exec > >(tee /dev/console) 2>&1
J=/root/results.json
# Whatever happens, what was measured goes to the console, then the instance powers off.
trap 'echo NEST-MEASURE-BEGIN; cat "$J"; echo; echo NEST-MEASURE-END; sync; shutdown -h now' EXIT
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

dnf install -y -q xfsprogs e2fsprogs zstd python3 util-linux >/dev/null 2>&1 || true
put kernel "\"$(uname -r)\""
put instance_type "\"$(curl -s -H "X-aws-ec2-metadata-token: $(curl -s -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/instance-type)\""

# 1. The instance store, formatted as bootstrap.sh formats it.
NVME=$(lsblk -dpno NAME,MODEL | awk '/Amazon EC2 NVMe Instance Storage/ {print $1; exit}')
[ -n "$NVME" ] || { put error '"no instance store"'; exit 1; }
mkfs.xfs -q -f -m reflink=1 -L nest-measure "$NVME"
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
}

# Random 4 KiB writes over the first `span` GiB of the disk, as a guest's churn: `n` writes.
churn() {
  python3 - "$M/disk.img" "$1" "$2" <<'PY'
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

# 3. Guest write stalls during the pause: a VM on the disk whose init writes 4 KiB O_DSYNC records
# and prints, every second, its slowest write; the host cuts every 5 s (pause, clone, resume).
cat > /root/writer.py <<'PY'
import os, time
fd = os.open("/stall", os.O_WRONLY | os.O_CREAT | os.O_DSYNC, 0o644)
buf, i, t0, worst = b"\xa5" * 4096, 0, time.time(), 0.0
while True:
    a = time.time()
    os.pwrite(fd, buf, (i % 65536) * 4096)
    worst = max(worst, time.time() - a)
    i += 1
    if time.time() - t0 >= 1:
        print(f"NEST-STALL {int(time.time() * 1000)} {int(worst * 1e6)} {i}", flush=True)
        t0, worst = time.time(), 0.0
PY
printf '#!/bin/sh\nmount -o remount,rw /\nexec python3 /writer.py\n' > /root/init.sh
debugfs -w -R "write /root/writer.py /writer.py" $M/disk.img >/dev/null 2>&1
debugfs -w -R "write /root/init.sh /nest-measure-init" $M/disk.img >/dev/null 2>&1
debugfs -w -R "sif /nest-measure-init mode 0100755" $M/disk.img >/dev/null 2>&1
API=/run/fc-measure.sock
rm -f $API
/opt/nest/bin/firecracker --api-sock $API > /root/vm.log 2>&1 &
FC=$!
sleep 1
call() { curl -s --unix-socket $API -X "$1" "http://localhost$2" -H 'Content-Type: application/json' -d "$3"; }
call PUT /machine-config '{"vcpu_count": 2, "mem_size_mib": 1024, "smt": false}'
call PUT /boot-source '{"kernel_image_path": "/var/lib/nest/kernel/vmlinux", "boot_args": "console=ttyS0 reboot=k panic=1 pci=off init=/nest-measure-init"}'
call PUT /drives/rootfs "{\"drive_id\": \"rootfs\", \"path_on_host\": \"$M/disk.img\", \"is_root_device\": true, \"is_read_only\": false}"
call PUT /actions '{"action_type": "InstanceStart"}'
sleep 20
PAUSES=()
for k in $(seq 12); do
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
kill $FC
put cut_while_writing "{\"pauses_ms\": [$(IFS=,; echo "${PAUSES[*]}")], \"guest\": [$(grep -o 'NEST-STALL [0-9]* [0-9]* [0-9]*' /root/vm.log | awk '{printf "%s[%s, %s, %s]", (n++ ? "," : ""), $2, $3, $4}')]}"
put done true
