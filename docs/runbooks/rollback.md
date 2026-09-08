# Operations runbook: rollback

Use this runbook when a deployed PSD EOC application, worker,
infrastructure/configuration, or mobile release causes a proven regression.
Rollback is a production change and requires an exact rollback point and
explicit product-owner approval. A safety stop may require the service stopped
first; it does not authorize an improvised deploy.

Current deployment, worker, and provider state lives only in the
[operational readiness register](../INTEGRATIONS.md). Confirm the exact active
boundary there before choosing a rollback point.

## Emergency notification stop

There is no in-app notification kill switch. When notification safety is
unknown, the emergency mechanism is to pause the serving and delivery runtimes
through their authenticated AWS control surfaces. This is a production change;
it does not start an incident, send a notification, issue an all-clear, or close
an event.

1. Start an append-only operations record. Record the exact environment,
   deployed revision, UTC stop-start time, responder roles, current queue/DLQ
   counts, oldest-message ages, configured retention deadlines, and last
   observed provider-call times. Do not record message bodies or recipient data.
2. Pause every provider-capable channel consumer first. Record each exact
   service, task, function, or event-source mapping and allow in-flight calls to
   reach a known outcome or remain `unknown`; do not retry them.
3. Disable the SQS event-source mapping for the canonical delivery router so no
   additional batch can move from the delivery queue to a channel queue.
4. Pause the App Runner service so no new web activation can be accepted. An
   unavailable activation surface is the honest state while delivery is paused.
5. Verify from read-only metrics and logs that every runtime reached its terminal
   paused or disabled state, in-flight invocations reached known outcomes or
   `unknown`, queue movement stopped, and provider-call counts do not increase.
   Then record a UTC quiescence fence after the latest confirmed state and
   observation. Missing or contradictory evidence keeps the system paused and
   escalates the response.
6. Do not purge, receive, delete, redrive, copy, or rewrite pending work. A pause
   does not suppress or alter an outbox row or queue message. SQS retention
   clocks keep running and can expire queued work; record each configured
   deadline and treat a vanished item as `unknown` unless immutable evidence
   proves its disposition.
7. Before resuming anything, reconcile every retained notification intent,
   outbox row, delivery batch, channel item, attempt, and provider outcome,
   regardless of timestamp. At minimum, account for everything created or
   attempted from the stop-start time through the quiescence fence and every
   later anomaly. Reconcile before a retention deadline can erase queue
   evidence.
8. An operations-record disposition does not enforce a provider-side stop. If
   any retained item is `unknown`, **BLOCKED**, unsafe, or must not send, keep
   the affected consumer paused until a separately reviewed and tested
   fail-closed change enforces its non-send disposition. Never resume a consumer
   merely because an item was classified in the record.
9. Resume only with product-owner approval for the exact affected runtimes and
   retained-work dispositions. Resume approved channel consumers, then the
   delivery router, and App Runner last. Record each state change and recheck
   queue movement, provider calls, health, and real/drill truth.

## Universal procedure

1. Start an append-only change/incident record. Confirm the configured
   environment, protected AWS account/region, current application/worker image
   digests, mobile build/runtime versions, infrastructure revision, database
   migration, secret version IDs, channel enablement, emergency-stop
   start/quiescence fences, and paused runtime state.
2. If the regression can misclassify real/drill, release unapproved work,
   expose a human-only action, or send through a disabled provider,
   follow the emergency notification stop before rolling back.
3. Prove the last known-good artifact by immutable digest/version and evidence.
   A branch name, `latest` tag, mutable channel, or operator memory is not a
   rollback point.
4. Define scope: server, one or more workers, infrastructure/configuration,
   database, secret, web static assets, or mobile store build. The current
   mobile profiles are embedded-only and have no OTA rollback path.
5. Record the expected user and delivery impact, pending work across the
   stop-start/quiescence interval, data/schema compatibility, provider changes,
   exact artifact, stop condition, and forward-recovery plan.
6. Obtain product-owner approval for the exact production change. A previous
   go-live approval does not authorize a later rollback.
7. Have a second responder compare the deployed and target commits, digests,
   and versions to the approved change record. Server/infrastructure rollback
   uses the one direct CDK command in [CONFIGURATION.md](../CONFIGURATION.md)
   from the current reviewed commit that contains the rollback-capable
   infrastructure. Select the older application only by its repository and
   immutable digest; do not check out or rebuild the older application commit.
   CDK builds the current bootstrap asset, and no separate image push or
   migration command is allowed.
