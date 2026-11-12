# Review: docs sandbox/networking vs code

Findings (severity, doc:line, problem, evidence)

- **high** docs/sandbox/networking/README.md:11 -- changed line still states as built "Anything else is rejected at once (UDP/443 too, so HTTP/3 falls back to TCP)". The netns ruleset has no reject rule: the input chain is `policy drop` with only accepts, so other traffic (UDP/443 included) is silently dropped and QUIC clients wait out a timeout. docs/README.md:180 already marks "the reject" as designed; the parent contradicts it. Evidence: crates/nestd/src/net.rs:218-224 (input chain `policy drop`, accepts only), net.rs:225-227 (forward `policy drop`); no `reject` anywhere in crates/nestd/src.
- **medium** docs/sandbox/networking/egress/steering/README.md:10 (unchanged) -- "everything else -> **reject**: TCP with a reset, anything else with ICMP port-unreachable ... UDP/443 (QUIC) is rejected" is presented as built in a list that now otherwise mirrors the ruleset; it is not built (drop). Needs a "designed, not built: today dropped (input policy drop)" marker. Evidence: crates/nestd/src/net.rs:219.
- **low** docs/sandbox/networking/egress/tls/README.md:43 (unchanged, sampled) -- "HTTP/3 is refused at the netns, so clients fall back to TCP at once": today UDP/443 is dropped, not refused, so fallback waits for the client's QUIC timeout. Evidence: crates/nestd/src/net.rs:219.
