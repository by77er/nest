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
import Aws.Resource.IamOpenidConnectProvider
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
import Aws.Resource.ImagebuilderLifecyclePolicy
import Cell.Iam

/-!
One nest cell on AWS (docs/compute/provisioning/): public subnets with no NAT and an S3 gateway
endpoint, the cell's bucket, the sandbox hosts' egress-only security group, role and launch
template, the brain hosts' own (egress 443 only, a role that may only read the release, cheap
instance types; docs/compute/brain-hosts/), the host-image pipeline (one AMI for both kinds), the proxy
root CA key, the control plane's IAM user and its settings for this cell (its `AWS_CELLS` entry in
SSM), and the deploy role GitHub Actions assumes over OIDC. It creates no instances: FleetDO
launches them.
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
  /-- Instance families the control plane may launch, each in size `.large` only: IAM allows
  exactly `<family>.large` (`SandboxTypesOnly`). Only families with nested virtualization
  (Firecracker needs `/dev/kvm`) that Firecracker supports (`launch_types_sound`). A cell lists
  each family by name, `-flex` and `d` variants included. -/
  instanceFamilies : List String := ["c8i", "m8i", "r8i"]
  /-- The instance types FleetDO launches, in preference order: each on spot, then each on demand
  (`scaleUpPlan`). Each must fall within `instanceFamilies` (`launch_types_within_iam` in `Cell.Test`). -/
  launchTypes : List String
  /-- The autoscaler's settings (control-plane/src/lib/cells.ts, `AWS_CELLS`); the defaults are its own. -/
  spot : Bool := true
  maxHosts : Nat := 1
  /-- How long a sandbox host holding no running sandbox stays before it's terminated. -/
  idleGraceMs : Nat := 600000
  /-- A launched instance that hasn't enrolled by then is terminated. -/
  enrollTimeoutMs : Nat := 600000
  /-- What a sandbox on regular pages is expected to use, reserved until the host counts it. -/
  sandboxReserveMib : Nat := 768
  /-- The sandbox hosts' root volume, GB (gp3). An EBS-only host, or one whose bootstrap fell back
  from its instance store, keeps every sandbox's state there, so it must hold `maxSandboxesPerHost`
  sandboxes besides the OS, the base images and the chunk cache (`sandboxes_fit_their_disk`). -/
  hostRootGb : Nat := 30
  /-- On-demand prices in the cell's region, micro-USD an hour (Linux, AWS's Price List API), for
  every type it may launch: FleetDO tries on demand cheapest first (`CellSpec.onDemandTypes`). -/
  onDemandPrices : List (String × Nat) := []
  /-- At most this many sandboxes per host on regular pages; 0 is no cap. Placement packs by
  memory, so on a type with more memory per GB of instance store this is what keeps the store from
  filling (`sandboxes_fit_their_disk`). -/
  maxSandboxesPerHost : Nat := 0
  /-- Brain hosts (docs/compute/brain-hosts/): the instance families the control plane may launch
  from the brain template (IAM allows `<family>*.*`). Cheap x86 types, since both kinds boot the
  one host AMI (x86_64). -/
  brainInstanceFamilies : List String := ["t3a", "t3"]
  /-- The brain instance types FleetDO launches, in preference order: each on spot, then each on
  demand. About 2 vCPU / 4 GiB. Each must fall within `brainInstanceFamilies`. -/
  brainLaunchTypes : List String := ["t3a.medium", "t3.medium"]
  brainSpot : Bool := true
  /-- At most this many brain hosts: 3 `t3a.medium`s hold about 12 brains at the default 2 per
  vCPU, room for today's agents with one host's worth to spare; one host would cap a cell at ~4. -/
  brainMaxHosts : Nat := 3
  /-- How long a brain host holding no brain stays before it's terminated. -/
  brainIdleGraceMs : Nat := 1800000
  /-- Brains per brain host; 0 derives it from the instance's vCPUs (control-plane/src/lib/placement.ts). -/
  maxBrainsPerHost : Nat := 0
  /-- The GitHub repository that may assume the deploy role (dev/deploy.md), in GitHub's immutable
  OIDC subject form `OWNER@OWNER-ID/REPO@REPO-ID`: repositories created after 2026-07-15 put the
  owner and repository ids in the `sub` claim, and they can't be removed. -/
  deployRepo : String := "by77er@39721110/nest@1416068100"
  deployEnvironment : String := "production"

