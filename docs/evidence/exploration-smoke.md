# Exploration-smoke deployment evidence

Status: **configured-unverified; no AWS, GCP, DNS, or provider write is proved**

This record is the durable evidence template for the isolated
`PsdEocExplorationSmoke` environment from issue #163, with the private native
PostgreSQL deployment path superseded by issue #178. It is not a production
go-live record. It must contain synthetic data and identifiers only: never a
secret value, OAuth credential, session cookie, raw token, real recipient list,
or provider payload.

Kris Hagel selected the isolated synthetic AWS shape and allowed real Google
OIDC as its sole potentially live integration on 2026-08-15. That architecture
decision is not approval of an AWS, GCP, DNS, notification-provider, or mobile
store write. Each write still requires the exact preview and protected
environment approval described below.

## Fixed boundary

| Field                   | Required value                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------ |
| AWS account alias       | `psd401`                                                                             |
| AWS account ID          | `338414773271`                                                                       |
| AWS region              | `us-west-2`                                                                          |
| CloudFormation stack    | `PsdEocExplorationSmoke`                                                             |
| Environment tag         | `exploration-smoke`                                                                  |
| Data classification tag | `synthetic-only`                                                                     |
| GitHub workflow         | `.github/workflows/deploy-exploration-smoke.yml`                                     |
| GitHub environment      | `exploration-smoke` with required reviewers and main-only deployment protection      |
| Identity                | Google OIDC, hosted domain `psd401.net`, one approved immutable subject              |
| Roster/access data      | One idempotent synthetic staff access fixture; no Groups call and no student data    |
| Notification channels   | Disabled and mocked; no recipients, workers, provider credentials, or send authority |
| DNS/custom domain       | Out of scope; separately previewed and approved                                      |

The stack owns one App Runner service, one private Aurora PostgreSQL writer, an
App Runner VPC connector, a bounded NAT egress path, one protected ECS Fargate
bootstrap task definition/cluster/log group, one ECR repository, one
health-only SQS queue, and generated admin/application/approved-identity/cookie/API
secrets. Aurora's cluster HTTP endpoint is disabled. App Runner and the
bootstrap task connect directly on port 5432, require certificate-verified TLS
against the pinned AWS RDS CA bundle, and use a one-connection application
pool. Database security-group ingress is limited to the App Runner and
bootstrap security groups; the database subnets have no public route. The NAT
path provides required public HTTPS egress, including Google OIDC, without
making Aurora public. `ProvisionApplication=false` is permitted only for a
first-deployment foundation phase. An existing service, image digest, and
source SHA must never be changed during the candidate bootstrap phase of an
ordinary release. Aurora replacement/deletion takes a final snapshot; its
automated backup retention while running is one day. The database instance,
generated secrets, NAT resources, VPC connector, bootstrap resources, and queue
are deleted only on a separately approved stack teardown. The ECR repository
cannot be deleted while it contains an image, so image deletion is a separate
exact, human-reviewed prerequisite. The external Google OAuth secret is
referenced but not owned by the stack. App Runner creates provider-managed
`service` and `application` CloudWatch Logs
groups outside the synthesized resource inventory. The workflow discovers only
the two groups under the exact returned service ID, sets and reads back 14-day
retention, and records them separately. Setting retention is an irreversible
write for old log data: events older than 14 days permanently expire and are
ordinarily deleted by CloudWatch Logs within 72 hours. CloudFormation does not
own that retention setting, so teardown must inventory the exact groups rather
than assume stack deletion handled them. These are operational logs, not the
canonical event journal or delivery-evidence ledger; append-only application
truth remains in the retained database and is never rolled back or rewritten.

## Required immutable release record

Fill this section from the workflow preview before approving the protected
deployment job. Do not put staff identity values here; record their SHA-256
fingerprints so the approver and later readback can compare the exact protected
values without disclosing them.

