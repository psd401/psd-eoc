# Issue #278 Expo Push activation evidence

Status: **provider and physical-device evidence pending — Expo Push remains
`mocked`**

This append-only record separates source verification from external facts. It
must never contain an access token, device token, credential, raw provider
payload, recipient identity, personal contact data, or student data. Reference
access-controlled artifacts by bounded immutable ID; append a correction rather
than rewriting an earlier observation.

## Provider-free implementation proof

| Boundary | Retained proof |
| --- | --- |
| Isolated Firebase configuration | `infra/gcp/firebase` has its own project inputs, backend prefix, provider lock, API allowlist, exact Android app, and focused policy tests; it cannot bind the Google Groups project/state/IAM boundary. |
| Exact-build registration | Development/preview builds force registration off. Production still requires an exact protected server allowlist match for platform, application ID/version/build, EAS project, provider, and embedded-only update mode. |
| Durable worker lifecycle | Provider I/O claims, Expo ticket outcome, receipt polling, endpoint invalidation, retries, opaque SQS replay references, and a count-only stuck-outbox sample are covered by contract, worker, server, and PostgreSQL tests without provider access. |
| Dark deployment | The ECS worker desired count is controlled by the protected `EnableExpoPushWorker` deployment parameter and defaults to zero. If enabled, startup separately refuses a missing credential-evidence reference or structured secret whose status is not exactly `verified`; this runtime refusal is not a pre-start desired-count gate. |
| Synthetic presentation/tap route | Source defines provider-free iOS and Android `mobile-push-deep-link` flows with registration disabled and unmistakable `[DRILL]` copy. Deterministic tests execute foreground, background, killed-launch, locked-session, replay-fencing, registration-revocation, and classification-confusion behavior. An iOS simulator smoke passed locally; retained two-platform CI screenshots remain pending. |

Provider-free verification on 2026-08-26 UTC: `bun run
test:e2e:issue-278` passed 202 worker, PostgreSQL, mobile-lifecycle, policy, and
route assertions plus one mocked-provider Terraform plan. This is source and
synthetic proof only; final CI and both native platform artifacts remain
pending.

## External prerequisites

- [ ] The isolated Firebase project and exact Android app have been applied and
      read back from their separate Terraform state.
- [ ] APNs and FCM credentials are active in EAS for the exact private builds.
- [ ] The structured Expo server secret contains a reviewed access token and
      exact `verified` status; only the push worker can read it.
- [ ] Exact iOS and Android build identities are present in the protected
      server allowlist and retained without credentials or device identifiers.
- [ ] The worker, conditional metrics, and alarms are deployed dark; retained
      queue/attempt identities are reconciled before enablement.
- [ ] The product owner has explicitly authorized each bounded drill and an
      authenticated human will initiate it in the running app.
- [ ] The protected delivery-test console has one current approved
      `controlled-push-canary` endpoint for the platform being exercised.

Credential verification reference: _pending_

Worker image/deployment reference: _pending_

Exact iOS build reference: _pending_

Exact Android build reference: _pending_

## iOS physical drill

Platform/OS family and approved build reference, without device identity:
_pending_

Authenticated human activation/audit reference: _pending_

| Evidence boundary | UTC observation and retained token-free reference |
| --- | --- |
| 1. Expo ticket acceptance | _pending_ |
| 2. Final Expo receipt outcome | _pending_ |
| 3. Device presentation with unmistakable `[DRILL]` copy | _pending_ |
| 4. App tap routed to the exact drill event | _pending_ |
| 5. Human observation of presentation and route | _pending_ |

Alert channel/permission observation: _pending_

Redacted artifact references: _pending_

## Android physical drill

Platform/OS family and approved build reference, without device identity:
_pending_

Authenticated human activation/audit reference: _pending_

| Evidence boundary | UTC observation and retained token-free reference |
| --- | --- |
| 1. Expo ticket acceptance | _pending_ |
| 2. Final Expo receipt outcome | _pending_ |
| 3. Device presentation with unmistakable `[DRILL]` copy | _pending_ |
| 4. App tap routed to the exact drill event | _pending_ |
| 5. Human observation of presentation and route | _pending_ |

Configured Android alert-channel observation: _pending_

Redacted artifact references: _pending_

## Readiness decision

The readiness register may advance only to the narrowest boundary proved by
the completed rows above. Expo ticket acceptance is provider handoff, not final
receipt; an Expo receipt is not operating-system presentation; presentation is
not an app tap; and none of them alone proves human observation. Until both
physical tables and prerequisites are complete, no physical-device delivery is
claimed and no automated send is permitted.
