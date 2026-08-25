# Operations runbook: Aurora backup and isolated restore

This runbook inspects Aurora backup readiness and performs a restore drill only
against an isolated non-production PSD EOC stack containing synthetic data.
It never restores over the source cluster and never connects a restored cluster
to a provider, real recipient, or production application.

Current database and restore-drill state lives only in the
[operational readiness register](../INTEGRATIONS.md). Do not infer backup or
restore readiness from CDK synthesis.

The operational targets are approximately zero RPO through multi-AZ
synchronous database operation and an RTO under one hour. A backup restore
cannot prove zero RPO; record the exact restored point and any gap.

## Roles and approvals

- Database/AWS on-call operates the console.
- Operations incident lead controls the evidence timeline.
- A second database responder verifies target isolation before any restore.
- Product owner explicitly approves the non-production infrastructure write,
  exact source/target, data classification, test window, and retention plan.
- Security/privacy lead reviews any proposal to use data other than synthetic
  non-production fixtures. This runbook does not authorize production data.

## Read-only backup inspection

1. Sign in through the approved short-lived AWS access path. Confirm account
   and protected region from configuration; stop on any mismatch.
2. In **RDS > Databases**, locate the exact isolated non-production cluster
   named in the reviewed drill plan. Verify its environment tag and
   synthetic-only data attestation. Do not use a production cluster for this
   drill.
3. Open **Maintenance & backups** read-only. Record automated backup status,
   retention, earliest/latest restorable times, encryption key identifier,
   cluster engine/version, and most recent backup completion. Record IDs only,
   never credentials or database contents.
4. Confirm the target point falls inside the restorable window and follows a
   recorded synthetic fixture marker whose expected aggregate counts/checksums
   are stored in the access-controlled drill plan.
5. Review AWS Health and cluster events for backup failures. Missing,
   contradictory, or stale backup evidence is a failed precondition.

## Restore consequence preview

Before the product owner approves the write, attach a sanitized preview that
states:

- exact source cluster ID and synthetic-data attestation;
- restore point (UTC) and why it was selected;
- new target cluster ID, subnet/security groups, encryption key, engine
  version, capacity, deletion protection, and estimated cost;
- proof the target network has no route/event source/provider credential and
  cannot reach Expo, SES, SMS, real recipients, or a production application;
- operator, second verifier, start deadline, RTO clock definition, rollback/
  stop point, and retention/disposition plan; and
- expected read-only integrity checks and evidence location.

If the preview cannot prove isolation or synthetic-only data, stop. Never
create a temporary public endpoint.

## Execute the isolated restore

The repository has no automation for an isolated point-in-time restore, so use
these AWS Console steps. Application deployments continue to use the supported
GitHub Actions/OIDC workflow.

1. Record the approved restore start time in UTC. This starts the measured RTO.
2. In RDS, choose the exact source cluster and **Restore to point in time**.
   Select the approved UTC point and create a **new** cluster with the exact
   approved non-production identifier.
3. Apply only the pre-reviewed isolated VPC/subnets/security groups, KMS key,
   engine settings, capacity limits, tags, deletion protection, and no public
   access. Stop before creation if any field differs from the preview.
4. Have the second responder re-read the complete target summary. Create only
   after both humans agree it matches the approval. Record the AWS operation ID
   and time; never record credentials.
5. Wait for AWS to report the new cluster available with one writer and the
   approved reader topology. Do not make configuration changes to force it
   ready.
6. Re-prove target isolation before granting any application access. The
   restored cluster must not use a production App Runner role, queue, worker,
   provider secret, DNS name, or callback.
7. Use only a separately reviewed, read-only validation image or tool whose
   identity is recorded in the drill plan. Never substitute an ad hoc
   production SQL client or admin secret.

## Required validation

The approved validator must record aggregate or digest evidence only:

- database/schema migration version matches the source restore point;
- expected synthetic facility, roster snapshot, event, journal, notification
  intent, outbox, attempt, delivery-evidence, audit, and control-entry counts;
- append-only sequence and hash-chain verification passes;
- event real/drill classification and rendered-template markers agree for
  every synthetic fixture;
- no student data, routable endpoint, real recipient, or live-provider truth
  exists;
- no queue or provider call occurs during restore verification;
- database-backed application health/read-only queries pass in the isolated
  environment; and
- actual RTO and selected restore point/RPO gap are recorded.

An aggregate mismatch is a failed drill. Do not edit restored rows to make it
pass. Open a gap issue, retain the failed evidence, and keep go-live blocked.

S3 media/record-export objects are not inside an Aurora restore. Record them as
out of scope unless a separately approved S3 version-recovery drill proves
them; never infer media recovery from database foreign keys.

## Evidence template

Copy this section for each drill and append results. Do not overwrite a prior
attempt.

### Restore drill `[SEQUENTIAL ATTEMPT ID]`

- Status: `[NOT RECORDED]`
- Gap/dependency: `[NOT RECORDED]`
- Source environment/cluster ID: `[NOT RECORDED]`
- Synthetic-only attestation link: `[NOT RECORDED]`
- AWS account/region: `[NOT RECORDED]`
- Approved restore point (UTC): `[NOT RECORDED]`
- Target isolated cluster ID: `[NOT RECORDED]`
- Product-owner approval reference/time: `[NOT RECORDED]`
- Operator / second verifier roles: `[NOT RECORDED]`
- RTO start / available / validation-complete (UTC): `[NOT RECORDED]`
- Measured RTO: `[NOT RECORDED]` (target `< 1 hour`)
- Restored point and measured RPO gap: `[NOT RECORDED]`
- KMS/network/public-access/deletion-protection proof: `[NOT RECORDED]`
- Provider/recipient isolation proof: `[NOT RECORDED]`
- Schema and aggregate digest evidence: `[NOT RECORDED]`
- Append-only/hash-chain verification: `[NOT RECORDED]`
- Real/drill fixture verification: `[NOT RECORDED]`
- Zero queue/provider calls evidence: `[NOT RECORDED]`
- S3 scope statement: `[NOT RECORDED]`
- Observed behavior: `[NOT RECORDED — DO NOT FABRICATE]`
- Expected behavior: restore validation completes under one hour with no data
  mutation and no provider path
- Gap issue or explicit `none`: `[NOT RECORDED]`
- Product-owner gap acceptance, if any: `[NOT RECORDED]`
- Evidence package link (access controlled, redacted): `[NOT RECORDED]`
- Second-responder review/time: `[NOT RECORDED]`

Completion checkboxes:

- [ ] Isolated synthetic non-production source and target were proved.
- [ ] Product owner approved before the restore write.
- [ ] Restore and all validation steps executed.
- [ ] RTO/RPO results were recorded truthfully.
- [ ] No provider call, live recipient, or student data was present.
- [ ] Every mismatch has a linked gap and required acceptance.
- [ ] Evidence package was reviewed without secrets or recipient data.

All boxes intentionally remain unchecked until humans execute and review the
deployed drill.
