# PSD EOC operations runbooks

These are stable procedures for district technology responders. They never
authorize a provider write, production change, or notification. Before using a
procedure, consult the [operational readiness register](../INTEGRATIONS.md) for
the current environment, deployed resources, alarm coverage, DNS, identity,
provider, and mobile state.

## Stop conditions

Stop, preserve evidence, and escalate when:

- real and drill state may be confused;
- a real notification may have bypassed authenticated-human confirmation;
- automation appears able to invoke one of the four human-only actions;
- student data, a secret, or real recipient data appears in an unsafe place;
- provider acceptance is represented as delivery or human receipt;
- append-only event or delivery history appears rewritten; or
- current state is missing, unreadable, or contradictory.

Do not replay ambiguous work or create a provider sample while diagnosing it.
Call emergency services through normal district procedures when needed; PSD
EOC is not a 911 service.

## Start here

- [First deployment configuration](first-run.md)
- [Escalation and roles](escalation.md)
- [Emergency notification stop](rollback.md#emergency-notification-stop)
- [Rollback](rollback.md)
- [Go-live procedure](go-live.md)
- [Mobile release and rollback](release.md)
- [Backup inspection and isolated restore](backup-restore.md)

## Alarm response

| Alarm family                  | Procedure                                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App Runner errors and latency | [5xx](alarm-app-runner-5xx.md), [request latency](alarm-app-runner-latency.md)                                                                                                    |
| Activation acceptance         | [Activation latency](alarm-activation-latency.md)                                                                                                                                 |
| Aurora                        | [Capacity](alarm-aurora-capacity.md), [failover](alarm-aurora-failover.md)                                                                                                        |
| Queues and dead letters       | [Queue age](alarm-sqs-age.md), [common DLQ](alarm-sqs-dlq.md), [delivery](alarm-dlq-delivery.md), [push](alarm-dlq-push.md), [email](alarm-dlq-email.md), [SMS](alarm-dlq-sms.md) |
| Application data paths        | [Stuck outbox](alarm-outbox-stuck.md), [stale roster](alarm-roster-stale.md), [membership task failure](alarm-membership-sync-failure.md)                                         |
| Expo push worker              | [Worker health and receipt polling](alarm-push-worker-health.md), [provider handoff](provider-expo.md)                                                                            |
| Direct push providers         | [APNs/FCM activation, rotation, and rollback](provider-direct-push.md)                                                                                                            |
| Monitoring publishers         | [Metrics collector](alarm-metrics-collector.md), [shallow canary](alarm-canary-failure.md)                                                                                        |

## Provider and roster response

- [Expo Push](provider-expo.md)
- [Direct APNs and FCM push](provider-direct-push.md)
- [Amazon SES](provider-ses.md)
- [AWS End User Messaging SMS](provider-sms.md)
- [Google Groups roster sync](roster-sync.md)

## Maintenance and setup

- [Email setup](email-setup.md)
- [SMS registration](sms-registration.md)
- [Custom domain](eoc-custom-domain.md)
- [App store review account](app-store-review.md)
- [App-store setup](appstore-setup.md)
- [Google OAuth rotation](rotation-google-oauth.md)
- [Expo token rotation](rotation-expo-token.md)
- [Agent API-key rotation](rotation-api-keys.md)

## Evidence

Record UTC times, environment, sanitized immutable resource identifiers,
observations separately from inference, decisions, and rollback points. Keep
provider states distinct and link access-controlled evidence without secrets,
contacts, raw provider payloads, or student data. Append corrections with
provenance; never edit old evidence to make the timeline cleaner.

The superseded readiness-heavy index is retained in the district's private
operations records, outside this repository.
