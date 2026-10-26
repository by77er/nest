#!/usr/bin/env python3
"""Regenerate seeds/<target>/ from protocol/fixtures/ (run from anywhere; overwrites the seeds).

Each seed is a valid input for its target, so a run starts from frames that reach the deep
parsers. Targets whose input starts with a chunking byte get 0x00 (one read) or 0x07 (chunked).
"""

import json
import shutil
import struct
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parents[2] / "protocol" / "fixtures"
SEEDS = HERE / "seeds"


def compact(path):
    return json.dumps(json.loads(path.read_text()), separators=(",", ":")).encode()


def fixtures(rel):
    return sorted((FIXTURES / rel).glob("*.json"))


def guest_frame(kind, payload):
    return struct.pack(">I", len(payload) + 1) + bytes([kind]) + payload


def link_frame(payload):
    return struct.pack(">I", len(payload)) + payload


def write(target, name, data):
    d = SEEDS / target
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_bytes(data)


def main():
    if SEEDS.exists():
        shutil.rmtree(SEEDS)

    control = fixtures("guest/control")
    for p in control:
        write("guest_control_json", p.stem, compact(p))
        write("guest_stream", p.stem, b"\x00" + guest_frame(0, compact(p)))
    # A session as nestd sees it: hello, then events, a CLI relay and a reply, read in pieces.
    order = ["hello", "ok", "ports", "task_exited", "cli", "resume_done", "error"]
    stream = b"".join(guest_frame(0, compact(FIXTURES / "guest/control" / f"{n}.json")) for n in order)
    write("guest_stream", "session_chunked", b"\x07" + stream)
    write("guest_stream", "data_frame", b"\x00" + guest_frame(1, b"\x1b[0mpty bytes"))

    write("vsock_handshake", "ok", b"OK 1073741825\n")

    for p in fixtures("host/proxy_event"):
        write("proxy_events", p.stem, compact(p))

    for target, rel in (("gateway_events", "host/gateway_event"), ("runner_events", "host/runner_event")):
        frames = [link_frame(compact(p)) for p in fixtures(rel)]
        for p, f in zip(fixtures(rel), frames):
            write(target, p.stem, b"\x00" + f)
        write(target, "all_chunked", b"\x07" + b"".join(frames))

    for p in fixtures("control/fleet_to_host"):
        write("fleet_to_host", p.stem, compact(p))

    head = json.loads((FIXTURES / "control/generation_record/generation_record.json").read_text())
    meta = {
        "version": 1,
        "sandbox": head["sandbox"],
        "workstream": "ws_01jb7m0000",
        "epoch": head["epoch"],
        "image": "base",
        "resources": {"vcpus": 2, "memory_mib": 2048, "disk_gib": 8},
        "head": head,
        "clean": True,
    }
    write("meta_json", "head_clean", json.dumps(meta, indent=2).encode())
    meta2 = dict(meta, clean=False, unanswered={
        "request": "req_01jb7q0a1d",
        "parent": head["id"],
        "kind": "disk_only",
        "disk_manifest": head["disk_manifest"],
        "reason": "turn_end",
    })
    write("meta_json", "unanswered", json.dumps(meta2, indent=2).encode())
    minimal = {k: meta[k] for k in ("version", "sandbox", "workstream", "epoch", "image", "resources")}
    write("meta_json", "minimal", json.dumps(minimal).encode())


if __name__ == "__main__":
    main()
