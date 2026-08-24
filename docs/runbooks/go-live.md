# PSD EOC go-live checklist

## Decision status

> **BLOCKED — DO NOT GO LIVE.** This checklist is unsigned. Product owner Kris
> Hagel must personally review the completed evidence and sign the final
> decision before any production traffic or live provider configuration.
> Agents, automation, reviewers, commits, tests, and prior approvals cannot
> check or sign that box.

Use one immutable checklist copy for the proposed release. Link
access-controlled evidence; do not paste secrets, recipient data, provider
payloads, staff contact details, or student data. If a required item is unknown,
leave it unchecked and keep the decision blocked.

Release candidate:

- Proposed go-live time (UTC): `[PO/OPERATIONS TO FILL]`
- Server image digest: `[TO FILL]`
- Worker image digests: `[TO FILL]`
- Infrastructure commit/change-set ID: `[TO FILL]`
- Database migration/version: `[TO FILL]`
- iOS version/build: `[TO FILL]`
- Android version/build: `[TO FILL]`
- Emergency-control revision/enable epoch: `[TO FILL]`
- Internal delivery authorization secret resource/version reference:
  `[TO FILL — NEVER THE VALUE]`
- Evidence package link: `[CONTROLLED LINK TO FILL]`

## 1. Governance and safety

- [ ] `AGENTS.md`, PLAN, and D-001 through D-035 were reviewed for this exact
      release; accepted gaps cite the binding decision and do not weaken it.
- [ ] Server tests prove no agent, automation, service account, scheduled job,
      webhook, GET request, or link preview can start a real incident, send a real
      notification, issue an all-clear, or close a real event.
- [ ] Every web, mobile, REST, and MCP surface uses the canonical capability
      layer; there is no side-door mutation.
- [ ] Real incidents and drills are distinct in schema, preview, UI, push,
      email, SMS, timeline, records, and tests.
- [ ] Offline activation never queues for later; reconnection requires a fresh
      authenticated-human preview and confirmation.
- [ ] Event journals, audit records, control truth, notification attempts, and
      delivery evidence are append-only; corrections supersede with provenance.
- [ ] Delivery UI/evidence never equates provider acceptance with delivery or
      human receipt and represents `unknown` honestly.
- [ ] No student data is collected, imported, displayed, logged, or retained.
- [ ] No secret, token, credential, real recipient destination, roster export,
      or provider payload exists in the repository or release evidence.
- Evidence: `[BLOCKED / TO FILL]`

## 2. Dependencies and change gate

