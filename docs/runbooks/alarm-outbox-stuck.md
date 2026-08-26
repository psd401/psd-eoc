# Alarm runbook: transactional outbox stuck rows

**CloudWatch alarm names:**

- `psd-eoc-push-stuck-production-outbox` is created conditionally with the
  enabled Expo worker and its count-only publisher; and
- `psd-eoc-stuck-production-outbox` remains source-defined for the future
  full read-only metrics collector.

Current deployment and alarm read-back state lives only in the
[operational readiness register](../INTEGRATIONS.md). A source-defined alarm
name is not deployment evidence.

## Meaning

The alarms fire when at least one staff outbox row remains neither published
nor terminally failed for one minute. Missing metric data is breaching. The
event may exist even when delivery has not started. The push worker publishes
only the aggregate count through its authenticated server route and excludes
test data; it receives no database credential or row contents. Source code is
not proof that the deployed query, metric, or alarm is current.

## Safety posture

- Never update, delete, unlock, resequence, or manufacture an outbox row.
- Never publish a reconstructed batch directly to SQS.
- Never tell a user to repeat a real activation solely because notification
  work is delayed.

## Respond

1. Classify **SEV-1** when real activation delivery is delayed. Confirm the
   protected account/region, alarm time, and exact deployed revision.
2. Use the approved read-only operational metric and application evidence.
   Record only row count, oldest age, status/reason counts, and sanitized
   outbox/batch IDs. Direct production SQL is not an approved procedure in this
   runbook.
3. Compare App Runner health, `/psd-eoc/dispatcher` logs, central
   `psd-eoc-delivery` queue age/count, and Aurora events over the same UTC window.
4. Separate rows that are leased, retry-scheduled, permanently failed, or
   ambiguous. Missing or contradictory state fails closed and is escalated.
5. Determine whether a dispatcher deployment/configuration, database outage,
   SQS authorization failure, or central-queue outage is the proven cause.
   Do not infer a cause from age alone.

## Recover and verify

- Restore the canonical dispatcher path or roll back its proven regression.
  Follow [rollback.md](rollback.md). Do not introduce a side-door publisher.
- Confirm eligible rows leave through the normal dispatcher and produce one
  immutable batch identity. A service pause does not suppress older work, and
  downstream SQS retention clocks keep running. Reconcile every row and any
  corresponding queue item before its configured deadline and before delivery
  resumes.
- Confirm central queue age does not rise and no corresponding DLQ item appears.
- Reconcile each ambiguous activation using event, journal, intent, outbox, and
  queue evidence. Provider acceptance and human receipt remain separate.
- Do not send a live test or replay a row to prove recovery. Use only an
  approved isolated synthetic non-production path.

Append oldest-age/count trends, sanitized affected IDs, exact code/config
change, product-owner approval for any production mutation, and the second
responder's review.
