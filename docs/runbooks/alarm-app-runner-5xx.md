# Alarm runbook: App Runner HTTP 5xx

**Alarm ID / CloudWatch deep link: BLOCKED BY #29.** The alarm is not deployed.
This file is the stable runbook target that issue #29 must place in the alarm
description.

## Meaning

The planned alarm detects an elevated rate of server-side HTTP 5xx responses
from the `psd-eoc` App Runner service. It may affect sign-in, activation,
timeline reads, or admin operations. It does not prove that an event was lost
or a notification was sent.

## Safety posture

- Do not retry a real activation for a user. First establish whether an event
  and fan-out intent committed; an ambiguous result requires an authenticated
  human to inspect the app and make a fresh decision.
- Do not use direct database writes, forge requests, bypass authorization, or
  call a human-only action on the user's behalf.
- If errors create real/drill ambiguity, hide the emergency-disable truth, or
  make fan-out consequences uncertain, classify **SEV-0** and follow
  [emergency-disable.md](emergency-disable.md).

## Respond

1. Record the alarm transition time, environment, account, region, and App
   Runner service name in the operations record. Confirm account
   `338414773271` and region `us-west-2`.
2. In the App Runner console, open `psd-eoc` and inspect read-only **Metrics**,
   **Activity**, **Deployments**, and service status for the alarm interval.
   Record the latest immutable image digest and deployment start time.
3. In CloudWatch, correlate the 5xx interval with request count, latency, and
   `/psd-eoc/application` logs. Search by UTC interval and sanitized request ID;
   do not paste message content, recipients, tokens, cookies, or raw provider
   responses into the operations record.
4. Determine the failing surface: all requests, `/api/health`, database-backed
   calls, one route, or one deployment revision. Record observed status codes
   and counts without claiming a root cause yet.
5. Check Aurora and SQS alarm state read-only. If database availability or a
   queue backlog is involved, continue with
   [alarm-aurora-failover.md](alarm-aurora-failover.md),
   [alarm-aurora-capacity.md](alarm-aurora-capacity.md), or
   [alarm-sqs-age.md](alarm-sqs-age.md).
6. If the errors began with a deployment, prepare the exact prior image digest
   and follow [rollback.md](rollback.md). Changing the production service
   requires explicit product-owner approval.

## Verify recovery

1. Confirm the service is running the intended immutable image digest.
2. Confirm the side-effect-free `/api/health` route is returning `200` and the
   5xx rate and latency have returned below the final #29 thresholds.
3. Verify the emergency-disable state is readable and honestly rendered. Do
   not re-enable it as part of a health check.
4. Review append-only event/outbox evidence for requests reported ambiguous by
   users. Never create, close, all-clear, or send a real event as a test.
5. Use only the approved isolated non-production synthetic test path after #91
   exists. A production live test requires every AGENTS.md gate and a fresh
   authenticated-human confirmation; this alarm does not authorize one.

Escalate as **SEV-1** when activation is unavailable, the failing scope is
unknown, multiple dependencies fail, or recovery needs a production change.
Use [escalation.md](escalation.md).

Append the recovery time, image digest, remaining unknowns, and follow-up issue
links. Do not close the record until the #29 alarm returns to its documented
normal state and a second responder reviews the evidence.
