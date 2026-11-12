## Corrections
| docs/interfaces/control-host/tools/README.md | table omits `timer_set`/`timer_cancel`/`timer_list` | in the catalog; `timers` capability, no seed template; 10 s–30 d, 32 live, re-set replaces | protocol/schemas/control/platform-tools.json; control-plane/src/lib/spec.ts:247-252; control-plane/src/lib/timers.ts:9-13; control-plane/src/do/agent.ts:3256-3280,2870 |
## No drift
ToolDef fields & additionalProperties:false (platform-tools.json); agent_stop forbidden/unknown_agent (agent.ts:3245,1693); expose_port share forbidden (agent.ts:3228-3230); brokered tool names (control-plane/src/lib/brokered.ts:42-111); email.send not_implemented (agent.ts:3394); default not_implemented (agent.ts:3283).
STATUS: DONE
