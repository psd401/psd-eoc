# Integration Truth Register

This register describes what PSD EOC can prove about each planned Release 1
external integration today. A `mocked` label claims only a fail-closed
development or CI boundary using synthetic data. It does not claim live
configuration, and a passing mock does not demonstrate provider connectivity
or delivery.

| Integration | Planned purpose | Truth label | Current boundary |
|---|---|---|---|
| Google OIDC | Staff sign-in and identity source | `mocked` | Synthetic identities only; no live OAuth client is configured in PSD EOC |
| Google Groups | Access gating and versioned staff roster snapshots | `mocked` | Synthetic staff groups only; no delegated account is connected to PSD EOC |
| Expo Push | iOS and Android push handoff | `mocked` | Synthetic device targets only; no provider credentials or live handoff are connected |
| Amazon SES | Staff email notification handoff | `mocked` | Synthetic recipients only; no live send is connected |
| AWS End User Messaging SMS | Staff SMS notification handoff | `mocked` | Synthetic recipients only; no live send is connected, and carrier registration alone cannot establish live readiness |
| Amazon S3 | Private event-media storage and authorized reads | `mocked` | Synthetic object metadata only; no live bucket or presigned operation is connected |

The allowed truth labels are `mocked`, `configured-unverified`,
`live-verified`, and `blocked`. Advancing an entry requires evidence for the
new label. A production provider configuration or live write also requires the
product owner's explicit approval. Live notification tests additionally require
verified credentials, an approved synthetic target list, a consequence
preview, and confirmation by an authenticated human in the app. Credentials,
tokens, real recipient data, and provider payloads never belong in this file.
