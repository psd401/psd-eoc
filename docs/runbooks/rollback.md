# Operations runbook: rollback

Use this runbook when a deployed PSD EOC application, worker,
infrastructure/configuration, or mobile release causes a proven regression.
Rollback is a production change and requires an exact consequence preview,
rollback point, and explicit product-owner approval. A safety stop may require
the service stopped first; it does not authorize an improvised deploy.

Current deployment, worker, and provider state lives only in the
[operational readiness register](../INTEGRATIONS.md). Confirm the exact active
boundary there before choosing a rollback point.

## Universal procedure

1. Start an append-only change/incident record. Confirm the configured
   environment, protected AWS account/region, current application/worker image
   digests, mobile build/runtime versions, infrastructure revision, database
   migration, secret version IDs, integration truth labels, and emergency-
   disable revision/epoch.
2. If the regression can misclassify real/drill, release unapproved work,
   expose a human-only action, or send through a blocked/unverified provider,
   stop the App Runner service before rolling back; there is no kill switch
   that stops delivery on its own.
3. Prove the last known-good artifact by immutable digest/version and evidence.
   A branch name, `latest` tag, mutable channel, or operator memory is not a
   rollback point.
4. Define scope: server, one or more workers, infrastructure/configuration,
   database, secret, web static assets, mobile OTA, or mobile store build.
5. Write a consequence preview: expected user impact, delivery effect, old/new
   control epochs, data/schema compatibility, provider changes, exact artifact,
   stop condition, and forward-recovery plan.
6. Obtain product-owner approval for the exact production change. A previous
   go-live approval does not authorize a later rollback.
7. Have a second responder compare the deployed and target digests/versions to
   the preview. Apply through the approved deployment/configuration surface.
   Server/infrastructure rollback uses the GitHub Actions `Deploy` workflow and
   immutable digest described in [CONFIGURATION.md](../CONFIGURATION.md).
8. Verify read-only health, control truth, safety invariants, metrics, logs,
   queue/outbox state, and append-only evidence. Do not send a live notification
   as a smoke test.
9. If delivery was disabled, keep it disabled until the separate re-enable
   procedure receives a fresh product-owner authorization and creates a new
   epoch. Rollback success is not re-enable approval.

## Server or App Runner rollback

- Select the exact prior same-account ECR image by SHA-256 digest. Confirm its
  contracts/schema compatibility and side-effect-free `/api/health` behavior.
- Do not enable App Runner auto-deploy, use a mutable tag, or substitute a local
  build.
- Verify service revision/digest, health, 5xx/latency, database access, current
  control state, and activation UI banners. Resolve ambiguous activation
  outcomes from immutable evidence; never retry for the user.

## Worker rollback

- Roll back only the affected central router/channel workers to exact immutable
  images/configuration. Preserve event-source filters, least privilege,
  integration truth gates, attempt fencing, retry limits, and provider
  authorization.
- Do not process old-epoch work after rollback. Do not purge or redrive queues.
- Verify provider-call counts, queue ages, DLQs, bounded reason codes, and
  append-only attempt/evidence transitions. `Unknown` remains unknown.

## Infrastructure or configuration rollback

- Produce a reviewed CloudFormation change set from a known commit/digest.
  Compare retained resources, deletion/replacement flags, IAM, networking,
  queues/DLQs, Aurora, KMS, DNS, SES, secrets, App Runner, and monitoring.
- Never roll back by deleting retained resources, disabling deletion
  protection, weakening IAM, or hand-editing console drift.
- Versioned application configuration is corrected by appending a superseding
  version with provenance. Emergency control is changed only by appending a
  new control entry; never delete or edit an epoch.
- A provider/DNS/secret change also follows its provider/rotation runbook and
  needs explicit product-owner approval.

## Database rollback

- Do not run a down migration, rewrite/delete journal/audit/delivery history,
  restore over the production cluster, or point production at an unvalidated
  restore.
- Prefer a forward-only compatibility fix. If recovery requires restore, keep
  delivery disabled and use [backup-restore.md](backup-restore.md) to create a
  separate isolated target under an independently approved recovery plan.
- Record schema version, backup/restore point, RPO/RTO, integrity/hash-chain
  evidence, and every unknown. Database recovery cannot silently discard a
  committed event or notification fact.

## Mobile rollback

- Stop a staged store rollout in the human store console when a build is
  unsafe. Never auto-submit or make an app public as a rollback.
- An OTA rollback may republish only an exact reviewed JavaScript-only known-
  good update to the matching runtime after preview-channel verification. Push,
  authentication, native/runtime, or safety-boundary changes require a new
  store build; do not force them through OTA.
- A store rollback uses a new reviewed build/version when Apple/Google does not
  permit reverting installed binaries. TestFlight/Play tester changes and
  submissions remain human provider writes that require current product-owner
  authorization.
- Verify real/drill theming, notification permissions/handling, biometric
  session behavior, and activation offline refusal on both platforms with
  synthetic non-production evidence.

## Completion evidence

- Trigger/root cause and severity: `[REQUIRED]`
- Current and target immutable versions/digests: `[REQUIRED]`
- Consequence preview and data/control-epoch impact: `[REQUIRED]`
- Product-owner approval reference/time: `[REQUIRED]`
- Operator and second verifier: `[REQUIRED]`
- Applied change/deployment evidence: `[REQUIRED]`
- Health/metrics/queue/DLQ/database/control verification: `[REQUIRED]`
- Ambiguous outcomes and disposition: `[REQUIRED]`
- Re-enable approval/new epoch, or `remains disabled`: `[REQUIRED]`
- Follow-up fix/gap and access-controlled evidence link: `[REQUIRED]`

Append corrections and later forward fixes. Never replace the original
rollback record.
