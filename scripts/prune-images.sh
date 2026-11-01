#!/bin/bash
# Deletes a cell's dangling images so they stop costing money (dev/deploy.md, "Pruning images"):
#  - host AMIs (and their snapshots and Image Builder records) except the one the launch template resolves
#    to (the SSM parameter), the two newest (the rollback), and any a live instance runs. Image Builder's
#    own lifecycle policy can't do this: it counts per recipe version, so every old version keeps its
#    newest images forever (https://docs.aws.amazon.com/imagebuilder/latest/userguide/image-lifecycle-rules.html).
#  - guest image builds in the bucket (images/guest/<build id>/) except the two newest; `previous-*`
#    backups are kept. The builder's staging files (builder/) go. The bucket expires noncurrent versions
#    after a day (deploy/lean/Cell/Stack.lean), so deleted objects stop costing then.
#
#   scripts/prune-images.sh <cell> <bucket>        # DRY_RUN=1: print what would go, change nothing
set -euo pipefail
CELL=$1 BUCKET=$2
REGION=${AWS_REGION:-us-east-1}
DRY=${DRY_RUN:-0}
aws_() { aws --region "$REGION" "$@"; }
act() { if [ "$DRY" = 1 ]; then echo "would: $*"; else "$@"; fi; }

current=$(aws_ ssm get-parameter --name "/imagebuilder/nest-$CELL/host-ami" --query Parameter.Value --output text)
in_use=$(aws_ ec2 describe-instances --filters Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].ImageId' --output text)
# Newest first: "<ami> <created> <Image Builder ARN or None> <snapshot ids…>".
amis=$(aws_ ec2 describe-images --owners self --filters "Name=name,Values=nest-$CELL-host-*" \
  --query 'reverse(sort_by(Images, &CreationDate))[].[ImageId, CreationDate, Tags[?Key==`Ec2ImageBuilderArn`]|[0].Value, join(` `, BlockDeviceMappings[].Ebs.SnapshotId)]' \
  --output text)
[ -n "$current" ] && [ "$current" != None ] || { echo "no current AMI in SSM for $CELL: not pruning" >&2; exit 1; }
echo "$amis" | grep -q "^$current" || { echo "the current AMI $current isn't among the cell's AMIs: not pruning" >&2; exit 1; }

n=0
while read -r ami created arn snaps; do
  [ -n "$ami" ] || continue
  n=$((n + 1))
  if [ "$ami" = "$current" ] || [ "$n" -le 2 ] || grep -qw "$ami" <<<"$in_use"; then
    echo "keep $ami ($created)"
    continue
  fi
  echo "prune $ami ($created) snapshots: $snaps"
  act aws_ ec2 deregister-image --image-id "$ami"
  for s in $snaps; do act aws_ ec2 delete-snapshot --snapshot-id "$s"; done
  if [ "$arn" != None ]; then act aws_ imagebuilder delete-image --image-build-version-arn "$arn" >/dev/null || true; fi
done <<<"$amis"

# Guest image builds: prefixes named by their build id (digits), newest last. Only finished builds (their
# SHA256SUMS is written last) count toward the two kept; a failed one always goes.
builds=$(aws_ s3 ls "s3://$BUCKET/images/guest/" | awk '$1 == "PRE" {print $2}' | grep -E '^[0-9]+/$' | sort)
done_builds=$(for b in $builds; do aws_ s3 ls "s3://$BUCKET/images/guest/${b}SHA256SUMS" >/dev/null 2>&1 && echo "$b"; done)
keep=$(tail -n 2 <<<"$done_builds")
for b in $builds; do
  if grep -qx "$b" <<<"$keep"; then echo "keep images/guest/$b"; continue; fi
  echo "prune images/guest/$b"
  act aws_ s3 rm --recursive --only-show-errors "s3://$BUCKET/images/guest/$b"
done
act aws_ s3 rm --recursive --only-show-errors "s3://$BUCKET/builder/"
echo "pruned (dry run: $DRY)"
