# On-call escalation and role matrix

Current deployment, monitoring, and provider state lives only in the
[operational readiness register](../INTEGRATIONS.md).

Use this matrix for every PSD EOC operational alert. It identifies roles, not
personal contact details. Keep phone numbers, email addresses, schedules, and
credentials in the approved district operations system, never in this
repository.

## Severity

| Severity                  | Use when                                                                                                                                                                                  | Initial response                                                                                                                       | Product-owner involvement                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **SEV-0 safety boundary** | Real/drill confusion; possible unapproved live send; human-only action exposed to an agent or automation; student data, secrets, or recipient data exposed; append-only history changed   | Preserve evidence, page the operations incident lead and product owner immediately; engage district safety/security process            | Immediate; only the product owner may authorize a production/provider change                                                    |
| **SEV-1 critical**        | Activation unavailable or materially unreliable; delivery backlog across channels; Aurora unavailable/failing over without recovery; delivery DLQ has work; multiple channels unavailable | Acknowledge immediately, assign incident lead, follow the linked runbook, and prepare a rollback decision                              | Notify immediately; approval required for production mutation, or provider configuration                                        |
| **SEV-2 major**           | One notification channel degraded; one channel DLQ has work; roster is stale but a complete last-good snapshot is available; elevated errors/latency without full outage                  | Acknowledge promptly, diagnose read-only, preserve other channels, and escalate if the condition worsens or exceeds the runbook window | Notify on-call product owner according to the approved roster; explicit approval still required for production/provider changes |
| **SEV-3 advisory**        | Monitoring defect, canary-only issue with user paths independently healthy, or maintenance warning without user impact                                                                    | Open an operations record, investigate during the current support window, and escalate on uncertainty                                  | Include in operations review; no implied approval                                                                               |

When impact is uncertain, choose the higher severity. A provider status page
cannot lower severity by itself. `unknown` is an honest state.

## Decision roles

| Role                                    | Accountable for                                                                                                                                            | May not delegate away                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Product owner / safety and IT authority | Go-live, production infrastructure/provider changes, approved synthetic live-test targets, resuming delivery after an emergency stop, accepted launch gaps | The required explicit authorization and final go-live signature       |
| Operations incident lead                | Severity, task assignment, timeline, operator safety, handoff, and closure review                                                                          | Evidence integrity or a safety stop condition                         |
| Application on-call                     | App Runner, server behavior, web/mobile activation surfaces, rollback recommendation                                                                       | Human-only boundaries or real/drill truth                             |
| Delivery on-call                        | Outbox, SQS, workers, provider handoff, DLQ quarantine and reconciliation                                                                                  | Replaying ambiguous work or claiming receipt from provider acceptance |
| Database / AWS on-call                  | Aurora, backups, restore, AWS service health, least-privilege access                                                                                       | Destructive database changes or unapproved production mutation        |
| Identity / roster on-call               | Google OAuth, Google Groups sync, session continuity, last-good snapshot evidence                                                                          | Activating against an incomplete or ambiguous roster                  |
| Security/privacy lead                   | Suspected unauthorized access, secret/contact-data exposure, audit-chain concerns                                                                          | Evidence preservation and district reporting process                  |
| Communications liaison                  | Internal status updates approved by the incident lead/product owner                                                                                        | Sending PSD EOC notifications as an operations workaround             |

One person may fill more than one role, but the operations record must name the
role being exercised for each decision. The authenticated human who confirms a
critical action remains responsible for that action; automation cannot stand
in for the human.

## Escalation triggers

Escalate one level immediately when:

- the condition crosses a safety stop in
  [README.md](README.md#stop-conditions);
- diagnosis cannot prove the environment, resource, pending-delivery state, or
  real/drill classification;
- a proposed recovery could release queued or suppressed notification work;
- a provider outcome is ambiguous and someone proposes retrying it;
- the primary channel and its expected fallback are both impaired;
- no recent complete staff roster snapshot can be proved;
- recovery needs a production deploy, secret rotation, DNS/provider change,
  queue redrive, database failover/restore, or resumption after an emergency
  service stop; or
- the responder does not have the approved access or cannot locate the next
  named role.

If the primary role does not acknowledge within the locally approved paging
window, page the backup and the operations incident lead. The exact window and
contact route belong in the approved operations system, never this repository.

## Provider escalation packet

Before opening an AWS, Expo, Apple, or Google case, collect only:

- service, UTC interval, region, sanitized application resource ID, and request or
  provider reference that contains no recipient information;
- bounded error/reason code and diagnostic digest, not raw untrusted provider
  text or payload;
- whether the result is known failed, provider-accepted, or unknown;
- impact and safe actions already taken; and
- the authorized case owner.

Do not attach credentials, tokens, real recipient destinations, roster
exports, event message content, student data, or unredacted logs.
