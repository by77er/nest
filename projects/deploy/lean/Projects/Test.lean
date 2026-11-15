import Projects.Spec

/-!
What Access in front of the app may never do, checked while this module compiles (`inframe test`,
`plan` and `apply` refuse to run otherwise):
- **Theorems, for every spec,** over the applications as data (`apps`): only the owner's login is
  ever allowed, and only on the hostname itself; Service Auth admits only nest's cloud checks' one
  service token, and only on the hostname; the bypass covers exactly `/hooks` and `/mcp` on it; no
  other hostname or path is covered.
- **Policies over the rendered graph** of `bitcrush`, so the rendering can't drift from the data:
  the same rules on the applications OpenTofu would create (the hostname with exactly those two
  inline policies, each bypass with one), and the `projects_aud` output.
-/

open Inframe
open Projects

namespace Projects.Test

/-! ## Theorems over the data -/

/-- Only the owner's login is allowed, and only on the hostname itself. -/
theorem allow_only_the_owner (spec : ProjectsSpec) :
    ∀ a ∈ apps spec, ∀ r ∈ a.rules, r.decision = .allow → a.domain = hostname spec ∧ r.admits = [.email spec.ownerEmail] := by
  simp [apps, app, hooks, mcp, bypass]

/-- Service Auth admits only the cloud checks' one service token, and only on the hostname itself. -/
theorem service_auth_only_the_checks_token (spec : ProjectsSpec) :
    ∀ a ∈ apps spec, ∀ r ∈ a.rules, r.decision = .serviceAuth →
      a.domain = hostname spec ∧ r.admits = [.serviceToken spec.checksServiceTokenId] := by
  simp [apps, app, hooks, mcp, bypass]

/-- Nobody else: every rule admits the owner's login, the checks' token, or (bypassing) everyone. -/
theorem admits_nobody_else (spec : ProjectsSpec) :
    ∀ a ∈ apps spec, ∀ r ∈ a.rules, ∀ w ∈ r.admits,
      w = .email spec.ownerEmail ∨ w = .serviceToken spec.checksServiceTokenId ∨ (w = .everyone ∧ r.decision = .bypass) := by
  simp [apps, app, hooks, mcp, bypass]

/-- The bypass covers exactly the two paths the Worker authenticates itself, for everyone, and they
carry nothing else. -/
theorem bypass_only_hooks_and_mcp (spec : ProjectsSpec) :
    ((apps spec).filter (·.rules.any (·.decision == .bypass))).map (·.domain) = [hostname spec ++ "/hooks", hostname spec ++ "/mcp"]
      ∧ ∀ a ∈ apps spec, (a.rules.any (·.decision == .bypass)) → a.rules = [{ decision := .bypass, admits := [.everyone] }] := by
  simp [apps, app, hooks, mcp, bypass]

/-- Nothing but the hostname and those two paths on it is covered. -/
theorem covers_only_the_hostname (spec : ProjectsSpec) :
    (apps spec).map (·.domain) = [hostname spec, hostname spec ++ "/hooks", hostname spec ++ "/mcp"] := by
  simp [apps, app, hooks, mcp, bypass]

/-! ## Policies over the graph -/

def domain? (r : ResourceSpec) : Option String :=
  match r.argument? "domain" |>.bind ExprNode.literal? with
  | some (.string d) => some d
  | _ => none

/-- The inline policies of an application, each as literal fields. -/
def policies? (r : ResourceSpec) : Option (List (List (String × ExprNode))) :=
  match r.argument? "policies" with
  | some (.array ps) => ps.mapM fun | .object fields => some fields | _ => none
  | _ => none

def field? (fields : List (String × ExprNode)) (name : String) : Option Value :=
  (fields.lookup name).bind ExprNode.literal?

/-- The include rules of a policy: the kind of each rule, and its email or token id when it is one. -/
def includes (fields : List (String × ExprNode)) : List (String × Option Value) :=
  match fields.lookup "include" with
  | some (.array rules) => rules.filterMap fun
    | .object [(kind, .object inner)] =>
      some (kind, ((inner.lookup "email").bind ExprNode.literal?).orElse fun _ => (inner.lookup "token_id").bind ExprNode.literal?)
    | .object [(kind, _)] => some (kind, none)
    | _ => none
  | _ => []

def applications : String := "cloudflare_zero_trust_access_application"

/-- One inline policy's decision and includes. -/
def shape (p : List (String × ExprNode)) : Option Value × List (String × Option Value) :=
  (field? p "decision", includes p)

/-- Each application: the hostname allows the owner's login and gives Service Auth to the checks'
token, those two policies and no other; `/hooks` and `/mcp` on it bypass for everyone, one policy
each; any other domain is a violation. -/
def perApplication (spec : ProjectsSpec) : Policy :=
  Policy.resourcesOfType "per-application" applications fun r =>
    match domain? r, policies? r with
    | none, _ => some "every application names a literal domain"
    | _, none => some "every application carries literal inline policies"
    | some d, some ps =>
      if d == hostname spec then
        if ps.map shape != [(some (.string "allow"), [("email", some (.string spec.ownerEmail))]),
                            (some (.string "non_identity"), [("service_token", some (.string spec.checksServiceTokenId))])] then
          some s!"the app allows only {spec.ownerEmail}'s login and the checks' service token"
        else none
      else if d == hostname spec ++ "/hooks" || d == hostname spec ++ "/mcp" then
        if ps.map shape != [(some (.string "bypass"), [("everyone", none)])] then some "a bypass is one policy for everyone and nothing else"
        else none
      else some s!"covers only {hostname spec}, {hostname spec}/hooks and {hostname spec}/mcp"

/-- Exactly those three applications, once each. -/
def exactlyThree (spec : ProjectsSpec) : Policy :=
  Policy.graph "exactly-three" fun g =>
    let domains := (g.resources.filter (·.resourceType == applications)).map domain?
    if domains == [some (hostname spec), some (hostname spec ++ "/hooks"), some (hostname spec ++ "/mcp")] then none
    else some s!"the applications are the hostname, /hooks and /mcp, once each: {domains}"

/-- The Worker's `PROJECTS_AUD` comes from this output. -/
def audOutput : Policy :=
  Policy.graph "projects-aud" fun g =>
    if (g.output? "projects_aud").isSome then none else some "the stack outputs projects_aud"

def policies : Policy :=
  Policy.all "projects" [Policy.validGraph, perApplication bitcrush, exactlyThree bitcrush, audOutput]

#assert_policy policies (buildGraph (projects bitcrush))

end Projects.Test

def main : IO Unit :=
  Projects.Test.policies.enforce (buildGraph (Projects.projects Projects.bitcrush))
