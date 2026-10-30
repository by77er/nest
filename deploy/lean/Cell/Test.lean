import Cell.Cells

/-!
What the cell may never do, checked while this module compiles: `inframe test`, `plan` and
`apply` refuse to run if any of it fails.

* **Theorems** about the IAM statements, for every cell (any name, region, account and URL) and
  for any launch templates and host roles: what the control plane and the hosts can be granted
  doesn't depend on a cell's settings.
* **Policies** over the `use1` graph, evaluated by `#assert_policy`: no ingress, each security
  group's egress allow-list (brain hosts: 443 only), IMDSv2 with hop limit 1, and a brain role
  with no permissions.
-/

open Inframe
open Cell
open Cell.Iam

namespace Cell.Test

/-! ### The control plane's IAM user -/

/-- STONITH can only reach instances tagged `nest=true` (both launch templates tag theirs; the
image builder's are not). -/
theorem terminate_only_tagged (spec : CellSpec) (template brainTemplate role brainRole key : Input String) :
    ∀ s ∈ controlPlaneStatements spec template brainTemplate role brainRole key,
      s.Grants "ec2:TerminateInstances" → s.Requires "StringEquals" "aws:ResourceTag/nest" [lit "true"] := by
  simp [controlPlaneStatements, Statement.Grants, Statement.Requires]

/-- Every launch goes through one of the cell's two launch templates. -/
theorem launch_only_from_the_templates (spec : CellSpec) (template brainTemplate role brainRole key : Input String) :
    ∀ s ∈ controlPlaneStatements spec template brainTemplate role brainRole key,
      s.Grants "ec2:RunInstances" →
        s.Requires "ArnLike" "ec2:LaunchTemplate" [template, brainTemplate]
          ∨ s.Requires "ArnLike" "ec2:LaunchTemplate" [template]
          ∨ s.Requires "ArnLike" "ec2:LaunchTemplate" [brainTemplate] := by
  simp [controlPlaneStatements, Statement.Grants, Statement.Requires]

/-- An instance's type is tied to the template it is launched from: the sandbox template only
launches the cell's 8i families, the brain template only the brain families. These are the only
statements that grant `RunInstances` on `instance/*`. -/
theorem instance_types_follow_their_template (spec : CellSpec) (template brainTemplate role brainRole key : Input String) :
    ∀ s ∈ controlPlaneStatements spec template brainTemplate role brainRole key,
      s.Grants "ec2:RunInstances" → (s.sid = "EightIOnly" ∨ s.sid = "BrainTypesOnly") →
        (s.sid = "EightIOnly" ∧ s.Requires "ArnLike" "ec2:LaunchTemplate" [template]
            ∧ s.Requires "StringLike" "ec2:InstanceType" ((instancePatterns spec).map lit))
          ∨ (s.sid = "BrainTypesOnly" ∧ s.Requires "ArnLike" "ec2:LaunchTemplate" [brainTemplate]
            ∧ s.Requires "StringLike" "ec2:InstanceType" ((brainInstancePatterns spec).map lit)) := by
  simp [controlPlaneStatements, Statement.Grants, Statement.Requires]

/-- The only IAM action is passing the two host roles, to EC2. -/
theorem passes_only_the_host_roles (spec : CellSpec) (template brainTemplate role brainRole key : Input String) :
    ∀ s ∈ controlPlaneStatements spec template brainTemplate role brainRole key, ∀ a ∈ s.actions,
      a.startsWith "iam:" → a = "iam:PassRole" ∧ s.resources = [role, brainRole] := by
  simp [controlPlaneStatements]

/-- KMS only signs with (and reads the public key of) the proxy root CA key: no other key, no
decrypt, no key management. -/
theorem kms_only_the_root_key (spec : CellSpec) (template brainTemplate role brainRole key : Input String) :
    ∀ s ∈ controlPlaneStatements spec template brainTemplate role brainRole key, ∀ a ∈ s.actions,
      a.startsWith "kms:" → (a = "kms:Sign" ∨ a = "kms:GetPublicKey") ∧ s.resources = [key] := by
  simp [controlPlaneStatements]

/-- SSM only reads the host AMI parameter (both launch templates' `resolve:ssm:` image). -/
theorem ssm_only_the_host_ami (spec : CellSpec) (template brainTemplate role brainRole key : Input String) :
    ∀ s ∈ controlPlaneStatements spec template brainTemplate role brainRole key, ∀ a ∈ s.actions,
      a.startsWith "ssm:" → a = "ssm:GetParameters" ∧
        s.resources = [lit s!"arn:aws:ssm:{spec.region}:{spec.accountId}:parameter{hostAmiParameter spec}"] := by
  simp [controlPlaneStatements]

/-- The control plane's actions, whatever the cell: EC2, passing the host roles, resolving the host
AMI and signing with the root key, named exactly. -/
theorem control_plane_actions (spec : CellSpec) (template brainTemplate role brainRole key : Input String) :
    ((controlPlaneStatements spec template brainTemplate role brainRole key).map (·.actions)).flatten =
      ["ec2:RunInstances", "ec2:RunInstances", "ec2:RunInstances", "ec2:RunInstances", "ec2:RunInstances", "ec2:CreateTags",
       "iam:PassRole", "ec2:TerminateInstances", "ec2:StopInstances", "ec2:DescribeInstances", "ec2:DescribeImages",
       "ssm:GetParameters", "kms:Sign", "kms:GetPublicKey"] := by
  simp [controlPlaneStatements]

/-- The instance-type condition is the cell's families as `<family>*.*`, and nothing else. -/
theorem launch_only_listed_families (spec : CellSpec) (template brainTemplate role brainRole key : Input String) :
    ∀ s ∈ controlPlaneStatements spec template brainTemplate role brainRole key,
      s.Grants "ec2:RunInstances" → s.sid = "EightIOnly" →
        s.Requires "StringLike" "ec2:InstanceType" ((instancePatterns spec).map lit) := by
  simp [controlPlaneStatements, Statement.Grants, Statement.Requires]

/-- Brain hosts get no permission at all: their role has no statements. -/
theorem brain_hosts_have_no_permissions (spec : CellSpec) : brainHostStatements spec = [] := rfl

/-- `matchesFamily` is IAM's `StringLike` on `<family>*.*`: another family, or no `.`, is refused. -/
example : matchesFamily "c8i" "c8i-flex.large" ∧ !matchesFamily "c8i" "c7i.large" ∧ !matchesFamily "c8i" "c8i"
    ∧ !matchesFamily "c8i" "m8i.large" := by decide

/-- Every instance type `use1`'s autoscaler may pick (`AWS_CELLS`) is one IAM lets it launch, so a
launch never fails on `EightIOnly`. -/
theorem launch_types_within_iam : use1.launchTypesAllowed = true := by decide

/-- The same for its brain hosts and `BrainTypesOnly`. -/
theorem brain_launch_types_within_iam : use1.brainLaunchTypesAllowed = true := by decide

/-- The brain families are not the sandbox families: a brain template can never launch an 8i
instance and the sandbox template never a brain type. -/
example : use1.brainLaunchTypes.all (fun t => !use1.instanceFamilies.any (matchesFamily · t))
    ∧ use1.launchTypes.all (fun t => !use1.brainInstanceFamilies.any (matchesFamily · t)) := by decide

/-- `AWS_CELLS` is JSON keyed by the cell, carrying the stack's template, subnets and proxy root CA
key and the spec's instance types (the shape control-plane/src/lib/cells.ts parses). -/
def awsCellsHolds (spec : CellSpec) : Bool :=
  let key := s!"arn:aws:kms:{spec.region}:{spec.accountId}:key/1234abcd-12ab-34cd-56ef-1234567890ab"
  match Lean.Json.parse (awsCellsWith id spec "lt-0abc" "lt-0b" ["subnet-0a", "subnet-0b"] key) with
  | .ok json =>
    match json.getObjVal? spec.name with
    | .ok cell =>
      cell.getObjValAs? String "region" == .ok spec.region
        && cell.getObjValAs? String "launch_template_id" == .ok "lt-0abc"
        && cell.getObjValAs? (List String) "subnet_ids" == .ok ["subnet-0a", "subnet-0b"]
        && cell.getObjValAs? (List String) "instance_types" == .ok spec.launchTypes
        && cell.getObjValAs? Bool "spot" == .ok spec.spot
        && cell.getObjValAs? Nat "max_hosts" == .ok spec.maxHosts
        && cell.getObjValAs? Nat "idle_grace_ms" == .ok spec.idleGraceMs
        && cell.getObjValAs? Nat "enroll_timeout_ms" == .ok spec.enrollTimeoutMs
        && cell.getObjValAs? Nat "sandbox_reserve_mib" == .ok spec.sandboxReserveMib
        && cell.getObjValAs? Nat "max_sandboxes_per_host" == .ok spec.maxSandboxesPerHost
        && cell.getObjValAs? String "proxy_root_key_arn" == .ok key
        && (match cell.getObjVal? "brain" with
            | .ok brain =>
              brain.getObjValAs? String "launch_template_id" == .ok "lt-0b"
                && brain.getObjValAs? (List String) "instance_types" == .ok spec.brainLaunchTypes
                && brain.getObjValAs? Bool "spot" == .ok spec.brainSpot
                && brain.getObjValAs? Nat "max_hosts" == .ok spec.brainMaxHosts
                && brain.getObjValAs? Nat "idle_grace_ms" == .ok spec.brainIdleGraceMs
                && brain.getObjValAs? Nat "max_brains_per_host" == .ok spec.maxBrainsPerHost
            | .error _ => false)
    | .error _ => false
  | .error _ => false

#guard awsCellsHolds use1

/-- The sandbox hosts' actions, whatever the cell: object storage only, named exactly. -/
theorem host_actions (spec : CellSpec) :
    ((hostStatements spec).map (·.actions)).flatten =
      ["s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketLocation", "s3:GetObject", "s3:GetObjectVersion",
       "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:AbortMultipartUpload"] := by
  simp [hostStatements]

/-- Hosts reach only the cell's bucket and its objects. -/
theorem hosts_only_reach_the_bucket (spec : CellSpec) :
    ∀ s ∈ hostStatements spec, ∀ r ∈ s.resources,
      r = lit s!"arn:aws:s3:::{bucketName spec}" ∨ r = lit s!"arn:aws:s3:::{bucketName spec}/*" := by
  simp [hostStatements]

/-- The image builder only reads: it lists and gets the release, nothing else in the bucket. -/
theorem builder_only_reads_releases (spec : CellSpec) :
    ((builderStatements spec).map (·.actions)).flatten = ["s3:ListBucket", "s3:GetObject"] ∧
      ∀ s ∈ builderStatements spec, s.Grants "s3:GetObject" →
        s.resources = [lit s!"arn:aws:s3:::{bucketName spec}/releases/*"] := by
  simp [builderStatements, Statement.Grants]

/-- No action in any list is a wildcard, so `Grants` (exact membership) is what IAM grants. -/
theorem no_wildcards : ∀ a ∈ ["ec2:RunInstances", "ec2:CreateTags", "iam:PassRole", "ec2:TerminateInstances",
    "ec2:StopInstances", "ec2:DescribeInstances", "ssm:GetParameters", "kms:Sign", "kms:GetPublicKey", "s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketLocation",
    "s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion",
    "s3:AbortMultipartUpload"], '*' ∉ a.toList := by
  decide

/-! ### The `use1` graph -/

/-- A literal field of a nested block (`metadata_options[0].http_tokens`). -/
def blockField? (r : ResourceSpec) (block field : String) : Option Value :=
  match r.argument? block with
  | some (.array [.object fields]) => (fields.lookup field).bind ExprNode.literal?
  | _ => none

def literal? (r : ResourceSpec) (argument : String) : Option Value :=
  (r.argument? argument).bind ExprNode.literal?

/-- Nothing reaches a host from outside: no ingress rule of any kind. -/
def noIngress : Policy :=
  Policy.resources "no-ingress" fun r =>
    if r.resourceType == "aws_vpc_security_group_ingress_rule" || r.resourceType == "aws_security_group_rule"
        || (r.resourceType == "aws_security_group" && (r.argument? "ingress").isSome) then
      some "hosts accept no inbound traffic"
    else none

/-- The brain hosts' security group (its address in the graph). -/
def brainSecurityGroup : Address := .resource "aws_security_group" "brain"

/-- Egress is exactly HTTPS and cloudflared from sandbox hosts, and HTTPS only from brain hosts:
each rule is checked against the list of the group it belongs to. -/
def egressAllowList : Policy :=
  Policy.resourcesOfType "egress-allow-list" "aws_vpc_security_group_egress_rule" fun r =>
    let brain := (r.argument? "security_group_id").bind ExprNode.referencedAddress? == some brainSecurityGroup
    let allowed := if brain then brainEgress else hostEgress
    match literal? r "ip_protocol", literal? r "from_port", literal? r "to_port" with
    | some (.string p), some (.number f), some (.number t) =>
      if f == t && allowed.any (fun (proto, port) => proto == p && f == Lean.JsonNumber.fromNat port) then none
      else some s!"egress {p} {f}-{t} is not in the {if brain then "brain" else "sandbox"} hosts' allow-list"
    | _, _, _ => some "egress rules need literal protocol and ports"

/-- The brain role stays bare: no inline policy, attachment or bucket statement names it (its
permissions are `brainHostStatements`, empty). -/
def brainRoleBare : Policy :=
  Policy.resources "brain-role-bare" fun r =>
    let refersToBrain (arg : String) := ((r.argument? arg).bind ExprNode.referencedAddress?) == some (.resource "aws_iam_role" "brain")
    if (r.resourceType == "aws_iam_role_policy" || r.resourceType == "aws_iam_role_policy_attachment") && refersToBrain "role" then
      some "the brain hosts' role must have no permissions"
    else none

/-- The brain launch template runs no VM: no nested virtualization, and the brain security group only. -/
def brainTemplateShape : Policy :=
  Policy.resourcesOfType "brain-template" "aws_launch_template" fun r =>
    if r.name != "brain" then none
    else if (r.argument? "cpu_options").isSome then some "a brain host needs no nested virtualization"
    else match r.argument? "vpc_security_group_ids" with
      | some (.array [g]) => if g.referencedAddress? == some brainSecurityGroup then none else some "brain hosts use the brain security group"
      | _ => some "brain hosts use the brain security group, and only it"

/-- Hosts use IMDSv2 with hop limit 1, so nothing a hop away (a sandbox) reaches the role's keys. -/
def imdsV2 : Policy :=
  Policy.resourcesOfType "imds-v2" "aws_launch_template" fun r =>
    match blockField? r "metadata_options" "http_tokens", blockField? r "metadata_options" "http_put_response_hop_limit" with
    | some (.string "required"), some (.number 1) => none
    | _, _ => some "metadata_options must require tokens with hop limit 1"

/-- A field of a block nested two levels down (`policy_detail[0].filter[0].type`). -/
def blockField2? (r : ResourceSpec) (block inner field : String) : Option Value :=
  match r.argument? block with
  | some (.array [.object fields]) =>
    match fields.lookup inner with
    | some (.array [.object f2]) => (f2.lookup field).bind ExprNode.literal?
    | _ => none
  | _ => none

/-- Old host images are deleted with their snapshots, but never below two images. -/
def amiPruning : Policy :=
  Policy.resourcesOfType "ami-pruning" "aws_imagebuilder_lifecycle_policy" fun r =>
    match blockField2? r "policy_detail" "filter" "type", blockField2? r "policy_detail" "filter" "value",
          blockField2? r "policy_detail" "action" "type" with
    | some (.string "COUNT"), some (.number n), some (.string "DELETE") =>
      if n < Lean.JsonNumber.fromNat 2 then some "the lifecycle policy must keep at least two images" else none
    | _, _, _ => some "the lifecycle policy must delete by count with literal values"

def policies : Policy :=
  Policy.all "cell" [Policy.validGraph, noIngress, egressAllowList, imdsV2, amiPruning, brainRoleBare, brainTemplateShape]

#assert_policy policies (buildGraph (cell use1))

end Cell.Test

def main : IO Unit :=
  Cell.Test.policies.enforce (buildGraph (Cell.cell Cell.use1))
