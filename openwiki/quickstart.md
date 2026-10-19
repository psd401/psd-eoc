---
type: Quickstart
title: PSD EOC wiki quickstart
description: Entry point to the OpenWiki knowledge base for psd-eoc, an open-source school-district emergency notification platform. Gives a product and architecture overview, a task-routing table from change intent to wiki page, source entry points, focused tests and validation commands, plus links to every major section.
tags: [quickstart, navigation, psd-eoc]
---

# PSD EOC wiki quickstart

PSD EOC is an open-source emergency notification and operations platform for school districts. Authenticated staff activate an incident or drill, the system notifies staff over push, email and SMS, staff collaborate in a live event room, and everything lands in append-only records. It documents and notifies; it never contacts emergency services (call 911 first). Any district runs it on its own AWS account and Google Workspace, so district identity is configuration, never source.

Two rules shape every change (details in [architecture overview](architecture/overview.md)): automation may never start a real incident, send a real notification, issue a real all-clear or close a real event (`packages/contracts/src/human-only.ts`), and real versus drill must never blur. Source and tests outrank this wiki; the repo's own docs (`AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `docs/INTEGRATIONS.md`) remain authoritative for policy.

## Map of the wiki

| Section | Page | Covers |
| --- | --- | --- |
| Architecture | [Architecture overview](architecture/overview.md) | Packages, runtime topology, safety rules, end-to-end flow |
| Architecture | [Capability engine](architecture/capability-engine.md) | One capability catalog, execution tiers, human-only enforcement, idempotency, audit |
| Domain | [Event lifecycle and activation](domain/event-lifecycle-and-activation.md) | Event state machine, preview then confirm, join, all-clear, close, event room |
| Domain | [Notification pipeline](domain/notification-pipeline.md) | Outbox, SQS dispatch, delivery router, attempts, delivery truth, reconcile |
| Domain | [Roster and audience](domain/roster-and-audience.md) | Google Groups sync, immutable snapshots, audience resolution, stale report |
| Domain | [Identity and access](domain/identity-and-access.md) | OIDC sign-in, sessions, groups, roles, facility scope |
| Domain | [Event types and templates](domain/event-types-and-templates.md) | Response types, versioned wording, drafts, rendering |
| Domain | [Media, records and audit](domain/media-records-and-audit.md) | Photo pipeline, CSV and PDF exports, hash-chained security audit |
| Domain | [Data model](domain/data-model.md) | Schema groups, append-only rules, migrations |
| Integrations | [Channel workers](integrations/channel-workers.md) | Email, SMS and push workers, retries, provider adapters |
| Integrations | [Agent API and MCP](integrations/agent-api-and-mcp.md) | Agent keys, REST gateway, rate limits, MCP server |
| Integrations | [Mobile app](integrations/mobile-app.md) | Expo app, secure session, push registration, E2E |
| Operations | [Infrastructure](operations/infrastructure.md) | CDK stack, Lambdas, monitoring, GCP, deploy rules |
| Operations | [Configuration and readiness](operations/configuration-and-readiness.md) | Tenant manifest, env, readiness register, runbooks, doc drift |
| Testing | [Verification and testing](testing/verification-and-testing.md) | `bun run check`, sharded tests, database tests, CI jobs |

## Task routing

Run commands from the repository root with Bun. Tests ending in `.database.test.ts` or `.integration.test.ts` need `TEST_DATABASE_URL` (see [verification and testing](testing/verification-and-testing.md)); the narrow commands below are chosen to avoid them unless noted.

