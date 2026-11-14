# GitHub guards where nest injects no GitHub token (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)), for the GitHub constructor's guards [without nest's own token](../../docs/sandbox/networking/egress/policy/#github).

**Not a one-way deploy, and no ordering constraint.** No stored state, route or wire field: only the guards SandboxDO builds for a sandbox with no repos of either kind and no operator GitHub binding change, and they reach nest-proxy at its next policy push (`policy_update` or a create). A sandbox with nest's own token gets exactly the guards it did.

- **What changes:** in those sandboxes (no repos of either kind, and no operator binding that is a GitHub credential by name, placeholder or a `github.com`/`*.github.com` host), `github-push`, `github-api-write`, and `github-write` for receive-pack and Git LFS's API only, let a write through when the request's one `Authorization` field is a credential nest's injection wrote whole (`{injected: "*", at: authorization}`), and `github-push` lets push discovery through bare. Before, they refused every write there. github.com's cookie-authenticated web routes stay refused.
- **Hosts:** the exceptions use `*` and `at`, which a nest-proxy without `guard_injected_any` reads as a binding named `*` (never present): fail closed, so such a write is still refused there, as before. No placement constraint follows (only exceptions use `*`). Every sandbox host launched since #267 has the flag.
- **Who it's for:** the projects app's new spawns, which bind their own GitHub tokens as client secrets and add their own client guards. They need this release live before they can push.
- **What a rollback does:** the previous release builds the old guards again at the next policy push, so those sandboxes refuse every GitHub write again, an app's own binding's included. Nothing to undo.
- **Removed by** phase C3, with the constructor: the operator then keeps a floor like this in the base layer, as data.
