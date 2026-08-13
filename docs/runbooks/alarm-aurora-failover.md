# Alarm runbook: Aurora failover

**Source-defined CloudWatch alarm names:**

- `psd-eoc-aurora-failover-bridge-errors`;
- `psd-eoc-aurora-replica-lag`; and
- `psd-eoc-aurora-failover-event`.

**Deployment/read-back truth:** issue #29 source landed in pull request #96,
but no approved deployment, CloudWatch read-back, alarm-action exercise, or
console deep link is recorded. Treat all three alarms as **live-unverified**
and their deep links as unavailable until #91 supplies that evidence.

## Meaning

The source defines three related conditions: at least one failover bridge error
in one minute, maximum replica lag of at least 1,000 ms in 3 of 5 minutes, and
at least one Aurora failover event in one minute. Missing data breaches the
replica-lag alarm but not the two event-count alarms. The deployable design has
one writer and one reader in different Availability Zones, Data API access,
deletion protection, and a positive Serverless v2 capacity floor. These source
facts do not prove a cluster is deployed or failover has been tested.

## Safety posture

- Let AWS's managed failover complete unless a qualified database responder
  and product owner approve a different production action.
- Never promote, reboot, restore, delete, modify, or write directly to the
  database from this runbook.
- Activation results during the interval are ambiguous until append-only event
  and outbox evidence is inspected. Do not replay or manufacture rows.

## Respond

1. Classify **SEV-1**, assign the database/AWS responder, and confirm account
   `338414773271`, region `us-west-2`, and the exact PSD EOC cluster.
2. In the RDS console, inspect read-only cluster status, writer/reader roles,
   Availability Zones, recent events, and failover start/end times. Record
   sanitized instance IDs and UTC times.
3. In CloudWatch, inspect database connections, latency, errors, capacity, and
   App Runner 5xx/latency for the same window.
4. Determine whether AWS completed promotion and whether the cluster endpoint
   resolves to one healthy writer. If roles are missing, contradictory, or
   still changing, keep the incident open and escalate to AWS support.
5. Check SQS age and stuck-outbox alarms. Work committed before the outage must
   remain append-only and may be delayed; ambiguous work must not be blindly
   replayed.
6. If fan-out or control truth cannot be read, treat fan-out as disabled and
   follow [emergency-disable.md](emergency-disable.md).

## Verify recovery

1. Confirm one writer and at least one healthy reader are available and the
   cluster status is stable.
2. Confirm the side-effect-free application health route, database-backed
   reads, and current emergency-disable truth are readable.
3. Confirm App Runner errors and outbox/queue backlog are returning toward
   normal without purging, resetting, or replaying unknown work.
4. Reconcile each user-reported activation outcome from immutable event,
   journal, intent, and outbox evidence. `Unknown` remains valid when the
   transaction outcome cannot be proved.
5. Do not call a failover or live notification a verification test. The
   deployed isolated restore/failover evidence required by #31 remains
   **BLOCKED BY #31/#91**.

Any manual failover, parameter change, restore, or production deployment needs
an explicit product-owner-approved plan and rollback point. Record AWS event
IDs, observed recovery time against the RTO target (under one hour), remaining
unknowns, and second-responder review.