/-- Outbound from sandbox hosts: HTTPS, plus cloudflared's 7844 over TCP and UDP. Nothing inbound. -/
def hostEgress : List (String × Nat) := [("tcp", 443), ("tcp", 7844), ("udp", 7844)]

/-- Outbound from brain hosts: HTTPS only (Anthropic, the control plane, the sandbox gateways'
hostnames, WebFetch). No tunnel, so no 7844. Nothing inbound. -/
def brainEgress : List (String × Nat) := [("tcp", 443)]

def bucketName (spec : CellSpec) : String := s!"nest-{spec.name}-{spec.accountId}"

/-- The only size sandbox hosts launch in. -/
def sandboxSize : String := ".large"

/-- The `ec2:InstanceType` patterns IAM allows from the sandbox template (`SandboxTypesOnly`):
exactly `<family>.large`, no wildcard, so neither a bigger size nor a look-alike family (`i7ie` for
`i7i`) passes. -/
def instancePatterns (spec : CellSpec) : List String := spec.instanceFamilies.map (· ++ sandboxSize)

/-- Whether `type` is one of `spec`'s sandbox patterns (character lists, so `decide` reduces it). -/
def CellSpec.allowsSandboxType (spec : CellSpec) (type : String) : Bool :=
  (instancePatterns spec).any (·.toList == type.toList)

/-- Whether `type` matches IAM's `StringLike` pattern `<family>*.*`: it starts with the family and
has a `.` after it. (`*` matches any run of characters, including none.) -/
def matchesFamily (family type : String) : Bool :=
  family.toList.isPrefixOf type.toList && (type.toList.drop family.length).contains '.'

/-- A type's on-demand price in `spec`'s table, if it has one. -/
def CellSpec.priceOf (spec : CellSpec) (type : String) : Option Nat :=
  (spec.onDemandPrices.find? (·.1.toList == type.toList)).map (·.2)

/-- `t` into `sorted` (cheapest first) after every type no dearer: equal prices keep their order. -/
def CellSpec.insertByPrice (spec : CellSpec) (t : String) : List String → List String
  | [] => [t]
  | u :: rest => if (spec.priceOf t).getD 0 < (spec.priceOf u).getD 0 then t :: u :: rest else u :: spec.insertByPrice t rest

/-- `types` cheapest first on demand; equal prices keep their preference order (an insertion sort:
structural, so `decide` reduces it). -/
def CellSpec.cheapestFirst (spec : CellSpec) (types : List String) : List String :=
  types.foldl (fun acc t => spec.insertByPrice t acc) []

/-- The order FleetDO tries sandbox types on demand in, once spot had no room for any (`AWS_CELLS`
`on_demand_types`): cheapest first, so an on-demand host is the cheapest that has room. -/
def CellSpec.onDemandTypes (spec : CellSpec) : List String := spec.cheapestFirst spec.launchTypes

/-- The same for brain hosts. -/
def CellSpec.brainOnDemandTypes (spec : CellSpec) : List String := spec.cheapestFirst spec.brainLaunchTypes

/-- Every type either kind may launch has a price in the table (so the order means something). -/
def CellSpec.onDemandPriced (spec : CellSpec) : Bool :=
  (spec.launchTypes ++ spec.brainLaunchTypes).all (fun t => (spec.priceOf t).isSome)
/-- The families AWS offers nested virtualization on (and so `/dev/kvm` for Firecracker), from the
EC2 user guide's list (2026-11-03): https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html -/
def nestedVirtualizationFamilies : List String :=
  ["m7i", "m7i-flex", "m8i", "m8id", "m8i-flex", "c7i", "c7i-flex", "c8i", "c8id", "c8i-flex",
   "r7i", "r7iz", "r8i", "r8id", "r8i-flex", "x8i", "i7i", "i7ie"]

