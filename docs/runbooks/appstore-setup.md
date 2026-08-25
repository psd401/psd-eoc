# App Store Connect and TestFlight operations

Current build, submission, store, and device state lives only in the
[operational readiness register](../INTEGRATIONS.md). This runbook defines the
durable private-distribution boundary; it is not deployment evidence and does
not authorize a provider write or notification.

## Configuration and tooling

The configured app name, SKU, bundle ID, internal group, and external group are
supplied at runtime through `ASC_APP_NAME`, `ASC_APP_SKU`, `ASC_BUNDLE_ID`,
`ASC_INTERNAL_GROUP_NAME`, and `ASC_EXTERNAL_GROUP_NAME`. Credentials use
`ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_KEY_PATH` and remain outside the
repository.

`scripts/ops/appstore/asc.ts` is the canonical App Store Connect operator
surface. Without `--apply` it performs authenticated reads and emits a bounded
plan. An apply is add-only and binds the configured bundle ID to the exact
previewed plan digest. Development and CI use mocks and never authenticate to
Apple.

The presence of `ascAppId` is routing configuration only, never proof of an
uploaded build, tester exposure, device installation, or provider authority.

## Procedure

1. Confirm the exact configured app and current readiness row. Keep tester
   inputs, review metadata, credentials, and private keys outside the
   repository.
2. Run a read/preview for the complete intended synthetic tester cohorts and
   immutable build. Stop on unknown app identity, audience, paging, capacity,
   build, group, or localization state.
3. Review the plan's exact actions and digest. An authorized human may apply
   only the reviewed plan after the product owner's current-session approval.
4. Treat build upload, processing, group attachment, tester invitation,
   installation, sign-in, push registration, notification delivery, and human
   receipt as separate evidence boundaries.
5. Keep automatic submission, automatic distribution, public-store release,
   and automatic tester notification disabled. Never use a staff roster or any
   student/guardian data as an input.
6. Record bounded provider IDs and aggregate results, then update only the
   readiness row actually proved. A failed or ambiguous write remains
   append-only evidence and is never blindly retried.

The dated app identity, build/upload transcript, exact commands, and provider
readbacks are preserved in the
[historical setup record](../archive/runbooks/appstore-setup-2026-08-25.md).
The current mobile build and rollback procedure is [release.md](release.md).
