# Alarm runbook: activation-accept latency

**Source-defined CloudWatch alarm name:**
`psd-eoc-activation-accept-latency-p95`.

**Deployment/read-back truth:** issue #29 source landed in pull request #96,
but no approved deployment, CloudWatch read-back, alarm-action exercise, or
console deep link is recorded. Treat the alarm as **live-unverified** and the
deep link as unavailable until #91 supplies that evidence.

## Meaning

The source-defined alarm evaluates the closed-minute p95 for staff incident and
drill activations from authenticated-human confirmation consumption to the
immutable activation transaction commit. It alarms at 500 ms or greater in 3
of 5 minutes. This is distinct from all-route App Runner request latency.

The metric depends on database commit timestamps. Missing or null commit
timestamps indicate monitoring impairment; they are never evidence of a fast
activation. The alarm source treats missing metric data as non-breaching, so an
`OK` state without recent eligible samples does not prove the activation path
met its SLO.

## Safety posture

- Never replay or submit a real activation for a user. An ambiguous result
  requires an authenticated human to inspect current application truth and
  make a fresh decision.
- Never weaken the consequence-preview, idempotency, real/drill, authorization,
  or offline-reconfirmation gates to improve latency.
- Do not send a notification to create a sample. Production SLO testing remains
  a separately authorized, human-confirmed operation under #30.

## Respond

1. Confirm account `338414773271`, region `us-west-2`, the exact alarm name,
   UTC evaluation interval, state transition, p95 value, and sample count.
2. Verify the interval contains eligible staff incident/drill commits and that
   commit timestamps are available. If samples or timestamps are missing,
   investigate monitoring rather than declaring the activation path healthy.
3. Compare activation p50/p95/p99 with App Runner 5xx and all-route latency,
   Aurora ACU utilization and replica lag, stuck-outbox count, and all four
   queue ages for the same closed minutes.
4. Review sanitized application and database evidence by bounded request ID.
   Separate preview latency, confirmation-to-commit latency, post-commit
   dispatch, and provider handoff; provider latency is not activation-accept
   latency.
5. If the breach began with an immutable application or infrastructure
   revision, prepare the exact prior digest/change set and follow
   [rollback.md](rollback.md). A production change requires product-owner
   approval.

## Recover and verify

Confirm eligible closed-minute p95 is below 500 ms for the source-defined
evaluation window, sample counts and commit timestamps are present, and related
error, capacity, outbox, and queue metrics agree. Reconcile every user-reported
ambiguous activation from append-only event, journal, intent, and outbox
evidence; retain `unknown` where the outcome cannot be proved. Record the exact
revision, metric interval, evidence link, remaining unknowns, and second
responder review.
