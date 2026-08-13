# PSD EOC operations runbooks

These runbooks are the operator entry point for PSD EOC. They are written for
a district technology responder who did not author the system. They do not
authorize a production change, a provider write, or a notification. Product
owner approval remains required where a runbook says so.

## Stop conditions that override every runbook

Stop, preserve evidence, and escalate immediately when any of these is true:

- a real incident is shown as a drill, or a drill is shown as real;
- a real notification may have been sent without the authenticated human
  confirmation required by `AGENTS.md`;
- an agent, automation, GET request, link preview, webhook, or scheduled job
  appears able to start a real incident, send a real notification, issue an
  all-clear, or close a real event;
- student data, a secret, a credential, or real recipient data appears in a
  log, ticket, repository file, or screenshot;
- delivery evidence overstates provider acceptance as delivery or human
  receipt;
- event-journal or delivery history appears to have been rewritten or deleted;
  or
- the emergency-disable state is missing, unreadable, contradictory, or
  cannot be proved current. Treat that state as disabled.

Do not bypass a gate, replay ambiguous work, re-enable fan-out, start or close
an event, or send a test while investigating. Call 911 through normal district
procedure when the physical situation requires it; PSD EOC is not a 911
service.

## First five minutes

1. Open the alarm or report in the approved operations console and note the
   first observed UTC time, environment, account, region, and alarm state.
2. Verify the target is PSD EOC in AWS account `338414773271`, region
   `us-west-2`. If either differs, stop and escalate; do not change anything.
3. Open the matching runbook below. Read the **Safety posture** and **Escalate
   now** sections before changing state.
4. Start an append-only operations record in the approved district system.
   Record only non-sensitive resource identifiers, UTC timestamps, metric
   values, decisions, approvers, and links to access-controlled evidence.
5. Determine whether the impact is activation, fan-out, one provider, roster
   freshness, or monitoring only. Never infer notification delivery from a
   green provider status.

Use [escalation.md](escalation.md) to assign severity and contact roles.

## P5.1 alarm-to-runbook inventory

