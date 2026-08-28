# App Store Connect and TestFlight operations

Current build, submission, store, and device state lives only in the
[operational readiness register](../INTEGRATIONS.md). This runbook defines the
durable private-distribution boundary; it is not deployment evidence and does
not authorize a provider write or notification.

## Configuration and tooling

The configured app name, SKU, bundle ID, and internal group are supplied at
runtime through `ASC_APP_NAME`, `ASC_APP_SKU`, `ASC_BUNDLE_ID`, and
`ASC_INTERNAL_GROUP_NAME`. Credentials use `ASC_KEY_ID`, `ASC_ISSUER_ID`, and
`ASC_KEY_PATH` and remain outside the repository.

`scripts/ops/appstore/asc.ts` is the canonical App Store Connect operator
surface. Without `--apply` it performs authenticated reads and emits a bounded
plan. An apply is add-only and binds the configured bundle ID to the exact
previewed plan digest. Development and CI use mocks and never authenticate to
Apple.

## Internal distribution only

The tool distributes to the internal TestFlight group and nothing else. It
cannot create or populate an external group, and it cannot submit a build for
Beta App Review. Internal distribution needs no Apple review, so a build is
available to internal testers as soon as processing completes.

Every internal tester must already be an eligible App Store Connect user on the
team; Apple caps that group at 100. `--test-info` supplies only the TestFlight
beta description, feedback email, locale, and What to Test text. There is no
demo-account or review-contact input, because nothing is submitted for review.

An external group that already exists in App Store Connect is ignored: the tool
reads it when accounting for app-wide tester capacity and never writes to it.

Apple rejected 1.0.5 (12) for external beta testing under Guideline 2.2,
stating that TestFlight is for beta testing apps intended for public
distribution and that an internal-use app belongs in Apple Business Manager.
Distributing this app to a wider audience is a distribution-model decision, not
a change to this tool.

The presence of `ascAppId` is routing configuration only, never proof of an
uploaded build, tester exposure, device installation, or provider authority.

## Procedure

1. Confirm the exact configured app and current readiness row. Keep tester
   inputs, beta test metadata, credentials, and private keys outside the
   repository.
2. Run a read/preview for the complete intended internal tester cohort and
   immutable build. Stop on unknown app identity, audience, paging, capacity,
   build, group, or localization state.
3. Review the plan's exact actions and digest. An authorized human may apply
   only the reviewed plan after the product owner's current-session approval.
4. Treat artifact upload, provider processing, exact private-group exposure,
   physical installation, in-app launch/readback, push registration, provider
   handoff, and human receipt as eight separate evidence boundaries. A later
   boundary is never inferred from an earlier one.
5. Keep automatic submission, automatic distribution, public-store release,
   and automatic tester notification disabled. Never use a staff roster or any
   student/guardian data as an input.
6. Record bounded provider IDs and aggregate results, then update only the
   readiness row actually proved. A failed or ambiguous write remains
   append-only evidence and is never blindly retried.

Store artifacts use the EAS `production` build profile. iOS uses the
`production` submit profile; submission still does not assign a TestFlight
group. Android uses `internal` for the bounded completed Internal test and
`production` for an `alpha` Closed-test draft. The draft is reviewed and
exposed to a group-based cohort by an authorized human without touching the
public production track. Remote version/build counters are read back after the
provider action rather than computed locally.

The dated app identity, build/upload transcript, exact commands, and provider
readbacks are preserved in the
[historical setup record](../archive/runbooks/appstore-setup-2026-08-25.md).
The current mobile build and rollback procedure is [release.md](release.md).
