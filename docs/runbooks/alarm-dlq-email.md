# Alarm runbook: email DLQ

**Source-defined CloudWatch alarm name:** `psd-eoc-email-dlq-depth`, targeting
`psd-eoc-email-dlq` paired only with source queue `psd-eoc-email`.

**Deployment/read-back truth:** issue #29 source landed in pull request #96,
but no approved deployment, CloudWatch read-back, alarm-action exercise, or
console deep link is recorded. Treat the alarm as **live-unverified** and the
deep link as unavailable until #91 supplies that evidence.

## Meaning and severity

Email work could not complete safely after bounded attempts. Classify
**SEV-2**, rising to **SEV-1** for broad impact or another channel outage.
Safety-boundary failures are **SEV-0**.

## Respond

1. Do not receive, purge, delete, copy, edit, or redrive the message. Follow
   [alarm-sqs-dlq.md](alarm-sqs-dlq.md) for common disposition rules.
2. Confirm account/region, exact queue pair, emergency-disable epoch, oldest
   age, counts, and SES integration truth. Non-`live-verified` truth must make
   zero provider calls.
3. Review `/psd-eoc/workers/email` by UTC interval, sanitized attempt ID, and
   bounded reason code. Never expose an address, message content, or raw SES
   response/event.
4. Separate pre-provider rejection, proven safe-to-retry failure, terminal
   failure/bounce/complaint, provider-accepted `MessageId`, delivery/delay
   evidence, and ambiguous call. Unknown work is never replayed.
5. Follow [provider-ses.md](provider-ses.md), fixing or rolling back the proven
   canonical worker/provider-boundary cause.

## Verify

Confirm new eligible work drains normally, old-epoch work stays suppressed,
DLQ growth stops, and append-only SES callback/evidence processing remains
truthful. A `MessageId` is not delivery or human receipt. Keep each retained
item blocked unless an individually reviewed mechanism can prove zero duplicate
provider side effect.