8. For an App Runner image rollback, inspect the service status before running
   CDK. [App Runner rejects `UpdateService` while the service is paused](https://docs.aws.amazon.com/apprunner/latest/dg/manage-pause.html).
   Keep all
   provider consumers and the delivery router disabled, but if App Runner is
   paused, resume the currently deployed version and wait for `Running` before
   the CDK update. Record the UTC start of this web-activation window and account
   for any new intents or queue entries; do not resume delivery. If the web
   surface cannot safely be exposed for this bounded window, do not attempt the
   image rollback.
9. Run the approved direct CDK phase described for the rollback type. Verify
   read-only health, safety invariants, metrics, logs, queue/outbox state, and
   append-only evidence. Do not send a live notification as a smoke test.
10. If the emergency stop remains in force, pause App Runner again only after
    CloudFormation finishes updating it and verify the paused state. Keep every
    delivery runtime disabled until the reconciliation and separately approved
    resumption procedure above is complete. Rollback success is not approval to
    resume delivery.

## Server or App Runner rollback

- Select the exact prior application digest and its bounded repository selector:
  `CDK_ASSET_REPOSITORY` for a direct-CDK release or
  `LEGACY_APPLICATION_REPOSITORY` for a transition-era release. Confirm its
  contracts, forward-schema compatibility, and side-effect-free `/api/health`
  behavior. Supply both rollback parameters from
  [CONFIGURATION.md](../CONFIGURATION.md) on the direct CDK command. The stack
  derives the reviewed source identity from immutable ECR metadata and fails
  closed if it cannot prove exactly one commit. Do not enable App Runner
  auto-deploy, use a mutable tag, or push an ad hoc image.
- App Runner must be `Running` when CloudFormation updates the image. If an
  emergency stop paused it, follow universal step 8 while keeping the router and
  every provider-send consumer disabled; pausing App Runner is not a maintenance
  mode in which a replacement image can be deployed.
- Establish a persistently dark baseline from the same current reviewed
  infrastructure commit. If the deployed stack is not already dark at that
  revision, phase 1 leaves both rollback parameters at `CURRENT_CDK_ASSET`,
  persists every provider-send enable as false, resets push cutover to
  all-Expo, and waits
  for CloudFormation plus all three send services to reach zero. Phase 2 keeps
  those values unchanged and supplies only the selected rollback repository and
  digest. The preflight proves the previous stack state was already dark and
  checks pre-update desired, pending, and running counts before App Runner or a
  send service can change. A one-step rollback from provider-live state is
  rejected; an already-dark same-revision stack already satisfies phase 1. A
  failed phase 2 returns to that dark baseline. The retained SNS-to-SQS callback
  subscription is never removed. If a compatible callback consumer cannot
  remain active, its messages stay retained for verified redrive after a
  compatible application returns.
- A failed CloudFormation update automatically restores the previous image and
  does not launch the previous bootstrap task during rollback. An intentional
  rollback also keeps bootstrap, callback, and access sync on the current CDK
  asset; only App Runner selects the older digest. If the older application is
  not compatible with the forward-migrated database, do not force it and never
  run a down migration; ship a forward compatibility fix instead.
- Verify service revision/digest, health or expected paused state, 5xx/latency,
  and database access. Resolve ambiguous activation outcomes from immutable
  evidence; never retry for the user.

## Worker rollback

- Roll back only the affected central router/channel workers to exact immutable
  images/configuration. Preserve event-source filters, least privilege,
  integration truth gates, attempt fencing, retry limits, and provider
  authorization.
- Do not process unreconciled work retained across the stop-start/quiescence
  interval after rollback. Do not purge or redrive queues.
- Verify provider-call counts, queue ages, DLQs, bounded reason codes, and
  append-only attempt/evidence transitions. `Unknown` remains unknown.
- Re-enabling email after a rollback is a new deployment verification and a new
  authenticated administrator action. A previous reference never authorizes an
  older or changed runtime.

## Infrastructure or configuration rollback

- Produce a reviewed CloudFormation change set from a known commit/digest.
  Compare retained resources, deletion/replacement flags, IAM, networking,
  queues/DLQs, Aurora, KMS, DNS, SES, secrets, App Runner, and monitoring.
- Never roll back by deleting retained resources, disabling deletion
  protection, weakening IAM, or hand-editing console drift.
- Versioned application configuration is corrected by appending a superseding
  version with provenance. An emergency stop changes runtime state only; it
  never rewrites application, event, or delivery history.
- A provider/DNS/secret change also follows its provider/rotation runbook and
  needs explicit product-owner approval.

## Database rollback

- Do not run a down migration, rewrite/delete journal/audit/delivery history,
  restore over the production cluster, or point production at an unvalidated
  restore.
- Prefer a forward-only compatibility fix. If recovery requires restore, keep
  the application and delivery consumers paused and use
  [backup-restore.md](backup-restore.md) to create a separate isolated target
  under an independently approved recovery plan.
- Record schema version, backup/restore point, RPO/RTO, integrity/hash-chain
  evidence, and every unknown. Database recovery cannot silently discard a
  committed event or notification fact.

## Mobile rollback

- Stop a staged store rollout in the human store console when a build is
  unsafe. Never auto-submit or make an app public as a rollback.
- Do not publish, republish, check for, download, or route an OTA update. The
  exact current development, preview, and production profiles are
  embedded-only. Changing that policy requires a separately reviewed new app
  version, signed update design, and store build.
- Fix forward with a new reviewed app version and store build when Apple or
  Google does not permit reverting installed binaries. TestFlight/Play tester
  changes and submissions remain human provider writes that require current
  product-owner authorization.
- Verify real/drill theming, notification permissions/handling, biometric
  session behavior, and activation offline refusal on both platforms with
  synthetic non-production evidence.

## Completion evidence

- Trigger/root cause and severity: `[REQUIRED]`
- Current and target immutable versions/digests: `[REQUIRED]`
- Expected user/delivery impact and pending-work state across the stop interval: `[REQUIRED]`
- Product-owner approval reference/time: `[REQUIRED]`
- Operator and second verifier: `[REQUIRED]`
- Applied change/deployment evidence: `[REQUIRED]`
- Health or paused-state, metrics, queue/DLQ, and database verification: `[REQUIRED]`
- Ambiguous outcomes and disposition: `[REQUIRED]`
- Resumption approval and exact runtime order, or `remains paused`: `[REQUIRED]`
- Follow-up fix/gap and access-controlled evidence link: `[REQUIRED]`

Append corrections and later forward fixes. Never replace the original
rollback record.