| Change area or intent | Wiki page | Source entry points | Key symbols | Focused tests | Minimal validation |
| --- | --- | --- | --- | --- | --- |
| Add or change a capability (action or query), its input or output, or its authorization | [Capability engine](architecture/capability-engine.md) | `packages/contracts/src/capability-catalog.ts`, `packages/server/lib/capabilities/engine.ts` | `canonicalCapability`, `ServerCapabilityRegistration`, `executeAuditedCapabilityTransaction`, `registerCapabilityHandler` | `packages/contracts/src/contracts.test.ts`, `packages/server/lib/capabilities/engine.test.ts`, `execution-boundary.test.ts` | `bun test packages/contracts packages/server/lib/capabilities/execution-boundary.test.ts` |
| Human-only actions or real/drill confirmation | [Capability engine](architecture/capability-engine.md) | `packages/contracts/src/human-only.ts`, `packages/server/lib/audit/human-only.ts` | `HUMAN_ONLY_ACTION_IDS`, `resolveHumanCapabilityInvocation` | `packages/contracts/src/human-only-agent-surface.test.ts`, `packages/server/lib/agents/human-only.test.ts`, `packages/server/lib/audit/human-only.test.ts` | `bun test packages/contracts/src/human-only-agent-surface.test.ts` |
| Event lifecycle, start, join, all-clear, close, reopen, event room, journal | [Event lifecycle](domain/event-lifecycle-and-activation.md) | `packages/server/lib/capabilities/events.ts`, `start.ts`, `journal.ts`, `packages/server/lib/events/state-machine.ts` | `EVENT_STATUS_TRANSITIONS`, `startEventRegistration`, `buildActivationPreview` | `packages/server/lib/capabilities/events.test.ts`, `packages/server/app/(app)/events/[id]/event-room.test.tsx` | `bun test packages/server/lib/capabilities/events.test.ts` |
| Notification dispatch, outbox, delivery evidence, reconcile, SMS policy, whether a queued send is still current | [Notification pipeline](domain/notification-pipeline.md) | `packages/server/lib/notify/dispatcher.ts`, `batch-lifecycle.ts`, `reconcile.ts`, `sms-policy.ts`, `infra/lambda/delivery-router/index.mjs` | `dispatchOutbox`, `createSqsDispatchBatchQueue`, `pollOutbox`, `batchHasCurrentLifecycle`, `EMAIL_SEND_HORIZON_MILLISECONDS` | `packages/server/lib/notify/dispatcher.test.ts`, `infra/test/delivery-router-runtime.test.ts`; DB: `packages/server/lib/notify/batch-lifecycle.integration.test.ts` | `bun test packages/server/lib/notify/dispatcher.test.ts` |
| Channel worker or provider adapter (email, SMS, push), email poll concurrency, retry rules | [Channel workers](integrations/channel-workers.md) | `workers/shared/processor.ts`, `workers/email/service.ts`, `workers/{email,sms,push}/service.ts`, `workers/README.md` | `WorkerAttemptProcessor`, `parseWorkerBatchMessage`, `DeliveryStateWritebackClient`, `runEmailService`, `EMAIL_WORKER_CONCURRENCY` | `workers/shared/processor.test.ts`, `workers/shared/retry.test.ts`, `workers/email/service.test.ts`, the channel's `*.test.ts` | `bun test workers/shared` (add the channel directory when touched) |
| Roster sync, group sources, audience resolution, stale roster | [Roster and audience](domain/roster-and-audience.md) | `packages/server/lib/roster/groups-sync.ts`, `resolve.ts`, `stale-report.ts` | `syncRoster`, `resolveAudience`, `buildStaleRosterReport` | `packages/server/lib/roster/groups-sync.test.ts`, `resolve.test.ts` | `bun test packages/server/lib/roster/resolve.test.ts packages/server/lib/roster/groups-sync.test.ts` |
| Sign-in, sessions, roles, facility scope, admission | [Identity and access](domain/identity-and-access.md) | `packages/server/lib/auth/oidc.ts`, `sessions.ts`, `trusted-group-access.ts` | `facilityScopeFromGroups`, `MEMBERSHIP_FRESHNESS_MS`, `executeRepositoryAuditedOidcCompletion` | `packages/server/lib/auth/oidc.test.ts`, `sessions.test.ts`, `trusted-group-access.test.ts` | `bun test packages/server/lib/auth/oidc.test.ts packages/server/lib/auth/sessions.test.ts` |
| Message wording, response types, drafts, rendering | [Event types and templates](domain/event-types-and-templates.md) | `packages/server/lib/capabilities/event-types.ts`, `packages/server/lib/notify/render.ts`, `packages/contracts/src/event-type.ts` | `renderTemplateSet`, `executePublishEventTypeVersionCapability`, `MessageTemplateSetSchema` | `packages/server/lib/agents/event-types.test.ts`, `packages/server/lib/notify/default-templates.test.ts` | `bun test packages/server/lib/agents/event-types.test.ts` |
| Agent API keys, grants, rate limits, MCP tools | [Agent API and MCP](integrations/agent-api-and-mcp.md) | `packages/contracts/src/agent-key-grants.ts`, `packages/server/lib/agents/gateway.ts`, `packages/mcp/src/manifest.ts` | `AGENT_KEY_GRANTABLE_CAPABILITY_IDS`, `AgentRestGateway`, `MCP_TOOLS` | `packages/contracts/src/agent-key-grants.test.ts`, `packages/server/lib/agents/gateway-rate-limit.test.ts`, `packages/mcp/src/protocol.test.ts` | `bun test packages/contracts/src/agent-key-grants.test.ts packages/mcp` |
| Photo upload, exports, security audit chain | [Media, records and audit](domain/media-records-and-audit.md) | `packages/server/lib/media/`, `packages/server/lib/capabilities/records.ts`, `packages/server/lib/audit/` | `sanitizeUploadedImage`, `createRecordsArtifactStore`, `SecurityAuditService` | `packages/server/lib/media/image.test.ts`, `packages/server/lib/audit/hash-chain.test.ts` | `bun test packages/server/lib/audit/hash-chain.test.ts packages/server/lib/media/image.test.ts` |
| Database schema or migration | [Data model](domain/data-model.md) | `packages/server/db/schema/*.ts`, `packages/server/drizzle/migrations/` | `bun run --cwd packages/server db:generate` | `packages/server/drizzle/migration-chain.test.ts`, `packages/server/db/schema-enums.test.ts` | `bun test packages/server/drizzle/migration-chain.test.ts` then `bun scripts/check-applied-migrations.ts origin/main HEAD` |
| Mobile screens, auth, push registration | [Mobile app](integrations/mobile-app.md) | `packages/mobile/src/app`, `src/lib/auth`, `src/lib/push`, `src/features/event-room` | `EventRoomSyncController`, `AuthPhase`, registration controller | colocated `*.test.ts`, `packages/mobile/native-tests/*.native.tsx` | `bun run --cwd packages/mobile test:bun`; both platforms via `bun packages/mobile/e2e/run.ts ios` and `android` |
| AWS stack, queues, Lambdas, alarms, GCP | [Infrastructure](operations/infrastructure.md) | `infra/src/stack/psd-eoc-stack.ts`, `infra/src/monitoring.ts`, `infra/lambda/*` | `PsdEocStack`, `configureInfrastructureMonitoring` | `infra/test/stack/psd-eoc-stack.test.ts`, `infra/test/monitoring-runtime.test.ts` | `bun run --cwd infra synth:example` (credential-free) |
| Tenant config, env vars, readiness register, runbooks | [Configuration and readiness](operations/configuration-and-readiness.md) | `infra/cdk.local.example.json`, `packages/server/lib/config/deployment.ts`, `docs/CONFIGURATION.md` | `readTenantContext`, `applicationOrigin` | `scripts/verify-documentation.test.ts`, `infra/test/tenant-context.test.ts` | `bun run verify:docs` and `bun run verify:config` |
| Test harness, CI gate, synthetic database | [Verification and testing](testing/verification-and-testing.md) | `scripts/test.ts`, `scripts/test-database.ts`, `.github/workflows/ci.yml` | `discoverTestFiles`, `balanceShards`, `selectTestFiles` | `scripts/test.test.ts`, `scripts/test-database.test.ts` | `bun test scripts/test.test.ts scripts/test-database.test.ts` |

