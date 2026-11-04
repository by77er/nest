#!/bin/bash
# Measures a checkpoint's reflink cut on one disposable instance of an instance-store type (M2's
# gate, docs/sandbox/state/disk/): clone time against extent count (a fresh 32 GiB disk, after
# 1 GiB of churn, after a simulated month of turn ends), reading a cut cold, and a guest's write
# stalls while a VM is paused for the clone. Not a CI job: it spends EC2 time, and only the owner's
# go-ahead runs it.
#
#   dev/measure-cut/run.sh [cell] [instance type]        # defaults: use1 c8id.large
#
# It launches from the cell's host launch template (its AMI, role, security group, nested
# virtualization) with this script's own user data (dev/measure-cut/on-host.sh), so the instance
# never runs bootstrap.sh and never enrolls. FleetDO tracks only the instances it launched, so it
# neither counts nor reaps this one; it is tagged `nest=measurement` (over the template's
# `nest=true`, if RunInstances' tags win as documented: unverified) so it reads as what it is. Results come back on the serial console (no bucket writes); the JSON is
# written to dev/measure-cut/results-<instance>.json. The instance terminates when it finishes, and
# this script terminates it on any exit (an error, a timeout, Ctrl-C).
#
# Needs the AWS CLI with credentials that may run, describe and terminate instances from that
# template (the cell's deploy role, or an operator's). `MEASURE_DRY_RUN=1` checks the permissions
# with EC2's dry run and launches nothing.
set -euo pipefail
CELL=${1:-use1}
TYPE=${2:-c8id.large}
REGION=${AWS_REGION:-us-east-1}
HERE=$(dirname "$(realpath "$0")")
TEMPLATE="nest-$CELL-host"
TIMEOUT_S=${MEASURE_TIMEOUT_S:-5400}
DRY=()
[ "${MEASURE_DRY_RUN:-0}" = 1 ] && DRY=(--dry-run)