/-- The families on CPUs Firecracker tests and supports (its README's tested platforms, 2026-11-04:
Cascade Lake, Ice Lake, Sapphire Rapids, Granite Rapids, AMD Milan and Genoa, Graviton 2-5;
https://github.com/firecracker-microvm/firecracker#tested-platforms). Of the nested-virtualization
families: 7i (Sapphire Rapids) and 8i (Granite Rapids, on a 6.1 or 6.18 host kernel only; AL2023's
is 6.18). Not I7i/I7ie (Emerald Rapids) or X8i: not listed. -/
def firecrackerFamilies : List String :=
  ["m7i", "m7i-flex", "c7i", "c7i-flex", "r7i", "m8i", "m8id", "m8i-flex", "c8i", "c8id", "c8i-flex", "r8i", "r8id", "r8i-flex"]

/-- Instance store per listed type, in GB (`describe-instance-types`, 2026-11-03). -/
def instanceStoreGb (type : String) : Nat :=
  if type.toList == "c8id.large".toList || type.toList == "m8id.large".toList || type.toList == "r8id.large".toList then 118
  else if type.toList == "i7i.large".toList then 468
  else 0

/-- What one sandbox is allowed of an instance store, in GB: its sparse 32 GiB disk shares
`nest-base`'s blocks by reflink, so it holds what the guest wrote plus a cut's copies (an
assumption, unmeasured on a used host). -/
def sandboxStoreBudgetGb : Nat := 8

/-- An instance type's family, as characters: what comes before its `.` (lists, so `decide` reduces it). -/
def familyOf (type : String) : List Char := type.toList.takeWhile (· ≠ '.')

/-- Whether a type has local NVMe instance store, by nest's families: the `d` variants and I7i/I7ie. -/
def hasInstanceStore (type : String) : Bool :=
  let f := familyOf type
  f.getLast? == some 'd' || f == "i7i".toList || f == "i7ie".toList

/-- Every type the autoscaler may pick has nested virtualization on a CPU Firecracker supports, and
the instance-store types come before every EBS-only one (FleetDO tries them in order). -/
def CellSpec.launchTypesSound (spec : CellSpec) : Bool :=
  spec.launchTypes.all (fun t => nestedVirtualizationFamilies.any (·.toList == familyOf t))
    && spec.launchTypes.all (fun t => firecrackerFamilies.any (·.toList == familyOf t))
    && (spec.launchTypes.dropWhile hasInstanceStore).all (fun t => !hasInstanceStore t)

/-- What a sandbox host's root volume holds besides sandboxes, GB: the OS and nest's install, the
base images (compressed and unpacked) and the store's local chunk cache (an assumption, unmeasured). -/
def hostRootReserveGb : Nat := 24

/-- Every host's sandbox state fits its disk at the per-host cap: an instance-store type's on its
store, and every host's on its root volume, since an EBS-only type keeps it there and an
instance-store host whose bootstrap fell back from its store does too. -/
def CellSpec.sandboxesFitStore (spec : CellSpec) : Bool :=
  spec.maxSandboxesPerHost > 0
    && (spec.launchTypes.filter hasInstanceStore).all (fun t => spec.maxSandboxesPerHost * sandboxStoreBudgetGb ≤ instanceStoreGb t)
    && spec.maxSandboxesPerHost * sandboxStoreBudgetGb + hostRootReserveGb ≤ spec.hostRootGb

/-- Every type the autoscaler may pick is one IAM lets it launch. -/
def CellSpec.launchTypesAllowed (spec : CellSpec) : Bool :=
  spec.launchTypes.all spec.allowsSandboxType

/-- The `ec2:InstanceType` patterns IAM allows from the brain template (`BrainTypesOnly`). -/
def brainInstancePatterns (spec : CellSpec) : List String := spec.brainInstanceFamilies.map (· ++ "*.*")

/-- Every brain type the autoscaler may pick is one IAM lets it launch from the brain template. -/
def CellSpec.brainLaunchTypesAllowed (spec : CellSpec) : Bool :=
  spec.brainLaunchTypes.all fun t => spec.brainInstanceFamilies.any (matchesFamily · t)

/-- The prefix under which each cell stack writes its own `AWS_CELLS` entry; the control plane's
deploy merges every parameter under it (dev/deploy-use1.sh). -/
def awsCellsPrefix : String := "/nest/control-plane/aws-cells/"

/-- This cell's `AWS_CELLS` parameter: one per cell, so no cell stack overwrites another's entry. -/
def awsCellsParameter (spec : CellSpec) : String := awsCellsPrefix ++ spec.name

/-- `AWS_CELLS` (control-plane/src/lib/cells.ts): this cell's settings, keyed by its name, from the
two launch template ids, subnet ids, the proxy root CA key's ARN and the spec. Generic over the
string type, so `Cell.Test` can render it with plain strings and parse the JSON; no value needs
escaping. -/
def awsCellsWith {α : Type} [HAppend α α α] (str : String → α) (spec : CellSpec) (launchTemplateId brainTemplateId : α)
    (subnetIds : List α) (proxyRootKeyArn : α) : α :=
  let quote (v : α) : α := str "\"" ++ v ++ str "\""
  let join : List α → α
    | [] => str ""
    | x :: rest => rest.foldl (fun acc y => acc ++ str "," ++ y) x
  let field (key : String) (value : α) : α := quote (str key) ++ str ":" ++ value
  let number (n : Nat) : α := str (toString n)
  let strings (xs : List α) : α := str "[" ++ join (xs.map quote) ++ str "]"
  str "{" ++ quote (str spec.name) ++ str ":{" ++ join
    [ field "region" (quote (str spec.region))
    , field "launch_template_id" (quote launchTemplateId)
    , field "subnet_ids" (strings subnetIds)
    , field "instance_types" (strings (spec.launchTypes.map str))
    , field "on_demand_types" (strings (spec.onDemandTypes.map str))
    , field "spot" (str (if spec.spot then "true" else "false"))
    , field "max_hosts" (number spec.maxHosts)
    , field "idle_grace_ms" (number spec.idleGraceMs)
    , field "enroll_timeout_ms" (number spec.enrollTimeoutMs)
    , field "sandbox_reserve_mib" (number spec.sandboxReserveMib)
    , field "max_sandboxes_per_host" (number spec.maxSandboxesPerHost)
    , field "proxy_root_key_arn" (quote proxyRootKeyArn)
    , field "brain" (str "{" ++ join
        [ field "launch_template_id" (quote brainTemplateId)
        , field "instance_types" (strings (spec.brainLaunchTypes.map str))
        , field "on_demand_types" (strings (spec.brainOnDemandTypes.map str))
        , field "spot" (str (if spec.brainSpot then "true" else "false"))
        , field "max_hosts" (number spec.brainMaxHosts)
        , field "idle_grace_ms" (number spec.brainIdleGraceMs)
        , field "max_brains_per_host" (number spec.maxBrainsPerHost) ]
        ++ str "}") ]
    ++ str "}}"

/-- `AWS_CELLS` from the stack's own launch templates, subnets and proxy root CA key. -/
def awsCells (spec : CellSpec) (launchTemplateId brainTemplateId : Input String) (subnetIds : List (Input String))
    (proxyRootKeyArn : Input String) : Input String :=
  awsCellsWith lit spec launchTemplateId brainTemplateId subnetIds proxyRootKeyArn

def bootstrapTemplate : String := include_str "../../host/bootstrap.sh"
def installTemplate : String := include_str "../../host/install.sh"

/-- The host install script with this cell's values: baked into the host AMI and rerun at boot. -/
def install (spec : CellSpec) : String :=
  (installTemplate.replace "@BUCKET@" (bucketName spec)).replace "@REGION@" spec.region

/-- A host's kind, written into its nestd config by its launch template's user data: the role
comes from which template FleetDO launched (and FleetDO's launch record binds the enrollment to
it), not from anything the instance could change. -/
inductive HostKind where
  | sandbox
  | brain
  deriving DecidableEq

/-- The role name the user data writes into nestd's config: this release still writes the
previous release's names (`burst`, `controller`; nestd reads both), so a control plane rolled back
to the previous release accepts every host these templates launch. The next release writes
`sandbox` and `brain` (expand/contract, dev/deploy.md). -/
def HostKind.roleName : HostKind → String
  | .sandbox => "burst"
  | .brain => "controller"

/-- The bootstrap script (user-data) for one host kind, with this cell's values; it carries no
secrets. -/
def bootstrap (spec : CellSpec) (kind : HostKind) : String :=
  let withCell := (bootstrapTemplate.replace "@BUCKET@" (bucketName spec)).replace "@CELL@" spec.name
  let withInstall := withCell.replace "@INSTALL@\n" (install spec)
  ((withInstall.replace "@REGION@" spec.region).replace "@CONTROL_URL@" spec.controlUrl).replace "@ROLE@" kind.roleName

/-- The SSM parameter holding the newest host AMI. The launch template resolves it at each launch;
the pipeline rewrites it after each build (Image Builder's service role may write only under
`/imagebuilder/`). -/
def hostAmiParameter (spec : CellSpec) : String := s!"/imagebuilder/nest-{spec.name}/host-ami"

/-- Image Builder versions are `major.minor.patch`; components and recipes are immutable, so each
new install script gets a new version (from its hash) and replaces the old one. -/
def imageVersion (spec : CellSpec) : String := s!"1.0.{(hash (install spec)).toNat % 1000000000}"

/-- Read the release (host binaries, install inputs) and nothing else in the bucket: list under
`releases/`, get objects under `releases/`. -/
def releaseReadStatements (spec : CellSpec) : List Statement :=
  [ { sid := "ListReleases", actions := ["s3:ListBucket"], resources := [lit s!"arn:aws:s3:::{bucketName spec}"]
      conditions := [{ op := "StringLike", entries := [("s3:prefix", [lit "releases/*"])] }] }
  , { sid := "ReadReleases", actions := ["s3:GetObject"], resources := [lit s!"arn:aws:s3:::{bucketName spec}/releases/*"] } ]

/-- The brain hosts' permissions: read the release, so a brain host installs it at boot like a
sandbox host and runs every release, not the one its AMI baked. No sandbox state (no chunk,
manifest or audit object), no writes. It authenticates to the control plane with its signed
identity document, which needs no IAM permission. -/
def brainHostStatements (spec : CellSpec) : List Statement := releaseReadStatements spec

/-- The sandbox hosts' permissions: the cell's bucket, nothing else. -/
def hostStatements (spec : CellSpec) : List Statement :=
  [ { sid := "CellBucket", actions := ["s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketLocation"]
      resources := [lit s!"arn:aws:s3:::{bucketName spec}"] }
  , { sid := "CellObjects"
      actions := ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion",
        "s3:AbortMultipartUpload"]
      resources := [lit s!"arn:aws:s3:::{bucketName spec}/*"] } ]

