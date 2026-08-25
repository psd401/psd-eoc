# PSD EOC — Implementation Plan

**Product:** Easy Alert replacement — incident/drill activation, instant staff notification, live event collaboration, and records for Peninsula School District.
**Repo:** `psd401/psd-eoc` (new). Built in this folder.
**Deadline:** Easy Alert shuts down in <6 weeks (~mid-September 2026). Core build sprint: this weekend, with 5+ parallel Codex agents.
**Decision log:** [docs/discovery/DECISION_LOG.md](discovery/DECISION_LOG.md) (D-001…D-027 govern; brief at psd-maps `docs/EASY_ALERT_EMERGENCY_OPERATIONS_DISCOVERY_BRIEF.md` is the charter).

---

## 1. Executive summary

Build a district-owned notification + documentation platform ("call 911 first" positioning, D-004) with a high-reliability activation/delivery core (D-017). One deployable system (modular monolith + isolated delivery workers), three clients (web, native iOS, native Android), agent-native capability layer with MCP/REST parity for district AI agents (D-019), with four human-only actions (D-020).

**Release 1 (go-live before Easy Alert shutdown):**
- Any staff member (Google Groups-gated) starts an incident or drill: site → type → confirm (≤3 taps after unlock).
- Delivery: native push + email (+ SMS when carrier registration clears, D-013) to the staff of the school an event is started at, and of its neighborhood when an event reaches beyond its own building (D-008; the configurable audience layer was retired in #292).
- Live event: timeline with text, photos, location pins; join-or-start-new for concurrent events (D-025); anyone can all-clear/close (D-009).
- Drill records captured automatically by running the drill in-app (D-018).
- Agent surfaces: REST + MCP over the same capability layer — read/report/draft only for live-event actions (D-020).

**Explicitly deferred:** PSD Maps integration (D-012), drill calendars/compliance reporting (D-018), acknowledgement tracking (D-014), InformaCast channel, ICS checklists, AAR workflows, wearables/hardware buttons.

**Excluded (brief §4/§9, fixed):** student data of any kind, 911/PSAP integration, external agency accounts, Alta/camera integration, door control, threat modeling.

---

## 2. Architecture

### 2.1 Topology

One deployment family in AWS account `<aws-account-id>` (us-west-2, D-026), fully separate stack from PSD Maps:

```
[Expo iOS/Android]  [Next.js web UI]  [MCP server / REST agents]
        \                 |                  /
         └──── Capability layer (audited server engine) ────────────┐
                          |                                         |
                Aurora PostgreSQL (Serverless v2, min-ACU>0,        |
                multi-AZ, RDS Data API) + S3 media (private)        |
                          |                                         |
                Transactional outbox ──► SQS ──► Lambda channel workers
                                                  ├─ Push (APNs/FCM via Expo Push at launch)
                                                  ├─ Email (SES)
                                                  └─ SMS (AWS End User Messaging)
                                              DLQ + reconciliation + delivery-state writes
```

- **Web/API tier:** Next.js App Router on App Runner, **min 2 instances** (no Maps-style single-instance cap).
- **Database:** Aurora Serverless v2 PostgreSQL, **auto-pause disabled**, multi-AZ replica, RDS Data API (mirrors Maps conventions without its availability posture).
- **Delivery:** transactional outbox row written in the same transaction as event creation → SQS → per-channel Lambda workers with bounded retries, DLQ, and delivery-state callbacks. Activation is durably accepted when the event + delivery intent commit.
- **Realtime timeline:** short-polling (3–5s) at launch; SSE as fast-follow. At ≤1,200 users (D-024), polling is simple and sufficient.
- **Media:** presigned S3 upload → validate by content → re-encode (sharp) → strip EXIF (location is an explicit field, never inferred from EXIF).

### 2.2 Identity and sessions (D-006, D-007, D-011, D-016)

- Sign-in: Google OIDC, hosted domain `psd401.net`, access gated by designated Google Groups.
- Sessions: long-lived device-bound refresh tokens (server-revocable). **Google outage does not block activation** — sessions and cached group membership (TTL + grace) keep working.
- Mobile: token in SecureStore behind biometric unlock (Face ID / Android biometric). Web: standard session cookie.
- Roster sync: Google Groups (per-building + "others") synced on schedule into versioned roster snapshots; activation resolves recipients from the latest snapshot — never a live Google call in the critical path.

### 2.3 Event model invariants (brief §8.8, all preserved)

- Append-only event journal; corrections/redactions are superseding entries, never rewrites.
- Roster, event-type version, and message templates used by an event stay reconstructable.
- A real incident can never render/transmit as a drill and vice versa (enforced in schema + templates + UI theming).
- Delivery truth states never overclaim: accepted → recorded → attempted → provider-accepted → delivered-if-provable → failed/expired/**unknown** (first-class).
- No GET/preview/webhook/agent/scheduled job can start, escalate, all-clear, or close a real event. Idempotency keys on all mutating calls.
- No silent offline queueing of activations (explicit human re-confirm after reconnect).

### 2.4 Agent-native surfaces (D-019, D-020)

- Every feature is a typed capability; web UI, REST, and MCP all use the audited server engine — no side doors.
- Agent credentials: scoped API keys (per-agent identity, auditable).
- **Human-only (server-enforced, no agent credential can ever):** start real incident, send real notification, all-clear, close real event.
- Agents CAN: read everything they're scoped to, run reports, draft messages/templates, manage config drafts, work with drill data, and *prepare* an activation for one-tap human confirmation.
- Drill/test events in training mode: agents may exercise the full lifecycle against synthetic rosters only.

### 2.5 Reliability targets (adopted engineering targets, D-034 — these define "instant" and "high reliability" measurably)

| Metric | Target |
|---|---|
| Activation accepted (p95) | < 500 ms |
| Push handed to provider from activation (p95) | < 5 s |
| Email/SMS handed to provider (p95) | < 15 s |
| Activation-path availability | 99.9 % |
| RPO (event journal + delivery evidence) | ~0 (multi-AZ synchronous) |
| RTO | < 1 h |
| Canary | Shallow health every 1 min; monthly live end-to-end delivery test to controlled recipients |

### 2.6 Security baseline

Carries forward the Maps safety-charter patterns: deny-by-default server-side authz scoped by facility, fail-closed live-action gates, consequence preview + confirmation on real sends, truth labels (`mocked`/`configured-unverified`/`live-verified`/`blocked`) on every integration, no secrets/student data in repo, untrusted-input treatment of all synced/imported data, hash-chained audit for security events. New repo gets its own `AGENTS.md` + `SECURITY.md` (issue #2).

---

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Monorepo | Bun workspaces + TypeScript strict | User runtime rules; one lockfile; shared contracts |
| Contracts | Zod schemas in `packages/contracts` | Mirrors Maps; agents + all clients share one source of truth |
| Server | Next.js App Router (`packages/server`) — web UI + REST + capability layer | Team convention from Maps; one deployable |
| Mobile | Expo (React Native) + EAS Build (`packages/mobile`) | Only credible path to two native apps in the timeline; expo-notifications, expo-local-authentication, SecureStore |
| Push | Expo Push API at launch → direct APNs/FCM fast-follow issue | Simplest working weekend path; migration issue tracks the extra-dependency tradeoff |
| Email | AWS SES (`alerts.psd401.net` subdomain identity) | AWS-native, fast verification |
| SMS | AWS End User Messaging SMS; 10DLC registration day 1; toll-free interim | D-013; same carrier queue regardless of vendor |
| DB/ORM | Aurora PG + Drizzle migrations | Maps convention |
| MCP | `packages/mcp` over capability layer | Agent-native requirement |
| Infra | AWS CDK v2 (`infra/`), GitHub Actions OIDC deploy | Maps convention, no static keys |
| Tests | `node --test` (server/contracts), Playwright + axe (web), Maestro smoke (mobile) | Maps convention; a11y = WCAG 2.2 AA |

## 4. Monorepo layout (parallel-agent collision map)

```
psd-eoc/
├── AGENTS.md  SECURITY.md            # safety charter (issue #2)
├── packages/
│   ├── contracts/                    # Zod domain + capability + API types  ← lands FIRST
│   ├── server/                       # Next.js: web UI, REST, capabilities, outbox
│   ├── mobile/                       # Expo app
│   └── mcp/                          # MCP server
├── workers/                          # Lambda channel workers (push/email/sms)
├── infra/                            # CDK
└── docs/                             # PLAN, decision log, runbooks
```

Collision rules for parallel Codex agents (D-023): contracts merge before dependents start; one issue = one package or one disjoint module inside a package; server issues split by route-group/module; every issue names the files it owns; cross-package changes go through a contracts PR first.

---

## 5. Epic and issue breakdown

**Epic:** "Release 1 — Easy Alert replacement live before shutdown."
Phases gate on dependencies; issues within a phase are parallel-safe.

### Phase 0 — Foundations (serial, land first)
1. **Scaffold monorepo** — Bun workspaces, TS strict, ESLint/Prettier, CI (check gate: format/lint/typecheck/test), PR template, CODEOWNERS.
2. **Safety charter** — `AGENTS.md` + `SECURITY.md`: human-only actions, live-action gate, synthetic-data rule, truth labels, no-student-data, production-change authority.
3. **Contracts v1** — Zod: identity/session, facility/neighborhood, group/roster snapshot, event type (versioned, real-vs-drill), event lifecycle + journal entries, notification intent/attempt/delivery-truth states, capability envelope + human-only action registry, API error model.
4. **Infra baseline** — CDK: Aurora (no pause, multi-AZ), S3 media, SQS + DLQ, App Runner (min 2), Secrets, SES identity, CloudWatch skeleton, GitHub OIDC deploy role.
5. **DB schema + migrations** — Drizzle from contracts; append-only journal tables; outbox table.

### Phase 1 — Identity & access (parallel after 3/5)
6. Google OIDC web sign-in + hosted-domain + Groups gate + minimal roles (staff/admin) + facility scoping.
7. Device sessions: long-lived refresh, rotation, revocation list, Google-outage grace; server-side session authz middleware.
8. Groups→roster sync job: per-building groups, neighborhood config, "others" group; versioned snapshots; stale-roster report.

### Phase 2 — Event engine (parallel after Phase 0; UI parts after 6/7)
9. Event lifecycle capabilities: create (idempotent), join-or-start-new, all-clear, close, reopen-correction; journal writes; real-vs-drill invariant.
10. Event-type admin CRUD (versioned; seed: Lockdown, Modified Lockdown, Medical, Wildlife, + drill variants; SRP-migration-ready).
11. Outbox dispatcher: transactional outbox → SQS enqueue, worker contract, delivery-state writeback, reconciliation, bounded retries.
12. Push worker (Expo Push at launch) + device token registry + receipts.
13. Email worker (SES) + templates (real vs drill theming).
14. SMS worker (AWS EUM) + length-safe templates + opt-out handling. *(Ships dark until registration clears.)*
15. Web: active-events dashboard + start-event flow (site→type→confirm, 911 affordance that clearly does NOT auto-dial or imply dispatch).
16. Web: event screen — timeline (poll), post text, all-clear/close with confirm.
17. Media: presigned upload, content validation, re-encode, EXIF strip, authorized reads; photo posts.
18. Location pins: explicit lat/lng + accuracy + label; web map display (MapLibre); "unknown/ambiguous" state.

### Phase 3 — Mobile (parallel after 3; API-dependent parts after 9)
19. Expo scaffold: navigation, theming (unmistakable real-vs-drill visual states), EAS config for TestFlight + Android build.
20. Mobile auth: OIDC flow, SecureStore, biometric unlock.
21. Start-event flow (≤3 taps), join-or-start-new, 911 affordance.
22. Event screen: timeline, text/photo/location posts.
23. Push registration + foreground/background/locked-screen notification handling.

### Phase 4 — Agent-native & admin (parallel after 9)
24. REST agent API: scoped API keys, per-agent identity, audit; human-only enforcement tests.
25. MCP server: read/report/draft capabilities + prepare-activation (human confirms in app).
26. Admin: facilities/neighborhoods, group mappings per site, test mode + synthetic roster.
27. Drill records view + event export (CSV/PDF summary).
28. Audit trail + security-event log (distinct from operational journal).

### Phase 5 — Reliability & launch (after Phases 1–3)
29. Monitoring: CloudWatch alarms → team notification, dashboards, shallow canary.
30. Monthly live end-to-end delivery test harness (controlled recipients) + latency measurement vs SLO.
31. Failure drills: kill worker mid-send, DB failover, Google-outage login, duplicate-delivery reconciliation — documented evidence.
32. E2E: Playwright + axe (WCAG 2.2 AA on activation/event/all-clear paths); Maestro smoke on both platforms.
33. TestFlight + Android distribution pipeline; enrollment/install guide for staff.
34. Runbooks (per §12 failure list), on-call escalation matrix, go-live/rollback checklist.

### External-dependency tasks (humans, start immediately — issues labeled `external`)
E1. A2P 10DLC brand/campaign registration (+ toll-free interim number).
E2. SES production access + `alerts.psd401.net` DNS.
E3. Google Play developer account creation + org verification.
E4. App Store Connect app record + TestFlight group.
E5. GCP project: OAuth clients + Cloud Identity Groups read via the dedicated
`roster-sync-reader@psd401-eoc.iam.gserviceaccount.com` service account,
direct Workspace Groups Reader assignment, and only the singleton
`cloud-identity.groups.readonly` scope; no delegated subject or domain-wide
delegation.
E6. FCM project for Android push (+ APNs key upload if/when direct).
E7. Confirm designated access Google Groups + per-building group inventory.
E8. WA Archives retention DAN lookup for incident/drill records (manual download; sos.wa.gov blocks bots).

---

## 6. Success criteria (ISC)

| Criterion | Source | Status |
|---|---|---|
| Staff member starts a drill from iPhone (TestFlight) and all building-group members receive push+email | Explicit | PENDING |
| Same works on Android (private distribution) and web | Explicit | PENDING |
| p95 activation→push-provider handoff < 5 s measured by test harness | Explicit (D-005/D-017) | PENDING |
| Google forced-outage test: existing session still starts an incident | Explicit (D-016) | PENDING |
| Agent via MCP can query events/drill records but is server-side blocked from the 4 human-only actions (test evidence) | Explicit (D-019/D-020) | PENDING |
| Drill run in-app produces exportable record with date/time/type (RCW 28A.320.125 fields) | Implicit | PENDING |
| Real incident and drill are visually + template-distinct in every channel (test evidence) | Implicit (brief invariant) | PENDING |
| CI gate green: format, lint, typecheck, tests, Playwright+axe | Implicit | PENDING |

## 7. Top risks

- **Weekend timeline vs. store/carrier lead times** — mitigated by starting E1–E6 immediately; SMS explicitly allowed to lag (D-013).
- **Expo Push as extra dependency in the alert path** — accepted for launch, direct APNs/FCM migration issue filed; risk documented in truth labels.
- **iOS TestFlight builds expire after 90 days** — acceptable short-term; unlisted App Store distribution decision within 60 days.
- **Google Groups data quality** — stale-roster report (issue 8) + admin override; roster snapshots make every send auditable.
- **Single AWS account shared with Maps** — separate stack/IAM boundaries; account-level limits watched (accepted per D-026).

---

## Question resolutions (2026-08-06)

7.1 → SLO table adopted as engineering targets (D-034). Plain meaning: the measurable promises behind "instant" and "high reliability" — how fast an activation is accepted, how fast notifications reach the delivery providers, and how much downtime per year is tolerable (99.9% ≈ under 9 hours/year).
7.2 → Access groups admin-configurable in-app (D-028).
7.3 → Neighborhoods built/configured in-app (D-029).
7.4 → "Others" groups added later via admin (D-030).
7.5 → Message wording: seeded defaults, admin-role configurable in-app (D-035).
7.6 → App name: PSD EOC (D-031).
7.7 → Retain everything (D-032).
7.8 → Expo Push at launch, direct APNs/FCM fast-follow (D-033).
