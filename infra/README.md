# PSD EOC infrastructure

`infra` owns the AWS CDK stack and credential-free synthesis checks. Tenant
context and current CloudFormation parameters are
indexed in [docs/CONFIGURATION.md](../docs/CONFIGURATION.md). Current deployed
resource and provider state lives only in the
[operational readiness register](../docs/INTEGRATIONS.md).

## Local verification

From the repository root:

```sh
bun run --cwd infra typecheck
bun run --cwd infra synth:example
```

`synth:example` replaces the checked-in tenant identity with a reserved example
district, synthesizes the stack in memory, and asserts the portable identity.
It performs no AWS, Google, DNS, store, or notification-provider call.

## Deployment

Deployment has one path: from the repository root, run the single
`bun run --cwd infra deploy -- PsdEoc` command with a locally authenticated,
short-lived AWS session and the required parameters in
[docs/CONFIGURATION.md](../docs/CONFIGURATION.md). That command builds and
publishes the CDK image asset, runs the database bootstrap, and promotes the
services only after bootstrap succeeds. There is no separate build, push,
migration, or promotion command. GitHub Actions, repository environments,
repository variables, repository secrets, and GitHub OIDC roles are not
deployment surfaces. The deploy script intrinsically refuses a dirty Git
worktree so the image's source revision always identifies its exact contents.

## Alarm response runbooks

CloudWatch alarm descriptions append the stable anchors below to the configured
`psdEoc:monitoringRunbookBaseUrl`. Preserve these headings when reorganizing
documentation.

### Runbook: App Runner errors and latency

Use the [5xx](../docs/runbooks/alarm-app-runner-5xx.md) and
[latency](../docs/runbooks/alarm-app-runner-latency.md) procedures.

### Runbook: Activation accept latency

Use the [activation latency](../docs/runbooks/alarm-activation-latency.md)
procedure.

### Runbook: Aurora failover readiness and capacity

Use the [failover](../docs/runbooks/alarm-aurora-failover.md) and
[capacity](../docs/runbooks/alarm-aurora-capacity.md) procedures.

### Runbook: Queue age and dead-letter queues

Use the [queue age](../docs/runbooks/alarm-sqs-age.md) and
[dead-letter queue](../docs/runbooks/alarm-sqs-dlq.md) procedures.

### Runbook: Stuck outbox

Use the [stuck outbox](../docs/runbooks/alarm-outbox-stuck.md) procedure.

### Runbook: Roster sync failure age

Use the [stale roster](../docs/runbooks/alarm-roster-stale.md) procedure.

### Runbook: Membership sync failure

Use the [membership task failure](../docs/runbooks/alarm-membership-sync-failure.md)
procedure.

### Runbook: Outbox to provider latency

Use the [Expo](../docs/runbooks/provider-expo.md),
[SES](../docs/runbooks/provider-ses.md), and
[SMS](../docs/runbooks/provider-sms.md) provider procedures.

### Runbook: Expo push worker health

Use the
[Expo push worker health](../docs/runbooks/alarm-push-worker-health.md)
procedure.

### Runbook: Metrics collector

Use the [metrics collector](../docs/runbooks/alarm-metrics-collector.md)
procedure.

### Runbook: Shallow canary

Use the [shallow canary](../docs/runbooks/alarm-canary-failure.md) procedure.
