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

ID=""
cleanup() {
  if [ -n "$ID" ]; then
    echo "terminating $ID"
    aws ec2 terminate-instances --region "$REGION" --instance-ids "$ID" >/dev/null || echo "terminate $ID failed: terminate it by hand" >&2
  fi
}
trap cleanup EXIT

ID=$(aws ec2 run-instances --region "$REGION" "${DRY[@]}" \
  --launch-template "LaunchTemplateName=$TEMPLATE" \
  --instance-type "$TYPE" \
  --user-data "fileb://$HERE/on-host.sh" \
  --instance-initiated-shutdown-behavior terminate \
  --tag-specifications "ResourceType=instance,Tags=[{Key=nest,Value=measurement},{Key=Name,Value=nest-$CELL-measure-cut}]" \
  --query 'Instances[0].InstanceId' --output text)
echo "launched $ID ($TYPE, from $TEMPLATE)"

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
grep '^measure:' "$OUT" || true
RESULT="$HERE/results-$ID.json"
if sed -n '/NEST-MEASURE-BEGIN/,/NEST-MEASURE-END/p' "$OUT" | sed '1d;$d' | python3 -I -m json.tool > "$RESULT"; then
  echo "results: $RESULT"
else
  echo "no results on the console (see $OUT)" >&2
  exit 1
fi
