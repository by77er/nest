import Cell.Cells

/-!
What the cell may never do, checked while this module compiles: `inframe test`, `plan` and
`apply` refuse to run if any of it fails.

* **Theorems** about the IAM statements, for every cell (any name, region, account and URL) and
  for any launch template and host role: what the control plane and the hosts can be granted
  doesn't depend on a cell's settings.
* **Policies** over the `use1` graph, evaluated by `#assert_policy`: no ingress, the egress
  allow-list, and IMDSv2 with hop limit 1.
-/

open Inframe
open Cell
open Cell.Iam

namespace Cell.Test

/-! ### The control plane's IAM user -/

/-- STONITH can only reach instances tagged `nest=true`. -/
theorem terminate_only_tagged (spec : CellSpec) (template role key : Input String) :
    ∀ s ∈ controlPlaneStatements spec template role key,
      s.Grants "ec2:TerminateInstances" → s.Requires "StringEquals" "aws:ResourceTag/nest" [lit "true"] := by
  simp [controlPlaneStatements, Statement.Grants, Statement.Requires]

/-- Every launch goes through the cell's launch template. -/
theorem launch_only_from_template (spec : CellSpec) (template role key : Input String) :
    ∀ s ∈ controlPlaneStatements spec template role key,
      s.Grants "ec2:RunInstances" → s.Requires "ArnLike" "ec2:LaunchTemplate" [template] := by
  simp [controlPlaneStatements, Statement.Grants, Statement.Requires]

/-- The only IAM action is passing the host role, to EC2. -/
theorem passes_only_the_host_role (spec : CellSpec) (template role key : Input String) :
    ∀ s ∈ controlPlaneStatements spec template role key, ∀ a ∈ s.actions,
      a.startsWith "iam:" → a = "iam:PassRole" ∧ s.resources = [role] := by
  simp [controlPlaneStatements]

/-- KMS only signs with (and reads the public key of) the proxy root CA key: no other key, no
decrypt, no key management. -/
theorem kms_only_the_root_key (spec : CellSpec) (template role key : Input String) :
    ∀ s ∈ controlPlaneStatements spec template role key, ∀ a ∈ s.actions,
      a.startsWith "kms:" → (a = "kms:Sign" ∨ a = "kms:GetPublicKey") ∧ s.resources = [key] := by
  simp [controlPlaneStatements]

/-- SSM only reads the host AMI parameter (the launch template's `resolve:ssm:` image). -/
theorem ssm_only_the_host_ami (spec : CellSpec) (template role key : Input String) :
    ∀ s ∈ controlPlaneStatements spec template role key, ∀ a ∈ s.actions,
      a.startsWith "ssm:" → a = "ssm:GetParameters" ∧
        s.resources = [lit s!"arn:aws:ssm:{spec.region}:{spec.accountId}:parameter{hostAmiParameter spec}"] := by
  simp [controlPlaneStatements]

/-- The control plane's actions, whatever the cell: EC2, passing the host role, resolving the host
AMI and signing with the root key, named exactly. -/
theorem control_plane_actions (spec : CellSpec) (template role key : Input String) :
    ((controlPlaneStatements spec template role key).map (·.actions)).flatten =
      ["ec2:RunInstances", "ec2:RunInstances", "ec2:RunInstances", "ec2:RunInstances", "ec2:CreateTags",
       "iam:PassRole", "ec2:TerminateInstances", "ec2:StopInstances", "ec2:DescribeInstances", "ec2:DescribeImages",
       "ssm:GetParameters", "kms:Sign", "kms:GetPublicKey"] := by
  simp [controlPlaneStatements]

/-- The hosts' actions, whatever the cell: object storage only, named exactly. -/
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

/-- Nothing reaches a burst host from outside: no ingress rule of any kind. -/
def noIngress : Policy :=
  Policy.resources "no-ingress" fun r =>
    if r.resourceType == "aws_vpc_security_group_ingress_rule" || r.resourceType == "aws_security_group_rule"
        || (r.resourceType == "aws_security_group" && (r.argument? "ingress").isSome) then
      some "burst hosts accept no inbound traffic"
    else none

/-- Egress is exactly HTTPS and cloudflared. -/
def egressAllowList : Policy :=
  Policy.resourcesOfType "egress-allow-list" "aws_vpc_security_group_egress_rule" fun r =>
    match literal? r "ip_protocol", literal? r "from_port", literal? r "to_port" with
    | some (.string p), some (.number f), some (.number t) =>
      if f == t && hostEgress.any (fun (proto, port) => proto == p && f == Lean.JsonNumber.fromNat port) then none
      else some s!"egress {p} {f}-{t} is not in the allow-list"
    | _, _, _ => some "egress rules need literal protocol and ports"

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
  Policy.all "cell" [Policy.validGraph, noIngress, egressAllowList, imdsV2, amiPruning]

#assert_policy policies (buildGraph (cell use1))

end Cell.Test

def main : IO Unit :=
  Cell.Test.policies.enforce (buildGraph (Cell.cell Cell.use1))
