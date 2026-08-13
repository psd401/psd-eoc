# Alarm runbook: Aurora capacity

**Alarm ID / CloudWatch deep link: BLOCKED BY #29.** The alarm is not deployed.

## Meaning

The planned alarm reports sustained Aurora capacity pressure. The deployable
stack sets Serverless v2 minimum capacity to `0.5` ACU and maximum capacity to
`4` ACUs with no auto-pause. Final #29 metrics, threshold, and evaluation
window are not yet defined.

## Safety posture

Do not terminate sessions, edit data, change scaling limits, restart the
cluster, or bypass the application. A capacity change is a production
infrastructure change requiring product-owner approval. Preserve append-only
history and treat failed reads as unknown, not absent.

## Respond

1. Confirm account `338414773271`, region `us-west-2`, and the exact cluster.
   Record the UTC interval and current writer/reader status.
2. In RDS/CloudWatch, inspect capacity, ACU utilization, connections, CPU,
   storage, read/write latency, Data API errors, and recent cluster events over
   the same interval.
3. Correlate with App Runner request/activation latency, 5xx, stuck-outbox, and
   queue-age metrics. Record correlation as an observation, not proof of cause.
4. In application logs, identify bounded request classes by sanitized request
   ID and route. Do not log query parameters, roster contents, event messages,
   tokens, or recipient data.
5. Check for a deployment or scheduled process that changed load. Do not stop
   it unless its behavior and consequences are understood and an authorized
   responder approves the action.

## Recover and verify

- Roll back a proven application regression using
  [rollback.md](rollback.md).
- For a scaling change, document current values, proposed values, cost and
  availability impact, rollback values, product-owner approval, and the
  operator. Apply through reviewed infrastructure, never an undocumented
  console drift.
- Confirm capacity, connections, query latency, activation-accept p95,
  App Runner errors, outbox age, and all queue ages return to the final #29
  normal ranges.
- Confirm no ambiguous activation was retried and no event/journal/outbox row
  was modified or removed to clear the condition.
- If saturation causes writer unavailability, continue with
  [alarm-aurora-failover.md](alarm-aurora-failover.md) and treat as **SEV-1**.

Append metric screenshots through the access-controlled evidence store,
sanitized IDs, exact approved change/digest if any, and the second responder's
review.
