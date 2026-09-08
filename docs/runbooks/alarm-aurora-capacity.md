# Alarm runbook: Aurora capacity

**Source-defined CloudWatch alarm name:** `psd-eoc-aurora-capacity-pinned`.

Current deployment and alarm read-back state lives only in the
[operational readiness register](../INTEGRATIONS.md). A source-defined alarm
name is not deployment evidence.

## Meaning

The source-defined alarm reports Aurora Serverless v2 running at its capacity
ceiling for 20 consecutive one-minute periods; missing data is non-breaching.
The deployable stack sets minimum capacity to `0.5` ACU and maximum capacity to
`1` ACU with no auto-pause. Source configuration is not deployment evidence.

The alarm reads `ServerlessDatabaseCapacity` in ACU, not `ACUUtilization`.
Utilization is capacity divided by the ceiling, so on a `0.5`-to-`1` range it
has two attainable values -- 50 at idle and 100 whenever the cluster scales up
at all -- and a percentage threshold could only ever mean "Aurora scaled up".
It fired that way on 2026-09-02 with three connections and no load. What this
alarm asks instead is whether the ceiling has become the constraint: a burst
that scales up and back within a few minutes is the cluster working normally,
while twenty consecutive minutes at the ceiling is the cluster asking for a
larger one.

Raising the ceiling is a cost decision for the product owner, which is why this
alarm reaches the operations topic rather than paging.

## Safety posture

Do not terminate sessions, edit data, change scaling limits, restart the
cluster, or bypass the application. A capacity change is a production
infrastructure change requiring product-owner approval. Preserve append-only
history and treat failed reads as unknown, not absent.

## Respond

1. Confirm the protected account/region and exact cluster.
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
- Confirm ACU utilization stays below 80% for the source-defined 3-of-5 window
  and capacity, connections, query latency, activation-accept p95, App Runner
  errors, outbox age, and all queue ages agree.
- Confirm no ambiguous activation was retried and no event/journal/outbox row
  was modified or removed to clear the condition.
- If saturation causes writer unavailability, continue with
  [alarm-aurora-failover.md](alarm-aurora-failover.md) and treat as **SEV-1**.

Append metric screenshots through the access-controlled evidence store,
sanitized IDs, exact approved change/digest if any, and the second responder's
review.
