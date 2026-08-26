# Synthetic failure-recovery drill

This runbook defines a synthetic proof boundary. Record only completed evidence
in the [operational readiness register](../INTEGRATIONS.md); never infer live
provider readiness from mocked channel behavior.

Use the manual **Synthetic failure-recovery drill** GitHub Actions workflow.
Select the exact commit and run it; `run_id` is optional. The workflow assumes
the reviewed OIDC deployment role, creates one separately named disposable
stack, runs the proof, uploads sanitized evidence, and destroys that exact
stack even when an earlier step fails.

The drill stack is non-production by construction. It uses only
`example.invalid` identities, the synthetic roster, mocked provider adapters,
separate queues and secrets, a separate ECR repository, separate App Runner
service DNS, and a two-instance disposable Aurora cluster. It imports no Google
or notification-provider credential and creates no SES configuration. Its
CloudWatch alarms have no notification actions.

## One-time account boundary

Create a protected GitHub environment named `failure-drill`. Give it only the
non-secret `AWS_ACCOUNT_ID`, `AWS_REGION`, and `AWS_DEPLOY_ROLE_ARN` variables;
do not add or inherit environment secrets. The OIDC role's trust policy must
allow the exact repository subject for `environment:failure-drill` alongside
the existing production subject. Preserve the exact issuer and
`sts.amazonaws.com` audience, and copy the existing repository subject while
changing only its final environment name. Never replace the repository or
environment with a wildcard.

The drill entry point and the production deploy use separate concurrency
groups. A production deployment waiting for human approval must not block a
synthetic drill, and a long drill must not block that production approval.

## Scenarios

One run executes all eight scenarios against one commit, image digest, and
stack ID:

1. worker termination during fanout;
2. Aurora writer failover and native TLS reconnection;
3. Google IdP outage with a retained session;
4. dead-letter queue redrive;
5. duplicate provider callback;
6. delayed callback after append-only all-clear history;
7. device revocation during an event; and
8. partial roster-sync failure during activation.

The manifest fails the workflow if a scenario is missing, repeated, failed, or
reports a missing, unexpected, or duplicate mock side effect. The browser proof
also verifies recovery from a lost timeline read, drill classification,
keyboard-visible lifecycle controls, axe results, and desktop/mobile layouts.
It never starts a real incident, sends a real notification, issues a real
all-clear, or closes a real event.

## Evidence and cleanup

Download the `failure-drill-<workflow run>` artifact. It contains the pending
and cleanup-finalized manifests, bounded task log messages, browser evidence,
and deployed desktop/mobile screenshots. A successful final manifest has
`cleanup.status: complete` and an empty `remainingResources` list.

If cleanup fails, preserve the workflow logs and delete only the stack named in
the run summary before rerunning. Do not manually redrive ambiguous provider
work. Fix any divergence and rerun the entire eight-scenario workflow against
one new immutable revision.

The current drill uses explicit mocked channel composition while issues #277
and #278 remain open. Repeat the full workflow after those worker compositions
land before treating their runtime paths as final readiness evidence.