Typecheck one workspace with `bun run --cwd packages/server typecheck` (or `packages/contracts`, `packages/mcp`, `packages/mobile`, `workers`, `infra`). The complete gate is `bun run check`; it is expensive (needs Docker, a synthetic PostgreSQL and Poppler) and is warranted only for cross-package or pre-merge verification.

## Working conventions

- Contracts first: change `packages/contracts` (Zod) before consumers; there is one capability layer shared by web, REST, MCP and mobile ([capability engine](architecture/capability-engine.md)).
- Never edit an applied migration or run a down migration; journals, audit and delivery evidence are append-only ([data model](domain/data-model.md)).
- No district literals in `.ts` source; tenant values live in git-ignored `infra/cdk.local.json` ([configuration and readiness](operations/configuration-and-readiness.md)).
- Deployment is only a local `cdk deploy`; never add a GitHub deployment workflow ([infrastructure](operations/infrastructure.md)).
- Mobile changes must land and be verified on both iOS and Android ([mobile app](integrations/mobile-app.md)).
- Do not hand-edit this wiki's generated pages; the OpenWiki workflow (`.github/workflows/openwiki-update.yml`) regenerates them.

## Backlog

Areas identified but not yet documented in depth:

- Administration web UI pages (`packages/server/app/(admin)/{access,facilities,integrations,devices,agents,audit}`): covered only where they touch identity, agents and templates; a per-page guide is missing.
- SMS consent flow (`packages/server/lib/capabilities/sms-consent.ts`, `packages/server/app/api/sms-consent`, `app/(app)/text-alerts`): only summarized in the notification pipeline and mobile pages.
- Operator tooling in `scripts/ops` (`appstore/`, `sms-registration/`, `groups-inventory*.ts`, `ses-*.ts`) and `packages/server/scripts/operations/bootstrap.ts`: referenced but not walked through.
- Google Cloud Terraform and Firebase under `infra/gcp`: summarized in infrastructure only.
- Individual alarm runbooks in `docs/runbooks/` and dated notes in `docs/learnings/`: indexed, not summarized.
- Map and location rendering (`packages/server/lib/map`, `location-map.tsx`): not documented.