The dispatch may supply an already known exact digest or the literal
`derive-in-preview`. In the latter case the preview creates the manifest in a
loopback-only registry, records its exact digest, proves a byte-preserving
registry copy, and the protected-environment approval binds that displayed
digest before any AWS write. The deploy job receives only that preview output.
The dispatch has ten inputs. `approved_identity_sha256` is exactly three
lowercase 64-hex SHA-256 values in `subject,email,display-name` order, separated
by two commas with no whitespace. The workflow parses all three fields only
after validating the whole string and compares them to protected environment
secrets without printing those values. `deployment_authority` is exactly
`role-arn|policy-inventory-sha256|permissions-boundary-arn-or-none`, with two
literal pipe delimiters and no whitespace. The preview validates and displays
all three authority fields; the deploy job requires them to equal the protected
environment variables and the stable live IAM readback before any AWS write.

| Evidence                                 | Required value                             |
| ---------------------------------------- | ------------------------------------------ |
| Product-owner change/approval reference  | `[PENDING]`                                |
| GitHub Actions run ID and URL            | `[PENDING]`                                |
| Workflow commit SHA                      | `[PENDING — 40 lowercase hex]`             |
| Requested source SHA                     | `[PENDING — 40 lowercase hex]`             |
| ECR manifest digest                      | `[PENDING — sha256 plus 64 lowercase hex]` |
| Synthesized template SHA-256             | `[PENDING]`                                |
| Google OAuth secret ARN (ARN only)       | `[PENDING]`                                |
| Deployment-role policy inventory SHA-256 | `[PENDING — 64 lowercase hex]`             |
| Deployment-role permissions boundary     | `[PENDING — exact ARN or none]`            |
| Approved Google subject SHA-256          | `[PENDING]`                                |
| Approved staff email SHA-256             | `[PENDING]`                                |
| Approved staff display-name SHA-256      | `[PENDING]`                                |
| Estimated monthly AWS cost (USD)         | `[PENDING]`                                |
| Pricing estimate/reference and timestamp | `[PENDING]`                                |
| Retention/deletion-policy summary        | `[PENDING]`                                |
| Previous deployed image digest, if any   | `[PENDING / NONE]`                         |

The cost entry must cover App Runner instance time, Aurora Serverless capacity
and storage/backups, the NAT gateway and processed bytes, App Runner VPC
connector traffic, the one-off Fargate bootstrap, ECR storage, Secrets Manager
secret-months/API calls, SQS requests, logs, and data transfer. A guessed number
is not approval. Attach a dated AWS Pricing Calculator or equivalent reviewed
estimate to the change reference.

## Consequence preview

Before an approver releases the `deploy` job, the workflow's `preview` job must
produce and retain a no-cloud-write artifact containing:

- the exact workflow/source SHA, requested ECR digest, synthesized template
  hash, stack/account/region, OAuth secret ARN, deployment-role policy hash and
  boundary expectation, cost estimate, and change reference;
- every synthesized resource type and logical ID, generated IAM action, tag,
  deletion policy, update-replace policy, and stack output;
- the NAT gateway, App Runner VPC connector, private database/bootstrap
  security-group paths, ECS cluster/task definition, bootstrap log group, and
  the disabled Aurora cluster HTTP endpoint;
- the two provider-managed App Runner log-group name patterns, their 14-day
  retention, and the consequence that older log events permanently expire;
- the exact phase-A command that preserves a live App Runner image/source while
  staging the candidate bootstrap image/source, the no-override Fargate
  `RunTask`/wait/log-read shape, and the phase-B promotion command;
- the expected one-writer/one-instance topology and the absence of SES, SNS,
  Expo, SMS, InformaCast, Google Groups, S3/media, scheduled actions, Lambda
  invocation, queue-send, or recipient authority;
- the consequences: AWS charges begin; synthetic application and audit data are
  written; an approved staff identity can sign in only after OAuth is valid;
  App Runner receives public HTTPS traffic at its provider URL and uses billed
  NAT egress for required public HTTPS; Aurora remains private and reachable
  only by native TLS from the two approved security groups; no custom-domain
  changes and no notification sends occur; and mobile apps remain blocked from
  an endpoint whose TLS/domain and sign-in have not been verified;
- rollback and stop conditions, including the previous immutable image digest.

