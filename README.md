# PSD EOC

Peninsula School District's emergency operations platform: incident/drill
activation, instant staff notification (push + email + SMS), live event
collaboration (text/photos/locations), and automatic incident/drill records.
Replaces Rapid Responder Easy Alert.

**Call 911 first.** PSD EOC notifies and documents; it does not contact
emergency services.

## Documents

- [Implementation plan](docs/PLAN.md) — architecture, stack, phases, issues
- [Decision log](docs/discovery/DECISION_LOG.md) — D-001…D-035, binding
- [AGENTS.md](AGENTS.md) — binding safety charter for all agents/contributors
- [SECURITY.md](SECURITY.md) — security posture and data classification
- [Codex goals](docs/CODEX_GOALS.md) — goal statements for parallel coding agents

## Layout (target)

```
packages/contracts   Zod domain + capability contracts (lands first)
packages/server      Next.js — web UI, REST, capability layer, outbox
packages/mobile      Expo — native iOS + Android
packages/mcp         MCP server for district AI agents
workers/             Lambda channel workers (push / email / sms)
infra/               AWS CDK
docs/                Plans, decisions, runbooks
```

## Non-negotiables

- Four human-only actions: start real incident, send real notification,
  all-clear, close real event. No agent or automation, ever.
- Real vs. drill can never be confused, in any channel.
- No student data. Staff only, minimized.
- Append-only records; delivery truth never overstated.
