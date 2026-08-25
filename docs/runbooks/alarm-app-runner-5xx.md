# Alarm runbook: App Runner HTTP 5xx

**Source-defined CloudWatch alarm name:** `psd-eoc-apprunner-5xx`.

Current deployment and alarm read-back state lives only in the
[operational readiness register](../INTEGRATIONS.md). A source-defined alarm
name is not deployment evidence.

## Meaning

The source-defined alarm fires when at least one server-side HTTP 5xx response
occurs in a one-minute period for the `psd-eoc` App Runner service. Missing data
is non-breaching. It may affect sign-in, activation, timeline reads, or admin
operations. It does not prove that an event was lost or a notification was
sent.

## Safety posture

- Do not retry a real activation for a user. First establish whether an event
  and delivery intent committed; an ambiguous result requires an authenticated
  human to inspect the app and make a fresh decision.
- Do not use direct database writes, forge requests, bypass authorization, or
  call a human-only action on the user's behalf.
- If errors create real/drill ambiguity or make delivery consequences
  uncertain, classify **SEV-0** and follow [rollback.md](rollback.md).

## Respond

1. Record the alarm transition time, environment, account, region, and App
   Runner service name in the operations record. Confirm account
   protected account/region from [CONFIGURATION.md](../CONFIGURATION.md).
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
2. Confirm the side-effect-free `/api/health` route is returning `200`, the
   exact 5xx alarm has a complete healthy evaluation period, and related
   latency evidence is current.
3. Review append-only event/outbox evidence for requests reported ambiguous by
   users. Never create, close, all-clear, or send a real event as a test.
4. Use only an approved isolated non-production synthetic test path. A
   production live test requires every AGENTS.md gate and a fresh
   authenticated-human confirmation; this alarm does not authorize one.

Escalate as **SEV-1** when activation is unavailable, the failing scope is
unknown, multiple dependencies fail, or recovery needs a production change.
Use [escalation.md](escalation.md).

Append the recovery time, image digest, remaining unknowns, and follow-up issue
links. After monitoring is deployed and read back, do not close the record
until the exact alarm returns to its documented normal state and a second
responder reviews the evidence.