- [ ] The exact release includes monitoring source from issue
      [#29](https://github.com/psd401/psd-eoc/issues/29) / pull request
      [#96](https://github.com/psd401/psd-eoc/pull/96), with all 26 exact alarm
      names and stable runbook anchors matching
      [README.md](README.md#p51-alarm-to-runbook-inventory).
- [ ] All 26 alarms, metric conditions, alarm/OK actions, and runbook links were
      read back from the approved CloudWatch account/region; exact console links
      are retained in the access-controlled release evidence. Synthesized
      source is not accepted as deployment proof.
- [ ] Issue [#91](https://github.com/psd401/psd-eoc/issues/91) provides an
      isolated deployed non-production stack with no path to real recipients or
      write-capable live providers.
- [ ] Issue [#31](https://github.com/psd401/psd-eoc/issues/31) completed all
      eight deployed failure drills; zero silent loss and zero duplicate provider
      side effects are proved where required; every gap is fixed or explicitly
      accepted by the product owner.
- [ ] Issue [#33](https://github.com/psd401/psd-eoc/issues/33) completed private
      iOS/Android distribution and human install evidence.
- [ ] `bun run check` passes on the exact release commit with no unexplained
      skip or external-database gap.
- [ ] Activation, event, and all-clear Playwright + axe tests pass WCAG 2.2 AA;
      both mobile platform smoke tests pass.
- [ ] All production changes are reviewed and deploy only through GitHub
      Actions OIDC; no static AWS keys or manual unreviewed drift.
- Evidence: `[BLOCKED / TO FILL]`

## 3. Infrastructure, availability, and monitoring

- [ ] The reviewed stack is deployed in account `338414773271`, region
      `us-west-2`, separate from PSD Maps, with inventory captured by immutable
      resource IDs.
- [ ] App Runner has at least two instances, an immutable image digest,
      automatic source deployment disabled, and a side-effect-free healthy
      `/api/health` path.
- [ ] Aurora has a positive capacity floor/no auto-pause, writer and reader in
      separate Availability Zones, TLS/encryption, Data API least privilege,
      retained backups, and deletion protection.
- [ ] Delivery queue plus push/email/SMS queues and paired retained DLQs have
      bounded retries, encryption, least privilege, and deployed consumers only
      for approved channels.
- [ ] CloudWatch dashboard shows p50/p95/p99 activation-accept and outbox-to-
      provider handoff plus delivery-state distribution and all DLQ depths.
- [ ] All 26 exact alarms in the
      [alarm inventory](README.md#p51-alarm-to-runbook-inventory), including
      activation-accept, metrics-collector, both roster-age conditions, and all
      six provider-handoff conditions, page the approved on-call routes and
      their alarm math was exercised.
- [ ] The one-minute canary is test-only, synthetic/unroutable, makes zero
      provider calls, cannot invoke a human-only action, and is excluded from real
      dashboards/records.
- [ ] On-call primaries/backups, paging windows, and controlled contact-system
      records in [escalation.md](escalation.md#product-owner-fillable-names-appendix)
      are complete and tested.
- Evidence: `[BLOCKED / TO FILL]`

## 4. Identity, authorization, and roster

- [ ] Google OIDC hosted-domain and designated-group gate is configured and
      independently verified; integration truth matches evidence.
- [ ] Existing device-bound long-lived sessions activate during the deployed
      Google-outage drill without a Google round trip; revocation still fails
      closed.
- [ ] Server-side role/facility authorization is deny-by-default for every
      capability, including media and admin reads.
- [ ] Google Groups sync uses approved staff-only delegated read access,
      validates untrusted responses, and creates immutable complete snapshots.
- [ ] Every launch facility/audience has a recent complete staff snapshot;
      partial/failed sync evidence does not replace the last-good snapshot.
- [ ] Agent API keys are least-privilege, bounded, stored securely, audited,
      and server-side denied all canonical human-only actions.
- Evidence: `[BLOCKED / TO FILL]`

## 5. Delivery, integrations, and delivery truth

- [ ] `docs/INTEGRATIONS.md` was reviewed on the release commit; every external
      integration uses only `mocked`, `configured-unverified`, `live-verified`, or
      `blocked`, backed by the claimed evidence.
- [ ] Transactional outbox commit, central routing, channel workers, delivery
      writeback, reconciliation, bounded retries, DLQ behavior, and attempt
      idempotency/fencing are deployed and tested.
- [ ] Push is `live-verified` for the exact production configuration and
      approved synthetic target evidence; provider acceptance is not called
      delivery.
- [ ] Email is `live-verified` for the exact SES identity/configuration/callback
      path and approved synthetic target evidence; bounce/complaint/delay handling
      is append-only.
- [ ] Every live test used verified credentials, an exact product-owner-
      approved synthetic target list, consequence preview, explicit authorization,
      and fresh authenticated-human confirmation in the app.
- [ ] Provider-call outcomes that could not be proved are retained as
      `unknown` and never blindly retried.
- Evidence: `[BLOCKED / TO FILL]`

### SMS D-013 launch decision (choose exactly one)

- [ ] **SMS verified:** registration, opt-in/opt-out, exact worker/provider
      configuration, synthetic delivery evidence, and `live-verified` label are
      complete; **or**
- [ ] **SMS dark:** product owner accepts launch under D-013 with push+email;
      SMS remains `blocked`, canonical channel configuration is off, the SMS
      queue receives no routable staff work, there is no SMS event source or
      provider permission, and UI/runbooks state the limitation honestly.

Selection/evidence/product-owner acceptance: `[BLOCKED — NEITHER SELECTED]`

## 6. Backup, restore, failure drills, and SLOs

- [ ] Automated Aurora backup window/retention and latest restorable time are
      verified on the deployed environment; encryption and deletion protection
      are proved.
- [ ] [backup-restore.md](backup-restore.md) was executed against isolated
      synthetic non-production data with linked evidence, measured RTO under one
      hour, honest restored-point/RPO gap, integrity/hash-chain checks, and zero
      provider calls.
- [ ] All #31 drills have expected versus observed evidence and gap tickets:
      worker killed mid-send, Aurora failover, Google outage, DLQ disposition,
      duplicate callback, delayed callback after all-clear, revoked device, and
      roster-sync failure/last-good snapshot.
- [ ] p95 activation accepted is under 500 ms, push handoff under 5 seconds,
      and email/SMS handoff under 15 seconds for the applicable verified channels,
      using stored evidence from the exact release/runtime.
- [ ] Activation-path availability evidence supports the 99.9% target.
- Evidence: `[BLOCKED / TO FILL]`

### Monthly live delivery test

**BLOCKED / UNCHECKED.** Issue
[#30](https://github.com/psd401/psd-eoc/issues/30) is open and current
integrations are not live-verified.

- [ ] The explicit opt-in synthetic canary recipient set is stored outside the
      repository and excludes every unlisted endpoint.
- [ ] A human launched the exact test through the audited capability engine after a fresh
      consequence preview, product-owner approval, and authenticated confirmation.
- [ ] No scheduled job or automation sent a notification; scheduling only
      reminded/paged a human that the test was due.
- [ ] Stored per-channel latency and delivery-truth outcomes are linked,
      including `unknown`; provider acceptance is not human receipt.
- [ ] Missed/failed monthly-test alarm and runbook route were exercised.
- Evidence: `[BLOCKED — NO LIVE TEST EXECUTED]`

## 7. Private mobile distribution and staff readiness

- [ ] Exact iOS build is installed from the approved internal TestFlight group
      on a staff-context test device; Apple record/group/build IDs and human
      evidence are linked without tester data.
- [ ] Exact Android build is installed from the chosen private track on a
      staff-context test device; track/release/build IDs and human evidence are
      linked without tester data.
- [ ] A non-engineer followed both install guides, enabled notification
      permissions, understood Focus/Do Not Disturb limits, and knew how to get
      help/revoke access.
- [ ] Mobile real/drill visual distinction, foreground/background/locked-screen
      handling, biometric unlock, stale-session behavior, offline refusal, and
      real/drill theming passed on both platforms.
- [ ] Store/OTA version policy and rollback were reviewed; native,
      authentication, push, runtime, and safety-boundary changes cannot ship as a
      JavaScript-only OTA update.
- Evidence: `[BLOCKED / TO FILL]`

## 8. Operator rehearsal and rollback

- [ ] A non-author used every alarm/provider/roster runbook in isolated
      non-production and recorded unclear or incorrect steps as fixed gap issues.
- [ ] Operators rehearsed exact server and worker image rollback, forward-only
      database recovery, safe mobile/store/OTA rollback, and provider/secret
      rotation without a live send.
- [ ] Rollback retains append-only history, old-epoch suppression, real/drill
      truth, and human-only boundaries.
- [ ] District communications explain PSD EOC is notification/documentation,
      not 911; call-911 remains a plain human action and does not imply dispatch.
- Evidence: `[BLOCKED / TO FILL]`

## 9. Accepted gaps

Every gap needs a GitHub issue, consequence statement, compensating control,
owner, deadline, and explicit product-owner acceptance. Binding safety rules
cannot be accepted away.

| Gap issue   | Consequence | Compensating control | Owner/deadline | Product-owner acceptance reference |
| ----------- | ----------- | -------------------- | -------------- | ---------------------------------- |
| `[TO FILL]` | `[TO FILL]` | `[TO FILL]`          | `[TO FILL]`    | `[BLOCKED — NOT ACCEPTED]`         |

- [ ] There are no unrecorded go-live gaps.
- [ ] Every listed gap is eligible for acceptance and has explicit product-
      owner acceptance; no AGENTS.md absolute is weakened.

## 10. Human sign-off

Technical reviewers may attest evidence but cannot approve go-live.

- Operations incident lead review/name/time: `[TO FILL — NOT SIGNED]`
- Application/delivery review/name/time: `[TO FILL — NOT SIGNED]`
- Database/AWS review/name/time: `[TO FILL — NOT SIGNED]`
- Identity/roster review/name/time: `[TO FILL — NOT SIGNED]`
- Security/privacy review/name/time: `[TO FILL — NOT SIGNED]`

### Product-owner decision — human only

- [ ] **I, Kris Hagel, reviewed the exact release evidence and accepted gaps
      above and explicitly authorize production go-live for the stated release and
      time.**

- Decision: **BLOCKED — NOT APPROVED**
- Product-owner signature: `[KRIS HAGEL TO SIGN — EMPTY]`
- Signed at (UTC): `[EMPTY]`
- Approval/change record reference: `[EMPTY]`
- Exact authorized release digests/versions: `[EMPTY]`

No agent or automation may fill, check, infer, or alter this sign-off. If any
artifact, digest, configuration, integration label, accepted gap, or scheduled
time changes after signature, stop and obtain a new product-owner decision.