The preview job has `contents: read` only. It must not request an OIDC token or
call AWS, GCP, DNS, mobile-store, or notification-provider APIs. Pinned
container/base-image reads and loopback-only registry writes are allowed. The
deploy job receives `id-token: write` only after GitHub's protected
`exploration-smoke` environment approval. The workflow must use no static AWS
access key and must reject any account, alias, region, stack, source SHA, image
digest, or OAuth secret ARN outside the fixed boundary.

## Prerequisites that must be proved, not assumed

- [ ] The GitHub `exploration-smoke` environment exists, allows deployments
      only from `main`, and requires Kris Hagel or a delegated human reviewer.
- [ ] `AWS_EXPLORATION_SMOKE_DEPLOY_ROLE_ARN` is an environment variable naming
      the reviewed OIDC deployment role in account `338414773271`; its trust and
      permissions are linked, and no static AWS credential is configured.
- [ ] The shared provider is exactly
      `arn:aws:iam::338414773271:oidc-provider/token.actions.githubusercontent.com`.
      The role trust contains one `sts:AssumeRoleWithWebIdentity` allow for that
      provider and exact `StringEquals` claims `aud=sts.amazonaws.com` and
      `sub=repo:psd401@1902994/psd-eoc@1326178900:environment:exploration-smoke`.
- [ ] `AWS_EXPLORATION_SMOKE_DEPLOY_POLICY_SHA256` contains the reviewed
      normalized deployment-role policy inventory hash, and
      `AWS_EXPLORATION_SMOKE_DEPLOY_PERMISSIONS_BOUNDARY_ARN` contains the exact
      reviewed boundary ARN or the literal `none`. The live attachment lists,
      inline documents, managed default versions, boundary, and role trust must
      remain stable across the gate and match both expectations before a write.
- [ ] The deployment role permits the required readback actions:
      `iam:GetOpenIDConnectProvider`, `iam:GetRole`, `iam:ListRolePolicies`,
      `iam:GetRolePolicy`, `iam:ListAttachedRolePolicies`, `iam:GetPolicy`,
      `iam:GetPolicyVersion`, and `iam:SimulatePrincipalPolicy`. It permits
      `logs:DescribeLogGroups` on `*` and `logs:PutRetentionPolicy` only on
      `arn:aws:logs:us-west-2:338414773271:log-group:/aws/apprunner/psd-eoc-exploration-smoke/*/application:*`
      and the corresponding `/service:*` ARN. Positive and neighboring-resource
      negative simulations must pass before provisioning.
- [ ] The deployment role also permits `ecs:RunTask` only for the output
      `BootstrapTaskDefinitionArn`, `ecs:DescribeTasks`,
      `ecs:DescribeTaskDefinition`, `logs:DescribeLogStreams` for the output
      `BootstrapLogGroupName`, and `logs:GetLogEvents` only for its
      `native-bootstrap/native-bootstrap/*` streams. `iam:PassRole` is limited
      to the exact output `BootstrapTaskExecutionRoleArn` and
      `BootstrapTaskRoleArn` with `iam:PassedToService=ecs-tasks.amazonaws.com`.
      The workflow positively simulates these direct permissions before
      `RunTask`; neither application runtime role receives them.
- [ ] The reviewed outer deployment policy restricts `sts:AssumeRole` to the
      exact required CDK bootstrap role resources. Its permissions boundary does
      not propagate into the CDK deploy or CloudFormation execution roles; those
      roles and their pass-role/execution authority are a separately linked,
      explicit prerequisite review rather than an inferred protection.
- [ ] App Runner existing-customer eligibility is read back from at least one
      existing district service; AWS stopped onboarding new App Runner customers
      after 2026-03-31.
- [ ] The correct district Google Cloud account/project owns a reviewed internal
      OAuth client with hosted-domain gate `psd401.net` and the exact callback.
- [ ] The five-field OAuth credential JSON exists in the separately reviewed
      Secrets Manager ARN; only metadata and ARN are recorded here.
- [ ] Protected environment secrets hold the approved immutable Google subject,
      staff email, and display name. CloudFormation stores them in one dedicated
      identity secret, and ECS/App Runner use JSON-key secret references. Their
      values are never task overrides, ordinary service variables, artifacts,
      or printed output.
