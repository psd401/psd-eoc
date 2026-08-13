# Alarm runbook: operational metrics collector failure

**Source-defined CloudWatch alarm name:**
`psd-eoc-metrics-collector-failure`.

**Deployment/read-back truth:** issue #29 source landed in pull request #96,
but no approved deployment, CloudWatch read-back, alarm-action exercise, or
console deep link is recorded. Treat the alarm as **live-unverified** and the
deep link as unavailable until #91 supplies that evidence.

## Meaning

The source-defined alarm fires when `MetricsCollectorSuccess` is below `1` for
2 consecutive one-minute periods. Missing data is breaching. The collector is
a one-minute, read-only production observer: it runs fixed aggregate queries,
excludes test data from staff operational metrics, unconditionally rolls back
its transaction, and publishes success only after all queries, rollback, and
metric publication complete.

This alarm can mean a collector runtime, dedicated database login, Data API,
query-performance, static database-parameter, or CloudWatch publication
failure. It does not by itself prove the application or notification path is
down, and stale operational metrics must not be interpreted as current health.

## Safety posture

- Never grant the collector database write authority, application-role
  membership, whole-table access to sensitive tables, or an application/admin
  secret.
- Never edit records, disable rollback, remove staff/test filters, or replace a
  missing metric with a fabricated success value.
- Aggregate diagnostics must not expose staff identities, recipient endpoints,
  message content, credentials, provider payloads, or student data.

## Respond

1. Confirm account `<aws-account-id>`, region `us-west-2`, the exact alarm name,
   UTC interval, last successful invocation, and whether data was zero or
   missing.
2. Inspect the retained collector Lambda log by request ID and bounded stage or
   reason code. Do not copy SQL results or sensitive payloads into the incident
   record.
3. Verify Lambda schedule/invocation state, Data API reachability, and the
   dedicated `psd_eoc_monitoring` login without exposing credentials. Confirm
   the login remains read-only and least-privileged.
4. Check whether every fixed query completed inside the collector timeout and
   whether the transaction rollback completed before metric publication.
   Query slowness requires reviewed plan/index work; it does not authorize a
   broader database grant.
5. Verify `track_commit_timestamp` is active before treating activation
   percentiles as available. Missing commit timestamps are monitoring
   impairment, not a successful latency observation.
6. Compare independent App Runner, Aurora, queue, DLQ, and canary evidence to
   determine whether impact is monitoring-only or a wider outage. Use the
   higher-severity runbook when another alarm is independently supported.

## Recover and verify

Fix or roll back the proven collector/runtime/configuration defect through the
reviewed deployment path. Confirm at least two consecutive scheduled
invocations publish success only after all reads and rollback, expected
operational metrics resume with current timestamps, test data remains excluded,
and the database role still has no write path. Record the immutable revision,
bounded failure reason, before/after invocation IDs, privilege/read-back
evidence, remaining metric gaps, and second responder review.
