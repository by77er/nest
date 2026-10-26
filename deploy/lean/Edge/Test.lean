import Edge.Edges

/-!
What the edge may never do, checked while this module compiles (`inframe test`, `plan` and `apply`
refuse to run otherwise): every Access application has exactly one policy; the gateways admit
one service token only (`non_identity`, with a 401 for a machine that has none), never any valid
token of the account; every other application admits one login, the owner's, and never `everyone`;
the control plane's bucket deletes egress audit by age and keeps R2's multipart-abort rule.
-/

open Inframe
open Edge

namespace Edge.Test

/-- The one inline policy of an application, as literal fields. -/
def policy? (r : ResourceSpec) : Option (List (String × ExprNode)) :=
  match r.argument? "policies" with
  | some (.array [.object fields]) => some fields
  | _ => none

def field? (fields : List (String × ExprNode)) (name : String) : Option Value :=
  (fields.lookup name).bind ExprNode.literal?

/-- The include rules of a policy: the names of the rule kinds used, and the email when it is one. -/
def includes (fields : List (String × ExprNode)) : List (String × Option Value) :=
  match fields.lookup "include" with
  | some (.array rules) => rules.filterMap fun
    | .object [(kind, .object inner)] =>
      some (kind, ((inner.lookup "email").bind ExprNode.literal?).orElse fun _ => (inner.lookup "token_id").bind ExprNode.literal?)
    | .object [(kind, _)] => some (kind, none)
    | _ => none
  | _ => []

def onePolicyEach : Policy :=
  Policy.resourcesOfType "one-policy" "cloudflare_zero_trust_access_application" fun r =>
    if (policy? r).isSome then none else some "every application carries exactly one inline policy"

def gatewaysServiceAuth (tokenId : String) : Policy :=
  Policy.resourcesOfType "gateways-service-auth" "cloudflare_zero_trust_access_application" fun r =>
    match r.argument? "domain" |>.bind ExprNode.literal? with
    | some (.string d) =>
      if d.startsWith "*-gw-" then
        match policy? r with
        | some p =>
          if field? p "decision" != some (.string "non_identity") then some "the gateways take service tokens only (non_identity)"
          else if includes p != [("service_token", some (.string tokenId))] then some "the gateways admit their one service token and nothing else"
          else if (r.argument? "service_auth_401_redirect" |>.bind ExprNode.literal?) != some (.bool true) then some "a machine without a token gets a 401, not a login page"
          else none
        | none => some "no policy"
      else none
    | _ => some "every application names a literal domain"

def ownerOnlyElsewhere (owner : String) : Policy :=
  Policy.resourcesOfType "owner-only" "cloudflare_zero_trust_access_application" fun r =>
    match r.argument? "domain" |>.bind ExprNode.literal? with
    | some (.string d) =>
      if d.startsWith "*-gw-" then none
      else match policy? r with
        | some p =>
          if field? p "decision" != some (.string "allow") then some "an identity application allows"
          else if includes p != [("email", some (.string owner))] then some s!"only {owner} may log in"
          else none
        | none => some "no policy"
    | _ => some "every application names a literal domain"

/-- Each lifecycle rule as (prefix, delete condition type, delete max age), literals only. -/
def lifecycleRules (r : ResourceSpec) : List (Option Value × Option Value × Option Value) :=
  match r.argument? "rules" with
  | some (.array rules) => rules.filterMap fun
    | .object fields =>
      let prefix_ := match fields.lookup "conditions" with
        | some (.object c) => field? c "prefix"
        | _ => none
      let (kind, age) := match fields.lookup "delete_objects_transition" with
        | some (.object d) => match d.lookup "condition" with
          | some (.object c) => (field? c "type", field? c "max_age")
          | _ => (none, none)
        | _ => (none, none)
      some (prefix_, kind, age)
    | _ => none
  | _ => []

/-- The control plane's bucket deletes egress audit by age (FleetDO writes it under `audit/`). -/
def auditExpires (bucket : String) : Policy :=
  Policy.graph "audit-expires" fun g =>
    let expiring := g.resources.any fun r =>
      r.resourceType == "cloudflare_r2_bucket_lifecycle"
        && (r.argument? "bucket_name" |>.bind ExprNode.literal?) == some (.string bucket)
        && (lifecycleRules r).any fun (p, kind, age) => p == some (.string "audit/") && kind == some (.string "Age") && age.isSome
    if expiring then none else some s!"{bucket} deletes `audit/` objects by age"

/-- The rule R2 gave the bucket (abort incomplete multipart uploads after 7 days) is kept: the
lifecycle resource replaces the bucket's whole configuration, so leaving it out would delete it. -/
def multipartAbortKept (bucket : String) : Policy :=
  Policy.graph "multipart-abort-kept" fun g =>
    let kept := g.resources.any fun r =>
      r.resourceType == "cloudflare_r2_bucket_lifecycle"
        && (r.argument? "bucket_name" |>.bind ExprNode.literal?) == some (.string bucket)
        && match r.argument? "rules" with
          | some (.array rules) => rules.any fun
            | .object fields =>
              let abort := match fields.lookup "abort_multipart_uploads_transition" with
                | some (.object a) => match a.lookup "condition" with
                  | some (.object c) => field? c "type" == some (.string "Age") && field? c "max_age" == some (.number 604800)
                  | _ => false
                | _ => false
              field? fields "id" == some (.string "Default Multipart Abort Rule") && field? fields "enabled" == some (.bool true) && abort
            | _ => false
          | _ => false
    if kept then none else some s!"{bucket} keeps R2's multipart-abort rule (7 days)"

def policies : Policy :=
  Policy.all "edge" [Policy.validGraph, onePolicyEach, gatewaysServiceAuth bitcrush.gatewayServiceTokenId, ownerOnlyElsewhere bitcrush.ownerEmail,
    auditExpires bitcrush.controlBucket, multipartAbortKept bitcrush.controlBucket]

#assert_policy policies (buildGraph (edge bitcrush))

end Edge.Test

def main : IO Unit :=
  Edge.Test.policies.enforce (buildGraph (Edge.edge Edge.bitcrush))
