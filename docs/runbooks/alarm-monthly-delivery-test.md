# Alarm runbook: monthly delivery-test due, failed, or missed

**Source-defined CloudWatch alarm names:**

- `psd-eoc-monthly-live-delivery-test-due`;
- `psd-eoc-monthly-live-delivery-test-failed`; and
- `psd-eoc-monthly-live-delivery-test-missed`.

Current deployment, alarm, provider, and test state lives only in the
[operational readiness register](../INTEGRATIONS.md). A source-defined alarm or
a provider-accepted request is not evidence of delivery or human receipt.

## Meaning and severity

- **Due** means the targetless monthly schedule fired. It is a reminder to a
  human and has no authority to start a test.
- **Failed** means the metrics collector observed an append-only terminal
  delivery-test report with a failed status in its closed evaluation window.
- **Missed** means the collector found no qualifying successful terminal report
  for the preceding configured calendar month.

Treat a verified reminder-only condition as **SEV-3**. Treat a failed or missed
test as at least **SEV-2**, rising to **SEV-1** when more than one intended
channel is affected. Use **SEV-0** for an automated or unapproved send, a real/
drill mismatch, exposed recipient data, or changed append-only evidence.

## Safety posture

- An alarm, schedule, ticket, or standing plan never authorizes a delivery
  test. Only an authenticated human acting in the application may confirm it.
- Never add a target to the due schedule, auto-start or retry a test, fabricate
  a report, or backdate evidence to clear an alarm.
- Do not use a staff roster. An approved test uses only the exact synthetic,
  unroutable or explicitly opted-in targets authorized for that run.
- Do not copy destinations, tokens, provider payloads, message content, or
  contact data into logs, tickets, screenshots, or this repository.

## Respond

1. Confirm the protected account/region, exact alarm name, state transition,
   evaluation window, deployed revision, and current readiness labels. If any
   identity is missing or contradictory, retain `unknown` and escalate.
2. Start an append-only operations record with the alarm name, first-observed
   UTC time, responder role, and access-controlled evidence links.
3. Verify the operational metrics collector is healthy for the same window.
   Missing collector output is a monitoring failure, not proof that a test
   failed or was missed; follow
   [alarm-metrics-collector.md](alarm-metrics-collector.md).
4. Use only the authenticated, destination-free delivery-test projection.
   Record sanitized run/report identifiers, report sequence, status, bounded
   reason code, channel counts, latency, and delivery-truth counts. A bounded
   recent view cannot prove a report is absent.
5. Follow the matching branch below. Do not start or retry a test while
   diagnosing the alarm.

### Due reminder

1. Read back the exact schedule and prove it has zero targets. Any target or
   application/provider invocation is a **SEV-0** safety-boundary failure.
2. Confirm the expected calendar trigger occurred. Returning to `OK` proves
   only that the reminder window ended.
3. Page the accountable human through the approved operations system, never
   through a PSD EOC notification. A proposed test starts a separate approval
   and authenticated-human flow.

### Failed report

1. Match the alarm window to the immutable terminal failed report. Do not
   substitute an incomplete report or one endpoint attempt for run truth.
2. Separate each channel's pre-provider failure, terminal rejection, provider
   acceptance, delivery evidence, human receipt, and `unknown` counts.
3. Follow the applicable [Expo](provider-expo.md),
   [SES](provider-ses.md), or [SMS](provider-sms.md) procedure. Do not retry an
   ambiguous or failed run to manufacture evidence.

### Missed month

1. Derive the preceding calendar month using the configured district time zone
   and record the exact UTC boundaries used by the collector.
2. Require approved complete destination-free read-back before claiming that a
   qualifying terminal success is absent. If only a bounded view is available,
   retain `unknown` and escalate.
3. Record the missed obligation and owner. Never backdate a run or report; a
   later test does not erase the missed period.

## Recovery evidence

Record the alarm transition times, exact deployed revision, sanitized run/report
identifiers, collector health, per-channel truth counts, remaining unknowns,
decision owner, and second-responder review. Alarm recovery never erases the
original reminder, failed report, or missed obligation. Any later live test
still requires current provider readiness, exact approved synthetic targets,
product-owner authorization, and authenticated-human confirmation.
