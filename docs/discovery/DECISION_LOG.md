# psd-eoc Discovery Decision Log

Format: each entry is a confirmed decision (D), assumption (A), open question (Q), or rejected option (R).
Source: PO = product owner (Kris Hagel) interview answer; BRIEF = discovery brief confirmed decision; RESEARCH = sourced research finding.

## Confirmed decisions

| ID | Date | Decision | Source |
|----|------|----------|--------|
| D-001 | 2026-08-06 | Build (not buy). All-new project, separate repo from PSD Maps. | BRIEF §4 |
| D-002 | 2026-08-06 | **Hard deadline: Easy Alert shuts down in <6 weeks (~mid-September 2026). Release 1 must be usable before shutdown.** | PO Q1.1 |
| D-003 | 2026-08-06 | Release 1 workflow: users report (start) incidents and drills; instant notification to recipients; event is documented. Must work on web, iOS, and Android. | PO Q1.1 |
| D-004 | 2026-08-06 | Product positioning: notification + documentation tool, not a 911 replacement and not marketed as 100% life-safety. Users always call 911 first. Call-911 stays a plain user action. | PO Q1.1 |
| D-005 | 2026-08-06 | Notification speed is the critical quality: "instant to everyone." (Measurable target TBD — see Q-002.) | PO Q1.1 |
| D-006 | 2026-08-06 | Any authenticated staff member may start an incident or drill — no per-site initiator subset. | PO Q1.2 |
| D-007 | 2026-08-06 | App access is gated by membership in designated Google Groups (which groups TBD). Note: Groups gate *access*; roster/recipient design still per §14 of brief — propagation delay and outage behavior must be handled. | PO Q1.2 |
| D-008 | 2026-08-06 | Notification audience is configurable per site: (a) staff in the building, (b) staff in the "neighborhood" — geographically co-located schools, (c) a configured "others" group. Explicitly NOT all staff district-wide. | PO Q1.3 |
| D-009 | 2026-08-06 | Any authenticated staff member may issue all-clear/close — same authority as starting. A mistaken all-clear is handled by audit + ability to re-activate, not by permission gating. | PO Q1.4 |
| D-010 | 2026-08-06 | Event types are admin-configurable and versioned, seeded small: Lockdown, Modified Lockdown, Medical, Wildlife (bear/cougar), plus a few others + drill variants. District intends to migrate to Standard Response Protocol (SRP) vocabulary later — the model must make that a config change, not a rebuild. Do NOT clone Easy Alert's oversized category list. | PO Q1.5 |
| D-011 | 2026-08-06 | Roster source = Google Groups (per-building groups). Not the Warehouse/Follett feed, not manual-only. | PO Q1.6 |
| D-012 | 2026-08-06 | PSD Maps integration is deferred — "not much right now," may integrate later. Release 1 has no Maps dependency. (Supersedes the brief's assumption that a Maps contract is a core discovery deliverable; boundary design still keeps a clean seam for later.) | PO Q1.6 |
| D-013 | 2026-08-06 | Channels: shoot for push + email + SMS in release 1. If SMS lags behind carrier registration, launch without it — push+email is acceptable at go-live. SMS provider default: AWS End User Messaging SMS (A2P 10DLC registration starts week 1; toll-free verification as faster interim path). | PO Q1.7 |
| D-014 | 2026-08-06 | No acknowledgement requirement — no "I got it" tap, no who-has-acknowledged board. Notification informs; recipients may ignore or open the event and follow the ongoing conversation. (Delivery status still recorded server-side for ops truth, but no recipient-facing ack workflow.) | PO Q1.8 |
| D-015 | 2026-08-06 | Event conversation in release 1: text messages, photos, and location pins — all three. | PO Q1.9 |
| D-016 | 2026-08-06 | Google outage must not block starting an incident: long-lived sessions keep working independent of Google availability. Biometric unlock for return visits (Face ID on iOS, Android biometric equivalent) — i.e., device-bound credential/passkey unlock, not a fresh SSO round-trip. Google is the identity *source*, not a runtime dependency of activation. | PO Q1.10 |
| D-017 | 2026-08-06 | Really high reliability required — this is school safety infrastructure. Not PSD Maps' repair-time-outage model: multi-AZ, always-on database, redundant fan-out, monitoring/canaries. Concrete SLOs to be proposed in the plan for PO approval. | PO (unprompted) |
| D-018 | 2026-08-06 | Release 1 drills: run a drill through the app + keep records. Drill calendars, monthly-requirement checks, and compliance reporting may live elsewhere (possibly other district systems/agents) — not release 1. | PO Q1.11 |
| D-019 | 2026-08-06 | Agent-native architecture required (ref: every.to/guides/agent-native). District AI agents must be able to interact with app data including reporting. All surfaces (web/REST/MCP) converge on one capability layer, mirroring Maps' executeCapability pattern. Scope of agent authority over live actions: see D-020. | PO Q1.11 |
| D-020 | 2026-08-06 | Human-only boundary accepted: agents may NOT start a real incident, send a real notification, issue all-clear, or close a real event. Full agent parity everywhere else — reads, reporting, drafts, configuration, drill data, and preparing an activation for one-tap human confirmation. | PO Q1.12 |
| D-021 | 2026-08-06 | Native mobile apps for BOTH platforms are a launch requirement (not PWA-only). Web app also required (D-003). Build sprint targeted for the upcoming weekend; store distribution lead times tracked as external dependencies. | PO Q1.13 |
| D-022 | 2026-08-06 | Distribution: private to staff. iOS via TestFlight (Apple Developer Program membership already exists). Android: no Google Play account yet; devices are PERSONAL (no MDM) — Play closed testing is the durable path (normal Play Store install), Firebase App Distribution as interim. Play account setup is an external-dependency task to start immediately. | PO Q1.14 + follow-up |
| D-024 | 2026-08-06 | Scale: ~100 users initially, hard ceiling 1,200 total staff. Largest-building count immaterial at this scale. Fan-out capacity is trivial; latency targets drive design, not throughput. | PO Q1.15 |
| D-025 | 2026-08-06 | Concurrent events at one site are legitimate. On activation at a site with an active event, show the active event(s) and offer an explicit choice: join existing OR start a new separate event. No blind 3-minute duplicate-suppression window. (Idempotency still protects against double-tap/replay of the same submission.) | PO Q1.16 |
| D-026 | 2026-08-06 | Hosting: same AWS account as PSD Maps (338414773271, us-west-2). Separate stack/resources, but shared account. Availability posture still differs from Maps per D-017 (no auto-pause, multi-AZ). | PO Q1.17 |
| D-027 | 2026-08-06 | Operations ownership: Kris + district technology team own on-call, deliverability, and incident response, using existing team monitoring/alerting practices. Kris is in charge of both safety/security and IT, so product, safety-procedure, and operational authority converge on him. | PO Q1.18 |
| D-028 | 2026-08-06 | Access-gating Google Groups are admin-configurable in the app — no hardcoded group names; no group inventory needed before build. | PO 7.2 |
| D-029 | 2026-08-06 | Neighborhoods (co-located school groupings) are defined in-app via admin UI, not seeded from an external source. | PO 7.3 |
| D-030 | 2026-08-06 | "Others" audience groups: supported in the audience model from day 1, populated later by admins. Launch audiences = building + neighborhood. | PO 7.4 |
| D-031 | 2026-08-06 | App name: **PSD EOC** — product will expand into the district's emergency operations center over time. | PO 7.6 |
| D-032 | 2026-08-06 | Records: retain everything, delete nothing. No automated disposition until a records-schedule decision is made later (E8 stays open as informational). | PO 7.7 |
| D-033 | 2026-08-06 | Push architecture: Expo Push service at launch (fastest working path), migration to direct APNs/FCM as a filed fast-follow issue. Adopted as engineering recommendation after PO deferred ("I don't know what this is"). | PO 7.8 + recommendation |
| D-034 | 2026-08-06 | SLO table in PLAN §2.5 adopted as engineering targets (what "instant" and "high reliability" mean measurably). PO briefed in plain language and approved ("reasonable"). | PO 7.1 |
| D-035 | 2026-08-06 | Message wording (per event type × channel, real + drill variants): seeded with engineering defaults, configurable by admin role in the system. | PO 7.5 |
| D-023 | 2026-08-06 | Build will run with 5+ parallel Codex agents. Issues must be scoped to avoid collisions: contract-first (shared schemas/API contracts land before dependents), monorepo with hard package boundaries (server / web / mobile / shared), issues own disjoint file sets, explicit dependency ordering in the epic. | PO Q1.14 |

## Assumptions (unconfirmed)

| ID | Date | Assumption | Validation path |
|----|------|-----------|-----------------|
| A-001 | 2026-08-06 | "Web/iOS/Android" may be satisfiable by PWA + web push if it meets the instant-notification bar on district devices; native apps only if evidence demands. App Store review + Apple Developer enrollment timelines likely don't fit 6 weeks for native. | Device/channel validation task; PO confirmation |

## Open questions

| ID | Date | Question | Owner | Status |
|----|------|----------|-------|--------|
| Q-001 | 2026-08-06 | Who may start an incident/drill; who receives; all-clear authority | PO interview | in progress |
| Q-002 | 2026-08-06 | Measurable definition of "instant" (activation→delivery latency target) | PO interview | open |
| Q-003 | 2026-08-06 | Exact Easy Alert shutdown date in writing | PO / Everi comms | open |
| Q-004 | 2026-08-06 | WA Archives retention class (DAN) for drill/incident records — sos.wa.gov blocks automated fetch | Manual download | open |

## Research findings on file

- Legacy replacement plan summary: no Peninsula operational data (sites, rosters, event types) in the doc; must come from PO/export.
- PSD Maps boundary: CRG grid resolver, Response View, document storage are spec-only (not built); deep links to facility/floor/room work today; IDs are unversioned convention strings; Maps accepts repair-time outages (not inheritable); InformaCast/Alta mocked with live writes hard-disabled.
- RCW 28A.320.125 (verified 2026-08-06): monthly drill in session; shelter-in-place, lockdown, evacuation named; log date/time/type. Pending HB 2328 touches this section.
- RCW 28A.320.126 (verified 2026-08-06): ≥1 qualifying emergency-response system; OSPI reporting via ICOS.
- Twilio A2P: government/Emergency special use case exists (throughput/fee-waiver figures secondary, unverified).
- iOS Web Push: requires home-screen install, iOS 16.4+; Safari 18.4 Declarative Web Push (secondary, unverified).
