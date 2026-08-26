# Alarm runbook: delivery DLQ

**Source-defined CloudWatch alarm name:** `psd-eoc-delivery-dlq-depth`, targeting
`psd-eoc-delivery-dlq` paired only with source queue `psd-eoc-delivery`.

Current deployment and alarm read-back state lives only in the
[operational readiness register](../INTEGRATIONS.md). A source-defined alarm
name is not deployment evidence.

## Meaning and severity

A delivery batch could not be safely routed to channel queues after
bounded attempts. Every approved channel may be affected. Classify **SEV-1**;
use **SEV-0** for real/drill mismatch, unapproved routable work, contradictory
authorization evidence, or a human-only boundary failure.

## Respond

1. Do not receive, purge, delete, copy, edit, or redrive the message. Follow
   the common safety/disposition procedure in
   [alarm-sqs-dlq.md](alarm-sqs-dlq.md).
2. Confirm the protected account/region, exact DLQ/source names,
   oldest age, visible count, and
   source queue age/count.
3. Review `/psd-eoc/dispatcher` logs by UTC interval and sanitized batch ID.
   Record bounded reason counts only; do not open or copy a body.
4. From authorized immutable application evidence, verify the event ID/kind,
   template mode, roster snapshot/population, integration truth, notification
   intent, and batch ID agree. Any missing or contradictory value fails closed.
5. Check stuck-outbox, App Runner, Aurora, and all channel queue metrics for the
   same interval. Fix or roll back the proven canonical router/runtime cause;
   never construct or publish a replacement batch manually.

## Verify

Confirm newly authorized batches route normally, queue age falls, DLQ depth
stops increasing, and no provider receives an unreviewed replay. A paused
consumer does not suppress or change retained work, but SQS retention clocks
keep running and may expire it. Record configured retention deadlines and
reconcile every pre-recovery item before its deadline or before any consumer
resumes. Disposition each item as reconciled without provider I/O or **BLOCKED**
pending a separately implemented and individually approved safe mechanism. A
zero count alone is not proof of recovery.
