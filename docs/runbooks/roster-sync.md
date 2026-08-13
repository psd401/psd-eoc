# Operations runbook: Google Groups roster sync

Use this runbook when Google Groups reads fail, a sync is rejected/partial, the
staff roster is stale, or a facility audience is incomplete.

**Current truth:** Google Groups is `mocked` in `docs/INTEGRATIONS.md`. No live
delegated account or scheduled production sync is verified. Source responses
are untrusted and snapshots are staff-only.

## Safety posture

- Never include students, guardians, schedules, or locations.
- Never paste, export, or attach a member roster to diagnose the sync.
- Never mark a partial/rejected result complete, mutate an earlier snapshot,
  or manually insert recipients/endpoints.
- A Google outage must not invalidate already authorized long-lived sessions
  or become a live dependency of activation.
- Activation may use only a canonical immutable complete last-good snapshot.
  No complete snapshot means fail closed for that audience.

## Diagnose

1. Record environment, UTC interval, latest complete snapshot ID/time,
   population, configured source IDs, facility scope, aggregate recipient
   count, and latest sanitized sync outcome.
2. In the authorized admin/roster-health view, verify that source configuration
   and facility mappings are current. Do not change them during diagnosis.
3. In the roster sync logs, count bounded group failure/reason codes. Separate:
   authentication/authorization, quota/transient provider failure, invalid
   response shape, duplicate/ambiguous identity, source configuration, and
   an intentionally rejected partial sync.
4. Check Google Workspace/Admin SDK status read-only. Verify the intended
   staff-only delegated configuration is the one referenced by the runtime;
   never print the key or subject identity into the operations record.
5. Confirm the last complete snapshot remains immutable and reconstructable.
   Record its age and affected facilities. A failed newer attempt must not
   replace it.
6. For OAuth client failure affecting interactive sign-in, use
   [rotation-google-oauth.md](rotation-google-oauth.md). The Groups-reader
   service credential has separately guarded provisioning/revocation scripts
   under `infra/gcp`; this runbook does not authorize running them.

## Recover

- Repair the proven source configuration or credential through a reviewed
  change with explicit product-owner approval where live Google configuration
  is affected.
- Let the canonical scheduled sync create a new versioned snapshot. A verified
  production manual trigger is not documented or deployed, so manual sync is
  **BLOCKED** until a reviewed operator surface exists. Do not call internal
  functions or write the database directly.
- Treat each Google response as untrusted. All sources must validate and the
  result must be complete before promotion.
- If Google remains unavailable, document continued use of the last complete
  snapshot. Do not force active users through fresh Google sign-in. Escalate
  **SEV-1** when no complete snapshot can resolve an approved audience.

## Verify

Confirm the new snapshot is immutable and complete, has the intended staff
population/facility/source configuration, preserves failed-attempt evidence,
and causes the stale report/alarm to return to normal. Compare aggregate counts
with an authorized human review in the controlled system; no member list or
contact destination belongs in GitHub evidence. Do not start an event or send
a notification to validate a roster.
