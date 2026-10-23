// Probe a sandbox gateway the way a brain does: open /hands, send `bind`, print the first reply.
// Usage: node gateway_probe.mjs <ws base url> <binding token> <guest protocol version>
// Prints one JSON line: {"message": <the first text message, parsed>} or {"close": {code, reason}}
// or {"error": "..."}; then closes. Node's global WebSocket client; no dependencies.
const [url, binding, version] = process.argv.slice(2);
const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
if (typeof WebSocket === "undefined") out({ error: "node >= 22 is required for the global WebSocket client" });
const ws = new WebSocket(url.replace(/\/$/, "") + "/hands");
const timer = setTimeout(() => out({ error: "timeout" }), 10000);
ws.onopen = () => ws.send(JSON.stringify({ type: "bind", binding, protocol_version: Number(version), gateway_version: 1 }));
ws.onmessage = (ev) => { clearTimeout(timer); const m = typeof ev.data === "string" ? JSON.parse(ev.data) : { binary: true }; ws.close(1000, ""); out({ message: m }); };
ws.onclose = (ev) => { clearTimeout(timer); out({ close: { code: ev.code, reason: ev.reason } }); };
ws.onerror = () => { clearTimeout(timer); out({ error: "socket error" }); };
