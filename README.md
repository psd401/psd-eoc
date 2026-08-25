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

## Local verification

The repository uses Bun 1.2.23, Docker, and Poppler's `pdftotext`. Install the
single root lockfile, start the repository-owned synthetic PostgreSQL service,
and export the two values printed by the start command:

```sh
bun install --frozen-lockfile
bun run test:db:start
# Copy the two export commands printed above into this shell.
bun run check
```

`bun run check` is the authoritative gate. It checks formatting for source and
current documentation, lints with zero warnings, verifies every TypeScript
workspace, builds the production server without district identity, and runs
all Bun and mobile-native tests with zero runtime skips. It fails before tests
when the synthetic database is missing or unsafe.

For explicitly database-free work, `bun run test:unit` lists every excluded
database suite by file name. It is not a substitute for `bun run check`.

Additional repository checks:

```sh
bun run verify:config              # validate .env.example without connecting
bun run --cwd infra synth:example  # synthesize a non-PSD identity fixture
bun run test:db:stop               # remove the local synthetic service/data
```
