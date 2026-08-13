# Alarm runbook: central fan-out DLQ

**Source-defined CloudWatch alarm name:** `psd-eoc-fanout-dlq-depth`, targeting
`psd-eoc-fanout-dlq` paired only with source queue `psd-eoc-fanout`.

**Deployment/read-back truth:** issue #29 source landed in pull request #96,
but no approved deployment, CloudWatch read-back, alarm-action exercise, or
console deep link is recorded. Treat the alarm as **live-unverified** and the
deep link as unavailable until #91 supplies that evidence.

## Meaning and severity

A central fan-out batch could not be safely routed to channel queues after
bounded attempts. Every approved channel may be affected. Classify **SEV-1**;
use **SEV-0** for real/drill mismatch, unapproved routable work, control-epoch
mismatch, or a human-only boundary failure.

## Respond

1. Do not receive, purge, delete, copy, edit, or redrive the message. Follow
   the common safety/disposition procedure in
   [alarm-sqs-dlq.md](alarm-sqs-dlq.md).
2. Confirm account `338414773271`, region `us-west-2`, exact DLQ/source names,
   current emergency-disable revision/epoch, oldest age, visible count, and
   source queue age/count.
3. Review `/psd-eoc/dispatcher` logs by UTC interval and sanitized batch ID.
   Record bounded reason counts only; do not open or copy a body.
4. From authorized immutable application evidence, verify the event ID/kind,
   template mode, roster snapshot/population, integration truth, batch ID, and
   enable epoch agree. Any missing or contradictory value fails closed.
5. Check stuck-outbox, App Runner, Aurora, and all channel queue metrics for the
   same interval. Fix or roll back the proven canonical router/runtime cause;
   never construct or publish a replacement batch manually.

## Verify

Confirm new current-epoch batches route normally, queue age falls, DLQ depth
stops increasing, old/disabled-epoch work stays terminally suppressed, and no
provider receives an unreviewed replay. Disposition every retained item as
suppressed, reconciled without provider I/O, or **BLOCKED** pending a separately
implemented and individually approved safe mechanism. A zero count alone is
not proof of recovery.
