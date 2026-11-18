# Upkeep: the weekly upstream check

The owner's request (2026-11-18): keep Claude Code, Firecracker, and the kernels in the VMs and on the hosts up to date. This file is the standing procedure: what each upstream component is, where nest pins it, which version to move to, and how a move reaches hosts and sandboxes; then [the check](#the-check), which turns "behind" into one task per move.

**No versions are recorded here.** Pins are named by file and variable and read on `main` at check time; a version below is evidence for a decision, with its date.

## Who runs it, and when

**Weekly.** Either:
- **the project's manager,** on a timer of its own (nest's timers are one-shot: each run sets the next; a replaced manager loses them, so the routine is the steadier choice); or
- **a routine of the projects app** ([routines](../projects/README.md#routines)): kind `custom`, a weekly timer, instructions `Follow dev/upkeep.md.` (the owner's prompt is what makes the repo's text instructions here; `/dev/` is a `CODEOWNERS` path), a 30-minute budget, proposals to the board as drafts. A run reads the repo and the web (`WebFetch`, `WebSearch`), proposes at most 5 tasks and never pushes. **Drafts, not triage:** a run's tools (`list_tasks`) see the board but not the triage queue, so with proposals in triage the next run can't see what the last one proposed and would propose it again.

Whoever runs it follows [the check](#the-check) as written. A change to a rule below is a PR to this file.

## Components

### Claude Code (all hosts; brains run it)

- **Pin:** `deploy/host/install.sh`, `CLAUDE_VERSION`. Installed by `curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_VERSION"` (skipped when `claude --version` already says it) and written to `/etc/nest/claude-version`; `scripts/tests/test_bootstrap.py` reads it. The SHA-256 pin and the runner's baseline check are designed, not built ([runner-claude](../docs/interfaces/host-internal/runner-claude/README.md#version)).
- **Upstream:** the npm registry document `https://registry.npmjs.org/@anthropic-ai/claude-code`: `dist-tags` and `time` (publish time per version). Read it with:

  ```bash
  curl -fsSL https://registry.npmjs.org/@anthropic-ai/claude-code | python3 -I -c '
  import json, sys, datetime as d
  j = json.load(sys.stdin); cut = d.datetime.now(d.timezone.utc) - d.timedelta(hours=72)
  ok = [v for v in j["versions"] if "-" not in v and d.datetime.fromisoformat(j["time"][v].replace("Z", "+00:00")) <= cut]
  print(max(ok, key=lambda v: tuple(map(int, v.split(".")))))'
  ```

  Changelog: [CHANGELOG.md](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md). That the native installer serves every version npm lists is unverified; a host install failing shows it.
- **Rule** (the manager's decision, 2026-11-18; the owner's to change): **the newest version published at least 72 hours before the check.**
  - Not `latest`: releases are near-daily and some are replaced within hours (2.1.324 → 2.1.325 in 85 minutes, 2026-11-13).
  - Not the `stable` dist-tag: it lags by weeks (2.1.311 on 2026-11-18), older than the version the runner's hooks were checked on (2.1.316, [runner-claude](../docs/interfaces/host-internal/runner-claude/README.md)).
- **The upgrade:** a PR that changes `CLAUDE_VERSION`, with the changelog between the two versions read against what nest relies on: the flags, environment and managed settings in [runner-claude](../docs/interfaces/host-internal/runner-claude/README.md), the hooks, stream-json, `--resume` and the session files, MCP `list_changed`. Observations in that doc name the version they were made on; a re-check updates them.
- **How it reaches hosts:** `install.sh` is `include_str`'d into the cell stack (`deploy/lean/Cell/Stack.lean`) as both launch templates' user data and the Image Builder component. A merge changes them at the deploy's `infra` apply (a new component and recipe version), but publishes no release (`install.sh` isn't among `deploy.yml`'s release inputs) and so starts no AMI build. Every host runs `install.sh` at boot, so each host launched after the apply installs the new version (a slower boot until the next AMI bakes it in). Running hosts keep the old one: hosts are replaced, never updated in place ([upgrades](../docs/compute/provisioning/README.md#upgrades)).
- **Who:** a worker opens the PR. `/deploy/` is a `CODEOWNERS` path, so the owner approves it, **after running the gates**.
- **Gates** ([runner](../docs/agents/runner/README.md), "Upgrades are gated"): the `e2e/claude-verify` probes, the [hands fidelity eval](../docs/README.md#first-spike) and resuming sessions written by the previous version. They need the real binary and the subscription token, which never enters a sandbox ([ci.md](ci.md): real Claude Code runs by hand), so **the owner runs them**; a worker can't. Only the probes are built (`e2e/claude-verify/run.py`, [e2e](../e2e/README.md)); the fidelity eval and a resume across versions aren't, so until they are the owner runs the probes and resumes a session the previous version wrote by hand, and says so on the PR. A worker runs `python3 -m unittest discover -s scripts/tests` and the stub-based `python3 -m unittest discover -s e2e/claude-verify`.

### cloudflared (sandbox hosts' tunnel)

- **Pin:** `deploy/host/install.sh`, `CLOUDFLARED_VERSION` and `CLOUDFLARED_SHA256` (of the release asset `cloudflared-linux-amd64`).
- **Upstream:** [releases](https://github.com/cloudflare/cloudflared/releases); the newest is `gh api repos/cloudflare/cloudflared/releases/latest --jq .tag_name`. Each release's notes list every asset's SHA-256.
- **Rule:** the newest release.
- **The upgrade:** a PR changing both variables. The digest is computed from the download (`curl -fsSL https://github.com/cloudflare/cloudflared/releases/download/<V>/cloudflared-linux-amd64 | sha256sum`; GitHub's downloads are reachable from a project sandbox) and matched against the release notes' line. Read the release notes for changes to what nestd runs (`cloudflared --no-autoupdate tunnel --metrics <addr> run`, `crates/nestd/src/cloudflared.rs`) and to token handling.
- **How it reaches hosts:** as Claude Code's, at each host's launch after the apply.
- **Who:** a worker's PR; the owner approves (`/deploy/`).
- **Gates:** `scripts/tests` (`test_bootstrap.py`, with shellcheck). After the deploy, on a sandbox host launched after the apply, a hands call through its tunnel: [hands_probe_check.py](cloud-checks/README.md#hands_probe_checkpy) (the owner's: it needs the admin token; in a warm cell it may land on an older host, so check which host it used).

### Firecracker and the jailer (sandbox hosts)

- **Pin: none in the repo.** `scripts/publish-release.sh` carries `firecracker` and `jailer` (with `vmlinux` and `nest-base.ext4.zst`, its `CARRIED`) unchanged from the cell bucket's `releases/current/`: "they change by hand". Hosts report no Firecracker version. The decision is "the 1.17 line, pinned by binary digest, patch level included", verified on 1.17.0 ([firecracker driver](../docs/sandbox/drivers/firecracker/README.md), which also says why a patch release can change the snapshot format). So the pinned version is the one that doc's "Version" bullet records as installed, or else the one it says was verified; each upgrade's PR records the version it promoted there. Only the owner can read the bucket's binaries.
- **Upstream:** [releases](https://github.com/firecracker-microvm/firecracker/releases), each with `firecracker-v<V>-x86_64.tgz` and `firecracker-v<V>-x86_64.tgz.sha256.txt`; the newest: `gh api repos/firecracker-microvm/firecracker/releases --jq '[.[] | select(.prerelease | not) | .tag_name] | .[:5]'`. [Changelog](https://github.com/firecracker-microvm/firecracker/blob/main/CHANGELOG.md).
- **Rule** (the manager's decision, 2026-11-18; the owner's to change):
  - **a newer patch release of the pinned line** is a task to move to it;
  - **a new minor line** (1.17 → 1.18) **is the owner's decision.** Its task reads the changelog against the driver doc (the snapshot format, the API fields nestd sends, the host and guest kernels in Firecracker's [kernel policy](https://github.com/firecracker-microvm/firecracker/blob/main/docs/kernel-policy.md)), reports, and stops for the owner's go.
  - Either way it changes the [restore ABI](../docs/compute/provisioning/README.md#upgrades): dormant memory generations can't load on the new hosts. Harmless while cold boot is the only restore. The guest and host kernels change it too.
- **The upgrade:** the tarball holds `release-v<V>-x86_64/firecracker-v<V>-x86_64` and `release-v<V>-x86_64/jailer-v<V>-x86_64`. A worker's PR updates the driver doc's "Version" bullet to the exact version promoted (and the line, for a new minor). The owner checks the tarball against its `.sha256.txt` and promotes the two binaries into `releases/current/` as `firecracker` and `jailer` by the [promotion](#promotion-into-releasescurrent), **before approving the PR**, so the merge (which marks the task done) means it's installed.
- **How it reaches hosts:** each sandbox host launched after the promotion installs it (`install.sh` installs the release at boot). The next AMI build bakes it in.
- **Who:** the doc PR is a worker's; the promotion is the owner's (AWS credentials on the cell's bucket).
- **Gates:** on a sandbox host launched after the promotion, a sandbox boots and serves hands calls ([hands_probe_check.py](cloud-checks/README.md#hands_probe_checkpy)) and a real turn runs in one ([brain_hosts_check.py](cloud-checks/README.md#brain_hosts_checkpy)); both the owner's. No test in the repo runs a real Firecracker (it needs KVM).

### The guest kernel and guest image (`nest-base`)

- **Pins:** `images/guest/build.sh`: `CI` (the URL of one Firecracker CI build, `…/firecracker-ci/<build id>/x86_64`), `KERNEL` and `KERNEL_SHA256`, `ROOTFS` and `ROOTFS_SHA256`. The kernel is Firecracker's prebuilt CI build on the 6.18 longterm line (decided 2026-10-22, [firecracker driver](../docs/sandbox/drivers/firecracker/README.md)); the rootfs is its Ubuntu 24.04 squashfs, plus packages apt installs at build time from `noble`, `noble-updates` and `noble-security` (`MIRROR`).
- **Upstream:** Firecracker's CI bucket.
  - **Builds:** `https://s3.amazonaws.com/spec.ccfc.min?list-type=2&prefix=firecracker-ci/&delimiter=/`. Build ids start with their date (`YYYYMMDD-<commit>-<n>`), so the newest is the last dated prefix; two builds can share a date, and which of those is newer is unverified, so compare their files' `LastModified`.
  - **A build's files:** `https://s3.amazonaws.com/spec.ccfc.min?list-type=2&prefix=firecracker-ci/<build id>/x86_64/` (the kernel is the key `x86_64/vmlinux-6.18.<n>` itself, not its `.config` or `debug/` copies; the rootfs is `x86_64/ubuntu-24.04.squashfs`). A project sandbox's egress refuses `s3.amazonaws.com` (403, seen 2026-11-18): read the listings with `WebFetch`.
- **What sandboxes run** (for the report, not the rules): inside a sandbox created from the live image, `uname -r` is its kernel, and the last `End-Date` in `/var/log/apt/history.log` is when its packages were installed (unless that sandbox has run apt since). A sandbox with a committed generation keeps its own older disk.
- **Rule:**
  - **Kernel:** behind when the newest CI build's `vmlinux-6.18.<n>` is newer than `KERNEL`; the target is that build. Staying on the 6.18 line; moving off it is a decision for the driver doc, not this check.
  - **Rootfs:** the same build's `ubuntu-24.04.squashfs`, moved with the kernel (one `CI` URL). A newer build with the same kernel isn't behind on its own: its rootfs changes every week, and the packages that matter are refreshed by the rebuild below.
  - **Packages:** a rebuild with unchanged pins picks up Ubuntu's security updates. **Rebuild at least monthly** even when no pin moves (the manager's decision, 2026-11-18; the build is the owner's, so the cadence is the owner's to change): behind when no guest task (a kernel move or a rebuild) was `done` this calendar month. The board is the record, not a sandbox: a long-lived sandbox keeps booting the image it was created from.
- **The upgrade:** a PR changing the pins. Both digests come from the files themselves, which a project sandbox can't fetch (its egress refuses `s3.amazonaws.com`), so **the owner supplies `KERNEL_SHA256` and `ROOTFS_SHA256`**, from a download on a machine that reaches it; never from a listing's `ETag`. The build can't: `build.sh` checks the pins and prints no digest on a mismatch. Then the owner builds from the PR's branch (`build-on-ec2.sh` uploads the checkout's `build.sh`) and promotes, **before approving the PR**, so the merge (which marks the task done) means it's live:
  1. `images/guest/build-on-ec2.sh <bucket> <subnet> <security group> <instance profile> <ami> <root CA PEM>`, the root CA from `GET /v1/admin/root-ca?cell=use1` (a wrong one breaks TLS in every new sandbox). It builds from `releases/current/nest-guest`, so it also ships every `nest-guest` change since the last rebuild. Done when `images/guest/<build id>/build.log` contains `BUILD-OK`.
  2. Promote the build's `vmlinux` and `nest-base.ext4.zst` by the [promotion](#promotion-into-releasescurrent).
- **How it reaches sandboxes:** each sandbox host launched after the promotion installs it; a sandbox created there gets a copy. A sandbox with a committed generation keeps booting its own disk, and a fork copies its parent's ([upgrades](../docs/compute/provisioning/README.md#upgrades)).
- **Who:** the PR is a worker's; the digests, the build and the promotion are the owner's (AWS credentials). `/images/` isn't a `CODEOWNERS` path.
- **Gates:** on a sandbox host launched after the promotion, a sandbox boots and serves hands calls ([hands_probe_check.py](cloud-checks/README.md#hands_probe_checkpy)) and a real turn runs in one ([brain_hosts_check.py](cloud-checks/README.md#brain_hosts_checkpy)), both the owner's; then `uname -r` in a new sandbox there shows the new kernel.

### The host AMI and its kernel (Amazon Linux 2023)

- **Pin: none to bump.** The Image Builder recipe's parent is `ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.18-x86_64` (`parentImage` in `deploy/lean/Cell/Stack.lean`), which Image Builder resolves at each build (AWS's behaviour for an `ssm:` parent, unverified here), so each build starts from Amazon's newest AL2023 AMI with the 6.18 kernel. The launch templates resolve the newest built AMI from `/imagebuilder/nest-use1/host-ami`, which each build rewrites.
- **What starts a build:** `deploy.yml`'s `release` job runs "Host AMI" (`aws imagebuilder start-image-pipeline-execution`) only when `scripts/publish-release.sh` published a changed release (`changed=true`). A `workflow_dispatch` always builds the host binaries, but starts an AMI build only if the built files differ from the current release's (whether a rebuild of unchanged code is byte-identical is unverified). A merge that changes only `install.sh` starts none (Claude Code, above). The pipeline has no schedule.
- **How it reaches hosts:** only at launch: running hosts keep their AMI until they are replaced (spot loss, autoscaling). Desired host versions and canaries aren't built ([deploy](deploy.md)).
- **Upstream:** [AL2023 release notes](https://docs.aws.amazon.com/linux/al2023/release-notes/relnotes.html), one page per quarterly line listing its dated releases (`2023.<minor>.<YYYYMMDD>`). Each release's page lists, under "Default Kernel 6.18 AMI", the packages it updated in the AMI the parameter names (a kernel update shows as `kernel6.18-…`).
- **The check:** the date of the newest build, against the newest AL2023 release.
  - **Exact,** the owner's (admin token): `GET /v1/admin/images?cell=use1` gives the AMI the launch template resolves to (`current`) and since when (`current_since_ms`).
  - **Estimate,** anyone with read access to the repo's Actions: the last `deploy.yml` run whose `release` job ran "Host AMI":

    ```bash
    for id in $(gh run list --repo by77er/nest --workflow deploy.yml -L 60 --json databaseId --jq '.[].databaseId'); do
      c=$(gh run view "$id" --repo by77er/nest --json jobs --jq '.jobs[] | select(.name == "release") | .steps[] | select(.name == "Host AMI") | .conclusion')
      [ "$c" = success ] && { gh run view "$id" --repo by77er/nest --json createdAt --jq .createdAt; break; }
    done
    ```

    It shows a build was started, not that it succeeded (unverified per run), and misses builds the owner started by hand: a `done` host AMI task counts as a build on its date.
- **Rule** (written with this procedure, 2026-11-18; the owner's to change): behind when a release after the newest build updated `kernel6.18` in its "Default Kernel 6.18 AMI" section, or the newest build is more than 14 days older than the newest release. Releases that change host code rebuild the AMI anyway, so this rarely fires.
- **The upgrade:** the owner starts the pipeline: `aws imagebuilder start-image-pipeline-execution --image-pipeline-arn <nest-use1-host's ARN>` (as `deploy.yml` does). A scheduled rebuild isn't built.
- **Who:** the owner (AWS credentials). Changing the kernel line is a stack PR (`/deploy/`), outside this check.
- **Gates:** a new host enrolls on it: [new_host_check.py](cloud-checks/README.md#new_host_checkpy), then [hands_probe_check.py](cloud-checks/README.md#hands_probe_checkpy) and [brain_hosts_check.py](cloud-checks/README.md#brain_hosts_checkpy), the owner's.

### Promotion into `releases/current/`

Firecracker, the jailer, the guest kernel and the guest image reach hosts only through the release, and the pipeline carries them over unchanged, so the owner swaps them in by hand. Read from `scripts/publish-release.sh`, `scripts/prune-images.sh` and `deploy/host/install.sh`, as in [the guest rollout of 2026-11-15](rollout/2026-11-15-guest-github.md); not yet run as written (unverified as a whole):

1. **Not while a deploy runs, nor while a merge to `main` may start one.** `publish-release.sh` reads `releases/current/SHA256SUMS` and the carried files first and writes `SHA256SUMS` last, so a swap in between leaves hashes no host can verify.
2. **Back up:** copy `releases/current/<each file being replaced>` and `releases/current/SHA256SUMS` to `images/guest/previous-<date>/` (`prune-images.sh` keeps every `previous-*`).
3. **Copy the new files** into `releases/current/` under the release's names (`firecracker`, `jailer`, `vmlinux`, `nest-base.ext4.zst`).
4. **Last, `releases/current/SHA256SUMS`,** with only those files' lines replaced by the new files' digests. Hosts install nothing that fails it (`install.sh`), and `publish-release.sh` refuses a carried file it doesn't vouch for. Never replace the whole file: a release published since would fail verification.
5. **Prune:** `DRY_RUN=1 scripts/prune-images.sh use1 <bucket>`, then without `DRY_RUN`, with credentials that may deregister images: it also prunes host AMIs and their snapshots and removes `builder/` ([pruning](deploy.md#pruning-images)). It keeps the two newest finished guest builds and every `previous-*`.

**Rolling back** is the same swap from the backup, again replacing only those lines of `SHA256SUMS`, last.

## The check

Needs read access to the repo and the web; nothing here changes anything but the board.

1. **Read the pins on `main`** (`git fetch origin` first): `CLAUDE_VERSION`, `CLOUDFLARED_VERSION` in `deploy/host/install.sh`; the Firecracker line and patch level as [its section](#firecracker-and-the-jailer-sandbox-hosts) says (or its pin, if the repo has one by then); `CI` and `KERNEL` in `images/guest/build.sh`.
2. **Read upstream** for each, as its section says, and the last host AMI build.
3. **Apply each rule.** A component is behind when its rule names a version newer than the pin, or (guest packages, host AMI) when its rule's dates say so.
4. **Look for its task** for each component behind, with `list_tasks`, by the component's title prefix below:
   - **a task with the same title,** in any state: nothing to do. Open, it's in hand; `done`, the move was made (Firecracker, guest packages and the host AMI have no pin on `main` that moves when it's done; a guest kernel task done this month is also this month's rebuild); cancelled by the owner (the cancel's actor in `get_task`'s history), **the owner declined that target**, which stays declined until a newer one gives a new title; cancelled by anyone else, it counts as absent. The owner cancels a task to decline it, never deletes it: a deleted task is invisible here and would be proposed again;
   - **one is open with an older target:** if it's a draft or ready with no worker yet, the manager retitles it to the new target; otherwise it lands first and the next run moves on from it. A routine run notes it in its report instead (it can't change tasks);
   - **none:** open one (the manager creates it; a routine proposes it).
5. **Each task** says: pinned and target versions, the upstream links and the changelog range read, the rule that chose the target, and which steps are the owner's (from the component's "Who" and "Gates"), listed apart from the worker's. At most one task per title kind below.
   - **Owner-only tasks** (a guest rebuild with unchanged pins, a host AMI rebuild, a Firecracker line before the owner's go) say so in their first line and stay unassigned drafts: no PR will mark them done, so the owner marks one done when the step is done (the board allows it from draft, ready or stalled), or cancels it to decline. The guest-packages rule reads that record. After the owner's go, a Firecracker line task is specced for a worker like a patch.
6. **Report,** one line per component: pinned, newest upstream, target by the rule, action (none, task opened, task updated, already open).

**Task titles,** fixed so a later run recognises its own:

| Component | Title |
|---|---|
| Claude Code | `Upkeep: Claude Code <pinned> → <target>` |
| cloudflared | `Upkeep: cloudflared <pinned> → <target>` |
| Firecracker, a patch | `Upkeep: Firecracker patch <pinned> → <target>` |
| Firecracker, a new line | `Upkeep: Firecracker line <line> (the owner's decision)` |
| Guest kernel and rootfs | `Upkeep: guest kernel <pinned> → <target>` |
| Guest packages | `Upkeep: rebuild the guest image (<YYYY-MM>)` |
| Host AMI | `Upkeep: rebuild the host AMI (<YYYY-MM-DD of the AL2023 release>)` |

Versions are written as the pin writes them, without a leading `v` (`CLAUDE_VERSION`, `CLOUDFLARED_VERSION`, Firecracker `<major>.<minor>.<patch>`, `KERNEL` without `vmlinux-`); `<line>` is `<major>.<minor>`. Titles compare ignoring case, punctuation and spacing, as the app compares declined proposals. The prefix is everything before the first version, date or arrow (`Upkeep: Claude Code`, `Upkeep: Firecracker patch`, `Upkeep: guest kernel`). There are seven kinds, so a routine run (at most 5 proposals) that finds more behind proposes the rest the next week.
