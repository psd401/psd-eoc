# Issue 43: direct APNs/FCM evidence record

This append-only record separates provider-free implementation evidence from
external provider and human observations. It contains no credentials, tokens,
recipients, notification content, tenant identity, or raw provider payloads.

## Automated boundary

- Canonical Expo/APNs/FCM registration, environment, replacement lineage,
  token-free receipt, and per-platform cutover contracts: implemented and
  covered by focused tests.
- Dual Expo/native mobile registration behind build opt-in, authentication,
  permission, enrollment, and protected server allowlist: implemented and
  covered by provider-free tests.
- APNs HTTP/2/ES256 and FCM HTTP v1/OAuth construction, bounded credential
  refresh, expiration, safe response classification, and ambiguous-outcome
  handling: implemented and covered by provider-free contract tests.
- Durable claim, eligibility, attempted/final evidence, provider-scoped
  invalidation (including Apple's authoritative unregistration time), no-replay
  unknown handling, routing, and rollback selection: implemented and covered
  by synthetic and PostgreSQL tests.
- Comparison evidence requires separate baseline/candidate cohorts, logical
  notifications, attempts, and endpoint-reference digests; snapshot publication
  fails closed when a direct cutover lacks paired endpoint coverage.
- Protected dark configuration and least-privilege secret access: synthesized
  and asserted without cloud or provider I/O.

These statements prove code behavior only. They do not advance the APNs, FCM,
or Expo rows in the readiness register beyond `mocked`.

## External and manual boundaries

| Boundary | Status | Required retained evidence |
| --- | --- | --- |
| Live Expo baseline from issue 278 | `PENDING` | Credentialed Expo handoff and physical-device boundary required by the dependency issue |
| APNs server credential provision and rotation | `PENDING` | Protected secret version/status and token-free rotation result |
| FCM server credential provision and rotation | `PENDING` | Protected secret version/status and token-free rotation result |
| APNs isolated comparison cohort | `PENDING` | At least 100 unique classified attempts, handoff p95 at or below five seconds, zero duplicate/unclassified outcomes |
| FCM isolated comparison cohort | `PENDING` | At least 100 unique classified attempts, handoff p95 at or below five seconds, zero duplicate/unclassified outcomes |
| Approved direct APNs physical drill | `PENDING (manual)` | Exact private dual-registration build, intended device presentation, and exact drill event tap |
| Approved direct FCM physical drill | `PENDING (manual)` | Exact private dual-registration build, intended device presentation, and exact drill event tap |
| Both platform cutovers | `PENDING` | Dated protected configuration changes and bounded observations |
| Seven-day Expo fallback window | `PENDING` | Seven calendar days after both cutovers plus three bounded successful synthetic runs per platform with no unexplained unknowns |

Automation must not initiate either physical drill or represent provider
acceptance as delivery. Append future observations with UTC provenance; never
replace a pending row by inference from source or CI.
