# Architecture and contributing

This document is the current repository architecture and contributor guide.
Historical plans and decision ledgers are retained outside the repository;
current code, contracts, tests, and this guide are the only authority.

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

Event-type template drafts follow "an agent drafts, a human publishes". Humans
and agents may create and revise an unpublished draft; the draft's revision
history is an append-only ledger of idempotency facts, and publication binds a
new immutable version to one exact draft revision. The human half is the
Responses admin page: `list-event-type-drafts` shows every unpublished draft
with its author resolved to a current name (for an agent, the agent and the
administrator-given label and public prefix of its key) and the published
version it was based on; the page renders the channel previews and a
field-by-field comparison. Only the actor who last saved a draft may publish
it, so approving an agent draft re-saves the reviewed wording under the
reviewer and then publishes. `discard-event-type-draft` appends a discard fact
for one exact revision; the draft stays readable but can no longer be edited or
published. Both review capabilities admit only human principals on web and
mobile, so no agent grant for them exists.

OIDC completion is the sole pre-session exception. It has no authenticated
actor or facility scope yet, so
`executeRepositoryAuditedOidcCompletion` accepts only the literal
`complete-oidc-sign-in` registration. Its serializable repository commits
replay protection, session issuance, and access-gate audit together. The
source-boundary test permits only the browser callback, the mobile exchange
route, app-store review sign-in, and partner web sign-in. Adding another
lower-tier consumer requires moving it through the audited engine or
deliberately updating this document and the exact allowlist test together.

Two issuers complete that one capability, and `lib/auth/identity-providers.ts`
is the only place an issuer becomes a sign-in path: district Google for staff,
and one Amazon Cognito user pool for partner (first-responder) accounts. The
two paths cannot be confused for one another. A Google identity completes only
through a code callback or the native exchange, a partner identity only
through a verified email one-time password, and the pre-session envelope
refuses either transport with the other's issuer. Staff authorization is
current trusted-group membership; a partner's is an administrator's admission
that has not ended or expired, re-read on every request. Staff sessions keep
their long lifetime; a partner session lasts at most one day and never past
its admission, which `lib/auth/partner-session.ts` caps rather than
configures. Partner access is configuration: without the pool parameters the
registry holds Google alone and the deployment has no partner sign-in.

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

## Agent API keys

An agent API key carries an explicit set of capability grants chosen by a
district administrator. The vocabulary it may be granted from is one written
allowlist, `AGENT_KEY_GRANTABLE_CAPABILITY_IDS` in
`packages/contracts/src/agent-key-grants.ts`, not a derivation from the
catalog. The catalog's invocation policy still says which capabilities can
execute under an agent principal at all, and that wider set is the persisted
PostgreSQL grant enum; the allowlist must be a subset of it, which contracts
assert at load.

The allowlist is enforced at every layer that touches a grant: the issuance
schema, the admin issue form (which offers only allowlisted IDs), key
persistence, authentication (a stored grant outside the allowlist is left out
of the key's effective grants), authorization (the REST gateway refuses the ID
with an audited `CAPABILITY_NOT_GRANTED`), the dispatcher (whose exhaustive
switch proves every allowlisted ID has a handler), and the OpenAPI document.
Publishing an event-type version, writing to a live journal, joining or
reactivating an event, reopening a closed event, and configuration writes are
deliberately absent: an agent may draft notification wording, and a human
publishes it. Synthetic-roster lifecycle grants remain because the capability
engine refuses every staff-roster target to a non-human actor.

Agent REST calls are budgeted per API key. The gateway admits at most 60
requests per key per minute, charged at authorization, and at most 20 per key
per hour across `export-drill-records`, `export-event-summary`, and
`create-activation-preview`, charged at dispatch because those calls render a
document or persist a row. A refused request is answered `429 RATE_LIMITED`
with a `Retry-After` header and never reaches a capability handler. A refusal
is recorded as an `access-denial` audit fact with reason code `RATE_LIMITED`
under the key, but only the first refusal of each lockout for either budget:
later refusals in that lockout are answered without an audit row, so a key
sending past its budget cannot grow the audit chain faster than its admitted
budget.
Protected-action aliases sit inside the same budget: within it every attempt
is audited `HUMAN_ONLY_REQUIRED`, and past it the lockout's refusal fact is a
`human-only-rejection` naming the action, so the signal is never lost.
Authentication, one indexed read, still runs for every request. The limiter is
in memory and per server process: with up to four App Runner instances, one
key's effective ceiling is up to four times each constant, and an instance
restart resets its windows. The constants live in
`packages/server/lib/agents/rate-limit.ts`.