- [ ] The exact source was reviewed and is reachable from `main`.
- [ ] The container built from that source, passed a local startup/health smoke,
      and produced exactly the requested manifest digest in a loopback-only
      registry before any external publication. The reviewed image contains the
      pinned AWS RDS CA bundle used by both native PostgreSQL clients.
- [ ] The synthesized template/policy tests and the full repository gate pass.
- [ ] The price/retention preview and rollback were reviewed.
- [ ] The product owner approved this exact source, digest, template hash,
      resources, IAM, estimate, consequences, and rollback in the protected job.

Any missing or mismatched item stops the run before an AWS write.

The normalized policy inventory is UTF-8 compact JSON with sorted object keys
and no trailing newline. It has this exact shape: `inlinePolicies` is sorted by
`policyName` and contains `{policyName,policyDocument}`; `attachedPolicies` is
sorted by `policyArn` and contains
`{policyName,policyArn,versionId,policyDocument}`; `permissionsBoundary` is
either `null` or `{policyArn,versionId,policyDocument}`. The workflow produces
that canonical artifact with `jq -cS` and hashes its exact bytes. Because the
OIDC role and trust must exist before the workflow can assume and inspect them,
their creation is a separately approved out-of-band AWS write. If the initial
policy hash is not already calculated out of band, set the protected hash to 64
zeroes and supply those same zeroes in `deployment_authority` for one
deliberately read-only discovery run. That run assumes the role, captures the
stable observed inventory/hash/boundary, fails closed before any AWS write, and
uploads the readback artifact. A human then reviews the artifact, sets the exact
protected expectations, and starts a fresh dispatch and approval using the same
exact values. The zero hash can never pass a deployment run.

## Deployment phases and exact command shape

The workflow is authoritative for quoting and parameter handling. Its preview
records the expanded, non-secret command shape below; protected values remain
masked.

1. Build the container from the repository root with
   `packages/server/container/exploration-smoke.Dockerfile`, run its local
   startup smoke, and require its OCI digest to equal the requested digest.
2. Assume the fixed-account deployment role through GitHub OIDC. Read back STS
   account `338414773271`, IAM alias `psd401`, region `us-west-2`, exact immutable
   OIDC trust, stable policy documents/default versions, and explicit boundary.
   Require the normalized policy hash and log-retention permission simulations
   to match the protected expectations before any write.
3. Deploy phase A with the reviewed Google secret ARN and all three protected
   identity fields as `NoEcho` parameters. On a missing or foundation-only
   stack, use `ProvisionApplication=false`, the all-zero `AppImageDigest`, and
   the candidate `SourceSha`. On a running stack, preserve its exact
   `ProvisionApplication=true`, `AppImageDigest`, and `SourceSha`. In both
   cases, set only `BootstrapImageDigest` and `BootstrapSourceSha` to the
   candidate. Read all four digest/source parameters back before publication;
   phase A must not update or remove an existing App Runner service.
4. Push the locally verified image to the stack's ECR repository, address it by
   digest, and require ECR readback to equal the requested digest.
5. Read the exact ECS cluster/task-definition/private-subnet/security-group/log
   group/task-role/execution-role outputs. Simulate the direct RunTask,
   describe, pass-role, and bounded log-read permissions. Describe the task
   definition and require the exact `repository-uri@digest`, candidate source,
   native PostgreSQL/TLS configuration, JSON-key secret references, Fargate
   network mode, and `native-bootstrap` command/log contract. Call `RunTask`
   once with `assignPublicIp=DISABLED`, provenance fields, and no environment or
   secret overrides; wait for that exact task to stop and require exit zero and
   the exact image digest. The task itself performs two full bootstrap passes,
   compares their summaries, and emits one JSON evidence line only after both
   admin and application sessions prove certificate-verified TLS. The workflow
   reads only that exact task stream and requires the source SHA, native
   transport, TLS, migrations, role boundary, deterministic seed/access counts,
   two equivalent runs, mocked Groups, and disabled messaging.
6. Only after step 5 succeeds, deploy phase B with
   `ProvisionApplication=true`, candidate `AppImageDigest`/`SourceSha`, and the
   same candidate bootstrap digest/source and protected parameters. Read all
   parameters back. This is the only phase allowed to promote App Runner.
