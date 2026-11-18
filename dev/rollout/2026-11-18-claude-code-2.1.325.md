# Claude Code baseline 2.1.325 (2026-11-18)

**Not one-way for the Worker or for stored state.** The change is `CLAUDE_VERSION` in `deploy/host/install.sh`, nothing in the control plane reads it, and the Worker has no ordering constraint. A `wrangler rollback` has nothing to undo: the change writes no stored state, and the Worker bundle is unchanged. **For sessions it may be one-way:** the [provisioning table](../../docs/compute/provisioning/#upgrades) lists a Claude Code baseline as one-way when the previous binary can't read what the newer one wrote. Whether 2.1.301 can read sessions written by 2.1.325 is unverified (the mixed-fleet section below).

- **What the merge starts:** CI passing on `main` runs `deploy.yml`. It applies the infrastructure (`use1`, then `edge`), deploys the Worker again with an identical bundle, and runs the release job, which normally finds its inputs already published.
- **What the apply changes:**
  - a new version of both launch templates (their user data carries `install.sh`);
  - the Image Builder component and recipe (their version is `install.sh`'s hash), and the image pipeline that points at the recipe.

  `AWS_CELLS` names the templates, not their versions, so it doesn't change.

  Normally no release is built. Its inputs (`crates/`, `protocol/`, the Cargo files, the toolchain, `.cargo/`, `scripts/publish-release.sh`) are unchanged, so the release job's `release-inputs-<digest>` cache marker hits. If that marker was evicted, the job rebuilds, and `publish-release.sh` publishes nothing only if the binaries come out byte-identical.

  Without a publish, no host AMI build starts, and the AMI the launch templates resolve keeps the version it was built with (2.1.301, if it was built since that pin; every host installs the pin at boot either way).
- **Right after the apply, start a host AMI build.** It needs the owner's AWS access; the commands are the ones `deploy.yml`'s release job runs:

  ```bash
  arn=$(aws imagebuilder list-image-pipelines --region us-east-1 --query "imagePipelineList[?name=='nest-use1-host'].arn | [0]" --output text)
  build=$(aws imagebuilder start-image-pipeline-execution --region us-east-1 --image-pipeline-arn "$arn" --query imageBuildVersionArn --output text)
  aws imagebuilder get-image --region us-east-1 --image-build-version-arn "$build" --query image.state.status   # until AVAILABLE
  aws ssm get-parameter --region us-east-1 --name /imagebuilder/nest-use1/host-ami --query Parameter.Value       # the new AMI id
  ```

  Until a new AMI exists, `install.sh` finds the AMI's older version at every boot and runs Claude's native installer. That installer's script downloads the *latest* binary from `downloads.claude.ai/claude-code-releases/` (its `latest` pointer and manifest). The latest binary then installs 2.1.325, which is a second download; this step happens inside the binary, so it is unverified.

  This applies to both host kinds, though only brain hosts run Claude Code. Every boot therefore depends on Anthropic's download host: `bootstrap.sh` runs `install.sh` under `set -e`. If a download fails, the host never enrolls, the launch ends in `enroll_timeout`, and it counts toward the enrolment breaker.
- **When a host gets 2.1.325:** at launch, after the apply, from user data or from the new AMI once built. A host that is already running keeps 2.1.301 until it is replaced (idle retirement, spot loss, autoscaling).
- **A mixed fleet:** both host sets run the same nest release, and brain placement doesn't look at Claude Code versions. It prefers the host that ran the agent last, or else the fullest brain host with room ([brain hosts](../../docs/compute/brain-hosts/)). So until the last 2.1.301 brain host is gone, a session can cross versions in either direction:
  - **Written by 2.1.301, resumed by 2.1.325:** this is the upgrade gate (resuming the previous baseline's sessions, [runner](../../docs/agents/runner/)). The owner checks it before approving.
  - **Written by 2.1.325, resumed by 2.1.301:** an older binary reading a newer session file. Unverified: the session JSONL is internal and "changes between versions" ([sessions](https://code.claude.com/docs/en/sessions)). The older binary may resume while silently dropping lines it doesn't understand. Or it may fail: the brain exits, the crash-loop guard restarts it (preferring the same 2.1.301 host), and after 3 restarts without a completed turn the agent is `errored`; only new input retries it ([AgentDO](../../docs/control-plane/durable-objects/agent/)). The provisioning table's "start fresh from memory" isn't built: the resume-or-fresh choice doesn't exist yet. So close the window soon after the apply.
- **Closing the window:** retire the 2.1.301 brain hosts, so every brain starts on 2.1.325.
  - **Which hosts:** the ones launched before the apply. Check their launch time, or an `aws:ec2launchtemplate:version` tag below the brain template's new default version (EC2 tags instances launched from a template; unverified on this cell). FleetDO doesn't keep the `claude_code` version a host's `hello` carries.
  - **The operator drain doesn't apply:** `POST /v1/admin/hosts/<id>/drain` refuses a brain host with 409 ("only a sandbox host is drained by hand", `FleetDO.drainHost`).
  - **Terminate the host in EC2 while it runs no brain, or when its brains are idle.** `GET /v1/admin/fleet` shows its brains, and a brain exits after 120 s idle. A brain host holds no sandbox. Once its lease expires (30 s), AgentDO releases its brains, and each starts again with `--resume` on another brain host when work arrives for it, or on a host FleetDO launches, which gets 2.1.325.
  - **If a brain was mid-turn,** it loses the transcript bytes AgentDO hadn't received: the runner tails every 500 ms and sends over its WebSocket. Its turn continues through AgentDO's recovery turn.
  - **One host at a time:** terminate the next only when no brain still waits for a host.
  - **Waiting isn't enough:** a brain host with no brain for 30 min is terminated, but that hasn't been seen on AWS yet, and placement fills the fullest host first, so a busy 2.1.301 host may never go idle.
- **Rollback (a forward revert):** a PR that sets `CLAUDE_VERSION` back to 2.1.301.
  - Hosts launched after that apply install 2.1.301. Hosts launched in the meantime keep 2.1.325 until they are replaced, so the fleet is mixed the other way round, with the same caveat for sessions 2.1.325 wrote.
  - If a host AMI was built with 2.1.325, `install.sh` reinstalls 2.1.301 at each boot until the next build, so start one after the revert's apply too.
