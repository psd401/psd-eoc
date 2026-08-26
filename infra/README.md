# PSD EOC infrastructure

`infra` owns the AWS CDK stack and credential-free synthesis checks. Tenant
context, protected workflow inputs, and current CloudFormation parameters are
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

The supported production path is `.github/workflows/deploy.yml` with GitHub
OIDC. A normal run selects a commit and leaves `rollback_image_digest` empty.
The workflow validates protected configuration, builds and publishes the
immutable image, stages the current bootstrap image, applies forward-only
migrations, updates the application, and verifies the deployed digest and
health. Manual `cdk deploy` commands are not maintained or supported.

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

### Runbook: Outbox to provider latency

Use the [Expo](../docs/runbooks/provider-expo.md),
[SES](../docs/runbooks/provider-ses.md), and
[SMS](../docs/runbooks/provider-sms.md) provider procedures.

### Runbook: Metrics collector

Use the [metrics collector](../docs/runbooks/alarm-metrics-collector.md)
procedure.

### Runbook: Monthly live delivery test

Use the
[monthly delivery-test alarm](../docs/runbooks/alarm-monthly-delivery-test.md)
procedure. A schedule may remind a human that a test is due; it may never send
one.

### Runbook: Shallow canary

Use the [shallow canary](../docs/runbooks/alarm-canary-failure.md) procedure.

The superseded infrastructure design and obsolete manual deployment command
are preserved as history in
[docs/archive/infrastructure/README-2026-08-25.md](../docs/archive/infrastructure/README-2026-08-25.md).
