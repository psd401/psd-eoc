# SECURITY.md — PSD EOC

School-safety infrastructure. Security posture is deny-by-default, fail-closed,
human-only for critical actions.

## Data classification

| Class | Examples | Handling |
|---|---|---|
| Staff identity | name, email, phone, device tokens | Encrypted at rest; minimized; never in logs/URLs; export controlled |
| Event operational | events, journal entries, photos, locations | Facility-scoped authorization; append-only; retained indefinitely (D-032) |
| Delivery evidence | provider receipts, attempt states | Separate from event narrative; truthful states only |
| Credentials | sessions, refresh tokens, API keys | Hashed/encrypted; device-bound; revocable; short rotation |
| Audit/security | authz failures, admin changes, agent access | Hash-chained; separate from operational journal |
| Student data | — | **Prohibited. Not collected, not stored, not planned.** |

## Hard rules

- Four human-only actions (start real incident, send real notification,
  all-clear, close real event) are enforced server-side; no agent credential
  can satisfy them. AI can never satisfy approval.
- All mutations require idempotency keys; activation endpoints are POST-only,
  CSRF-protected, rate-limited; no state change on GET.
- Live provider sends require: verified credentials + approved targets +
  consequence preview + explicit human confirmation. Otherwise fail closed
  (`LiveActionUnavailableError` pattern).
- Sessions: device-bound, server-revocable, biometric-gated on mobile.
  Google outage degrades to cached sessions/groups — never to open access.
- Media: content-validated, re-encoded, EXIF-stripped, private-bucket only,
  authorized on every read. No public URLs anywhere in the system.
- Secrets in AWS Secrets Manager only. GitHub Actions OIDC deploy; no static
  AWS keys. No secrets in repo, CI logs, or client bundles.
- Provider callbacks are authenticated/verified; replayed or forged callbacks
  must not corrupt delivery state.
- Test/training mode targets synthetic rosters only; production recipient data
  never appears in test paths. A test configuration can never reach real
  recipients.

## Reporting

Security issues: report privately to the district technology department
(product owner: Kris Hagel). Do not open public issues for vulnerabilities.