7. From the exact returned App Runner ARN, verify the fixed service name and ID,
   discover only its `/application` and `/service` log groups, set both to
   14-day retention, and poll until the exact names, ARNs, and retention read
   back. Do not read or archive App Runner application log events; the only log
   content read by the workflow is the bounded one-off bootstrap summary.
8. Run resource, IAM, queue, database, App Runner, TLS/health, and zero-send
   readback. Store a redacted artifact and job summary; do not automatically
   edit this append-only evidence file.

The deployment workflow has no destroy mode. DNS, custom-domain, provider,
store, and notification actions are separate changes.

## Required deployment readback

- [ ] STS account, account alias, region, stack ID/status, and all resource
      physical IDs match the fixed boundary.
- [ ] Every supported resource has `Environment=exploration-smoke` and
      `DataClassification=synthetic-only`; none references `PsdEoc` production
      resources.
- [ ] ECR reports the exact requested manifest digest; App Runner has automatic
      deployment disabled and references `repository-uri@sha256:...` exactly.
- [ ] App Runner has exactly one minimum and one maximum instance.
- [ ] App Runner uses the exact output VPC connector, native
      `DATABASE_DRIVER=postgres`, endpoint port 5432, pinned CA path, source
      SHA, and bounded pool/timeouts (maximum 1, connect 10 seconds, idle 20
      seconds). Its database username/password and approved admin subject are
      JSON-key secret references, not ordinary runtime values. The sanitized
      artifact records names and network topology but no values.
- [ ] The exact App Runner service ID has only the expected `/application` and
      `/service` log groups under its prefix, both in account `338414773271` and
      region `us-west-2`, and both read back with 14-day retention. No App
      Runner log-event content or runtime environment value is captured.
- [ ] Aurora has one writer, no reader, its cluster HTTP endpoint disabled,
      encryption enabled, `rds.force_ssl=1`, no public endpoint/route, ingress
      only from the exact App Runner/bootstrap security groups on port 5432,
      and the reviewed backup/removal behavior.
- [ ] The runtime role trust contains only
      `tasks.apprunner.amazonaws.com`/`sts:AssumeRole`, has no permissions
      boundary or attached policy, and has exactly one inline policy. That
      policy has only two statements: get/describe its
      application/approved-identity/cookie/API/Google OAuth secret resources,
      and `sqs:GetQueueAttributes` on the health queue. It has no database API
      action; native database authorization is the private network plus the
      generated least-privilege PostgreSQL login.
- [ ] The runtime role has no `sqs:SendMessage`, SES/SNS/Expo/SMS, Google
      Groups, media/S3, scheduler, event source, notification-provider
      credential, recipient, or Lambda-invoke authority. The separate
      deployment role's OIDC trust, protected-environment boundary, and
      provisioning policy are recorded and reviewed; it is never used by the
      application runtime.
- [ ] The deployment-role trust, stable inline/attached/default-version policy
      inventory, explicit boundary (including `none`), canonical inventory
      SHA-256, exact Fargate/pass-role/bootstrap-log simulations, positive exact
      App Runner retention simulation, and neighboring-resource negative
      simulation match the protected approval. The evidence does not claim the
      outer boundary applies transitively to CDK/CloudFormation roles.
- [ ] The queue has no sender, event source, subscription, redrive producer, or
      message; it is used only by the side-effect-free deep-health read.
- [ ] Generated secrets are encrypted, referenced by ARN/JSON key, and never
      printed or passed as Fargate overrides.
- [ ] Fargate readback proves the exact cluster, private subnets, security
      group, task definition, task/execution roles, candidate source and image
      digest, `native-bootstrap` log stream, stopped state, and exit code zero.
- [ ] The single bootstrap summary proves two equivalent runs, deterministic
      migrations/seeds, native PostgreSQL transport, and certificate-verified
      admin/application sessions; LOGIN
      `psd_eoc_application` has membership only in migration-owned NOLOGIN role
      `psd_eoc_app` and is not superuser, createdb, createrole, replication, or
      bypassrls.
