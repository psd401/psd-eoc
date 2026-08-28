# Issue #277 SES email activation evidence

Status: **AWS-side prerequisites read back live; deployment parameters set to
enable the worker — no provider send, delivery, or human receipt is claimed**

This append-only record separates source verification from external facts. It
must never contain a credential, recipient identity, raw provider payload,
personal contact data, or student data. Reference access-controlled artifacts by
bounded immutable ID; append a correction rather than rewriting an earlier
observation.

## Read-only inventory observed 2026-08-28T02:16:53Z

Account `338414773271`, region `us-west-2`, stack `PsdEoc`, read with the
protected administrator role.

| Boundary | Observed value |
| --- | --- |
| Account production access | `ProductionAccessEnabled: true` |
| Account sending | `SendingEnabled: true`; 24-hour quota 50000, max send rate 14/s |
| Sender domain identity | `psd401.net` `VerifiedForSendingStatus: true` |
| DKIM | `DkimAttributes.Status: SUCCESS`, `SigningEnabled: true` |
| Feedback forwarding | `FeedbackForwardingStatus: true` |
| Account suppression | Enabled for `BOUNCE` and `COMPLAINT` |
| Configuration set | `psd-eoc-transactional` present with `SendingOptions.SendingEnabled: true`, `ReputationMetricsEnabled: true`, CDK-managed under stack `PsdEoc` |
| Send binding | `workers/email/ses-adapter.ts` pins `ConfigurationSetName` to the `SES_CONFIGURATION_SET_NAME` literal `psd-eoc-transactional`, so sends never inherit the identity's unrelated default configuration set |
| Event topic | `PSD_EOC_SES_SNS_TOPIC_ARN` resolves to `arn:aws:sns:us-west-2:338414773271:psd-eoc-email-events` |
| Callback consumer | ECS service `psd-eoc-email-callback-worker` `ACTIVE`, desired 1, running 1, pending 0 |
| Send worker before this change | ECS service `psd-eoc-email-worker` `ACTIVE`, desired 0, running 0 |
| Retained queues | `psd-eoc-email`, `psd-eoc-email-dlq`, `psd-eoc-email-callback`, `psd-eoc-email-callback-dlq` |
| Queue reconciliation before enablement | `psd-eoc-email` and `psd-eoc-email-dlq` each reported `ApproximateNumberOfMessages: 0` and `ApproximateNumberOfMessagesNotVisible: 0`; no message body was read, purged, replayed, or redriven |
| Alarms | `psd-eoc-email-dlq-depth`, `psd-eoc-email-queue-age`, `psd-eoc-email-callback-dlq-depth`, `psd-eoc-email-callback-failures`, `psd-eoc-email-callback-worker-health` all `ActionsEnabled: true`, state `OK`, action `arn:aws:sns:us-west-2:338414773271:psd-eoc-critical-alarms` |

## Deployment inputs

`SesCredentialVerificationReference` is set to
`issue-277-ses-credentials-2026-08-28T021653Z`, which names this record.
`EnableEmailWorker` is set to `true`. The stack rule
`EmailWorkerRequiresLiveApplicationAndEvidence` independently requires
`ProvisionApplication=true` and a non-`UNVERIFIED` reference.

## What is not proved

- [ ] No SES provider send has been executed from the deployed worker.
- [ ] No `queued → provider accepted → delivered or bounced` ledger row exists.
- [ ] No human has received an EOC email from the deployed application.
- [ ] The email and callback DLQ alarms have not been forced to `ALARM` in an
      isolated environment for this deployment.
- [ ] The authenticated administrator has not yet used **Verify and enable
      email** in the running application; until that action the database channel
      stays disabled even though the worker is scaled to one.

The first physical delivery proof remains a human acceptance step in the running
application: one exact recipient, DRILL copy visible in both preview and message,
with append-only evidence retained. Automation never performs that send.
