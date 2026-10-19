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
import Aws.Resource.FisExperimentTemplate
import Aws.Resource.KmsKey
import Aws.Resource.KmsAlias
import Aws.Resource.IamRolePolicyAttachment
import Aws.Resource.SsmParameter
import Aws.Resource.ImagebuilderComponent
import Aws.Resource.ImagebuilderImageRecipe
import Aws.Resource.ImagebuilderInfrastructureConfiguration
import Aws.Resource.ImagebuilderDistributionConfiguration
import Aws.Resource.ImagebuilderImagePipeline
import Cell.Iam

/-!
One nest cell on AWS (docs/compute/provisioning/): public subnets with no NAT and an S3 gateway
endpoint, an egress-only host security group, the cell's bucket, the burst hosts' role and launch
template, the host-image pipeline, and the control plane's IAM user. It creates no instances:
FleetDO launches them.
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
def installTemplate : String := include_str "../../host/install.sh"

/-- The host install script with this cell's values: baked into the host AMI and rerun at boot. -/
def install (spec : CellSpec) : String :=
  (installTemplate.replace "@BUCKET@" (bucketName spec)).replace "@REGION@" spec.region

/-- The bootstrap script (user-data) with this cell's values; it carries no secrets. -/
def bootstrap (spec : CellSpec) : String :=
  let withCell := (bootstrapTemplate.replace "@BUCKET@" (bucketName spec)).replace "@CELL@" spec.name
  let withInstall := withCell.replace "@INSTALL@\n" (install spec)
  (withInstall.replace "@REGION@" spec.region).replace "@CONTROL_URL@" spec.controlUrl

/-- The SSM parameter holding the newest host AMI. The launch template resolves it at each launch;
the pipeline rewrites it after each build (Image Builder's service role may write only under
`/imagebuilder/`). -/
def hostAmiParameter (spec : CellSpec) : String := s!"/imagebuilder/nest-{spec.name}/host-ami"

/-- Image Builder versions are `major.minor.patch`; components and recipes are immutable, so each
new install script gets a new version (from its hash) and replaces the old one. -/
def imageVersion (spec : CellSpec) : String := s!"1.0.{(hash (install spec)).toNat % 1000000000}"

/-- The burst hosts' permissions: the cell's bucket, nothing else. -/
def hostStatements (spec : CellSpec) : List Statement :=
  [ { sid := "CellBucket", actions := ["s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketLocation"]
      resources := [lit s!"arn:aws:s3:::{bucketName spec}"] }
  , { sid := "CellObjects"
      actions := ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion",
        "s3:AbortMultipartUpload"]
      resources := [lit s!"arn:aws:s3:::{bucketName spec}/*"] } ]

/-- The image builder's permissions, beside Image Builder's managed instance policies: read the
release it bakes. -/
def builderStatements (spec : CellSpec) : List Statement :=
  [ { sid := "ListReleases", actions := ["s3:ListBucket"], resources := [lit s!"arn:aws:s3:::{bucketName spec}"]
      conditions := [{ op := "StringLike", entries := [("s3:prefix", [lit "releases/*"])] }] }
  , { sid := "ReadReleases", actions := ["s3:GetObject"], resources := [lit s!"arn:aws:s3:::{bucketName spec}/releases/*"] } ]

/-- The control plane's permissions (FleetDO): launch only from the cell's template, only 8i;
stop and terminate only instances tagged `nest=true`; describe; resolve the host AMI parameter;
sign with the proxy root CA key. -/
def controlPlaneStatements (spec : CellSpec) (template hostRole rootKey : Input String) : List Statement :=
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
  , { sid := "Describe", actions := ["ec2:DescribeInstances"], resources := [lit "*"] }
  , { sid := "ResolveHostAmi", actions := ["ssm:GetParameters"]
      resources := [lit s!"arn:aws:ssm:{spec.region}:{spec.accountId}:parameter{hostAmiParameter spec}"] }
  , { sid := "SignWithProxyRootOnly", actions := ["kms:Sign", "kms:GetPublicKey"], resources := [rootKey] } ]

