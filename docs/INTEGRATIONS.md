# Integration Truth Register

This register describes what PSD EOC can prove about each planned Release 1
external integration today. A `mocked` label claims only a fail-closed
development or CI boundary using synthetic data. It does not claim live
configuration, and a passing mock does not demonstrate provider connectivity
or delivery.

| Integration                                | Planned purpose                                                              | Truth label             | Current boundary                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google OIDC                                | Staff sign-in and identity source                                            | `mocked`                | Synthetic identities only; no live OAuth client is configured in PSD EOC                                                                                                                                                                                                                                                  |
| Google Groups                              | Access gating and versioned staff roster snapshots                           | `mocked`                | Synthetic staff groups only; no delegated account is connected to PSD EOC                                                                                                                                                                                                                                                 |
| Expo Application Services (Build / Update) | Store-signed mobile builds and compatible JS-only OTA updates                | `configured-unverified` | Repository configuration pins the PSD EOC project, production-environment OTA verification, separate preview/production update channels, compatible runtimes, remote build-number automation, and human-only write gates; no authenticated build, OTA publication, rollback, or installed-device result has been verified |
| Expo Application Services (Submit)         | Exact-build upload to Apple and Google provider records                      | `blocked`               | Android is constrained to an unreleased Play `alpha` draft; iOS non-interactive submission is deliberately blocked by an empty profile until a human-created App Store record is verified and its non-secret `ascAppId` is reviewed into configuration; no provider upload has been verified                              |
| Apple App Store Connect / TestFlight       | Private iOS distribution to approved staff testers                           | `blocked`               | Guarded setup automation exists, but no App Store Connect app record, API credential, processed PSD EOC build, internal-group assignment, invitation, or physical-device installation is verified; E4 human steps and an exact product-owner-authorized synthetic audience remain required                                |
| Google Play closed testing                 | Private Android distribution to the approved staff tester group              | `blocked`               | The submission profile targets an unreleased `alpha` draft, but Play organization verification, app record, first manual AAB, tester group, release credential, reviewed publication, and physical-device installation remain unverified under E3                                                                         |
| Firebase App Distribution                  | Interim private Android distribution while Play setup is incomplete          | `blocked`               | No isolated Firebase project, approved tester group, distribution credential, artifact release, invitation, or physical-device installation is configured or verified; E6 remains blocked and this interim path must never be represented as the durable Play closed-test path                                            |
| Expo Push                                  | iOS and Android push handoff                                                 | `mocked`                | Client permission, fail-closed registration, rotation, foreground handling, and authenticated tap routing are covered with synthetic mocks; no provider credentials, physical-device receipt, or live handoff are verified                                                                                                  |
| Amazon SES                                 | Staff email notification handoff                                             | `mocked`                | Synthetic recipients only; no live send is connected                                                                                                                                                                                                                                                                      |
| AWS End User Messaging SMS                 | Staff SMS notification handoff                                               | `blocked`               | No live send is connected; `CARRIER_REGISTRATION_PENDING` records the unmet prerequisite, and registration alone cannot establish live readiness                                                                                                                                                                          |
| Amazon S3                                  | Private event-media and generated record-export storage and authorized reads | `mocked`                | Synthetic media and record-export object metadata only; no live bucket or presigned operation is connected                                                                                                                                                                                                                |
| Amazon GuardDuty Malware Protection for S3 | Scan and tag newly uploaded private media under `quarantine/`                | `configured-unverified` | CDK configures the prefix-scoped plan, tagging, and least-privilege service role; no deployment, active plan status, or controlled scan result has been verified                                                                                                                                                          |
| OpenStreetMap raster tiles                 | Optional location-pin map context                                            | `configured-unverified` | Public read-only tile configuration only; no credentials or write path exist, no deployment or live availability is verified, any production use (direct public tiles or self-hosted) requires explicit product-owner approval, and failure leaves canonical location text and posting controls available                 |

The allowed truth labels are `mocked`, `configured-unverified`,
`live-verified`, and `blocked`. Advancing an entry requires evidence for the
new label. A production provider configuration or live write also requires the
product owner's explicit approval. Live notification tests additionally require
verified credentials, an approved synthetic target list, a consequence
preview, and confirmation by an authenticated human in the app. Credentials,
tokens, real recipient data, and provider payloads never belong in this file.

`configured-unverified` for GuardDuty means only that the deployable
CloudFormation configuration is complete enough for review and synthesis. It
does not establish that the plan exists, is active, can read the KMS-encrypted
quarantine object, or can write `GuardDutyMalwareScanStatus`. Application code
must treat a missing tag and every result other than `NO_THREATS_FOUND` as a
closed gate. The App Runner role can read that quarantine tag but has no S3
tag-write permission. Bucket policy reserves quarantine tag mutations to
sessions issued from the dedicated GuardDuty scanner role, matching the stable
IAM role ARN through `aws:PrincipalArn`, and denies non-scanner reads of any
current object without the exact clean tag. It does not depend on an
AWS-controlled role-session name, so another broad same-account role cannot
manufacture or bypass a clean verdict.
