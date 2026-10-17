import Inframe
import Aws.Provider
import Aws.Data.SsmParameter
import Aws.Resource.Vpc
import Aws.Resource.InternetGateway
import Aws.Resource.RouteTable
import Aws.Resource.Route
import Aws.Resource.Subnet
import Aws.Resource.RouteTableAssociation
import Aws.Resource.VpcEndpoint
import Aws.Resource.SecurityGroup
import Aws.Resource.VpcSecurityGroupEgressRule
import Aws.Resource.S3Bucket
import Aws.Resource.S3BucketVersioning
import Aws.Resource.S3BucketPublicAccessBlock
import Aws.Resource.S3BucketOwnershipControls
import Aws.Resource.S3BucketServerSideEncryptionConfiguration
import Aws.Resource.S3BucketLifecycleConfiguration
import Aws.Resource.S3BucketPolicy
import Aws.Resource.IamRole
import Aws.Resource.IamRolePolicy
import Aws.Resource.IamInstanceProfile
import Aws.Resource.IamUser
import Aws.Resource.IamPolicy
import Aws.Resource.IamUserPolicyAttachment
import Aws.Resource.LaunchTemplate
import Cell.Iam

/-!
One nest cell on AWS (docs/compute/provisioning/): public subnets with no NAT and an S3 gateway
endpoint, an egress-only host security group, the cell's bucket, the burst hosts' role and launch
template, and the control plane's IAM user. It creates no instances: FleetDO launches them.
-/

open Inframe
open Aws
open Aws.Resource
open Cell.Iam

namespace Cell

structure CellSpec where
  /-- Short cell name, e.g. `use1`; FleetDO's cell and part of every resource name. -/
  name : String
  region : String
  accountId : String
  /-- The control plane's public URL, which hosts enroll with. -/
  controlUrl : String
  /-- Instance-type patterns the control plane may launch: the 8i family only. -/
  instanceTypes : List String := ["c8i*.*", "m8i*.*", "r8i*.*"]

/-- Outbound from burst hosts: HTTPS, plus cloudflared's 7844 over TCP and UDP. Nothing inbound. -/
def hostEgress : List (String × Nat) := [("tcp", 443), ("tcp", 7844), ("udp", 7844)]

def bucketName (spec : CellSpec) : String := s!"nest-{spec.name}-{spec.accountId}"

def bootstrapTemplate : String := include_str "../../host/bootstrap.sh"

/-- The bootstrap script with this cell's values; it carries no secrets. -/
def bootstrap (spec : CellSpec) : String :=
  let withCell := (bootstrapTemplate.replace "@BUCKET@" (bucketName spec)).replace "@CELL@" spec.name
  (withCell.replace "@REGION@" spec.region).replace "@CONTROL_URL@" spec.controlUrl

/-- The burst hosts' permissions: the cell's bucket, nothing else. -/
def hostStatements (spec : CellSpec) : List Statement :=
  [ { sid := "CellBucket", actions := ["s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketLocation"]
      resources := [lit s!"arn:aws:s3:::{bucketName spec}"] }
  , { sid := "CellObjects"
      actions := ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion",
        "s3:AbortMultipartUpload"]
      resources := [lit s!"arn:aws:s3:::{bucketName spec}/*"] } ]

/-- The control plane's permissions (FleetDO): launch only from the cell's template, only 8i;
stop and terminate only instances tagged `nest=true`; describe. -/
def controlPlaneStatements (spec : CellSpec) (template hostRole : Input String) : List Statement :=
  let fromTemplate : Condition := { op := "ArnLike", entries := [("ec2:LaunchTemplate", [template])] }
  let ec2 (kind : String) : Input String := lit s!"arn:aws:ec2:{spec.region}:{spec.accountId}:{kind}"
  [ { sid := "LaunchFromTemplateOnly", actions := ["ec2:RunInstances"], resources := [template]
      conditions := [fromTemplate] }
  , { sid := "LaunchedResources", actions := ["ec2:RunInstances"]
      resources := [lit s!"arn:aws:ec2:{spec.region}::image/*", ec2 "subnet/*", ec2 "network-interface/*", ec2 "volume/*",
        ec2 "spot-instances-request/*"]
      conditions := [fromTemplate] }
  , { sid := "SecurityGroupFromTemplate", actions := ["ec2:RunInstances"], resources := [ec2 "security-group/*"]
      conditions := [fromTemplate, { op := "Bool", entries := [("ec2:IsLaunchTemplateResource", ["true"])] }] }
  , { sid := "EightIOnly", actions := ["ec2:RunInstances"], resources := [ec2 "instance/*"]
      conditions := [fromTemplate, { op := "StringLike", entries := [("ec2:InstanceType", spec.instanceTypes.map lit)] }] }
  , { sid := "TagAtLaunch", actions := ["ec2:CreateTags"], resources := [lit "*"]
      conditions := [{ op := "StringEquals", entries := [("ec2:CreateAction", ["RunInstances"])] }] }
  , { sid := "PassHostRole", actions := ["iam:PassRole"], resources := [hostRole]
      conditions := [{ op := "StringEquals", entries := [("iam:PassedToService", ["ec2.amazonaws.com"])] }] }
  , { sid := "StonithNestOnly", actions := ["ec2:TerminateInstances", "ec2:StopInstances"], resources := [ec2 "instance/*"]
      conditions := [{ op := "StringEquals", entries := [("aws:ResourceTag/nest", ["true"])] }] }
  , { sid := "Describe", actions := ["ec2:DescribeInstances"], resources := [lit "*"] } ]