Issue [#29](https://github.com/psd401/psd-eoc/issues/29) has not landed. No
P5.1 alarm is deployed, and final alarm IDs and CloudWatch deep links do not
exist. Every `Alarm ID / deep link` below is therefore **BLOCKED BY #29**.
These are planned alarm categories, not evidence that monitoring is active.

| Planned alarm                   | Resource instances                                               | Runbook                                           | Alarm ID / deep link                |
| ------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------- |
| App Runner HTTP 5xx             | `psd-eoc`                                                        | [App Runner 5xx](alarm-app-runner-5xx.md)         | **BLOCKED BY #29**                  |
| App Runner latency              | `psd-eoc`                                                        | [App Runner latency](alarm-app-runner-latency.md) | **BLOCKED BY #29**                  |
| Aurora failover                 | PSD EOC Aurora cluster                                           | [Aurora failover](alarm-aurora-failover.md)       | **BLOCKED BY #29**                  |
| Aurora capacity                 | PSD EOC Aurora cluster                                           | [Aurora capacity](alarm-aurora-capacity.md)       | **BLOCKED BY #29**                  |
| SQS oldest-message age          | `psd-eoc-fanout`, `psd-eoc-push`, `psd-eoc-email`, `psd-eoc-sms` | [Queue age](alarm-sqs-age.md)                     | **BLOCKED BY #29 (four IDs/links)** |
| SQS DLQ depth                   | `psd-eoc-fanout-dlq`                                             | [DLQ: central fan-out](alarm-dlq-fanout.md)       | **BLOCKED BY #29**                  |
| SQS DLQ depth                   | `psd-eoc-push-dlq`                                               | [DLQ: push](alarm-dlq-push.md)                    | **BLOCKED BY #29**                  |
| SQS DLQ depth                   | `psd-eoc-email-dlq`                                              | [DLQ: email](alarm-dlq-email.md)                  | **BLOCKED BY #29**                  |
| SQS DLQ depth                   | `psd-eoc-sms-dlq`                                                | [DLQ: SMS](alarm-dlq-sms.md)                      | **BLOCKED BY #29**                  |
| Transactional outbox stuck rows | PSD EOC database                                                 | [Stuck outbox](alarm-outbox-stuck.md)             | **BLOCKED BY #29**                  |
| Roster-sync failure age         | staff roster snapshots                                           | [Stale roster](alarm-roster-stale.md)             | **BLOCKED BY #29**                  |
| Shallow canary failure          | synthetic health transaction                                     | [Canary failure](alarm-canary-failure.md)         | **BLOCKED BY #29**                  |

The queue names above are the deployable names in `infra/src/psd-eoc-stack.ts`.
They are not proof that a stack or queue is deployed. When #29 lands, its alarm
descriptions must link to the corresponding stable file on `main`, and this
table must be updated with the exact alarm ID and console deep link in the same
reviewed change.

## Provider and roster incidents

| Trigger                                          | Runbook                              |
| ------------------------------------------------ | ------------------------------------ |
| Expo Push degradation or outage                  | [Expo Push outage](provider-expo.md) |
| Amazon SES degradation or outage                 | [Amazon SES outage](provider-ses.md) |
| AWS End User Messaging SMS degradation or outage | [SMS outage](provider-sms.md)        |
| Google Groups sync failure or stale staff roster | [Roster sync](roster-sync.md)        |

## Planned maintenance

| Operation                                           | Runbook                                           |
| --------------------------------------------------- | ------------------------------------------------- |
| Google OAuth client-secret rotation                 | [Google OAuth rotation](rotation-google-oauth.md) |
| Expo access-token rotation                          | [Expo token rotation](rotation-expo-token.md)     |
| PSD EOC agent/API-key rotation                      | [API-key rotation](rotation-api-keys.md)          |
| Aurora backup inspection and isolated restore drill | [Backup and restore](backup-restore.md)           |

## High-consequence controls and release

| Operation                                                        | Runbook                                   |
| ---------------------------------------------------------------- | ----------------------------------------- |
| Stop notification fan-out                                        | [Emergency disable](emergency-disable.md) |
| Roll back application, workers, configuration, or mobile release | [Rollback](rollback.md)                   |
| Decide whether production traffic may begin                      | [Go-live checklist](go-live.md)           |

## Current readiness truth (2026-08-12)

- There is no verified deployed PSD EOC non-production stack. Issue
  [#91](https://github.com/psd401/psd-eoc/issues/91) is open.
- P5.1 monitoring is open in
  [#29](https://github.com/psd401/psd-eoc/issues/29); the alarm identifiers and
  deep links above are blocked.
- The eight deployed failure drills and their evidence are open in
  [#31](https://github.com/psd401/psd-eoc/issues/31).
- The monthly human-confirmed delivery test and stored SLO evidence are open in
  [#30](https://github.com/psd401/psd-eoc/issues/30). A scheduled job may remind
  a human that a test is due; it may never send the test.
- The emergency-disable implementation and tests are part of
  [#34](https://github.com/psd401/psd-eoc/issues/34). Documentation alone is
  not proof that it works.
- `docs/INTEGRATIONS.md` is authoritative for provider truth. A mock, dry run,
  synthesized stack, provider status page, or accepted API request does not
  prove end-to-end delivery.

## Evidence rules

For every response or maintenance operation, append:

- UTC start/end times and the responder role;
- environment, account, region, and sanitized resource ID;
- alarm transitions and bounded metric values;
- the exact control epoch or deployment/build digest where relevant;
- observations separated from inferences;
- every decision, approver, and rollback point;
- provider truth as `attempted`, `provider-accepted`, `delivered` only with
  provider proof, `failed`, `expired`, or `unknown`; and
- a link to access-controlled logs/screenshots with secrets, contact data,
  provider payloads, and recipient data removed.

Append corrections as new entries with provenance. Never edit or delete prior
evidence to make a timeline look cleaner.