- [ ] Seed/access readback contains exactly one approved staff access fixture
      and four separate synthetic, non-routable roster recipients, identified
      only by fingerprints in this file; no student or live-recipient data
      exists and every notification channel is disabled.
- [ ] App Runner provider URL has valid HTTPS and `/api/health` succeeds against
      the exact deployed service through the certificate-verified native
      PostgreSQL path. Provider availability is not evidence of human sign-in
      or notification delivery.
- [ ] A human exercises Google OIDC with the approved district identity and
      records custom-domain callback, hosted-domain, token-validation, session,
      and authorization results only after the separately owned
      `eoc.psd401.net` DNS/certificate work is live. Until then web/mobile
      sign-in is `blocked` and Google OIDC stays `configured-unverified`.
- [ ] Web and mobile endpoint/TLS/sign-in results are recorded separately. The
      mobile configuration is not changed to an unverified provider URL.

Readback must retain `unknown` when evidence is unavailable. Stack success,
App Runner health, ECR acceptance, OAuth redirect, and provider acceptance must
not be overstated as human sign-in, human receipt, or live notification proof.

## Rollback and halt conditions

Stop before the next write if account/alias/region, source/digest/template,
resource inventory, role policy, secret ARN, approved-identity fingerprints,
cost, or consequence preview differs from approval. Stop if any notification
or recipient authority appears. Do not bypass TLS or OAuth errors.

For an application regression, redeploy the previously recorded immutable
image digest through a fresh workflow dispatch and protected approval. Database
migrations and journals are forward-only and append-only: never run a down
migration, rewrite history, or restore an older database over current truth.
`UPDATE_ROLLBACK_COMPLETE` is an admissible prior state only after the workflow
verifies its reverted parameters, outputs, and (when present) running App Runner
service/digest. `UPDATE_ROLLBACK_FAILED` and every other in-progress or failed
state halt; this workflow never calls `continue-update-rollback` or skips a
resource. Retrying always requires a fresh dispatch and approval. Reverting an
image does not restore CloudWatch log events that expired under the approved
14-day policy.
Do not delete the stack, database, secret, ECR repository, or evidence as an
automated rollback. Cost shutdown, resource teardown, DNS change, and secret
rotation each require a separate exact preview and product-owner approval.

## Append-only truth ledger

Never edit or delete an existing row. Add a superseding row when evidence
changes; include the prior row's date/run in the new row. A failed or partial
run remains recorded with `unknown` where readback did not complete.

| Recorded at (UTC) | Run/change reference   | AWS platform            | Google OIDC             | Groups/roster | Messaging providers | DNS/custom domain | Evidence summary                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ---------------------- | ----------------------- | ----------------------- | ------------- | ------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-15        | Issue #163 source only | `configured-unverified` | `configured-unverified` | `mocked`      | `mocked`            | `blocked`         | Deployable isolated configuration is under review. No AWS/GCP/DNS/provider write, resource readback, OAuth sign-in, TLS check, or live notification occurred.                                                                                                                                                                                               |
| 2026-08-15        | Issue #178 source only | `configured-unverified` | `configured-unverified` | `mocked`      | `mocked`            | `blocked`         | Supersedes only the architecture description from issue #163: reviewed source removes the cluster HTTP path in favor of private native PostgreSQL, a VPC connector/NAT egress path, and an exact-digest Fargate bootstrap gate. No AWS/GCP/DNS/provider write, native session, resource readback, OAuth sign-in, TLS check, or live notification is proved. |

## Current blockers

As of 2026-08-15, no workflow run or cloud readback has been attached. The
protected environment, exact OIDC deployment role, exact Google OAuth client
and secret ARN, normalized deploy-policy hash/boundary, reviewed CDK bootstrap
role authority, exact direct ECS/pass-role/bootstrap-log grants, approved
immutable identity fields, tested container digest, NAT-inclusive priced
consequence preview, custom-domain work, and product-owner approval for the
exact write all remain unproved here. Therefore the environment and Google OIDC
are not `live-verified`, web/mobile sign-in and DNS remain blocked, and every
messaging integration remains mocked with zero authorization for a live send.
