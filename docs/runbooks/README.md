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
2. Verify the target is PSD EOC in AWS account `<aws-account-id>`, region
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

Issue [#29](https://github.com/psd401/psd-eoc/issues/29) landed on `main` in
pull request [#96](https://github.com/psd401/psd-eoc/pull/96). The source now
defines the 26 exact CloudWatch alarm names below and gives every synthesized
alarm a stable runbook anchor. This proves source definition only. It does
**not** prove that the stack, metrics, alarm actions, or recipients are deployed
or that an alarm was read back from CloudWatch.

Every row is currently **source-defined / live-unverified**. No approved
deployment/read-back evidence or CloudWatch console deep link is recorded in
the repository; those fields remain blocked by
[#91](https://github.com/psd401/psd-eoc/issues/91). An operator must match the
exact source-defined name against the approved account and region after a
deployment, then store the console link in the access-controlled evidence
package. Never substitute a synthesized template, source name, or dashboard
widget for that read-back.

| Exact source-defined CloudWatch alarm name    | Source condition                                                                              | Operator runbook                                         | Truth                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------- |
| `psd-eoc-apprunner-5xx`                       | At least one App Runner 5xx response in one minute                                            | [App Runner 5xx](alarm-app-runner-5xx.md)                | source-defined / live-unverified |
| `psd-eoc-apprunner-request-latency-average`   | All-route average latency at least 500 ms in 3 of 5 minutes                                   | [App Runner latency](alarm-app-runner-latency.md)        | source-defined / live-unverified |
| `psd-eoc-activation-accept-latency-p95`       | Staff incident/drill activation-accept p95 at least 500 ms in 3 of 5 closed minutes           | [Activation-accept latency](alarm-activation-latency.md) | source-defined / live-unverified |
| `psd-eoc-aurora-failover-bridge-errors`       | At least one failover EventBridge target or metric-Lambda error in one minute                 | [Aurora failover](alarm-aurora-failover.md)              | source-defined / live-unverified |
| `psd-eoc-aurora-acu-utilization`              | Aurora ACU utilization at least 80% in 3 of 5 minutes                                         | [Aurora capacity](alarm-aurora-capacity.md)              | source-defined / live-unverified |
| `psd-eoc-metrics-collector-failure`           | Collector success below 1 for 2 consecutive minutes, including missing data                   | [Metrics collector](alarm-metrics-collector.md)          | source-defined / live-unverified |
| `psd-eoc-aurora-replica-lag`                  | Maximum replica lag at least 1,000 ms in 3 of 5 minutes                                       | [Aurora failover](alarm-aurora-failover.md)              | source-defined / live-unverified |
| `psd-eoc-aurora-failover-event`               | At least one Aurora cluster failover event in one minute                                      | [Aurora failover](alarm-aurora-failover.md)              | source-defined / live-unverified |
| `psd-eoc-one-minute-canary-failure`           | Canary success below 1 for 2 consecutive minutes, including missing data                      | [Canary failure](alarm-canary-failure.md)                | source-defined / live-unverified |
| `psd-eoc-stuck-production-outbox`             | At least one staff outbox row remains unpublished and nonterminal for one minute              | [Stuck outbox](alarm-outbox-stuck.md)                    | source-defined / live-unverified |
| `psd-eoc-roster-sync-failure-age`             | Latest staff sync remains failed or partial-rejected for at least 15 minutes                  | [Stale roster](alarm-roster-stale.md)                    | source-defined / live-unverified |
| `psd-eoc-roster-sync-success-age`             | No complete staff sync is retained within 25 hours                                            | [Stale roster](alarm-roster-stale.md)                    | source-defined / live-unverified |
| `psd-eoc-fanout-queue-age`                    | Oldest central fan-out message reaches 60 seconds                                             | [Queue age](alarm-sqs-age.md)                            | source-defined / live-unverified |
| `psd-eoc-push-queue-age`                      | Oldest push message reaches 60 seconds                                                        | [Queue age](alarm-sqs-age.md)                            | source-defined / live-unverified |
| `psd-eoc-email-queue-age`                     | Oldest email message reaches 60 seconds                                                       | [Queue age](alarm-sqs-age.md)                            | source-defined / live-unverified |
| `psd-eoc-sms-queue-age`                       | Oldest SMS message reaches 60 seconds                                                         | [Queue age](alarm-sqs-age.md)                            | source-defined / live-unverified |
| `psd-eoc-fanout-dlq-depth`                    | At least one visible central fan-out DLQ message                                              | [DLQ: central fan-out](alarm-dlq-fanout.md)              | source-defined / live-unverified |
| `psd-eoc-push-dlq-depth`                      | At least one visible push DLQ message                                                         | [DLQ: push](alarm-dlq-push.md)                           | source-defined / live-unverified |
| `psd-eoc-email-dlq-depth`                     | At least one visible email DLQ message                                                        | [DLQ: email](alarm-dlq-email.md)                         | source-defined / live-unverified |
| `psd-eoc-sms-dlq-depth`                       | At least one visible SMS DLQ message                                                          | [DLQ: SMS](alarm-dlq-sms.md)                             | source-defined / live-unverified |
| `psd-eoc-push-outbox-to-provider-p95`         | Push outbox-to-provider p95 reaches 5 seconds                                                 | [Expo Push](provider-expo.md)                            | source-defined / live-unverified |
| `psd-eoc-push-outbox-to-provider-incomplete`  | At least one push endpoint misses provider acceptance by the deterministic one-minute cutoff  | [Expo Push](provider-expo.md)                            | source-defined / live-unverified |
| `psd-eoc-email-outbox-to-provider-p95`        | Email outbox-to-provider p95 reaches 15 seconds                                               | [Amazon SES](provider-ses.md)                            | source-defined / live-unverified |
| `psd-eoc-email-outbox-to-provider-incomplete` | At least one email endpoint misses provider acceptance by the deterministic one-minute cutoff | [Amazon SES](provider-ses.md)                            | source-defined / live-unverified |
| `psd-eoc-sms-outbox-to-provider-p95`          | SMS outbox-to-provider p95 reaches 15 seconds                                                 | [AWS End User Messaging SMS](provider-sms.md)            | source-defined / live-unverified |
| `psd-eoc-sms-outbox-to-provider-incomplete`   | At least one SMS endpoint misses provider acceptance by the deterministic one-minute cutoff   | [AWS End User Messaging SMS](provider-sms.md)            | source-defined / live-unverified |

The source alarm descriptions link stable anchors in `infra/README.md`; this
table maps the same exact names to the detailed operator procedures in this
directory. Queue and function names in source remain deployable definitions,
not proof that a resource exists. After an approved deployment, read back all
26 names, conditions, actions, and runbook links from CloudWatch before checking
any go-live monitoring item.

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

## Current readiness truth (2026-08-13)

- There is no verified deployed PSD EOC non-production stack. Issue
  [#91](https://github.com/psd401/psd-eoc/issues/91) is open.
- P5.1 monitoring source landed through
  [#29](https://github.com/psd401/psd-eoc/issues/29) and pull request
  [#96](https://github.com/psd401/psd-eoc/pull/96). Its 26 alarm names are
  source-defined, but deployment, alarm-action exercise, CloudWatch read-back,
  recipient verification, and console links are not recorded and remain
  blocked by [#91](https://github.com/psd401/psd-eoc/issues/91).
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
