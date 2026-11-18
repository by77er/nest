# Claude Code baseline 2.1.325 (2026-11-18)

Not a one-way deploy, and no ordering constraint with the Worker: the change is `CLAUDE_VERSION` in `deploy/host/install.sh`, and nothing in the control plane reads it. A `wrangler rollback` has nothing to undo: the change writes no stored state, and the Worker bundle is unchanged.

- **What the apply changes:**
  - a new version of both launch templates (their user data carries `install.sh`);
  - the Image Builder component and recipe (their version is `install.sh`'s hash), and the image pipeline that points at the recipe.

  `AWS_CELLS` names the templates, not their versions, so it doesn't change. No release is built, because its inputs (`crates/`, `protocol/`, the Cargo files, the toolchain, `.cargo/`, `scripts/publish-release.sh`) are unchanged. No host AMI build starts either: the release job starts one only after a publish. The AMI the launch templates resolve keeps 2.1.301.
- **Right after the apply, start a host AMI build** (the owner, with AWS access; the same commands as `deploy.yml`'s release job):

  ```bash
  arn=$(aws imagebuilder list-image-pipelines --query "imagePipelineList[?name=='nest-use1-host'].arn | [0]" --output text)
  aws imagebuilder start-image-pipeline-execution --image-pipeline-arn "$arn" --query imageBuildVersionArn --output text
  ```

  Until a new AMI exists, `install.sh` finds the AMI's 2.1.301 at every boot and installs 2.1.325 with Claude's native installer, which downloads about 366 MB from `downloads.claude.ai`. This applies to both host kinds, though only brain hosts run Claude Code. The boot then depends on Anthropic's download host: `bootstrap.sh` runs `install.sh` under `set -e`. If the download fails, the host never enrolls, the launch ends in `enroll_timeout`, and it counts toward the enrolment breaker.
- **When a host gets 2.1.325:** at launch, after the apply (from user data, or from the new AMI once built). A host that is already running keeps 2.1.301 until it is replaced by idle retirement, spot loss or autoscaling.
- **A mixed fleet:** brain placement doesn't look at Claude Code versions, and both host sets run the same nest release. Its only preference is the host that ran the agent last ([brain hosts](../../docs/compute/brain-hosts/)). When that host is full or gone, an agent's session moves to any brain host with room, so until the last 2.1.301 brain host is gone a session can cross versions in either direction:
  - **Written by 2.1.301, resumed by 2.1.325:** the upgrade gate (resuming the previous baseline's sessions, [runner](../../docs/agents/runner/)). The owner checks it before approving.
  - **Written by 2.1.325, resumed by 2.1.301:** an older binary reading a newer session file. This is unverified: the session JSONL is internal and "changes between versions" ([sessions](https://code.claude.com/docs/en/sessions)). If the older binary can't resume the file, the brain exits and the crash-loop guard starts it again, possibly on the same kind of host. After 3 restarts without a completed turn the agent is `errored`, and only new input retries it ([AgentDO](../../docs/control-plane/durable-objects/agent/)). There is no lever to start such an agent on a fresh session, because the resume-or-fresh choice isn't built. So close the window soon after the apply.
- **Closing the window:** retire the 2.1.301 brain hosts so that every brain starts on 2.1.325. These are the hosts launched before the apply: check their launch time, or an `aws:ec2launchtemplate:version` tag below the brain template's new default version. FleetDO doesn't keep the `claude_code` version a host's `hello` carries. `POST /v1/admin/hosts/<id>/drain` doesn't work here: it refuses a brain host with 409 ("only a sandbox host is drained by hand", `FleetDO.drainHost`).
  - **Terminate it in EC2 while its agents are idle.** A brain host holds no sandbox. Once its lease expires (30 s), AgentDO starts each of its brains on another brain host with `--resume`, or FleetDO launches a host, which gets 2.1.325. AgentDO flushes what it holds to R2 before any start. A brain mid-turn loses only what the runner hadn't tailed yet (it polls every 500 ms), and its turn continues through AgentDO's recovery turn. Terminate one host at a time, and the next only when no brain still waits for a host.
  - **Waiting isn't enough:** a brain host with no brain for 30 min is terminated, but that hasn't been seen on AWS yet. Placement also fills the fullest host first, so a busy 2.1.301 host may never go idle.
- **Rollback (a forward revert):** a PR that sets `CLAUDE_VERSION` back to 2.1.301. Hosts launched after that apply install 2.1.301; hosts launched in the meantime keep 2.1.325 until they are replaced. The fleet is then mixed the other way round, with the same caveat for sessions 2.1.325 wrote. If a host AMI was built with 2.1.325, `install.sh` reinstalls 2.1.301 at each boot until the next build, so start one after the revert's apply too.