# Nothing may outlive the run. Four layers, each enough alone:
# - the instance powers itself off (terminating it) when on-host.sh ends, and at the latest
#   MEASURE_DEADLINE_MIN after boot, whatever hangs (on-host.sh's first line);
# - this script terminates it by id on any exit (an error, a timeout, Ctrl-C, SIGTERM) and waits for
#   `terminated`;
# - a sweep by the run's tag (`nest-measure=<run id>`) afterwards terminates anything of the run
#   still not terminated, and must find nothing;
# - the id and tag are printed (and written to $HERE/last-run) the moment it launches, so a person
#   can terminate it by hand if this script is killed outright.
RUN_ID=${MEASURE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}
ID=""
sweep() {
  aws ec2 describe-instances --region "$REGION" \
    --filters "Name=tag:nest-measure,Values=$RUN_ID" "Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text
}
cleanup() {
  trap - EXIT INT TERM HUP
  [ -n "${DRY[*]}" ] && return
  if [ -n "$ID" ]; then
    echo "terminating $ID"
    aws ec2 terminate-instances --region "$REGION" --instance-ids "$ID" >/dev/null || echo "terminate $ID failed: terminate it by hand" >&2
    aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$ID" || echo "$ID not terminated yet: check it" >&2
  fi
  local left
  left=$(sweep)
  if [ -n "$left" ]; then
    echo "sweep: terminating $left (tag nest-measure=$RUN_ID)" >&2
    # shellcheck disable=SC2086
    aws ec2 terminate-instances --region "$REGION" --instance-ids $left >/dev/null
    # shellcheck disable=SC2086
    aws ec2 wait instance-terminated --region "$REGION" --instance-ids $left || true
    left=$(sweep)
  fi
  echo "sweep (tag nest-measure=$RUN_ID, every state but terminated): ${left:-none}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# The user data: the power-off deadline first, in plain text, then on-host.sh and m3.py as a
# gzipped tarball it unpacks and runs (EC2 allows 16 KB of user data).
DEADLINE=${MEASURE_DEADLINE_MIN:-90}
PACK=$(mktemp -d)
sed "s/@DEADLINE_MIN@/$DEADLINE/" "$HERE/on-host.sh" > "$PACK/on-host.sh"
cp "$HERE/fdiff.c" "$PACK/"
USER_DATA=$(mktemp)
{
  echo '#!/bin/bash'
  echo "shutdown -h +$DEADLINE || shutdown -P +$DEADLINE"
  echo "mkdir -p /root/measure && base64 -d <<'NEST_PACK' | tar -xz -C /root/measure"
  tar -czf - -C "$PACK" on-host.sh fdiff.c | base64
  echo 'NEST_PACK'
  echo 'exec bash /root/measure/on-host.sh'
} > "$USER_DATA"
size=$(wc -c < "$USER_DATA")
[ "$size" -le 16384 ] || { echo "user data is $size bytes, over EC2's 16384" >&2; exit 1; }
echo "user data: $size bytes"
# The template names the cell's security group but no subnet: a subnet of that group's VPC, each AZ in
# turn until one has the capacity (or MEASURE_SUBNET).
SG=$(aws ec2 describe-launch-template-versions --region "$REGION" --launch-template-name "$TEMPLATE" --versions '$Default' \
  --query 'LaunchTemplateVersions[0].LaunchTemplateData.SecurityGroupIds[0]' --output text)
VPC=$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$SG" --query 'SecurityGroups[0].VpcId' --output text)
SUBNETS=${MEASURE_SUBNET:-$(aws ec2 describe-subnets --region "$REGION" --filters "Name=vpc-id,Values=$VPC" --query 'Subnets[].SubnetId' --output text)}
for SUBNET in $SUBNETS; do
  if ID=$(aws ec2 run-instances --region "$REGION" "${DRY[@]}" \
  --launch-template "LaunchTemplateName=$TEMPLATE" \
  --instance-type "$TYPE" --subnet-id "$SUBNET" \
  --user-data "fileb://$USER_DATA" \
  --instance-initiated-shutdown-behavior terminate \
  --tag-specifications "ResourceType=instance,Tags=[{Key=nest,Value=measurement},{Key=nest-measure,Value=$RUN_ID},{Key=Name,Value=nest-$CELL-measure-cut}]" \
    "ResourceType=volume,Tags=[{Key=nest,Value=measurement},{Key=nest-measure,Value=$RUN_ID}]" \
  --query 'Instances[0].InstanceId' --output text); then break; fi
  ID=""
  [ -n "${DRY[*]}" ] && exit 1
done
[ -n "$ID" ] || { echo "no subnet of $VPC launched a $TYPE" >&2; exit 1; }
echo "launched $ID ($TYPE, from $TEMPLATE), tag nest-measure=$RUN_ID: if this script dies, terminate it by hand"
echo "$ID nest-measure=$RUN_ID $REGION" > "$HERE/last-run"
# Every volume it has goes with it.
aws ec2 describe-instances --region "$REGION" --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].BlockDeviceMappings[].[DeviceName,Ebs.VolumeId,Ebs.DeleteOnTermination]' --output text

OUT=$(mktemp)
deadline=$(( $(date +%s) + TIMEOUT_S ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 60
  aws ec2 get-console-output --region "$REGION" --instance-id "$ID" --latest --output text --query Output > "$OUT" 2>/dev/null || true
  if grep -q NEST-MEASURE-END "$OUT"; then break; fi
  state=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$ID" --query 'Reservations[0].Instances[0].State.Name' --output text)
  echo "$(date -u +%H:%M:%S) $ID $state"
  [ "$state" = terminated ] && break
done
# EC2 posts the console in snapshots that can lag by many minutes (2026-11-03: the last one before the
# power-off was 28 minutes old, and the one with the results came 9 minutes after it): keep reading
# for up to 20 minutes after it terminates.
if ! grep -q NEST-MEASURE-END "$OUT"; then
  late=$(( $(date +%s) + 1200 ))
  while [ "$(date +%s)" -lt "$late" ]; do
    aws ec2 get-console-output --region "$REGION" --instance-id "$ID" --latest --output text --query Output > "$OUT" 2>/dev/null || true
    grep -q NEST-MEASURE-END "$OUT" && break
    echo "$(date -u +%H:%M:%S) waiting for the console snapshot with the results"
    sleep 60
  done
fi
grep -o 'measure: .*' "$OUT" || true
RESULT="$HERE/results-$ID.json"
# The JSON comes in `NEST-R <400 chars>` lines (cloud-init's console copy, each with its own prefix);
# the console can still splice a `[<timestamp>]` into one.
if grep -o 'NEST-R .*' "$OUT" | sed -E 's/^NEST-R //; s/\[[0-9]{4}-[0-9T:.-]+\]//g' | tr -d '\n' | python3 -I -m json.tool > "$RESULT"; then
  echo "results: $RESULT"
else
  echo "no results on the console (see $OUT)" >&2
  exit 1
fi
