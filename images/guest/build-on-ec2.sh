#!/bin/bash
# Builds the guest image on a disposable EC2 instance in a cell (the build chroots and mounts, so it
# shouldn't run on a workstation or a shared dev box) and leaves it in the cell's bucket under
# images/guest/<build id>/. The instance uses the cell's host role, uploads its log either way, and
# terminates itself.
#
#   images/guest/build-on-ec2.sh <bucket> <subnet> <security group> <instance profile> <ami> <root CA PEM>
set -euo pipefail
BUCKET=$1 SUBNET=$2 SG=$3 PROFILE=$4 AMI=$5 ROOT_CA=$6
REGION=${AWS_REGION:-us-east-1}
HERE=$(dirname "$(realpath "$0")")
BID=$(date -u +%Y%m%d%H%M%S)
aws s3 cp --only-show-errors "$HERE/build.sh" "s3://$BUCKET/builder/$BID/build.sh"
aws s3 cp --only-show-errors "$HERE/init" "s3://$BUCKET/builder/$BID/init"
aws s3 cp --only-show-errors "$ROOT_CA" "s3://$BUCKET/builder/$BID/root-ca.pem"
USERDATA=$(mktemp)
cat > "$USERDATA" <<EOF
#!/bin/bash
exec > >(tee -a /var/log/nest-image-build.log) 2>&1
set -euxo pipefail
trap 'aws s3 cp --region $REGION /var/log/nest-image-build.log s3://$BUCKET/images/guest/$BID/build.log; shutdown -h now' EXIT
dnf install -y -q squashfs-tools e2fsprogs util-linux zstd
mkdir -p /opt/build/images/guest && cd /opt/build
aws s3 cp --region $REGION s3://$BUCKET/builder/$BID/build.sh images/guest/build.sh
aws s3 cp --region $REGION s3://$BUCKET/builder/$BID/init images/guest/init
aws s3 cp --region $REGION s3://$BUCKET/releases/current/nest-guest ./nest-guest
aws s3 cp --region $REGION s3://$BUCKET/builder/$BID/root-ca.pem ./root-ca.pem
chmod +x images/guest/build.sh images/guest/init
images/guest/build.sh ./nest-guest /opt/build/out ./root-ca.pem
(cd /opt/build/out && sha256sum vmlinux nest-base.ext4.zst > SHA256SUMS)
aws s3 cp --region $REGION --recursive --only-show-errors /opt/build/out s3://$BUCKET/images/guest/$BID/
echo BUILD-OK
EOF
I=$(aws ec2 run-instances --region "$REGION" --image-id "$AMI" --instance-type c8i.large --subnet-id "$SUBNET" \
  --security-group-ids "$SG" --iam-instance-profile "Name=$PROFILE" --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1 \
  --instance-initiated-shutdown-behavior terminate \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=nest-image-builder},{Key=nest-builder,Value=true}]' \
  --user-data "file://$USERDATA" --query 'Instances[0].InstanceId' --output text)
rm -f "$USERDATA"
echo "builder $I; output s3://$BUCKET/images/guest/$BID/ (build.log, then SHA256SUMS, vmlinux, nest-base.ext4.zst)"
