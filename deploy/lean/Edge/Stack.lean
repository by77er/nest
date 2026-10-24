import Inframe
import Cloudflare.Provider
import Cloudflare.Resource.ZeroTrustAccessApplication

/-!
Cloudflare Access in front of nest's hostnames: the `edge` stack (docs/sandbox/gateway/, Auth
layers; docs/control-plane/dashboard/). Account-level, not per cell. The provider reads its token
from `CLOUDFLARE_API_TOKEN` (Account › Access: Apps and Policies › Edit).

Three self-hosted applications, each with one inline policy:
- the sandbox gateways, `*-gw-<label>.<zone>`: Service Auth (`non_identity`) for any valid service
  token of the account, answering 401 instead of a login redirect, so a machine client (the hands
  client) sees a refusal it understands;
- the dashboard, `dash-<label>.<zone>`: Allow for the owner's login;
- previews, `*-preview-<label>.<zone>`: Allow for the owner's login (the routes are not built yet;
  the application is cheap and keeps the hostname closed).
-/

open Inframe
open Cloudflare
open Cloudflare.Resource

namespace Edge

structure EdgeSpec where
  /-- The Cloudflare account that holds the zone and the Zero Trust team. -/
  accountId : String
  /-- The zone (`bitcru.sh`) and the nest label (`nest`): every nest hostname is `<x>-<kind>-<label>.<zone>`. -/
  zone : String
  label : String
  /-- The one login the identity policies allow. -/
  ownerEmail : String

def gatewaysDomain (spec : EdgeSpec) : String := s!"*-gw-{spec.label}.{spec.zone}"
def dashboardDomain (spec : EdgeSpec) : String := s!"dash-{spec.label}.{spec.zone}"
def previewsDomain (spec : EdgeSpec) : String := s!"*-preview-{spec.label}.{spec.zone}"

/-- The policy that admits any valid service token of the account and nobody else. -/
def serviceAuth : ZeroTrustAccessApplication.PoliciesArgs :=
  { name := some "service token", decision := some "non_identity", precedence := some 1
    include_ := some [{ anyValidServiceToken := some {} }] }

/-- The policy that admits the owner's login and nobody else. -/
def ownerOnly (spec : EdgeSpec) : ZeroTrustAccessApplication.PoliciesArgs :=
  { name := some "owner", decision := some "allow", precedence := some 1
    include_ := some [{ email := some { email := lit spec.ownerEmail } }] }

def edge (spec : EdgeSpec) : Infra Unit := do
  let _ ← Provider.configure {}
  let _ ← ZeroTrustAccessApplication.create "gateways"
    { accountId := some (lit spec.accountId), name := some (lit s!"{spec.label} gateways"), type := some "self_hosted"
      domain := some (lit (gatewaysDomain spec))
      serviceAuth401Redirect := some true, appLauncherVisible := some false
      policies := some [serviceAuth] }
  let _ ← ZeroTrustAccessApplication.create "dashboard"
    { accountId := some (lit spec.accountId), name := some (lit s!"{spec.label} dashboard"), type := some "self_hosted"
      domain := some (lit (dashboardDomain spec))
      sessionDuration := some "24h", appLauncherVisible := some true
      policies := some [ownerOnly spec] }
  let _ ← ZeroTrustAccessApplication.create "previews"
    { accountId := some (lit spec.accountId), name := some (lit s!"{spec.label} previews"), type := some "self_hosted"
      domain := some (lit (previewsDomain spec))
      sessionDuration := some "24h", appLauncherVisible := some false
      policies := some [ownerOnly spec] }

end Edge
