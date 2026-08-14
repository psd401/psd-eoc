# Integration Truth Register

This register describes what PSD EOC can prove about each planned Release 1
external integration today. A `mocked` label claims only a fail-closed
development or CI boundary using synthetic data. It does not claim live
configuration, and a passing mock does not demonstrate provider connectivity
or delivery.

| Integration                                | Planned purpose                                                              | Truth label             | Current boundary                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google OIDC                                | Staff sign-in and identity source                                            | `blocked`               | Source and CDK tests strictly align the retained five-field OAuth contract, fixed production boundaries, and a separate cookie-key secret, but no approved stack deployment or exact runtime readback has connected that contract; no provider call or district sign-in has been performed, and runtime tests use synthetic loopback identities only |
| Google Groups                              | Access gating and versioned staff roster snapshots                           | `mocked`                | Synthetic staff groups only; no delegated account is connected to PSD EOC                                                                                                                                                                                                                                                                            |
| Expo Push                                  | iOS and Android push handoff                                                 | `mocked`                | Client permission, fail-closed registration, rotation, foreground handling, and authenticated tap routing are covered with synthetic mocks; no provider credentials, physical-device receipt, or live handoff are verified                                                                                                                           |
| Amazon SES                                 | Staff email notification handoff                                             | `mocked`                | Synthetic recipients only; no live send is connected                                                                                                                                                                                                                                                                                                 |
| AWS End User Messaging SMS                 | Staff SMS notification handoff                                               | `blocked`               | No live send is connected; `CARRIER_REGISTRATION_PENDING` records the unmet prerequisite, and registration alone cannot establish live readiness                                                                                                                                                                                                     |
| Amazon S3                                  | Private event-media and generated record-export storage and authorized reads | `mocked`                | Synthetic media and record-export object metadata only; no live bucket or presigned operation is connected                                                                                                                                                                                                                                           |
| Amazon GuardDuty Malware Protection for S3 | Scan and tag newly uploaded private media under `quarantine/`                | `configured-unverified` | CDK configures the prefix-scoped plan, tagging, and least-privilege service role; no deployment, active plan status, or controlled scan result has been verified                                                                                                                                                                                     |
| OpenStreetMap raster tiles                 | Optional location-pin map context                                            | `configured-unverified` | Public read-only tile configuration only; no credentials or write path exist, no deployment or live availability is verified, any production use (direct public tiles or self-hosted) requires explicit product-owner approval, and failure leaves canonical location text and posting controls available                                            |

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
