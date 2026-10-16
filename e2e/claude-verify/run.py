#!/usr/bin/env python3
"""Verify nest's assumptions about Claude Code against the real binary. See e2e/README.md.

Drives `claude` directly with nest's flags, env and managed settings (hooks and a stdio MCP server
that log everything) inside a private mount namespace, one small probe per item, and writes
e2e/.work/claude-verify/report.{json,md}.

Exit: 0 no probe failed · 1 a probe failed (or the harness broke) · 2 skipped (no token, no binary,
or Claude Code's global configuration can't be isolated).
"""
import argparse, os, shutil, subprocess, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as h  # noqa: E402
import probes  # noqa: E402

DEFAULT_WORK = os.path.join(h.ROOT, "e2e", ".work", "claude-verify")


def parse(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--only", default="", help="comma-separated item numbers or keys, e.g. 1,2,cancel")
    p.add_argument("--work", default=os.environ.get("NEST_CLAUDE_VERIFY_WORK", DEFAULT_WORK), help="work and report directory (wiped first)")
    p.add_argument("--list", action="store_true", help="list the items and exit")
    return p.parse_args(argv)


def skip(msg):
    h.eprint(f"claude-verify: SKIPPED: {msg}")
    return h.SKIP_EXIT


def main(argv):
    args = parse(argv)
    if args.list:
        for n, key, title in probes.ITEMS:
            print(f"{n:>2}  {key:<18} {title}")
        return 0
    # Popped so nothing but Claude Code (given it explicitly as CLAUDE_CODE_OAUTH_TOKEN) inherits it.
    # A token has no whitespace; `claude setup-token` wraps it, so a copied line break is dropped.
    token = "".join(os.environ.pop(h.TOKEN_ENV, "").split())
    if not token:
        return skip(f"{h.TOKEN_ENV} is not set. Put the owner's `claude setup-token` token in it to run the probes; nothing was run.")
    claude = os.environ.get("NEST_CLAUDE_BIN") or shutil.which("claude")
    if not claude or not os.access(claude, os.X_OK):
        return skip(f"no Claude Code binary (NEST_CLAUDE_BIN={os.environ.get('NEST_CLAUDE_BIN')!r}, none on PATH).")
    claude = os.path.abspath(claude)
    if os.environ.get("NEST_CV_INNER") != "1":
        if not shutil.which("unshare"):
            return skip("`unshare` is missing, so the probes can't run in a private mount namespace.")
        bwrap, source = h.find_bwrap(os.path.join(h.ROOT, "e2e", ".work", "tools", "bubblewrap"))
        env = dict(os.environ, NEST_CV_INNER="1", NEST_CV_PARENT_MNTNS=h.mount_ns(), NEST_CLAUDE_BIN=claude,
                   NEST_CV_HOME=os.path.expanduser("~"), NEST_CV_BWRAP=bwrap or "", NEST_CV_BWRAP_SOURCE=source, **{h.TOKEN_ENV: token})
        try:
            return subprocess.run(h.namespace_argv(sys.executable, os.path.abspath(__file__), argv), env=env).returncode
        except KeyboardInterrupt:
            return 130
    return inner(args, token, claude)


def inner(args, token, claude):
    if h.mount_ns() == os.environ.get("NEST_CV_PARENT_MNTNS"):
        h.eprint("claude-verify: refusing to run outside a private mount namespace")
        return 1
    work = os.path.abspath(args.work)
    shutil.rmtree(work, ignore_errors=True)
    managed = os.path.join(work, "etc-claude-code")
    os.makedirs(managed)
    redact = h.Redactor(token)
    home = os.environ.get("NEST_CV_HOME") or os.path.expanduser("~")
    try:
        mounts = h.isolate(work, managed, home, extra_masks=[os.environ.get("CLAUDE_CONFIG_DIR", "")])
    except Exception as e:  # noqa: BLE001
        detail = getattr(e, "stderr", b"") or b""
        return skip(f"can't isolate Claude Code's global configuration ({e} {detail.decode(errors='replace').strip()}); refusing to run.")

    vtmp = tempfile.mkdtemp(prefix="nest-cv-version-", dir="/tmp")
    try:
        v = subprocess.run([claude, "--version"], env={"PATH": h.CHILD_PATH, "HOME": vtmp, "CLAUDE_CONFIG_DIR": vtmp, "DISABLE_AUTOUPDATER": "1"},
                           cwd=vtmp, capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        v = f"unknown ({e})"
    finally:
        shutil.rmtree(vtmp, ignore_errors=True)

    model = os.environ.get("NEST_CLAUDE_MODEL", "haiku")
    temp_root = tempfile.mkdtemp(prefix="nest-cv-", dir="/tmp")
    ctx = probes.Context(claude, model, token, work, managed, temp_root, redact,
                         turn_timeout=float(os.environ.get("NEST_CLAUDE_TURN_TIMEOUT_S", "120")),
                         init_wait=float(os.environ.get("NEST_CLAUDE_INIT_WAIT_S", "10")))
    meta = {"claude_version": v, "claude_bin": claude, "model": model, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "isolation": mounts, "work": work}
    print(f"[claude-verify] Claude Code {v} ({claude}), model {model}; work dir {work}", flush=True)
    meta["bubblewrap"] = ctx.prepare(os.environ.get("NEST_CV_BWRAP") or None, os.environ.get("NEST_CV_BWRAP_SOURCE"))
    if meta["bubblewrap"].get("deviation"):
        print(f"[claude-verify] Claude Code requires bubblewrap for CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1; {meta['bubblewrap']['deviation']}", flush=True)
    selected = {s.strip() for s in args.only.split(",") if s.strip()}
    t0 = time.time()
    try:
        results = probes.run_all(ctx, selected, log=lambda m: print(m, flush=True))
    finally:
        for s in ctx.sessions:
            if s.p.poll() is None:
                s.kill()
        shutil.rmtree(temp_root, ignore_errors=True)
    cost, turns = ctx.cost()
    meta.update(duration_s=round(time.time() - t0, 1), total_cost_usd=cost, turns_sent=turns)
    jp, mp = h.write_report(work, meta, results, redact)
    scrubbed = redact.scrub_tree(work)
    if scrubbed:
        print(f"[claude-verify] redacted the token from {len(scrubbed)} file(s) under {work}", flush=True)
    counts = {st: sum(1 for r in results if r["status"] == st) for st in (h.PASS, h.FAIL, h.INCONCLUSIVE, h.SKIPPED)}
    print(f"[claude-verify] done in {meta['duration_s']} s: " + ", ".join(f"{c} {st}" for st, c in counts.items()) +
          f"; {turns} user turns, ${cost} (client estimate); report: {mp}", flush=True)
    return h.exit_code(results)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
