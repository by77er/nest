#!/usr/bin/env python3
"""Read-only check of the hosts launched since a deploy (README.md in this directory).

For every instance FleetDO launched since CHECK_SINCE (default: the last 24 h), it reports what
FleetDO says (enrolled as which host, connected, or ended and why) and what the instance's own
console says of its bootstrap: the instance-store line, cloud-init's verdict on the user data, and
nestd starting. Fails when a launch ended with `enroll_timeout`, or when a console shows the user
data didn't run or failed.

Creates nothing and changes nothing: one admin GET (`/v1/admin/fleet`), and EC2 `DescribeInstances`
and `GetConsoleOutput` through the AWS CLI (read-only calls, with whatever credentials the shell
has). Reads NEST_ADMIN_TOKEN (required), NEST_BASE_URL (default https://nest.bitcru.sh), NEST_CELL
(default use1), AWS_REGION (default us-east-1) and CHECK_SINCE (ISO 8601 UTC, or epoch ms). Never
prints the token or any header.
"""
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.request

BASE = os.environ.get("NEST_BASE_URL", "https://nest.bitcru.sh").rstrip("/")
CELL = os.environ.get("NEST_CELL", "use1")
REGION = os.environ.get("AWS_REGION", "us-east-1")
ADMIN = os.environ.get("NEST_ADMIN_TOKEN", "")

# What a console says of a bootstrap (bootstrap.sh's own lines, cloud-init's and nestd's).
MARKS = {
    "store": re.compile(r"sandbox state on the instance store at \S+ \(XFS, reflink\)"),
    "store_fallback": re.compile(r"the instance store isn't usable|no instance store: sandbox state stays on the root volume"),
    # cloud-init didn't run the user data (it couldn't read it: gzip not unpacked, say) or it failed.
    "user_data_failed": re.compile(r"Failed to run module scripts[_-]user|scripts-user.*fail|Unhandled non-multipart|Unhandled unknown content-type", re.I),
    "cloud_init_done": re.compile(r"Cloud-init v\. \S+ finished"),
    "nestd_started": re.compile(r"Started nestd\.service|nestd\.service: Main process exited|Failed to start nestd\.service"),
}


def since_ms():
    v = os.environ.get("CHECK_SINCE")
    if not v:
        return int((datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=24)).timestamp() * 1000)
    if v.isdigit():
        return int(v)
    return int(datetime.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp() * 1000)


def fleet():
    req = urllib.request.Request(f"{BASE}/v1/admin/fleet?cell={CELL}", headers={"authorization": f"Bearer {ADMIN}", "user-agent": "nest-cloud-check/1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def aws(*args):
    r = subprocess.run(["aws", "--region", REGION, "--output", "json", *args], capture_output=True, text=True)
    if r.returncode != 0:
        return None, r.stderr.strip()[-300:]
    return json.loads(r.stdout or "null"), None


def main():
    if not ADMIN:
        sys.exit("NEST_ADMIN_TOKEN is required (never pass it on the command line)")
    since = since_ms()
    view = fleet()
    hosts = {h["instance_id"]: h for h in view.get("hosts", []) if h.get("instance_id")}
    launches = [l for l in view.get("launches", []) if l["launched_ms"] >= since]
    print(f"since {datetime.datetime.fromtimestamp(since / 1000, datetime.UTC).isoformat()}: {len(launches)} launch(es) in FleetDO's record")
    failed = False
    for l in launches:
        iid = l["instance_id"]
        h = hosts.get(iid)
        d, err = aws("ec2", "describe-instances", "--instance-ids", iid, "--query",
                     "Reservations[0].Instances[0].{type:InstanceType,state:State.Name,reason:StateReason.Message,az:Placement.AvailabilityZone,template:Tags[?Key=='aws:ec2launchtemplate:id']|[0].Value}")
        con, cerr = aws("ec2", "get-console-output", "--instance-id", iid, "--latest", "--query", "Output")
        text = con or ""
        marks = {k: bool(p.search(text)) for k, p in MARKS.items()}
        row = {
            "instance": iid, "launched_ms": l["launched_ms"], "ec2": d or err,
            "fleet": {"host": l.get("host"), "ended": l.get("reason"), "role": h and h.get("role"), "status": h and h.get("status"), "connected": h and h.get("connected")},
            "console_bytes": len(text), "console": marks if con is not None else cerr,
        }
        bad = l.get("reason") == "enroll_timeout" or marks["user_data_failed"]
        failed = failed or bad
        print(("FAIL " if bad else "ok   ") + json.dumps(row))
        if bad and text:
            print("  console tail: " + json.dumps(text[-1500:]))
    live = [h for h in view.get("hosts", []) if h.get("status") != "dead"]
    print(json.dumps({"live_hosts": [{k: h.get(k) for k in ("host", "role", "instance_id", "status", "connected", "leases")} for h in live]}))
    print("FAIL" if failed else "PASS (no launch failed to enroll; a launch still pending isn't judged yet)")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
