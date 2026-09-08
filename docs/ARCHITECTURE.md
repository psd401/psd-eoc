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

## Records-retention classification

<!-- psd-eoc:records-retention:start -->

The product retains records; disposition authority belongs to the deploying
district. The repository defines the content inventory and safety boundary
below. Each deploying district owns the authoritative classification in its
district-controlled operations record, reviewed by its records officer.

Current schedule sources, versions, effective dates, candidate series, and the
source-check date live in the
[records-retention review](INTEGRATIONS.md#records-retention-review). They are
dated evidence, not architectural constants.

### Product record-class inventory

Classification follows actual record content and the event context, not table
names, file formats, or one blanket DAN for the database. The inventory is:

<!-- docs-contract:records-retention-classes:start -->

- `operational-events-and-lifecycle`
  Event identity, real-versus-drill kind, activation preparation and
  consumption, lifecycle decisions, and event transitions.
- `operational-journal`
  Text, location, photo, and system entries, including superseding corrections
  and redactions that preserve the original history.
- `notification-content-and-authorization`
  Notification intents, selected channels, versioned templates, rendered
  activation/reactivation/all-clear content, and human authorization evidence.
- `dispatch-and-delivery-evidence`
  Outbox work, batches, channel attempts and executions, provider facts,
  delivery evidence, endpoint-status facts, and SMS opt-out facts.
- `drills`
  Drill events and unroutable synthetic tests.
- `media-and-private-objects`
  Upload intents, sanitized metadata and checksums, quarantine objects,
  sanitized private objects, and journal references. A presentation redaction
  does not dispose of the retained source or history.
- `audit-and-mutation-evidence`
  Hash-chained security audit entries and anchors, idempotency facts, human
  confirmations, and integration-change authorizations. The security audit is
  distinct from the operational journal.
- `roster-and-recipient-snapshots`
  Source configuration versions, immutable staff/synthetic snapshots,
  facility/source provenance, minimized recipient endpoints, and sync
  outcomes/failures. Public examples never include contact or token data.
- `identity-device-and-session-lifecycle`
  Staff accounts, roles and scopes, access snapshots, device enrollment,
  session and credential lifecycle, push-token lifecycle, and agent/API-key
  lifecycle.
- `configuration-and-governance`
  Facilities and neighborhoods, the threat catalog, group sources, event-type
  versions/templates and drafts, integration observations, channel
  configuration, and governance decisions.
- `generated-reports-and-exports`
  Derived event/drill projections and immutable,
  content-addressed CSV/PDF objects. Expiration of a signed download URL does
  not dispose of its object.
- `transport-and-operational-copies`
  Queue messages, provider callbacks, logs, backups, CI artifacts, and
  monitoring telemetry. The controlled mapping must decide which are official,
  secondary, or transitory copies; unrelated infrastructure lifecycle policies
  are outside the product-record boundary. Existing operational expiry does not
  establish lawful record disposition. An expiring copy that the controlled
  mapping identifies as official or secondary must not remain the sole copy of
  content that the district is required to retain.

<!-- docs-contract:records-retention-classes:end -->

A single event can span lifecycle, journal, media, notification, delivery,
audit, roster-reference, and export records. `incident` alone does not say
whether the event is routine/minor, uncommon/major, or a security incident.
Notification documentation inherits its actual operational context; it is not
assigned a stand-alone blanket classification. A mixed-content event can
require more than one series or a documented controlling classification.

The product does not own a school-safety-plan record class. Do not assign a
school-safety-plan series unless a future inventory proves that a deployment
actually stores the plans themselves.

### Controlled mapping and disposition boundary

For every inventory class, the district-controlled operations record must name
the schedule title/version and effective date; DAN/revision; retention trigger
and minimum period; disposition; archival designation and appraisal
requirement; source OPR/OFM designation; official-copy owner and secondary-copy
treatment; content-based rationale; reviewer and review date; ambiguity status;
and any retained records-officer or Washington State Archives guidance.
Tenant-specific determinations, staff data, and private evidence do not belong
in this public repository.

An ongoing legal hold, reasonably anticipated litigation, active
public-records request, unresolved audit requirement, or required archival
appraisal overrides otherwise eligible disposition. Ambiguity is resolved with
retained written guidance from the district records officer or Washington State
Archives, not an engineering guess.

Until a separately approved disposition design exists, retain every event,
journal entry, audit fact, delivery fact, drill/test record, roster snapshot,
media object, and export. This guidance authorizes none of the following:
deletion, purge, a retention timer, a lifecycle rule, a down migration, or
automated disposition. Applied migrations and append-only product history
remain unchanged.

<!-- docs-contract:records-retention-policy:start -->

- `record-retention: all`
- `automated-disposition: prohibited`
- `deletion: prohibited`
- `down-migrations: prohibited`
- `lifecycle-rules: prohibited`
- `purge: prohibited`
- `retention-timers: prohibited`

<!-- docs-contract:records-retention-policy:end -->

<!-- psd-eoc:records-retention:end -->

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
