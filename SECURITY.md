# SECURITY.md — PSD EOC

School-safety infrastructure. Security posture is deny-by-default, fail-closed,
human-only for critical actions.

## Data classification

| Class             | Examples                                    | Handling                                                                  |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| Staff identity    | name, email, phone, device tokens           | Encrypted at rest; minimized; never in logs/URLs; export controlled       |
| Event operational | events, journal entries, photos, locations  | Facility-scoped authorization; append-only; retained indefinitely (D-032) |
| Delivery evidence | provider receipts, attempt states           | Separate from event narrative; truthful states only                       |
| Credentials       | sessions, refresh tokens, API keys          | Hashed/encrypted; device-bound; revocable; short rotation                 |
| Audit/security    | authz failures, admin changes, agent access | Hash-chained; separate from operational journal                           |
| Student data      | —                                           | **Prohibited. Not collected, not stored, not planned.**                   |

## Hard rules

- The four human-only actions—start a real incident, send a real notification,
  issue an all-clear on a real event, and close a real event—are registered in
  `packages/contracts/src/human-only.ts` and enforced server-side. No agent
  credential or agent-surface manifest may expose or satisfy a registered
  action ID; AI can never supply approval or confirmation.
- All mutations require idempotency keys; activation endpoints are POST-only,
  CSRF-protected, rate-limited; no state change on GET.
- Live provider sends require: verified credentials + approved targets +
  consequence preview + explicit human confirmation. Otherwise fail closed
  (`LiveActionUnavailableError` pattern).
- Sessions: device-bound, server-revocable, biometric-gated on mobile.
  Google outage degrades to cached sessions/groups — never to open access.
- Media: content-validated, re-encoded, EXIF-stripped, private-bucket only,
  authorized on every read. No public URLs anywhere in the system.
- Secrets in AWS Secrets Manager only. Deploy only with direct `cdk deploy`
  from a locally authenticated, short-lived AWS session. GitHub has no
  deployment authority. No secrets in the repo, CI logs, or client bundles.
- Provider callbacks are authenticated/verified; replayed or forged callbacks
  must not corrupt delivery state.
- Test/training mode targets synthetic rosters only; production recipient data
  never appears in test paths. A test configuration can never reach real
  recipients.

## Reporting

Security issues: report privately to the district technology department
(product owner: Kris Hagel). Do not open public issues for vulnerabilities.