## Partner access

Responders from outside the district (partners) sign in through a separate
identity provider, never Google. A person is identified by issuer and
subject, and `partner` is held alone: no access group grants it and no partner
holds a staff role, which contracts, database triggers, and the server's
access decisions each enforce.

- A partner is let in only by a partner admission. Admissions and their
  endings are append-only; `expires_at` is computed by the database one year
  after admission. A renewal or a corrected address is a new admission that
  supersedes the old one. Every session read asks whether the partner's
  current admission is unended and unexpired, so ending or expiring it
  refuses the next request.
- Administrators invite, disable, renew, and re-invite partners on the Access
  page. The admission write commits first; the identity-provider change and
  the invitation email follow and are recorded as confirmed facts, so a gap
  between the two is visible on the page and a retry completes it.
- Partner account mail (invitation, the one expiry notice 14 days ahead, and
  the administrators' quarterly review) is the one email the application
  runtime sends itself, through SES in the alert email's branded shell,
  restricted to the deployment's sender address and present only while
  partner access is configured. Alerts reach people only through the email
  worker.
- A daily scheduled task (`scripts/operations/sweep-partner-access.ts`) ends
  admissions past their expiry as the system, cuts the partner out of the app,
  completes pending provider changes, sends the notice, and sends the
  quarterly review. It writes partner records directly through `lib/partners`
  rather than running a capability. Inactivity is reviewed, never acted on:
  nothing disables a partner automatically except expiry.
- A partner session may run only the written allowlist
  `PARTNER_CAPABILITY_IDS` in `packages/contracts/src/partner-capabilities.ts`:
  seeing live events and the facility, threat, and published event-type reads
  that render them; opening an event room, joining, reading and posting to the
  timeline, and attaching media; and the partner's own session, devices, push
  registration, and text-message consent. A partner session's
  server-resolved capability scope carries `partner: true`, and the capability
  engine refuses every other capability for every transport with the same
  generic refusal any principal gets. The event-type reads, which run outside
  the engine's invocation check, and lifecycle confirmation issuance restate
  the refusal. Starting, ending, correcting, or reopening an event, Records
  and exports, configuration, audit, and agent keys are all outside it.
- A partner acts at every facility that is not isolated, resolved by
  `partnerFacilityScope` in `lib/auth/partner-admission.ts` on every session
  read, never at the limit stored on the account row. An isolated facility's
  events (the store reviewer's, for one) are therefore invisible to partners.
  With no non-isolated facility, no partner is admitted.
- Which real events alert partners is a district administrator's setting on
  the Partner alerts page (`get-partner-alert-settings` and
  `set-partner-alert-settings`, web-only administration, never on the partner
  allowlist): the response families that alert them (`event_types.family_key`)
  and the threats that never do (`threats.key`). Each save is an append-only
  version in `partner_alert_settings` naming its administrator and the version
  it replaced; a save from a stale page is refused. Until the first save the
  contracts' default applies: Lockdown and Modified Lockdown, no threat
  excluded. Saving no response turns partner alerts off. Drills never alert
  partners, so there is no drill setting, and channels are not a setting: a
  partner is emailed at the admitted address and reached by push or text only
  after enrolling a device or consenting. The settings in effect are read
  through `loadEffectivePartnerAlertSettings` in
  `lib/partners/alert-settings.ts`.
- A live incident's activation preview pins the admitted partners those
  settings select (`lib/partners/audience.ts`), and the confirmed send writes a
  partner intent beside the staff one. Its all-clear and reactivation reach
  exactly that pinned set. Delivery resolves each partner when the batch is
  sent (`lib/partners/delivery.ts`): the admitted address by email, the
  partner's own live push registrations, and the partner's own live text
  consent, each recorded once as a `partner_endpoints` row that attempts bind
  to. An admission ended or expired since activation, an unregistered or
  handed-on device, a withdrawn consent, or a suppressed address is not sent
  to. Partner alert email goes out under the partner SES configuration set, so
  a partner bounce or complaint is recorded against partner mail and never
  suppresses a staff address.

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
  Staff and partner accounts, partner admissions and how each ended, roles
  and scopes, access snapshots, device enrollment,
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
for the CDK stack is a human operator's short-lived AWS session; for Terraform
roots it is the GitHub `production` environment and its OIDC role
([AGENTS.md](../AGENTS.md), "Production"). A portable manifest is not permission to
deploy, and every deploy must independently verify the configured account,
region, and origin.

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
