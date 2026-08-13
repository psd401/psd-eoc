# Alarm runbook: shallow canary failure

**Alarm ID / CloudWatch deep link: BLOCKED BY #29.** The one-minute canary and
alarm are not deployed.

## Meaning

Issue #29 plans a synthetic health transaction against a synthetic roster with
no provider sends. The canary must be unmistakably test-only and excluded from
real dashboards and records. #29 is currently blocked because that exclusion
cannot be proved with its original model/scope. Do not enable a canary that
pollutes retained drill records or can route to a provider.

## Safety posture

- A scheduled canary may never start a real incident, send a real
  notification, issue an all-clear, or close a real event.
- It may never use a staff roster or routable endpoint.
- Do not manually trigger the transaction in production to diagnose it.
- If evidence shows a real/drill event, staff audience, provider call, or
  human-only action, classify **SEV-0**, preserve evidence, and follow
  [emergency-disable.md](emergency-disable.md).

## Respond

1. Confirm account `338414773271`, region `us-west-2`, canary identity,
   scheduled time, last success, and alarm transition. Final identifiers are
   **BLOCKED BY #29**.
2. Check App Runner `/api/health` read-only and compare App Runner, Aurora, SQS,
   and Secrets reachability evidence planned by #29. The health route itself
   must remain side-effect-free.
3. Review canary logs for a bounded stage/reason code. Verify the transaction
   was classified `test`, used a synthetic roster, selected only mocked and
   provably unroutable endpoints, and made zero provider calls.
4. Verify any retained canary evidence is excluded exactly as #29 specifies.
   Absence from a dashboard is not enough; query/projection tests and deployed
   evidence must agree.
5. If user paths and dependencies are healthy and only scheduler/monitoring
   failed, classify **SEV-3**. If the canary exposes a real dependency outage,
   follow that alarm runbook at its higher severity.

## Recover and verify

Fix or roll back the proven monitoring/runtime defect. Do not relax synthetic
guards, change classification, add a live provider credential, or use real
recipients to make the canary pass. Confirm the next scheduled run succeeds,
the final #29 alarm returns to normal within its required window, no provider
call occurred, and excluded test evidence remains excluded. Record both the
canary result and the independent user-path evidence; neither substitutes for
the other.
