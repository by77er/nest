import Edge.Edges

/-!
What the edge may never do, checked while this module compiles (`inframe test`, `plan` and `apply`
refuse to run otherwise): every Access application has exactly one policy; the gateways admit
service tokens only (`non_identity`, with a 401 for a machine that has none); every other
application admits one login, the owner's, and never `everyone`.
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
    | .object [(kind, .object inner)] => some (kind, (inner.lookup "email").bind ExprNode.literal?)
    | .object [(kind, _)] => some (kind, none)
    | _ => none
  | _ => []

def onePolicyEach : Policy :=
  Policy.resourcesOfType "one-policy" "cloudflare_zero_trust_access_application" fun r =>
    if (policy? r).isSome then none else some "every application carries exactly one inline policy"

def gatewaysServiceAuth : Policy :=
  Policy.resourcesOfType "gateways-service-auth" "cloudflare_zero_trust_access_application" fun r =>
    match r.argument? "domain" |>.bind ExprNode.literal? with
    | some (.string d) =>
      if d.startsWith "*-gw-" then
        match policy? r with
        | some p =>
          if field? p "decision" != some (.string "non_identity") then some "the gateways take service tokens only (non_identity)"
          else if includes p != [("any_valid_service_token", none)] then some "the gateways admit any valid service token and nothing else"
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

def policies : Policy :=
  Policy.all "edge" [Policy.validGraph, onePolicyEach, gatewaysServiceAuth, ownerOnlyElsewhere bitcrush.ownerEmail]

#assert_policy policies (buildGraph (edge bitcrush))

end Edge.Test

def main : IO Unit :=
  Edge.Test.policies.enforce (buildGraph (Edge.edge Edge.bitcrush))
