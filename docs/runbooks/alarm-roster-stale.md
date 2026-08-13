# Alarm runbook: stale staff roster

**Source-defined CloudWatch alarm names:**

- `psd-eoc-roster-sync-failure-age`; and
- `psd-eoc-roster-sync-success-age`.

**Deployment/read-back truth:** issue #29 source landed in pull request #96,
but no approved deployment, CloudWatch read-back, alarm-action exercise, or
console deep link is recorded. Treat both alarms as **live-unverified** and
their deep links as unavailable until #91 supplies that evidence.

## Meaning

The source defines two staff-only conditions: the latest sync remains failed or
partial-rejected for at least 15 minutes, or no complete sync has been retained
within 25 hours. Both treat missing metric data as breaching. Activation
resolves recipients from an immutable, complete snapshot; it must never make a
live Google call in the critical path.

## Safety posture

- Staff data only. Never import student, guardian, schedule, or location data.
- Never mark a partial or rejected sync complete, edit an old snapshot, or
  paste group membership into a ticket or repository file.
- Existing long-lived sessions are designed to continue through a Google
  outage. Do not force sign-out or make Google a runtime activation dependency.
- If no complete snapshot can be proved for the selected facility/audience,
  activation must fail closed. Do not substitute a directory export.

## Respond

1. Confirm the environment and record the latest complete snapshot timestamp,
   snapshot ID, population (`staff` or `synthetic`), configured sources, and
   latest sanitized sync outcome from the authorized roster-health view.
2. Verify the snapshot is complete, facility-scoped, and tied to the intended
   group-source configuration. Do not inspect or export member-level data.
3. Review roster sync logs by UTC time and bounded reason code. Distinguish
   Google API/authentication failure, invalid/untrusted response, configuration
   issue, and a deliberately rejected partial result.
4. Check Google Workspace status read-only and the local OAuth/Groups
   integration truth in `docs/INTEGRATIONS.md`. A green provider page does not
   prove the delegated configuration or snapshot is current.
5. If a valid last-good complete snapshot exists, document its age and affected
   facilities. Continue serving it only through the canonical application
   behavior; do not copy or modify it. Escalate **SEV-2**, or **SEV-1** when no
   approved audience can be resolved.
6. Continue with [roster-sync.md](roster-sync.md) for source-specific recovery.

## Verify recovery

Confirm a new immutable complete snapshot exists, its capture time and source
configuration are current, previous failed/partial evidence remains retained,
and both source-defined freshness conditions return to normal with current
metric timestamps. Compare only aggregate counts and approved source IDs; no
membership list belongs in the operations record. Never start a real event or
send a notification to test the roster.