/-- AWS Fault Injection Service, for spot interruption drills: it may interrupt nest's spot
instances only. -/
def fisStatements (spec : CellSpec) : List Statement :=
  [ { sid := "InterruptNestSpotOnly", actions := ["ec2:SendSpotInstanceInterruptions"]
      resources := [lit s!"arn:aws:ec2:{spec.region}:{spec.accountId}:instance/*"]
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

  -- The host AMI: Amazon Linux 2023 with install.sh baked in, built by EC2 Image Builder in the
  -- cell's subnet (so it reads the release like a host). Builds run on demand:
  -- `aws imagebuilder start-image-pipeline-execution --image-pipeline-arn <host_image_pipeline>`.
  let parentImage := "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.18-x86_64"
  let image ← Data.SsmParameter.read "al2023" { name := parentImage }
  -- Starts at stock AL2023 (bootstrap installs everything); each build points it at the new AMI.
  let hostAmi ← SsmParameter.createWith "host_ami"
    { name := lit (hostAmiParameter spec), type := "String", dataType := "aws:ec2:image"
      insecureValue := image.insecureValue
      description := lit s!"nest {spec.name}: the newest host AMI (written by the host image pipeline)" }
    (resourceOptions |>.ignoreChanges ["insecure_value"])
  let builderRole ← IamRole.create "builder"
    { name := lit s!"nest-{spec.name}-builder"
      assumeRolePolicy := "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}" }
  let _ ← IamRolePolicy.create "builder_releases"
    { name := "read-releases", role := builderRole.id, policy := document (builderStatements spec) }
  let _ ← IamRolePolicyAttachment.create "builder_ssm"
    { role := builderRole.name, policyArn := "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" }
  let _ ← IamRolePolicyAttachment.create "builder_imagebuilder"
    { role := builderRole.name, policyArn := "arn:aws:iam::aws:policy/EC2InstanceProfileForImageBuilder" }
  let builderProfile ← IamInstanceProfile.create "builder"
    { name := lit s!"nest-{spec.name}-builder", role := builderRole.name }
  let component ← ImagebuilderComponent.createWith "host"
    { name := lit s!"nest-{spec.name}-host", platform := "Linux", version := lit (imageVersion spec)
      description := "Installs nest's host software (deploy/host/install.sh)"
      data := lit ("name: nest-host\nschemaVersion: 1.0\nphases:\n  - name: build\n    steps:\n      - name: Install\n"
          ++ "        action: ExecuteBash\n        inputs:\n          commands:\n            - echo '")
        ++ (unsafeCall "base64encode" [unsafeArgument (lit (install spec))] : Input String)
        ++ lit "' | base64 -d > /tmp/nest-install.sh\n            - bash /tmp/nest-install.sh\n" }
    (resourceOptions |>.createBeforeDestroy true)
  let recipe ← ImagebuilderImageRecipe.createWith "host"
    { name := lit s!"nest-{spec.name}-host", version := lit (imageVersion spec)
      parentImage := lit s!"ssm:{parentImage}"
      component := [{ componentArn := component.arn }]
      blockDeviceMapping := [{ deviceName := "/dev/xvda"
                               ebs := some { volumeSize := 30, volumeType := "gp3", encrypted := "true", deleteOnTermination := "true" } }] }
    (resourceOptions |>.createBeforeDestroy true)
  -- Not tagged `nest=true`: the builder isn't a host, and FleetDO's STONITH must not reach it.
  let builderInfra ← ImagebuilderInfrastructureConfiguration.create "host"
    { name := lit s!"nest-{spec.name}-host", instanceProfileName := builderProfile.name
      instanceTypes := some (array [lit "c8i.large"]), subnetId := subnetA.id, securityGroupIds := some (array [sg.id])
      terminateInstanceOnFailure := true
      instanceMetadataOptions := some { httpTokens := "required", httpPutResponseHopLimit := 1 }
      resourceTags := some (object [("nest:builder", lit spec.name)]) }
  let distribution ← ImagebuilderDistributionConfiguration.create "host"
    { name := lit s!"nest-{spec.name}-host"
      distribution := [{ region := lit spec.region
                         amiDistributionConfiguration := some
                           { name := lit s!"nest-{spec.name}-host-\{\{imagebuilder:buildDate}}"
                             amiTags := some (nestTags spec) }
                         ssmParameterConfiguration := [{ parameterName := hostAmi.name, dataType := "aws:ec2:image" }] }] }
  let pipeline ← ImagebuilderImagePipeline.create "host"
    { name := lit s!"nest-{spec.name}-host", imageRecipeArn := recipe.arn
      infrastructureConfigurationArn := builderInfra.arn, distributionConfigurationArn := distribution.arn
      -- The real test is a host enrolling; Image Builder's boot test would add ~10 minutes.
      imageTestsConfiguration := some { imageTestsEnabled := false } }

  -- The launch template: nested virtualization, IMDSv2 with hop limit 1, tagged `nest=true`.
  -- Instance type, zone and market are chosen per launch by FleetDO; the AMI at each launch.
  let template ← LaunchTemplate.create "host"
    { name := lit s!"nest-{spec.name}-host"
      imageId := lit "resolve:ssm:" ++ hostAmi.name
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

  -- The proxy root CA: a non-exportable P-256 signing key. FleetDO signs each host's intermediate
  -- with it through KMS `Sign`; the private key never leaves KMS.
  let rootKey ← KmsKey.createWith "proxy_root"
    { description := lit s!"nest {spec.name}: proxy root CA (signs per-host intermediates)"
      customerMasterKeySpec := "ECC_NIST_P256", keyUsage := "SIGN_VERIFY", deletionWindowInDays := 30 }
    (resourceOptions |>.preventDestroy true)
  let _ ← KmsAlias.create "proxy_root" { name := lit s!"alias/nest-{spec.name}-proxy-root", targetKeyId := rootKey.keyId }

  -- The control plane (FleetDO). Its access key is created out of band and kept as a Worker secret.
  let cp ← IamUser.create "control_plane" { name := lit s!"nest-{spec.name}-control-plane" }
  let templateArn : Input String := template.arn
  -- A managed policy: the document is over IAM's 2,048-byte limit for inline user policies.
  let fleet ← IamPolicy.create "control_plane_fleet"
    { name := lit s!"nest-{spec.name}-fleet", policy := document (controlPlaneStatements spec templateArn hostRole.arn rootKey.arn) }
  let _ ← IamUserPolicyAttachment.create "control_plane_fleet" { user := cp.name, policyArn := fleet.arn }

  -- Spot interruption drill: `aws fis start-experiment --experiment-template-id <output>` sends a
  -- real two-minute notice to one running nest spot instance.
  let fisRole ← IamRole.create "fis"
    { name := lit s!"nest-{spec.name}-fis"
      assumeRolePolicy := "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"fis.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}" }
  let _ ← IamRolePolicy.create "fis_interrupt" { name := "interrupt-nest-spot", role := fisRole.id, policy := document (fisStatements spec) }
  let drill ← FisExperimentTemplate.create "spot_interruption"
    { description := lit s!"nest {spec.name}: interrupt one running nest spot host (2 min notice)"
      roleArn := fisRole.arn
      stopCondition := [{ source := "none" }]
      target := [{ name := "nest-spot", resourceType := "aws:ec2:spot-instance", selectionMode := "COUNT(1)"
                   resourceTag := [{ key := "nest", value := "true" }]
                   filter := [{ path := "State.Name", values := array [lit "running"] }] }]
      action := [{ name := "interrupt", actionId := "aws:ec2:send-spot-instance-interruptions"
                   parameter := [{ key := "durationBeforeInterruption", value := "PT2M" }]
                   target := some { key := "SpotInstances", value := "nest-spot" } }] }

  output "bucket" bucket.id
  output "launch_template_id" template.id
  output "subnet_ids" (array [subnetA.id, subnetB.id, subnetC.id])
  output "security_group_id" sg.id
  output "s3_endpoint_id" s3.id
  output "control_plane_user" cp.name
  output "spot_drill_template_id" drill.id
  output "proxy_root_key_arn" rootKey.arn
  output "host_image_pipeline" pipeline.arn

end Cell