/-- The image builder's permissions, beside Image Builder's managed instance policies: read the
release it bakes. -/
def builderStatements (spec : CellSpec) : List Statement := releaseReadStatements spec

/-- The control plane's permissions (FleetDO): launch only from the cell's two templates, sandbox
hosts only as 8i with the sandbox hosts' instance profile and brain hosts only as the brain
families with theirs, each from its own template; pass only the two host roles; stop and terminate
only instances tagged `nest=true`; describe instances and images (the operator view of host AMIs);
resolve the host AMI parameter; sign with the proxy root CA key.

The profile conditions are `ArnEqualsIfExists` on `ec2:InstanceProfile`: a request (or template)
naming another profile is refused, and should IAM not populate the key from a launch template's
profile (unverified on AWS), launches still work rather than all failing; the graph policy
`template-profiles` checks each template names its own profile. -/
def controlPlaneStatements (spec : CellSpec) (template brainTemplate hostRole brainRole hostProfile brainProfile rootKey : Input String) :
    List Statement :=
  let fromTemplate : Condition := { op := "ArnLike", entries := [("ec2:LaunchTemplate", [template, brainTemplate])] }
  let fromSandboxTemplate : Condition := { op := "ArnLike", entries := [("ec2:LaunchTemplate", [template])] }
  let fromBrainTemplate : Condition := { op := "ArnLike", entries := [("ec2:LaunchTemplate", [brainTemplate])] }
  let ec2 (kind : String) : Input String := lit s!"arn:aws:ec2:{spec.region}:{spec.accountId}:{kind}"
  [ { sid := "LaunchFromTemplateOnly", actions := ["ec2:RunInstances"], resources := [template, brainTemplate]
      conditions := [fromTemplate] }
  , { sid := "LaunchedResources", actions := ["ec2:RunInstances"]
      resources := [lit s!"arn:aws:ec2:{spec.region}::image/*", ec2 "subnet/*", ec2 "network-interface/*", ec2 "volume/*",
        ec2 "spot-instances-request/*"]
      conditions := [fromTemplate] }
  , { sid := "SecurityGroupFromTemplate", actions := ["ec2:RunInstances"], resources := [ec2 "security-group/*"]
      conditions := [fromTemplate, { op := "Bool", entries := [("ec2:IsLaunchTemplateResource", ["true"])] }] }
  , { sid := "SandboxTypesOnly", actions := ["ec2:RunInstances"], resources := [ec2 "instance/*"]
      conditions := [fromSandboxTemplate, { op := "StringLike", entries := [("ec2:InstanceType", (instancePatterns spec).map lit)] },
        { op := "ArnEqualsIfExists", entries := [("ec2:InstanceProfile", [hostProfile])] }] }
  , { sid := "BrainTypesOnly", actions := ["ec2:RunInstances"], resources := [ec2 "instance/*"]
      conditions := [fromBrainTemplate, { op := "StringLike", entries := [("ec2:InstanceType", (brainInstancePatterns spec).map lit)] },
        { op := "ArnEqualsIfExists", entries := [("ec2:InstanceProfile", [brainProfile])] }] }
  , { sid := "TagAtLaunch", actions := ["ec2:CreateTags"], resources := [lit "*"]
      conditions := [{ op := "StringEquals", entries := [("ec2:CreateAction", ["RunInstances"])] }] }
  , { sid := "PassHostRoles", actions := ["iam:PassRole"], resources := [hostRole, brainRole]
      conditions := [{ op := "StringEquals", entries := [("iam:PassedToService", ["ec2.amazonaws.com"])] }] }
  , { sid := "StonithNestOnly", actions := ["ec2:TerminateInstances", "ec2:StopInstances"], resources := [ec2 "instance/*"]
      conditions := [{ op := "StringEquals", entries := [("aws:ResourceTag/nest", ["true"])] }] }
  , { sid := "Describe", actions := ["ec2:DescribeInstances", "ec2:DescribeImages"], resources := [lit "*"] }
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

  -- The sandbox host security group. The provider removes AWS's default allow-all egress rule.
  -- (Its description is the previous release's: changing it would replace the group.)
  let sg ← SecurityGroup.create "host"
    { name := lit s!"nest-{spec.name}-host", description := "nest burst hosts: egress 443 and 7844 only, no ingress"
      vpcId := vpc.id, revokeRulesOnDelete := true }
  let _ ← VpcSecurityGroupEgressRule.create "https"
    { securityGroupId := sg.id, ipProtocol := "tcp", fromPort := 443, toPort := 443, cidrIpv4 := "0.0.0.0/0" }
  let _ ← VpcSecurityGroupEgressRule.create "cloudflared_tcp"
    { securityGroupId := sg.id, ipProtocol := "tcp", fromPort := 7844, toPort := 7844, cidrIpv4 := "0.0.0.0/0" }
  let _ ← VpcSecurityGroupEgressRule.create "cloudflared_udp"
    { securityGroupId := sg.id, ipProtocol := "udp", fromPort := 7844, toPort := 7844, cidrIpv4 := "0.0.0.0/0" }
  -- The brain host security group: HTTPS out, nothing else, nothing in (no tunnel on a brain host).
  let brainSg ← SecurityGroup.create "brain"
    { name := lit s!"nest-{spec.name}-brain", description := "nest brain hosts: egress 443 only, no ingress"
      vpcId := vpc.id, revokeRulesOnDelete := true }
  let _ ← VpcSecurityGroupEgressRule.create "brain_https"
    { securityGroupId := brainSg.id, ipProtocol := "tcp", fromPort := 443, toPort := 443, cidrIpv4 := "0.0.0.0/0" }

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

  -- Sandbox hosts: the cell's bucket only, and only through the endpoint (the bucket policy).
  let hostRole ← IamRole.create "host"
    { name := lit s!"nest-{spec.name}-host"
      assumeRolePolicy := "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}" }
  let _ ← IamRolePolicy.create "host_cell_bucket"
    { name := "cell-bucket", role := hostRole.id, policy := document (hostStatements spec) }
  let profile ← IamInstanceProfile.create "host" { name := lit s!"nest-{spec.name}-host", role := hostRole.name }
  -- Brain hosts: read the release, nothing else (`brainHostStatements`; the `brain-role-exact`
  -- policy checks that this inline policy is the only way any permission reaches the role).
  let brainRole ← IamRole.create "brain"
    { name := lit s!"nest-{spec.name}-brain"
      assumeRolePolicy := "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}" }
  let _ ← IamRolePolicy.create "brain_releases"
    { name := "read-releases", role := brainRole.id, policy := document (brainHostStatements spec) }
  let brainProfile ← IamInstanceProfile.create "brain" { name := lit s!"nest-{spec.name}-brain", role := brainRole.name }
  let _ ← S3BucketPolicy.create "cell"
    { bucket := bucket.id
      policy := "{\"Version\":\"2012-10-17\",\"Statement\":["
        ++ "{\"Sid\":\"TlsOnly\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"" ++ bucket.arn ++ "\",\""
        ++ bucket.arn ++ "/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}},"
        ++ "{\"Sid\":\"HostsOnlyThroughEndpoint\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\""
        ++ bucket.arn ++ "\",\"" ++ bucket.arn ++ "/*\"],\"Condition\":{\"ArnEquals\":{\"aws:PrincipalArn\":[\"" ++ hostRole.arn
        ++ "\",\"" ++ brainRole.arn ++ "\"]},\"StringNotEquals\":{\"aws:SourceVpce\":\"" ++ s3.id ++ "\"}}}]}" }

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
  -- Old host images go: Image Builder's lifecycle policy keeps the two newest images of the host
  -- recipe (every version of it, `1.0.x`) and deletes the rest with their AMIs and snapshots. An
  -- AMI that launched an instance in the last seven days is kept regardless, so a run of failed
  -- builds cannot delete the AMI the launch template still resolves to. Image Builder evaluates
  -- policies on its own daily schedule.
  let lifecycleRole ← IamRole.create "image_lifecycle"
    { name := lit s!"nest-{spec.name}-image-lifecycle"
      assumeRolePolicy := "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"imagebuilder.amazonaws.com\"},\"Action\":\"sts:AssumeRole\"}]}" }
  let lifecycleAttachment ← IamRolePolicyAttachment.create "image_lifecycle"
    { role := lifecycleRole.name, policyArn := "arn:aws:iam::aws:policy/service-role/EC2ImageBuilderLifecycleExecutionPolicy" }
  let _ ← ImagebuilderLifecyclePolicy.createWith "host"
    { name := lit s!"nest-{spec.name}-host", executionRole := lifecycleRole.arn, resourceType := "AMI_IMAGE"
      description := "Keeps the two newest host images; deletes the rest with their AMIs and snapshots"
      resourceSelection := [{ recipe := [{ name := lit s!"nest-{spec.name}-host", semanticVersion := "1.0.x" }] }]
      policyDetail := [{ action := [{ type := "DELETE", includeResources := [{ amis := some true, snapshots := some true }] }]
                         filter := [{ type := "COUNT", value := 2 }]
                         exclusionRules := [{ amis := [{ lastLaunched := [{ unit := "DAYS", value := 7 }] }] }] }] }
    (resourceOptions |>.dependsOn lifecycleAttachment)

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
                                ebs := some { volumeSize := spec.hostRootGb, volumeType := "gp3", encrypted := "true", deleteOnTermination := "true" } }]
      tagSpecifications := [{ resourceType := "instance", tags := some (nestTags spec) },
                            { resourceType := "volume", tags := some (nestTags spec) }]
      -- Gzipped: EC2 allows 16 KB of user data before base64, and the script with install.sh inside is
      -- over it; cloud-init unpacks gzip (scripts/tests/test_bootstrap.py checks the size).
      userData := some (unsafeCall "base64gzip" [unsafeArgument (lit (bootstrap spec .sandbox))] : Input String)
      updateDefaultVersion := true }

  -- The brain launch template: the same AMI, cheap instances without nested virtualization, the
  -- brain security group and role, IMDSv2 with hop limit 1, tagged `nest=true`. No credit
  -- specification: EC2 drops it from a template that names no instance type (this one's
  -- `standard` never applied), so FleetDO asks for unlimited credits at launch. Its user data
  -- writes `role: brain`.
  let brainTemplate ← LaunchTemplate.create "brain"
    { name := lit s!"nest-{spec.name}-brain"
      imageId := lit "resolve:ssm:" ++ hostAmi.name
      iamInstanceProfile := some { arn := brainProfile.arn }
      vpcSecurityGroupIds := some (array [brainSg.id])
      metadataOptions := some { httpEndpoint := "enabled", httpTokens := "required", httpPutResponseHopLimit := 1
                                instanceMetadataTags := "disabled" }
      instanceInitiatedShutdownBehavior := "terminate"
      blockDeviceMappings := [{ deviceName := "/dev/xvda"
                                ebs := some { volumeSize := 30, volumeType := "gp3", encrypted := "true", deleteOnTermination := "true" } }]
      tagSpecifications := [{ resourceType := "instance", tags := some (nestTags spec) },
                            { resourceType := "volume", tags := some (nestTags spec) }]
      -- Gzipped, as the sandbox template's.
      userData := some (unsafeCall "base64gzip" [unsafeArgument (lit (bootstrap spec .brain))] : Input String)
      updateDefaultVersion := true }

  -- The proxy root CA: a non-exportable P-256 signing key. FleetDO signs each host's intermediate
  -- with it through KMS `Sign`; the private key never leaves KMS.
  let rootKey ← KmsKey.createWith "proxy_root"
    { description := lit s!"nest {spec.name}: proxy root CA (signs per-host intermediates)"
      customerMasterKeySpec := "ECC_NIST_P256", keyUsage := "SIGN_VERIFY", deletionWindowInDays := 30 }
    (resourceOptions |>.preventDestroy true)
  let _ ← KmsAlias.create "proxy_root" { name := lit s!"alias/nest-{spec.name}-proxy-root", targetKeyId := rootKey.keyId }

  -- The control plane (FleetDO). Its access key is created out of band and kept in the Worker
  -- secret `AWS_CELL_CREDENTIALS` under this cell's name (dev/deploy.md).
  let cp ← IamUser.create "control_plane" { name := lit s!"nest-{spec.name}-control-plane" }
  let templateArn : Input String := template.arn
  -- A managed policy: the document is over IAM's 2,048-byte limit for inline user policies.
  let fleet ← IamPolicy.create "control_plane_fleet"
    { name := lit s!"nest-{spec.name}-fleet"
      policy := document (controlPlaneStatements spec templateArn brainTemplate.arn hostRole.arn brainRole.arn profile.arn brainProfile.arn
        rootKey.arn) }
  let _ ← IamUserPolicyAttachment.create "control_plane_fleet" { user := cp.name, policyArn := fleet.arn }
  -- This cell's settings, from the template, subnets and root key above: a replaced template,
  -- subnet or key reaches the Worker on the deploy that follows the apply (dev/deploy-use1.sh
  -- merges every cell's parameter into `AWS_CELLS`).
  let _ ← SsmParameter.create "aws_cells"
    { name := lit (awsCellsParameter spec), type := "String"
      insecureValue := awsCells spec template.id brainTemplate.id [subnetA.id, subnetB.id, subnetC.id] rootKey.arn
      description := lit s!"nest: the {spec.name} cell's AWS_CELLS entry for the control plane (written by its cell stack)" }

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

  -- Deploys (dev/deploy.md): GitHub Actions assumes this role over OIDC, only from the repo's
  -- `production` environment, which only `main` may deploy from. Applying the stack manages IAM,
  -- so the role is administrator-equivalent; the trust policy is what limits it. The first apply
  -- of a cell runs by hand with the provisioner key: it creates the role later applies assume.
  let github ← IamOpenidConnectProvider.create "github"
    { url := "https://token.actions.githubusercontent.com", clientIdList := array [lit "sts.amazonaws.com"] }
  let deployRole ← IamRole.create "deploy"
    { name := lit s!"nest-{spec.name}-deploy"
      assumeRolePolicy := "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Federated\":\""
        ++ github.arn ++ "\"},\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{"
        ++ "\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\","
        ++ "\"token.actions.githubusercontent.com:sub\":\"repo:" ++ lit spec.deployRepo ++ ":environment:"
        ++ lit spec.deployEnvironment ++ "\"}}}]}" }
  let _ ← IamRolePolicyAttachment.create "deploy_admin"
    { role := deployRole.name, policyArn := "arn:aws:iam::aws:policy/AdministratorAccess" }

  output "bucket" bucket.id
  output "launch_template_id" template.id
  output "brain_launch_template_id" brainTemplate.id
  output "brain_security_group_id" brainSg.id
  output "subnet_ids" (array [subnetA.id, subnetB.id, subnetC.id])
  output "security_group_id" sg.id
  output "s3_endpoint_id" s3.id
  output "control_plane_user" cp.name
  output "spot_drill_template_id" drill.id
  output "proxy_root_key_arn" rootKey.arn
  output "host_image_pipeline" pipeline.arn
  output "deploy_role_arn" deployRole.arn

end Cell
