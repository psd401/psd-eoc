# CLAUDE.md — psd-eoc

**Read `AGENTS.md` first.** It holds the rules and Kris Hagel's authority over
them. This file is orientation: what the system is, where things live, and how
to run it.

## What this is

Peninsula School District's emergency notification and operations platform —
the replacement for Easy Alert. Staff activate incidents, run an event
timeline, and issue all-clears. Notifications fan out over email, SMS, and
push. Staff-only; no student data ever.

## Live environment

| | |
|---|---|
| URL | https://eoc.psd401.net |
| AWS account | `338414773271` (`psd401`), `us-west-2` |
| Local profile | `psd401-prr-prod` (`aws sso login --profile psd401-prr-prod`) |
| Stack | `PsdEocExplorationSmoke` (legacy physical name; this is the live stack) |
| Compute | App Runner → VPC connector → private Aurora PostgreSQL 16 |
| Sign-in | Google OIDC, hosted domain `psd401.net`, callback `/auth/callback` |

The stack's physical names still say "exploration-smoke" for CloudFormation
compatibility. Do not read that as "not real" — it serves production traffic.

## Layout

```
packages/contracts   Zod domain types + capability signatures. Source of truth.
packages/server      Next.js 15 app — web UI, REST API, capability layer, DB
packages/mobile      Expo / React Native — iOS + Android, shipped via EAS
packages/mcp         MCP server exposing non-human-only capabilities
workers/             email · sms · push · shared — outbox consumers
infra/               AWS CDK (TypeScript) + GCP config
drizzle/             migrations
docs/                runbooks, integration truth register, evidence
```

Every surface (web, REST, MCP) funnels through `executeCapability`. If you're
adding a mutation and not calling it, you're building a side door.

## Commands

```bash
bun install                      # deps (never npm)
bun run check                    # the full gate: format + lint + typecheck + tests
bun run format                   # fix formatting
bun run lint
bun run typecheck
bun test                         # all tests
bun test path/to/file.test.ts    # one file

bun run --cwd packages/server dev          # Next dev server
bun run --cwd packages/server db:generate  # new migration from schema
bun run --cwd packages/server db:migrate

bun run --cwd packages/mobile start        # Expo
bun run --cwd packages/mobile test
```

Tests need PostgreSQL. Set `DATABASE_URL` and `TEST_DATABASE_URL`.

## Auth and access — read this before touching sign-in

Sign-in is two independent steps, and they fail for different reasons:

1. **Google OIDC** — `packages/server/lib/auth/oidc.ts`, `app/(auth)/`.
   Working. `/auth/sign-in` redirects to Google; `/auth/callback` returns.
2. **The access gate** — `packages/server/lib/auth/access-gate.ts`. After
   OIDC succeeds, the user must appear in a published *access membership
   snapshot* proving they're in an approved Google Group. No snapshot means
   nobody signs in, including admins. Denial reasons are enumerated in
   `ACCESS_GATE_DENIAL_REASONS`.

Snapshots are produced by `lib/auth/access-membership-sync.ts` reading Google
Cloud Identity Groups via `lib/auth/google-access-membership.ts`.

**Known design defect:** the approved group is hardcoded as
`DESIGNATED_ACCESS_GROUP_EMAIL` in `packages/contracts/src/identity.ts` and
enforced with `z.literal()` in ~20 places. The `group_sources` table and the
`app/(admin)/access/` UI already exist to make this configurable data. Making
groups admin-editable is priority work, not a nice-to-have — changing who can
sign in must never require a deploy.

## Mobile

iOS and Android are live to testers (TestFlight / Play internal testing) at
app version 1.0.2. `EXPO_PUBLIC_PSD_EOC_API_BASE_URL` must be
`https://eoc.psd401.net`. Native projects are generated — edit `app.json`, not
`ios/` or `android/` directly. `bun run prebuild:check` regenerates them.

## Documentation honesty

`docs/INTEGRATIONS.md` labels each integration `mocked`,
`configured-unverified`, `live-verified`, or `blocked`. These labels have
drifted behind reality before. If you verify something works, update the label
in the same PR. A stale `blocked` costs real debugging hours.

## Conventions

- TypeScript strict. No `any` without a comment explaining why.
- Colocate tests: `foo.ts` → `foo.test.ts`.
- Prettier decides formatting; don't hand-format.
- Server components by default in Next; `'use client'` only when needed.
- Errors carry a `code`, `message`, and `requestId`. Never leak provider
  payloads or PII into responses or logs.
