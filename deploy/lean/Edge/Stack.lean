import Inframe
import Cloudflare.Provider
import Cloudflare.Resource.ZeroTrustAccessApplication
import Cloudflare.Resource.R2BucketLifecycle

/-!
Cloudflare Access in front of nest's hostnames: the `edge` stack (docs/sandbox/gateway/, Auth
layers; docs/control-plane/dashboard/), and the lifecycle of the control plane's R2 bucket
(docs/data/). Account-level, not per cell. The provider reads its token from
`CLOUDFLARE_API_TOKEN` (Account › Access: Apps and Policies › Edit, and Workers R2 Storage › Edit).

Three self-hosted applications, each with one inline policy:
- the sandbox gateways, `*-gw-<label>.<zone>`: Service Auth (`non_identity`) for one service token,
  the one the control plane hands out as `edge` (BrokerDO `access:gateway`), answering 401 instead of
  a login redirect, so a machine client (the hands client) sees a refusal it understands;
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
  /-- The id (not a secret) of the service token the gateways admit: the one in `access:gateway`. -/
  gatewayServiceTokenId : String
  /-- The control plane's R2 bucket (`control-plane/wrangler.jsonc`, binding `BUCKET`). -/
  controlBucket : String
  /-- Days FleetDO's egress audit (`audit/<sandbox>/<day>/…`) is kept (docs/data/). -/
  auditRetentionDays : Nat

def gatewaysDomain (spec : EdgeSpec) : String := s!"*-gw-{spec.label}.{spec.zone}"
def dashboardDomain (spec : EdgeSpec) : String := s!"dash-{spec.label}.{spec.zone}"
def previewsDomain (spec : EdgeSpec) : String := s!"*-preview-{spec.label}.{spec.zone}"

/-- The policy that admits the gateways' service token and nobody else. -/
def serviceAuth (spec : EdgeSpec) : ZeroTrustAccessApplication.PoliciesArgs :=
  { name := some "service token", decision := some "non_identity", precedence := some 1
    include_ := some [{ serviceToken := some { tokenId := lit spec.gatewayServiceTokenId } }] }

/-- The policy that admits the owner's login and nobody else. -/
def ownerOnly (spec : EdgeSpec) : ZeroTrustAccessApplication.PoliciesArgs :=
  { name := some "owner", decision := some "allow", precedence := some 1
    include_ := some [{ email := some { email := lit spec.ownerEmail } }] }

/-- Egress audit objects are deleted `auditRetentionDays` after they are written. -/
def auditExpiry (spec : EdgeSpec) : R2BucketLifecycle.RulesArgs :=
  { id := "audit-expiry", enabled := true, conditions := { prefix_ := "audit/" }
    deleteObjectsTransition := some
      { condition := some { type := "Age", maxAge := some (lit (Lean.JsonNumber.fromNat (spec.auditRetentionDays * 86400))) } } }

/-- The rule R2 gave the bucket at creation, kept because the lifecycle resource replaces the whole
configuration: verified on `nest-control` (id `Default Multipart Abort Rule`, enabled, abort after
604800 s, empty conditions, which the provider writes as the empty prefix). -/
def multipartAbort : R2BucketLifecycle.RulesArgs :=
  { id := "Default Multipart Abort Rule", enabled := true, conditions := { prefix_ := "" }
    abortMultipartUploadsTransition := some { condition := some { type := "Age", maxAge := 604800 } } }

def edge (spec : EdgeSpec) : Infra Unit := do
  let _ ← Provider.configure {}
  let _ ← ZeroTrustAccessApplication.create "gateways"
    { accountId := some (lit spec.accountId), name := some (lit s!"{spec.label} gateways"), type := some "self_hosted"
      domain := some (lit (gatewaysDomain spec))
      serviceAuth401Redirect := some true, appLauncherVisible := some false
      policies := some [serviceAuth spec] }
  let dashboard ← ZeroTrustAccessApplication.create "dashboard"
    { accountId := some (lit spec.accountId), name := some (lit s!"{spec.label} dashboard"), type := some "self_hosted"
      domain := some (lit (dashboardDomain spec))
      sessionDuration := some "24h", appLauncherVisible := some true
      policies := some [ownerOnly spec] }
  let _ ← ZeroTrustAccessApplication.create "previews"
    { accountId := some (lit spec.accountId), name := some (lit s!"{spec.label} previews"), type := some "self_hosted"
      domain := some (lit (previewsDomain spec))
      sessionDuration := some "24h", appLauncherVisible := some false
      policies := some [ownerOnly spec] }
  -- The dashboard Worker checks Access tokens against this audience (dashboard/wrangler.jsonc).
  output "dashboard_aud" dashboard.aud
  -- This resource owns the bucket's whole lifecycle configuration: a rule for another prefix goes
  -- here too (one set by hand in the Cloudflare dashboard is replaced on apply).
  let _ ← R2BucketLifecycle.create "control_bucket"
    { accountId := lit spec.accountId, bucketName := lit spec.controlBucket
      rules := some [multipartAbort, auditExpiry spec] }

end Edge
