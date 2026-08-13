# Alarm runbook: stale staff roster

**Alarm ID / dashboard deep link: BLOCKED BY #29.** The roster-sync failure-age
alarm is not deployed.

## Meaning

The planned alarm reports that a complete Google Groups staff roster snapshot
has not been captured within the final #29 freshness threshold, or recent sync
attempts are failing. Activation resolves recipients from an immutable,
complete snapshot; it must never make a live Google call in the critical path.

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
and the stale report returns to the final #29 normal state. Compare only
aggregate counts and approved source IDs; no membership list belongs in the
operations record. Never start a real event or send a notification to test the
roster.
