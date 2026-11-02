import Inframe
import Cloudflare.Provider
import Cloudflare.Resource.ZeroTrustAccessApplication

/-!
Cloudflare Access in front of the projects app (projects/README.md): the `projects` stack. The app is
not part of nest, so neither is this stack: it imports nothing from nest's `deploy/`. The provider
reads its token from `CLOUDFLARE_API_TOKEN` (Account › Access: Apps and Policies › Edit).

Three self-hosted applications, each with one inline policy, described as data (`apps`) and then
rendered, so `Projects.Test` can prove things about the data for every spec and check the rendering:
- the app, `<hostname>`: Allow for the owner's login, a 24 h session, in the App Launcher. The
  Worker checks the token against this application's audience (`projects_aud`, its `PROJECTS_AUD`);
- `<hostname>/hooks` and `<hostname>/mcp`: Bypass for everyone. The Worker authenticates those paths
  itself, webhooks by their signatures and MCP calls by nest's `Nest-Identity` JWT, and asks for no
  Access token there (`projects/src/worker.ts`).

**Precedence.** Access applies the more specific of overlapping paths: "When multiple rules are set
for a common root path, the more specific rule takes precedence", and a path with no rule of its
own inherits its parent's, so `/hooks` covers `/hooks/nest` and `/hooks/github`
(https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/). Unverified
here: that the docs' rule applies to separate applications with a Bypass policy (a community report,
https://community.cloudflare.com/t/cloudflare-access-exclude-path-from-authentication/204893, saw
such a bypass stop applying), and whether `/hooks` also covers a lookalike such as `/hooksX`. Either
way the Worker fails closed: every path outside `/hooks/` and `/mcp/` needs a valid Access token for
`projects_aud`, and the bypassed ones check their own credentials. The README has the check to run
after an apply (projects/deploy/README.md).
-/

open Inframe
open Cloudflare
open Cloudflare.Resource

namespace Projects

structure ProjectsSpec where
  /-- The Cloudflare account that holds the zone and the Zero Trust team. -/
  accountId : String
  /-- The zone, and the app's first-level label in it: the hostname is `<name>.<zone>`. -/
  zone : String
  name : String
  /-- The one login the app's Allow policy admits. -/
  ownerEmail : String

def hostname (spec : ProjectsSpec) : String := s!"{spec.name}.{spec.zone}"

/-- What a policy matches: one login, or everyone. -/
inductive Who where
  | email (address : String)
  | everyone
  deriving DecidableEq, Repr

inductive Decision where
  | allow
  | bypass
  deriving DecidableEq, Repr

def Decision.wire : Decision → String
  | .allow => "allow"
  | .bypass => "bypass"

/-- A self-hosted application and its one inline policy. -/
structure App where
  domain : String
  decision : Decision
  admits : List Who
  launcherVisible : Bool
  sessionDuration : Option String
  deriving Repr

/-- The app: the owner's login, nobody else. -/
def app (spec : ProjectsSpec) : App :=
  { domain := hostname spec, decision := .allow, admits := [.email spec.ownerEmail]
    launcherVisible := true, sessionDuration := some "24h" }

/-- A path the Worker authenticates itself: Access lets everyone through. -/
def bypass (spec : ProjectsSpec) (path : String) : App :=
  { domain := hostname spec ++ path, decision := .bypass, admits := [.everyone]
    launcherVisible := false, sessionDuration := none }

def hooks (spec : ProjectsSpec) : App := bypass spec "/hooks"
def mcp (spec : ProjectsSpec) : App := bypass spec "/mcp"

/-- Every application the stack creates, in order. -/
def apps (spec : ProjectsSpec) : List App := [app spec, hooks spec, mcp spec]

def Who.args : Who → ZeroTrustAccessApplication.PoliciesExcludeArgs
  | .email address => { email := some { email := lit address } }
  | .everyone => { everyone := some {} }

def App.args (spec : ProjectsSpec) (a : App) : ZeroTrustAccessApplication.Args :=
  { accountId := some (lit spec.accountId), name := some (lit a.domain), type := some "self_hosted"
    domain := some (lit a.domain)
    sessionDuration := a.sessionDuration.map lit, appLauncherVisible := some (lit a.launcherVisible)
    policies := some [{ name := some (lit a.decision.wire), decision := some (lit a.decision.wire), precedence := some 1
                        include_ := some (a.admits.map Who.args) }] }

def projects (spec : ProjectsSpec) : Infra Unit := do
  let _ ← Provider.configure {}
  let main ← ZeroTrustAccessApplication.create "app" ((app spec).args spec)
  let _ ← ZeroTrustAccessApplication.create "hooks" ((hooks spec).args spec)
  let _ ← ZeroTrustAccessApplication.create "mcp" ((mcp spec).args spec)
  -- The Worker's `PROJECTS_AUD` (projects/wrangler.jsonc): it checks Access tokens against this audience.
  output "projects_aud" main.aud

end Projects
