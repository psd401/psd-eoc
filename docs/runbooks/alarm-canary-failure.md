# Alarm runbook: shallow canary failure

**Source-defined CloudWatch alarm name:**
`psd-eoc-one-minute-canary-failure`.

**Deployment/read-back truth:** issue #29 source landed in pull request #96,
but no approved deployment, CloudWatch read-back, alarm-action exercise, or
console deep link is recorded. Treat the alarm as **live-unverified** and the
deep link as unavailable until #91 supplies that evidence.

## Meaning

The source-defined one-minute canary runs the canonical lifecycle only as
`TEST` / drill / synthetic / mocked inside a server-controlled transaction that
is always rolled back. Its role has no database, queue, or provider-send
permission. The alarm fires when canary success is below `1` for 2 consecutive
minutes; missing data is breaching. Source tests and synthesized IAM are not
proof that the deployed canary preserves those boundaries.

## Safety posture

- A scheduled canary may never start a real incident, send a real
  notification, issue an all-clear, or close a real event.
- It may never use a staff roster or routable endpoint.
- Do not manually trigger the transaction in production to diagnose it.
- If evidence shows a real/drill event, staff audience, provider call, or
  human-only action, classify **SEV-0**, preserve evidence, and follow
  [rollback.md](rollback.md).

## Respond

1. Confirm account `<aws-account-id>`, region `us-west-2`, exact alarm name,
   source-defined function name `psd-eoc-one-minute-canary`, scheduled time,
   last success, and alarm transition against deployed read-back evidence.
2. Check App Runner `/api/health` read-only and compare App Runner, Aurora, SQS,
   and Secrets reachability evidence. The health route itself
   must remain side-effect-free.
3. Review canary logs for a bounded stage/reason code. Verify the transaction
   was classified `test`, used a synthetic roster, selected only mocked and
   provably unroutable endpoints, and made zero provider calls.
4. Verify the outer transaction rolled back and no event, journal, outbox,
   queue, provider, or real-dashboard record persisted. Absence from one
   dashboard is not enough; database, logs, metrics, and deployed permissions
   must agree.
5. If user paths and dependencies are healthy and only scheduler/monitoring
   failed, classify **SEV-3**. If the canary exposes a real dependency outage,
   follow that alarm runbook at its higher severity.

## Recover and verify

Fix or roll back the proven monitoring/runtime defect. Do not relax synthetic
guards, change classification, add a live provider credential, or use real
recipients to make the canary pass. Confirm the next scheduled run succeeds,
the exact alarm returns to normal for its 2-minute evaluation window, no
provider call occurred, and no test transaction persisted. Record both the
canary result and the independent user-path evidence; neither substitutes for
the other.
