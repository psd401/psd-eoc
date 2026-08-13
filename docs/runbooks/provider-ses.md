# Provider runbook: Amazon SES outage

Use this runbook when email queue age rises, SES rejects or throttles requests,
delivery-event evidence stops, or AWS reports an SES incident.

**Current truth:** Amazon SES is `mocked` in `docs/INTEGRATIONS.md`. The
deployable infrastructure defines an identity and configuration set, but no
live send/runtime is verified. The setup and read-only verification boundary
is documented in [email-setup.md](email-setup.md).

**Source-defined monitoring alarms:**

- `psd-eoc-email-outbox-to-provider-p95` fires when completed email handoff p95
  reaches 15 seconds; and
- `psd-eoc-email-outbox-to-provider-incomplete` fires when at least one email
  endpoint has not reached provider acceptance by the deterministic one-minute
  cutoff.

Issue #29 source landed in pull request #96, but no approved deployment,
CloudWatch read-back, alarm-action exercise, or console deep link is recorded.
Treat both alarms as **live-unverified**. Their source definition does not
change the `mocked` SES integration truth or authorize provider I/O.

## Safety posture

- Never send from the SES console as a workaround.
- Never change production access, DNS, identity, DKIM, MAIL FROM,
  configuration-set, SNS, or credentials without a reviewed consequence plan
  and explicit product-owner approval.
- Never log an address, message body, raw SES event, or provider response.
- `MessageId` means provider acceptance only. Delivery, bounce, complaint,
  delay, failure, and `unknown` remain distinct append-only evidence.
- Email subject/body must retain exact incident/drill classification.

## Respond

1. Confirm account `<aws-account-id>`, region `us-west-2`, current fan-out control
   epoch, SES integration truth, and `psd-eoc-email` queue/DLQ state.
2. In CloudWatch, inspect `/psd-eoc/workers/email` and sanitized SES
   configuration-set metrics for the UTC interval. Count bounded reason codes;
   do not copy payloads or destinations.
3. In the SES console, inspect read-only account sending status, identity
   verification for `alerts.psd401.net`, DKIM, custom MAIL FROM
   `mail.alerts.psd401.net`, and configuration set `psd-eoc-transactional`.
4. Check AWS Health/status and the encrypted SES event topic state. A healthy
   identity or accepted API request does not prove event consumption, mailbox
   delivery, or human receipt.
5. Separate safe pre-send validation failures, safe-to-retry rejections,
   terminal rejection/bounce/complaint, provider-accepted messages awaiting
   evidence, and ambiguous calls. Never retry the ambiguous category.
6. Use [alarm-sqs-age.md](alarm-sqs-age.md) or
   [alarm-dlq-email.md](alarm-dlq-email.md) for queue impact.
   Determine independently whether push is verified and healthy; do not build
   a manual recipient workaround.

## Recover and verify

- Roll back a proven application/worker regression. For an AWS/DNS/secret
  repair, document exact current and proposed state, rollback, approver, and
  operator before mutation.
- Confirm identity/configuration-set readiness, canonical worker health, queue
  age, DLQ depth, and append-only callback/evidence processing.
- Resolve bounces and complaints through endpoint-status evidence; do not
  remove attempts or rewrite roster history.
- Do not use a real recipient to test recovery. The optional one-message test
  in `email-setup.md` is still a live provider send and may run only for an
  explicitly approved synthetic mailbox with fresh human confirmations. This
  incident does not supply that approval.

Escalate **SEV-1** for broad email loss plus another channel impairment,
classification concerns, or unresolved ambiguous outcomes. Provider status
and PSD EOC delivery truth must remain separate in the evidence record.
