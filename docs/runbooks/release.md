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
- Build one immutable artifact per platform and retain its provider ID and
  digest without tester identities.
- Submit only to the intended private TestFlight or Play testing surface.
- Keep public App Store and Play production release controls untouched.
- Treat provider upload acceptance, processing, tester exposure, installation,
  notification receipt, and human verification as separate evidence.

## Verify

On a physical device, record platform/OS, exact installed version/build,
installation time, authentication result, real/drill presentation, permission
behavior, and bounded screenshots without identities or notification tokens.
Update only the corresponding row in the readiness register with evidence for
the boundary actually observed.

## Roll back

Stop additional exposure, preserve provider and device evidence, and restore a
previously verified immutable build through the same private channel. Database
history and server contracts move forward; never run a down migration or use a
mobile rollback to reinterpret append-only event/delivery state. Revoke a
credential only after all intended consumers have moved or immediately if
compromise requires it.

The prior release ledger and one-off provider evidence fields are preserved in
the [historical archive](../archive/runbooks/release-2026-08-25.md).
