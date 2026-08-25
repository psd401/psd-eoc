# Architecture and contributing

This document is the current repository architecture and contributor guide.
Historical plans and decision ledgers are preserved in the
[archive](archive/README.md), but they do not override current code, contracts,
tests, or this guide.

## Package ownership

| Area                 | Owns                                                                                                                 | Must not own                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/contracts` | Zod domain schemas, capability catalog, public types, and the human-only registry                                    | Database or provider implementations                          |
| `packages/server`    | Next.js web and REST surfaces, the capability engine, authorization, database repositories, and transactional outbox | Parallel domain types or direct provider sends from UI routes |
| `packages/mobile`    | Native presentation, local session handling, and calls to canonical server APIs                                      | Business-rule forks or offline real-action execution          |
| `packages/mcp`       | A constrained adapter over the scoped agent REST API                                                                 | Direct database/provider access or human-only actions         |
| `workers`            | Durable dispatch, provider adapters, reconciliation, and delivery evidence                                           | Activation authority or reconstructed recipient lists         |
| `infra`              | CDK resources and deploy-time configuration                                                                          | Tenant identity hidden in application source                  |
| `scripts`            | Verification and bounded operator tooling                                                                            | Unattended live-provider writes                               |

Cross-package domain work lands in `packages/contracts` first. Consumers import
the canonical schemas and capability signatures instead of defining local
lookalikes.

## Capability execution

Every capability is registered once in
`packages/contracts/src/capability-catalog.ts`. Web, mobile, REST, and MCP
adapters authenticate, validate input, and delegate to the same server-side
authorization and execution system.

There are three execution tiers:

1. `executeAuditedCapabilityTransaction` is the normal mutation boundary. It
   owns authorization, idempotency, the domain transaction, and append-only
   audit.
2. `executeAuthorizedCapabilityQuery` is restricted to canonical read-only
   capability IDs.
3. `invokeAuthorizedCapabilityHandler` is an internal primitive. It does not
   own a database transaction, idempotency record, or audit append. Production
   may import it only at the exact source-tested boundaries that own their
   surrounding durable protocol:
   - the audited server engine;
   - delivery-state reconciliation;
   - scheduled roster synchronization;
   - SES webhook ingestion;
   - notification dispatch, reconciliation, and SMS policy processing; and
   - the access-membership synchronization operations script.

Event-type, session, and agent-key repositories retain specialized durable
idempotency protocols, but their mutations still run inside
`executeAuditedCapabilityTransaction`; audit appends before a domain write can
commit.

OIDC completion is the sole pre-session exception. It has no authenticated
actor or facility scope yet, so
`executeRepositoryAuditedOidcCompletion` accepts only the literal
`complete-oidc-sign-in` registration. Its serializable repository commits
replay protection, session issuance, and access-gate audit together. The
source-boundary test permits only the browser callback and mobile exchange
routes. Adding another lower-tier consumer requires moving it through the
audited engine or deliberately updating this document and the exact allowlist
test together.

Reusable capability services live under `packages/server/lib`. Next `app`
folders contain authentication, bounded request parsing, capability
invocation, and HTTP/page response mapping—not alternate business logic.

Authorization is deny-by-default, server-side, and scoped by role and facility.
Client visibility is never an authorization control.

## Human-only actions

The immutable registry is `packages/contracts/src/human-only.ts`. Automation,
agents, schedules, webhooks, link previews, and tests may never:

1. `start-real-incident` — start a real incident;
2. `send-real-notification` — send a real notification;
3. `all-clear` — issue a real all-clear; or
4. `close-real-event` — close a real event.

Only an authenticated human acting in the application may perform them. MCP
and agent REST do not expose aliases or alternate mutation paths. Synthetic
drills and unroutable fixtures remain safe for automated tests.

## Data and delivery truth

- Staff data only; no student, guardian, schedule, or reunification data.
- Event journals, audit records, delivery attempts, and evidence are
  append-only. Corrections supersede earlier entries with provenance.
- Applied migrations are historical records and are never edited or renamed.
- Real incidents and drills remain distinct in contracts, storage, UI,
  templates, and channel payloads.
- Provider acceptance, delivery, and human receipt are separate facts.
  Ambiguous results remain `unknown`.
- External payloads and uploads are untrusted; validate by content and strip
  image metadata.

## Configuration boundaries

Portable tenant configuration lives in the manifest and environment surfaces
indexed by [CONFIGURATION.md](CONFIGURATION.md). Protected production authority
lives in GitHub environment variables/secrets and OIDC role policy. A portable
manifest is not permission to deploy, and a protected role must independently
verify the configured account, region, and origin.

## Contributor workflow

1. Read the issue contract and current documentation linked from the root
   README.
2. Add or update a failing test first when practical.
3. Make contracts changes before dependent package changes.
4. Fix necessary adjacent defects rather than preserving a known broken edge.
5. Use Bun commands only. Do not add bypass comments such as `@ts-ignore` or
   lint suppressions.
6. Run `bun run check`, which includes the documentation contract.
7. Describe acceptance evidence, adjacent fixes, and risk in the pull request.

Accessibility ships with activation, event timeline, and all-clear changes.
The four human-only restrictions remain server-enforced regardless of UI.
