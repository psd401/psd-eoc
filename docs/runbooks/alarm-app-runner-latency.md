# Alarm runbook: App Runner latency

**Source-defined CloudWatch alarm name:**
`psd-eoc-apprunner-request-latency-average`.

Current deployment and alarm read-back state lives only in the
[operational readiness register](../INTEGRATIONS.md). A source-defined alarm
name is not deployment evidence.

## Meaning

The source-defined alarm detects all-route average App Runner response latency
of at least 500 ms in 3 of 5 one-minute periods for `psd-eoc`; missing data is
non-breaching. This metric is not the adopted activation-accept p95. Use
[alarm-activation-latency.md](alarm-activation-latency.md) for that distinct
confirmation-to-commit alarm.

## Safety posture

Slow confirmation can lead a human to tap twice. Idempotency protects the same
submission, but operators must never assume an ambiguous response failed and
must not retry on the user's behalf. No offline or delayed real activation may
be queued for automatic execution.

## Respond

1. Confirm the protected account/region, service `psd-eoc`, and
   record the UTC alarm interval.
2. In App Runner **Metrics**, compare request latency, request count, active
   instances, and 4xx/5xx for the same period. In **Deployments**, note the
   immutable image digest and whether latency began after a revision.
3. In CloudWatch, correlate the interval with Aurora connections/capacity and
   the four queue-age metrics. Do not infer provider delivery from application
   response time.
4. Review `/psd-eoc/application` logs by sanitized request ID. Separate route,
   database, roster, and external-provider timing. Provider calls should not
   sit in the activation-accept transaction; unexpected coupling is a
   **SEV-1** engineering gap.
5. If Aurora is constrained, use
   [alarm-aurora-capacity.md](alarm-aurora-capacity.md). If queue age is rising,
   use [alarm-sqs-age.md](alarm-sqs-age.md). If a new image is implicated,
   prepare [rollback.md](rollback.md).

## Contain and verify

- Prefer reducing a proven source of load or rolling back a proven regression.
  Scaling, configuration, and production deploys require product-owner
  approval and a consequence review.
- If users cannot obtain a fresh consequence preview, instruct them that no
  activation should be assumed. Never cache or reuse an expired preview.
- Confirm all-route average latency stays below 500 ms for the source-defined
  3-of-5 evaluation window. Review activation-accept p50/p95/p99 separately;
  one metric cannot clear the other.
- Confirm no rise in duplicate events, stale previews, stuck outbox rows, or
  queue age. Record `unknown` where evidence cannot resolve an outcome.
- Do not send a notification to measure recovery. Use approved non-production
  synthetic evidence only. A live test requires separate product-owner
  authorization and an authenticated human acting in the application.

Escalate as **SEV-1** when activation p95 breaches the target with real user
impact, latency causes ambiguous activation outcomes, or the cause is unknown.
Append the metric window, image digest, decision, approver, and follow-up links.
