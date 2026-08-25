# Alarm runbook: transactional outbox stuck rows

**Source-defined CloudWatch alarm name:**
`psd-eoc-stuck-production-outbox`.

Current deployment and alarm read-back state lives only in the
[operational readiness register](../INTEGRATIONS.md). A source-defined alarm
name is not deployment evidence.

## Meaning

The source-defined alarm fires when at least one staff outbox row remains
neither published nor terminally failed for one minute. Missing metric data is
breaching. The event may exist even when delivery has not started. The collector
excludes test data; source code is not proof that the deployed query, metric,
or alarm is current.

## Safety posture

- Never update, delete, unlock, resequence, or manufacture an outbox row.
- Never publish a reconstructed batch directly to SQS.
- Never tell a user to repeat a real activation solely because notification
  work is delayed.

## Respond

1. Classify **SEV-1** when real activation delivery is delayed. Confirm account
   protected account/region, alarm time, and current control epoch.
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
- Confirm current-epoch eligible rows leave through the normal dispatcher and
  produce one immutable batch identity. Rows from a disabled/older epoch stay
  suppressed after re-enable.
- Confirm central queue age does not rise and no corresponding DLQ item appears.
- Reconcile each ambiguous activation using event, journal, intent, outbox, and
  queue evidence. Provider acceptance and human receipt remain separate.
- Do not send a live test or replay a row to prove recovery. Use only an
  approved isolated synthetic non-production path.

Append oldest-age/count trends, sanitized affected IDs, exact code/config
change, product-owner approval for any production mutation, and the second
responder's review.
