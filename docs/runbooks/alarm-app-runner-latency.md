# Alarm runbook: App Runner latency

**Alarm ID / CloudWatch deep link: BLOCKED BY #29.** The alarm is not deployed.

## Meaning

The planned alarm detects elevated App Runner response latency for `psd-eoc`.
The adopted activation-accept target is p95 under 500 ms. The final alarm
window and threshold must come from #29; do not invent them from this runbook.

## Safety posture

Slow confirmation can lead a human to tap twice. Idempotency protects the same
submission, but operators must never assume an ambiguous response failed and
must not retry on the user's behalf. No offline or delayed real activation may
be queued for automatic execution.

## Respond

1. Confirm account `338414773271`, region `us-west-2`, service `psd-eoc`, and
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
- Confirm p50/p95/p99 request and activation-accept metrics return to the final
  #29 normal range for its documented evaluation window.
- Confirm no rise in duplicate events, stale previews, stuck outbox rows, or
  queue age. Record `unknown` where evidence cannot resolve an outcome.
- Do not send a notification to measure recovery. Use approved non-production
  synthetic evidence only; #30 owns any future human-confirmed live test.

Escalate as **SEV-1** when activation p95 breaches the target with real user
impact, latency causes ambiguous activation outcomes, or the cause is unknown.
Append the metric window, image digest, decision, approver, and follow-up links.
