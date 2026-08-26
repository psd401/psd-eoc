# Operational readiness register

<!-- psd-eoc:readiness-register -->

This is the repository's only current source for deployment, DNS, identity,
monitoring, provider, and mobile-distribution readiness. Durable runbooks link
here instead of copying time-sensitive claims. Update a row only from dated,
retained evidence; do not infer live state from source code or synthesis.

Allowed labels:

- `mocked`: synthetic, fail-closed behavior only;
- `configured-unverified`: configuration or a partial provider boundary is
  proved, but the complete path is not;
- `live-verified`: the stated boundary was observed live on the evidence date;
- `blocked`: a required boundary is unavailable or deliberately disabled.

Last consolidated from retained evidence: **2026-08-26**.

| Boundary                             | Status                  | Current evidence boundary                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web application, Aurora, and DNS/TLS | `live-verified`         | On 2026-08-21 the App Runner service reported `RUNNING`; the public custom domain served the application and `/api/health`; the service used private Aurora through its VPC connector. This does not prove notification delivery.                                                                            |
| CloudWatch monitoring                | `configured-unverified` | On 2026-08-21, 13 infrastructure alarms and their actions were read back. Publisher-dependent activation, roster, provider-latency, metrics-collector, and canary alarms remain source-defined only.                                                                                                         |
| Google OIDC                          | `configured-unverified` | The live sign-in route redirected to Google with the registered callback on 2026-08-21. A completed district sign-in/session result is not retained.                                                                                                                                                         |
| Google Groups access membership      | `live-verified`         | The deployed scheduled job read the provider and published a complete fresh access snapshot on 2026-08-21/22 using aggregate, staff-only evidence.                                                                                                                                                           |
| EAS Build                            | `configured-unverified` | Signed app/runtime 1.0.4 artifacts were produced for iOS build 10 and Android version code 4. Source is now embedded-only 1.0.5 for the public privacy link, and no 1.0.5 store build is yet retained.                                                                                                       |
| EAS Update                           | `blocked`               | Remote updates are disabled for the current embedded-only runtime.                                                                                                                                                                                                                                           |
| EAS Submit                           | `live-verified`         | On 2026-08-25 App Store Connect showed 1.0.4/build 10 processed and Testing; Google Play showed 1.0.4/code 4 active on Internal testing. This does not submit or expose 1.0.5.                                                                                                                               |
| TestFlight device installation       | `live-verified`         | On 2026-08-25 App Store Connect showed 1.0.4/build 10 in the approved external group with aggregate counts of one invitation and one installation. An exact physical-device launch/readback is not retained.                                                                                                 |
| Google Play device installation      | `configured-unverified` | On 2026-08-25 Play showed 1.0.4/code 4 active on Internal testing with a one-user aggregate tester list and opt-in link. No exact-build installation/launch is retained, and a durable group-based Closed test is not yet active.                                                                            |
| Public mobile privacy policy         | `configured-unverified` | Source defines a public `/privacy` route, configured contact channel, truthful staff-data disclosure, and the mobile app's exact-origin link. Production deployment and store-record readback are not yet retained.                                                                                          |
| Play app content and store record    | `blocked`               | On 2026-08-25 Play showed 0/11 setup tasks complete. Privacy URL, sign-in instructions, ads declaration, content rating, target audience, Data Safety, government/financial/health declarations, category/contact details, listing assets, tester group, and Closed rollout still require provider readback. |
| Expo Push notification handoff       | `mocked`                | Client registration/receipt behavior and worker boundaries use synthetic mocks. No credentialed provider handoff or physical-device notification receipt is retained.                                                                                                                                        |
| Amazon SES notification handoff      | `configured-unverified` | Production access and the domain identity were read on 2026-08-16. The configuration set remains sending-disabled and no executable sender, recipient, controlled provider send, delivery, or human receipt is proved.                                                                                       |
| AWS End User Messaging SMS           | `blocked`               | No approved origination identity or connected live send exists. Registration alone cannot establish readiness.                                                                                                                                                                                               |
| Event media and record exports       | `mocked`                | Synthetic object metadata and authorization behavior are covered; no live storage operation is claimed.                                                                                                                                                                                                      |
| GuardDuty Malware Protection for S3  | `configured-unverified` | CDK defines the scoped plan and fail-closed tag boundary; no active-plan readback or controlled scan is retained.                                                                                                                                                                                            |
| OpenStreetMap raster tiles           | `configured-unverified` | The optional read-only configuration is source-defined; no live availability claim is retained.                                                                                                                                                                                                              |

The pre-consolidation register and its detailed dated observations are
preserved in the [historical readiness snapshot](archive/evidence/readiness-register-2026-08-25.md).
The append-only deployment ledger is
[live-pilot.md](archive/evidence/live-pilot.md). These are evidence, not current
instructions.

Advancing a provider row requires evidence for exactly the claimed boundary.
Provider acceptance is not delivery or human receipt. A live notification test
also requires verified credentials, an approved synthetic target, and an
authenticated human acting in the application; automation cannot send it.
