# CLAUDE.md — psd-eoc

**Read `AGENTS.md` first.** It holds the rules and Kris Hagel's authority over
them. This file is orientation: what the system is, where things live, and how
to run it.

## What this is

An open-source emergency notification and operations platform for school
districts, built by Peninsula School District as its Easy Alert replacement.
Staff activate incidents, run an event timeline, and issue all-clears.
Notifications fan out over email, SMS, and push. Staff-only; no student data
ever.

**It is meant to be deployable by any district.** PSD is the first tenant, not
the only one. That constraint is not aspirational — it decides how you write
code here. Anything specific to a district is configuration, never a literal.
See `AGENTS.md` §4.

The repository does not currently meet that bar: roughly 1,100 PSD-specific
values (`psd401.net`, AWS account `<aws-account-id>`, `us-west-2`,
`net.psd401.eoc`, store IDs, OAuth client IDs) are hardcoded across about 200
files. Reducing that is active work — don't add to it.

## Live environment

| | |
|---|---|
| URL | https://eoc.psd401.net |
| AWS account | `<aws-account-id>` (`psd401`), `us-west-2` |
| Local profile | `psd401-prr-prod` (`aws sso login --profile psd401-prr-prod`) |
| Stack | `PsdEoc` |
| Compute | App Runner → VPC connector → private Aurora PostgreSQL 16 |
| Sign-in | Google OIDC, hosted domain `psd401.net`, callback `/auth/callback` |

The stack and its physical names were `PsdEocExplorationSmoke` /
`psd-eoc-exploration-smoke` until 2026-08-21. CloudFormation identifies a stack
by name, so the rename could not be done in place: the old stack was deleted and
`PsdEoc` created in its place, and every physical name was reissued with it.
`docs/evidence/live-pilot.md` records that cutover.

Two references to the old name are deliberate and must stay. Migration
`0019_retire_exploration_fixture.sql` is applied history and its filename is
part of the record. The docstring of `scripts/check-applied-migrations.ts` cites
the incident where an earlier sweep of these words edited that applied
migration, which is why the guard exists at all.

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
2. **The trusted-group check** — `packages/server/lib/auth/trusted-group-access.ts`.
   After OIDC succeeds, `decideAccess` asks one question about the present: is
   this address in an active access group whose membership was read within the
   last 24 hours? It refuses with `NO_TRUSTED_GROUPS_CONFIGURED`,
   `NOT_IN_A_TRUSTED_GROUP`, or `MEMBERSHIP_STALE`. Sign-in attempts are
   recorded by `lib/auth/sign-in-audit.ts`.

Membership is read by `lib/auth/access-membership-sync.ts` from Google Cloud
Identity Groups via `lib/auth/google-access-membership.ts`, on a schedule.

Trusted groups are rows in `group_sources` with `purpose='access'`, `active`,
and a `granted_role`. Membership lives in `access_group_members`, replaced
wholesale by the sync. Roles are derived from group membership on every request
and are never stored — there is no way to make somebody an administrator except
by putting them in a group that grants it.

A deployment with no access group admits nobody, and the page that configures
access groups is behind sign-in, so the first group comes from configuration:
`PSD_EOC_INITIAL_ACCESS_GROUP_ID` and `PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL`,
applied with migrations and only when no access group exists at all. See
`docs/guides/first-administrator.md`.

## Mobile

App version is 1.0.3. What is actually in the field is not what this file used
to claim — `docs/INTEGRATIONS.md` and `docs/runbooks/release.md` are the truth
register, and they record iOS 1.0.1/build 2 as having failed Apple processing
and Android 1.0.1 as an unexposed Play internal-testing draft. Read them before
believing anything about store state. `EXPO_PUBLIC_PSD_EOC_API_BASE_URL` must be
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
