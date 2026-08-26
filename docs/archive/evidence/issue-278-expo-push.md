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

## Superseding provider-free and dark-deployment readback — 2026-08-26 UTC

The earlier provider-free section's statement that final CI and two-platform
native artifacts were pending is superseded by completed workflow run
`32940527287` at commit `56cd9fd010b202d17349519b0b1b93b9fcd50c15`:

- the authoritative repository gate and issue #278 provider-free lifecycle
  verification passed;
- the synthetic iOS drill lifecycle passed and retained artifact
  `mobile-e2e-ios-32940527287-1` (`9596988305`); and
- the synthetic Android drill lifecycle passed and retained artifact
  `mobile-e2e-android-32940527287-1` (`9597111031`).

Production deployment run `32975859074` completed from commit
`22592929ceb6044c70a5904f06ba28f8ad2a7d2c`. It created the conditional Expo
worker, queue/DLQ, protected secret boundaries, and alarms in dark mode with
the worker disabled. This remains deployment-topology proof only. It does not
prove a credentialed provider handoff, a physical-device presentation or tap,
or human receipt, and it does not authorize an automated notification.

## Superseding isolated-provider credential readback — 2026-08-26 UTC

At `2026-08-26T20:54:03Z`, the dedicated Firebase project
`eoc-push-prod-c5c14b` and its exact `net.psd401.eoc` Android app were present
in the independent `terraform/gcp/firebase-isolated` state. The final OpenTofu
readback reported no changes. That root enables only its fixed Firebase/FCM,
project-management, billing, service-usage, and IAM API allowlist; it still
declares no Google Groups access, IAM bindings, service accounts, datastore,
hosting, or storage resources.

The protected provider configuration was then retained outside the repository:

- EAS production environment variable `GOOGLE_SERVICES_JSON` has immutable
  variable ID `8226eb0b-04fb-4a10-9bee-ebeeaab4be36`, type `file`, and
  visibility `SECRET`. Its contents were not read back or retained here.
- EAS FCM V1 for `net.psd401.eoc` is assigned to the dedicated
  `expo-push-delivery@eoc-push-prod-c5c14b.iam.gserviceaccount.com` identity.
  Google IAM readback showed only
  `roles/firebasecloudmessaging.admin` for that identity; the unrelated Play
  submission credential was left unchanged.
- Apple APNs key `P7TQSB2728` is production-only and topic-restricted to
  `net.psd401.eoc`. EAS assigned that key to the same bundle identifier. No
  other Apple service or application topic was enabled.

Credential verification reference:
`issue-278-provider-credentials-2026-08-26T205403Z`. This proves isolated
project provisioning and token-free EAS credential assignment only. It does
not prove an exact native build, Expo ticket, final receipt, device
presentation, app tap, or human observation, and it authorizes no automated
notification.

## Direct-CDK dark runtime readback — 2026-08-26 UTC

At `2026-08-26T23:02:27Z`, the protected production stack `PsdEoc` reached
`UPDATE_COMPLETE` after one locally authenticated direct CDK command built and
published the application asset, ran the native bootstrap, and completed the
App Runner cutover. CloudFormation reported deployed source
`a9ca6b8a75ef750db532696da12e46821a0983ad`; the application and bootstrap
outputs both resolved to immutable digest
`sha256:07118c896134fca7cf568313d2d4af4ccc59253fc1a16060ccfd81017882369c`.
No GitHub environment, OIDC role, repository secret, or deployment workflow
participated.

The post-deployment push boundary remained dark and quiescent:

- `EnableExpoPushWorker=false` and
  `ExpoCredentialVerificationReference=UNVERIFIED`;
- ECS service `psd-eoc-expo-push-worker` was active at desired/running/pending
  `0/0/0` on task definition revision 5;
- both `psd-eoc-push` and `psd-eoc-push-dlq` reported zero visible, in-flight,
  and delayed messages; and
- the protected Expo secret had only the exact `accessToken` and `status` keys,
  with `status=UNCONFIGURED`. No token value was read or retained.

Evidence reference: `issue-278-direct-cdk-dark-runtime-2026-08-26T230227Z`.
This proves the direct-CDK deployment path, bootstrap, immutable runtime
identity, deployed dark worker topology, and post-deployment quiescence only.
It does not prove a credentialed Expo handoff, ticket, receipt, device
presentation, app tap, physical installation, or human observation, and it
authorizes no automated notification.

## Exact native builds and private distribution — 2026-08-26 UTC

EAS built both embedded-only 1.0.5 production artifacts from commit
`99e478361c01c8072104c64fcd5e3ca34d008e76`:

- iOS build 12 is EAS build `ca6b4b4d-5ccd-4414-a7ec-bea95ee52191`,
  artifact
  `https://expo.dev/artifacts/eas/o_L5fGxzFby6kLBLLiO7olJBnHROFdI5SEWeZDpN5t4.ipa`,
  and SHA-256
  `9c414f3384aa8e04b9dc716233fa92482f39273b0c6282e86d7c507d71115814`.
  Exact submission `73c0a30d-23eb-46c7-bc8f-f62ea2b178cb` completed Apple
  upload and processing. App Store Connect build
  `43a11cd2-64de-443d-b439-eb8b32685f51` is assigned to the existing
  `PSD EOC Testers` external group with automatic notifications disabled and
  is waiting for beta review. The superseded build 11 was removed from review
  before build 12 was submitted.
- Android code 6 is EAS build `1556fd0a-f1da-4fcf-8565-caedfc4fe772`,
  artifact
  `https://expo.dev/artifacts/eas/8TFcecmf94GN20w6tks4luyV7OmQGt31pH670kqVjKM.aab`,
  and SHA-256
  `f8d5f987d2637e507dbd1d559159833723d201f854b06b9fbbb4a7f310fad2f0`.
  Exact submission `fb278800-12bb-4807-9421-2d4595d9b695` completed and Play
  release 4 shows code 6 active for the existing `PSD EOC initial pilot`
  Internal testers. EAS submission `dc0a9d0d-6c98-4c03-956c-09119dcdb77f`
  could not upload the same code a second time; Play's artifact library was
  therefore used to save that exact code 6 in Alpha draft release 1 with the
  same tester list and United States targeting. The Alpha draft was not rolled
  out or sent for review.

At `2026-08-26T21:37:50Z`, production stack `PsdEoc` was
`UPDATE_COMPLETE`, `EnableExpoPushWorker` remained `false`, and both
`psd-eoc-push` and `psd-eoc-push-dlq` reported zero visible, in-flight, and
delayed messages. Protected allowlist version
`765d13e0-f6ae-4c44-8e24-6df6b61d4de6` read back only exact iOS build 12 and
Android code 6 tuples. The Expo server secret still reported status
`UNCONFIGURED`; no token value was read or retained.

Evidence reference: `issue-278-exact-builds-2026-08-26T213750Z`. This proves
signed exact builds, private-store placement, exact registration
authorization, and a quiescent dark worker boundary only. It does not prove an
Expo ticket, receipt, operating-system presentation, app tap, physical
installation, or human observation, and it authorizes no automated
notification.
