# Alarm runbook: email DLQ

**Source-defined CloudWatch alarm names:**

- `psd-eoc-email-dlq-depth`, targeting `psd-eoc-email-dlq` paired only with
  source queue `psd-eoc-email`.
- `psd-eoc-email-callback-dlq-depth`, targeting retained signed SES callbacks
  that exhausted the durable callback consumer's bounded receives.
- `psd-eoc-email-worker-health` and
  `psd-eoc-email-callback-worker-health`, proving both enabled consumers keep
  emitting sanitized heartbeats.

Current deployment and alarm read-back state lives only in the
[operational readiness register](../INTEGRATIONS.md). A source-defined alarm
name is not deployment evidence.

## Meaning and severity

Email work or authenticated SES delivery evidence could not complete safely
after bounded attempts. Classify **SEV-2**, rising to **SEV-1** for broad impact
or another channel outage. Safety-boundary failures are **SEV-0**.

## Respond

1. Do not receive, purge, delete, copy, or edit a message. Never redrive an
   email send item. A signed callback may be redriven only through the SQS
   redrive-to-source operation after the callback cause is fixed; that path
   re-runs signature verification and idempotent persistence and has no SES
   send authority. Follow [alarm-sqs-dlq.md](alarm-sqs-dlq.md) for common
   evidence handling.
2. Confirm account/region, exact queue or callback DLQ, oldest age, counts, and
   SES integration truth. Non-`live-verified` truth must make zero provider
   calls.
3. Review `/psd-eoc/workers/email` by UTC interval, sanitized attempt ID, and
   bounded reason code. Never expose an address, message content, or raw SES
   response/event.
4. For a callback failure, correlate the SNS message ID and immutable attempt
   only from sanitized logs. SQS redrive-to-source cannot select or filter one
   message. Fix callback authentication or persistence, prove that every
   retained message in the callback DLQ is safe to retry through the same
   signature and idempotency path, then redrive the whole DLQ to
   `psd-eoc-email-callback`. If the entire retained set is not safe, do not
   redrive it. Never copy a signed body into a ticket, terminal, or log.
5. Separate pre-provider rejection, proven safe-to-retry failure, terminal
   failure/bounce/complaint, provider-accepted `MessageId`, delivery/delay
   evidence, and ambiguous call. Unknown work is never replayed.
6. Follow [provider-ses.md](provider-ses.md), fixing or rolling back the proven
   canonical worker/provider-boundary cause.

## Verify

Confirm newly authorized work drains normally, DLQ growth stops, worker
heartbeats recover, and append-only SES callback/evidence processing remains
truthful. Pausing a consumer does not suppress queued work, and its SQS
retention clock keeps running. Record the configured retention deadline. Keep
every email-send item blocked unless it has been reconciled with zero duplicate
provider side effect. Callback redrive is safe only because it cannot invoke
SES and repeats the signature, claim-token, and idempotency checks. A
`MessageId` is not delivery or human receipt.
