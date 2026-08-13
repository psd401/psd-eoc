# Alarm runbook: Aurora capacity

**Source-defined CloudWatch alarm name:** `psd-eoc-aurora-acu-utilization`.

**Deployment/read-back truth:** issue #29 source landed in pull request #96,
but no approved deployment, CloudWatch read-back, alarm-action exercise, or
console deep link is recorded. Treat the alarm as **live-unverified** and the
deep link as unavailable until #91 supplies that evidence.

## Meaning

The source-defined alarm reports Aurora Serverless v2 ACU utilization at or
above 80% in 3 of 5 one-minute periods; missing data is breaching. The
deployable stack sets minimum capacity to `0.5` ACU and maximum capacity to `4`
ACUs with no auto-pause. Source configuration is not deployment evidence.

## Safety posture

Do not terminate sessions, edit data, change scaling limits, restart the
cluster, or bypass the application. A capacity change is a production
infrastructure change requiring product-owner approval. Preserve append-only
history and treat failed reads as unknown, not absent.

## Respond

1. Confirm account `<aws-account-id>`, region `us-west-2`, and the exact cluster.
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
