# Mobile release and rollback

Current store, build, and device state lives only in the
[operational readiness register](../INTEGRATIONS.md). This runbook defines the
durable private-distribution procedure; it does not authorize a public release,
provider mutation, production deploy, or real notification.

## Prepare

1. Record the source commit, application version, native build number, runtime
   version, EAS project/profile, target store record/track, and rollback build.
2. Run `bun run check` and the applicable native configuration and mobile E2E
   checks on the exact commit.
3. Confirm tenant identity comes from mobile build configuration and matches
   the intended protected environment.
4. Keep credentials in the provider or approved secret store. Never put them
   in source, logs, screenshots, shell history, or an evidence attachment.
5. Review the exact build, target private cohort, provider changes, expected
   consequences, stop conditions, and rollback before an authorized human
   performs a provider write.

## Build and private distribution

- Generate native projects from the checked-in Expo configuration; do not edit
  generated `ios/` or `android/` projects as the source of truth.
- Build both store artifacts with the EAS `production` build profile. Read the
  remote iOS build number and Android version code after each build; never
  predict either counter from local state.
- Retain each immutable artifact's source commit, EAS ID, app/runtime version,
  native build number, provider ID, and digest without tester identities.
- Submit iOS with the EAS `production` submit profile. Upload and provider
  processing do not expose the build; after processing, an authorized human
  assigns that exact build to the approved private TestFlight group.
- Submit Android to the bounded Internal test with the EAS `internal` submit
  profile. Stage the durable Closed test with the EAS `production` submit
  profile, whose `alpha` track and `draft` status prevent automatic exposure.
  An authorized human verifies the exact draft, group-based tester cohort, and
  non-public release controls before starting the closed rollout.
- Keep public App Store and Play production release controls untouched.
- Never use `--latest`, `--auto-submit`, automatic tester notification, or a
  mutable channel to select or expose a build.

Record these as eight separate evidence boundaries. Evidence for one never
proves a later boundary:

1. artifact upload accepted;
2. provider processing completed;
3. exact private-group or test-track exposure completed;
4. exact build installed on a physical device;
5. that installed build launched and its Release diagnostics matched;
6. push registration completed, if separately authorized;
7. a notification provider accepted a separately authorized synthetic handoff;
8. a human confirmed receipt.

## Verify

On a physical device, record platform/OS, installation time, authentication
result, real/drill presentation, permission behavior, and bounded screenshots
without identities or notification tokens. After sign-in, open **Release
diagnostics** and require **Identity available**, the announced app version and
native build version, **Disabled — embedded store bundle only**, and
**Embedded in this installed binary**. Compare this in-app identity with the
provider record; a provider version alone is not launch evidence. Update only
the corresponding readiness row for the boundary actually observed.

The current app/runtime is 1.0.5. Remote updates are disabled, so every code or
asset change requires another app-version bump and fresh store builds. The
EAS `production` profile is the exact current store-build path; `production`
is the iOS submit profile, `internal` is the bounded Android Internal-test
submit profile, and `production` is the Android Closed-test draft profile.

## Roll back

Stop additional exposure and preserve provider and device evidence. Current
mobile runtimes are embedded-only: do not publish, republish, or route an OTA
rollback. Fix forward with a new app version and reviewed store build through
the same private channel. Database history and server contracts move forward;
never run a down migration or use a mobile rollback to reinterpret append-only
event/delivery state. Revoke a credential only after all intended consumers
have moved or immediately if compromise requires it.

The prior release ledger and one-off provider evidence fields are preserved in
the [historical archive](../archive/runbooks/release-2026-08-25.md).
