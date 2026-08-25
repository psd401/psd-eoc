# Go-live procedure

Current deployment and provider state lives only in the
[operational readiness register](../INTEGRATIONS.md). This procedure defines
what to verify for a proposed release; it does not carry a standing go-live
decision and does not authorize any of the four human-only actions.

## Prepare the release record

Record the exact server and worker image digests, source commit, migration
version, infrastructure change, mobile versions/builds, proposed time, and an
access-controlled evidence location. Do not copy secrets, recipients, staff
contact details, or provider payloads.

## Verify the release

1. Run `bun run check` on the exact commit and require green CI.
2. Confirm the deployed configuration names match
   [CONFIGURATION.md](../CONFIGURATION.md) and the protected GitHub environment.
3. Verify human-only enforcement, real/drill distinction, deny-by-default
   authorization, append-only records, and honest delivery states.
4. Read back the exact application digest, health, database protections,
   active queues/workers, alarm actions, and runbook links for this release.
5. Verify OIDC, staff-only group freshness, facility scope, and first-admin
   access without exporting a roster.
6. For each enabled notification channel, require the readiness register to
   show evidence sufficient for the intended use. A channel that is not ready
   stays dark and receives no routable work.
7. Verify backup/restoration evidence, failure drills, rollback points, and
   operator contacts applicable to this release.
8. Verify the exact privately distributed mobile builds and install guidance
   if mobile is in scope.
9. Record every accepted gap, consequence, compensating control, owner, and
   deadline. Repository safety rules are not waivable gaps.

Production changes occur through the GitHub Actions deploy workflow described
in [CONFIGURATION.md](../CONFIGURATION.md). A deploy does not start an incident
or send a notification. Any later real incident, real notification, all-clear,
or event closure still requires an authenticated human acting in the app.

The superseded launch checklist and its unfilled evidence fields are preserved
in the [historical archive](../archive/runbooks/go-live-2026-08-25.md).