def nestTags (spec : CellSpec) : Input (Map String) := object [("nest", "true"), ("nest:cell", lit spec.name)]

def cell (spec : CellSpec) : Infra Unit := do
  let _ ← Provider.configure
    { region := spec.region
      allowedAccountIds := some (array [lit spec.accountId])
      defaultTags := [{ tags := some (nestTags spec) }] }

  -- Network: public subnets, no NAT; S3 through a free gateway endpoint.
  let vpc ← Vpc.create "cell"
    { cidrBlock := "10.42.0.0/16", enableDnsSupport := true, enableDnsHostnames := true
      tags := some (object [("Name", lit s!"nest-{spec.name}")]) }
  let igw ← InternetGateway.create "cell" { vpcId := vpc.id }
  let routes ← RouteTable.create "public" { vpcId := vpc.id }
  let _ ← Route.create "internet" { routeTableId := routes.id, destinationCidrBlock := "0.0.0.0/0", gatewayId := igw.id }
  let subnetA ← Subnet.create "a"
    { vpcId := vpc.id, cidrBlock := "10.42.0.0/20", availabilityZone := lit s!"{spec.region}a", mapPublicIpOnLaunch := true }
  let subnetB ← Subnet.create "b"
    { vpcId := vpc.id, cidrBlock := "10.42.16.0/20", availabilityZone := lit s!"{spec.region}b", mapPublicIpOnLaunch := true }
  let subnetC ← Subnet.create "c"
    { vpcId := vpc.id, cidrBlock := "10.42.32.0/20", availabilityZone := lit s!"{spec.region}c", mapPublicIpOnLaunch := true }
  let _ ← RouteTableAssociation.create "a" { routeTableId := routes.id, subnetId := subnetA.id }
  let _ ← RouteTableAssociation.create "b" { routeTableId := routes.id, subnetId := subnetB.id }
  let _ ← RouteTableAssociation.create "c" { routeTableId := routes.id, subnetId := subnetC.id }
  let s3 ← VpcEndpoint.create "s3"
    { vpcId := vpc.id, serviceName := lit s!"com.amazonaws.{spec.region}.s3", vpcEndpointType := "Gateway"
      routeTableIds := some (array [routes.id]) }

  -- The host security group. The provider removes AWS's default allow-all egress rule.
  let sg ← SecurityGroup.create "host"
    { name := lit s!"nest-{spec.name}-host", description := "nest burst hosts: egress 443 and 7844 only, no ingress"
      vpcId := vpc.id, revokeRulesOnDelete := true }
  let _ ← VpcSecurityGroupEgressRule.create "https"
    { securityGroupId := sg.id, ipProtocol := "tcp", fromPort := 443, toPort := 443, cidrIpv4 := "0.0.0.0/0" }
  let _ ← VpcSecurityGroupEgressRule.create "cloudflared_tcp"
    { securityGroupId := sg.id, ipProtocol := "tcp", fromPort := 7844, toPort := 7844, cidrIpv4 := "0.0.0.0/0" }
  let _ ← VpcSecurityGroupEgressRule.create "cloudflared_udp"
    { securityGroupId := sg.id, ipProtocol := "udp", fromPort := 7844, toPort := 7844, cidrIpv4 := "0.0.0.0/0" }

  -- The cell's bucket: versioned Standard; noncurrent versions expire after a day.
  let bucket ← S3Bucket.createWith "cell" { bucket := lit (bucketName spec) }
    (resourceOptions |>.preventDestroy true)
  let _ ← S3BucketVersioning.create "cell" { bucket := bucket.id, versioningConfiguration := { status := "Enabled" } }
  let _ ← S3BucketPublicAccessBlock.create "cell"
    { bucket := bucket.id, blockPublicAcls := true, blockPublicPolicy := true, ignorePublicAcls := true
      restrictPublicBuckets := true }
  let _ ← S3BucketOwnershipControls.create "cell" { bucket := bucket.id, rule := { objectOwnership := "BucketOwnerEnforced" } }
  let _ ← S3BucketServerSideEncryptionConfiguration.create "cell"
    { bucket := bucket.id, rule := [{ applyServerSideEncryptionByDefault := some { sseAlgorithm := "AES256" } }] }
  let _ ← S3BucketLifecycleConfiguration.create "cell"
    { bucket := bucket.id
      rule := [{ id := "expire-noncurrent", status := "Enabled", filter := [{}]
                 noncurrentVersionExpiration := [{ noncurrentDays := 1 }]
                 abortIncompleteMultipartUpload := [{ daysAfterInitiation := 1 }] }] }

  -- Burst hosts: the cell's bucket only, and only through the endpoint (the bucket policy).
  let hostRole ← IamRole.create "host"
    { name := lit s!"nest-{spec.name}-host"
      assumeRolePolicy := "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}" }
  let _ ← IamRolePolicy.create "host_cell_bucket"
    { name := "cell-bucket", role := hostRole.id, policy := document (hostStatements spec) }
  let profile ← IamInstanceProfile.create "host" { name := lit s!"nest-{spec.name}-host", role := hostRole.name }
  let _ ← S3BucketPolicy.create "cell"
    { bucket := bucket.id
      policy := "{\"Version\":\"2012-10-17\",\"Statement\":["
        ++ "{\"Sid\":\"TlsOnly\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"" ++ bucket.arn ++ "\",\""
        ++ bucket.arn ++ "/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}},"
        ++ "{\"Sid\":\"HostsOnlyThroughEndpoint\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\""
        ++ bucket.arn ++ "\",\"" ++ bucket.arn ++ "/*\"],\"Condition\":{\"ArnEquals\":{\"aws:PrincipalArn\":\"" ++ hostRole.arn
        ++ "\"},\"StringNotEquals\":{\"aws:SourceVpce\":\"" ++ s3.id ++ "\"}}}]}" }

  -- The launch template: nested virtualization, IMDSv2 with hop limit 1, tagged `nest=true`.
  -- Instance type, zone and market are chosen per launch by FleetDO.
  let image ← Data.SsmParameter.read "al2023"
    { name := "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.18-x86_64" }
  let template ← LaunchTemplate.create "host"
    { name := lit s!"nest-{spec.name}-host"
      imageId := image.insecureValue
      iamInstanceProfile := some { arn := profile.arn }
      vpcSecurityGroupIds := some (array [sg.id])
      cpuOptions := some { nestedVirtualization := "enabled" }
      metadataOptions := some { httpEndpoint := "enabled", httpTokens := "required", httpPutResponseHopLimit := 1
                                instanceMetadataTags := "disabled" }
      instanceInitiatedShutdownBehavior := "terminate"
      blockDeviceMappings := [{ deviceName := "/dev/xvda"
                                ebs := some { volumeSize := 30, volumeType := "gp3", encrypted := "true", deleteOnTermination := "true" } }]
      tagSpecifications := [{ resourceType := "instance", tags := some (nestTags spec) },
                            { resourceType := "volume", tags := some (nestTags spec) }]
      userData := some (unsafeCall "base64encode" [unsafeArgument (lit (bootstrap spec))] : Input String)
      updateDefaultVersion := true }

  -- The control plane (FleetDO). Its access key is created out of band and kept as a Worker secret.
  let cp ← IamUser.create "control_plane" { name := lit s!"nest-{spec.name}-control-plane" }
  let templateArn : Input String := template.arn
  -- A managed policy: the document is over IAM's 2,048-byte limit for inline user policies.
  let fleet ← IamPolicy.create "control_plane_fleet"
    { name := lit s!"nest-{spec.name}-fleet", policy := document (controlPlaneStatements spec templateArn hostRole.arn) }
  let _ ← IamUserPolicyAttachment.create "control_plane_fleet" { user := cp.name, policyArn := fleet.arn }

  output "bucket" bucket.id
  output "launch_template_id" template.id
  output "subnet_ids" (array [subnetA.id, subnetB.id, subnetC.id])
  output "security_group_id" sg.id
  output "s3_endpoint_id" s3.id
  output "control_plane_user" cp.name

end Cell
