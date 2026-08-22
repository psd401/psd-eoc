# Live-pilot deployment evidence

Status: **issue #204 source is configured-unverified; no issue #204 AWS, DNS,
provider, recipient, or send write is proved**

This record is the durable evidence template for the staff-only live-pilot
stack, named `PsdEocExplorationSmoke` until the rename to `PsdEoc` on
2026-08-21. Issue #178
superseded its database path with private native PostgreSQL. Issue #204
reclassifies the source boundary from synthetic exploration to staff-minimized
live pilot and adds dark SES readiness; it does not activate or exercise email.
Never record a secret value, OAuth credential, session cookie, raw token, real
recipient address/list, or provider payload here.

Kris Hagel authorized the staff-only live pilot and, on 2026-08-16, authorized
removing exploration-only blocks and preparing live provider configuration.
The binding human-only notification boundary remains unchanged. Issue #204
stops before activation: the canonical SES configuration set is disabled,
runtime and worker roles have zero SES authority, and no executable email
worker, provider call, cloud mutation, recipient mutation, or send is included.

## Fixed boundary

| Field                   | Required value                                                                   |
| ----------------------- | -------------------------------------------------------------------------------- |
| AWS account alias       | `psd401`                                                                         |
| AWS account ID          | `<aws-account-id>`                                                                   |
| AWS region              | `us-west-2`                                                                      |
| CloudFormation stack    | `PsdEoc`                                                         |
| Environment tag         | `live-pilot`                                                                     |
| Data classification tag | `staff-minimized`                                                                |
| GitHub workflow         | `.github/workflows/deploy.yml`                                                   |
| GitHub environment      | `production` with required reviewers and main-only deployment protection        |
| Identity                | Google OIDC, hosted domain `psd401.net`, one approved immutable subject          |
| Roster/access data      | Staff-only access; no student data; population changes are separately owned      |
| Notification channels   | Email `configured-unverified` and disabled; every other provider remains blocked |
| DNS/custom domain       | Out of scope; separately previewed and approved                                  |

The source stack owns one App Runner service, one private Aurora PostgreSQL writer, an
App Runner VPC connector, a bounded NAT egress path, one protected ECS Fargate
bootstrap task definition/cluster/log group, one ECR repository, one
health-only SQS queue, one dark email queue/DLQ, a non-executable email worker
role/log group, a disabled SES configuration set, an encrypted SES event topic,
and generated admin/application/approved-identity/cookie/API secrets. Aurora's
cluster HTTP endpoint is disabled. App Runner and the
bootstrap task connect directly on port 5432, require certificate-verified TLS
against the pinned AWS RDS CA bundle, and use a one-connection application
pool. Database security-group ingress is limited to the App Runner and
bootstrap security groups; the database subnets have no public route. The NAT
path provides required public HTTPS egress, including Google OIDC, without
making Aurora public. `ProvisionApplication=false` is permitted only for a
first-deployment foundation phase. An existing service, image digest, and
source SHA must never be changed during the candidate bootstrap phase of an
ordinary release. Aurora deletion protection is enabled and its automated
backup retention is 14 days. Aurora, generated secrets, ECR, queues, managed
log groups, the SES configuration set, evidence topic, and evidence key use
retention policies. A future teardown or data-retirement action is a separate
exact, human-reviewed decision. The external Google OAuth secret is
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

The verified SES identity is the existing account-level `psd401.net` domain;
the stack does not create or mutate an identity, hosted zone, DKIM record, MAIL
FROM domain, credential, or recipient. The fixed source sender is
`eoc-alerts@psd401.net`. The configuration set is
`psd-eoc-transactional`, with `SendingEnabled=false`; the encrypted evidence
topic is `psd-eoc-email-events`. The dark email worker role can consume only the
exact `psd-eoc-email` queue and has no `ses:*`, secrets, SNS, or runtime
deployment authority. No service or event source assumes that role.

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
- the expected one-writer/one-instance topology; retained email queue/DLQ;
  disabled SES configuration set; encrypted SES event topic/key; exact
  queue-only dark-worker policy; and the absence of SES send, provider
  credential, executable worker, event-source, subscription, queue-send,
  recipient, Expo, SMS, InformaCast, Google Groups, S3/media, scheduled-action,
  or Lambda-invocation authority;
- the consequences: AWS charges begin; staff-minimized application and audit
  data are retained; an approved staff identity can sign in only after OAuth is valid;
  App Runner receives public HTTPS traffic at its provider URL and uses billed
  NAT egress for required public HTTPS; Aurora remains private and reachable
  only by native TLS from the two approved security groups; the dark email
  readiness resources incur charges but cannot send; no custom-domain changes
  and no notification sends occur; and mobile apps remain blocked from
  an endpoint whose TLS/domain and sign-in have not been verified;
- rollback and stop conditions, including the previous immutable image digest.

The preview job has `contents: read` only. It must not request an OIDC token or
call AWS, GCP, DNS, mobile-store, or notification-provider APIs. Pinned
container/base-image reads and loopback-only registry writes are allowed. The
deploy job receives `id-token: write` only after GitHub's protected
`production` environment approval. The workflow must use no static AWS
access key and must reject any account, alias, region, stack, source SHA, image
digest, or OAuth secret ARN outside the fixed boundary.

## Prerequisites that must be proved, not assumed

- [ ] The GitHub `production` environment exists, allows deployments
      only from `main`, and requires Kris Hagel or a delegated human reviewer.
- [ ] `AWS_DEPLOY_ROLE_ARN` is an environment variable naming
      the reviewed OIDC deployment role in account `<aws-account-id>`; its trust and
      permissions are linked, and no static AWS credential is configured.
- [ ] The shared provider is exactly
      `arn:aws:iam::<aws-account-id>:oidc-provider/token.actions.githubusercontent.com`.
      The role trust contains one `sts:AssumeRoleWithWebIdentity` allow for that
      provider and exact `StringEquals` claims `aud=sts.amazonaws.com` and
      `sub=repo:psd401@1902994/psd-eoc@1326178900:environment:production`.
- [ ] `AWS_DEPLOY_POLICY_SHA256` contains the reviewed
      normalized deployment-role policy inventory hash, and
      `AWS_DEPLOY_PERMISSIONS_BOUNDARY_ARN` contains the exact
      reviewed boundary ARN or the literal `none`. The live attachment lists,
      inline documents, managed default versions, boundary, and role trust must
      remain stable across the gate and match both expectations before a write.
- [ ] The deployment role permits the required readback actions:
      `iam:GetOpenIDConnectProvider`, `iam:GetRole`, `iam:ListRolePolicies`,
      `iam:GetRolePolicy`, `iam:ListAttachedRolePolicies`, `iam:GetPolicy`,
      `iam:GetPolicyVersion`, and `iam:SimulatePrincipalPolicy`. It permits
      `logs:DescribeLogGroups` on `*` and `logs:PutRetentionPolicy` only on
      `arn:aws:logs:us-west-2:<aws-account-id>:log-group:/aws/apprunner/psd-eoc/*/application:*`
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
   `packages/server/container/psd-eoc.Dockerfile`, run its local
   startup smoke, and require its OCI digest to equal the requested digest.
2. Assume the fixed-account deployment role through GitHub OIDC. Read back STS
   account `<aws-account-id>`, IAM alias `psd401`, region `us-west-2`, exact immutable
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
- [ ] Every supported resource has `Environment=live-pilot` and
      `DataClassification=staff-minimized`; physical names
      are retained only for compatibility.
- [ ] ECR reports the exact requested manifest digest; App Runner has automatic
      deployment disabled and references `repository-uri@sha256:...` exactly.
- [ ] App Runner has exactly one minimum and one maximum instance.
- [ ] App Runner uses the exact output VPC connector, native
      `DATABASE_DRIVER=postgres`, endpoint port 5432, pinned CA path, source
      SHA, and bounded pool/timeouts (maximum 1, connect 10 seconds, idle 0
      seconds). Its database username/password and approved admin subject are
      JSON-key secret references, not ordinary runtime values. The sanitized
      artifact records names and network topology but no values.
- [ ] The exact App Runner service ID has only the expected `/application` and
      `/service` log groups under its prefix, both in account `<aws-account-id>` and
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
- [ ] The App Runner runtime role has no `sqs:SendMessage`, SES/SNS/Expo/SMS, Google
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
- [ ] The health queue has no sender, event source, subscription, redrive
      producer, or message; it is used only by the side-effect-free deep-health
      read.
- [ ] The email queue and DLQ are encrypted, retained, and linked only by the
      exact max-five-receive redrive policy. The dark email worker role has only
      `ChangeMessageVisibility`, `DeleteMessage`, `GetQueueAttributes`,
      `GetQueueUrl`, and `ReceiveMessage` on the source queue. It has no SES,
      SNS, secret, pass-role, or wildcard action; no ECS service, Lambda, event
      source, subscription, or queue producer invokes it.
- [ ] SES identity readback proves existing domain `psd401.net` without a stack
      identity or DNS mutation. The `psd-eoc-transactional` configuration set
      reads back `SendingEnabled=false`; its complete event-type destination
      targets retained encrypted topic `psd-eoc-email-events`. The evidence KMS
      and SNS policies allow only the SES service from account `<aws-account-id>`
      and that exact configuration-set ARN. No `ses:SendEmail` or
      `ses:SendRawEmail` action exists in any live-pilot runtime/worker role.
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
- [ ] Staff access readback is handled by its separately owned bootstrap/access
      change. It contains no student data and is not reused as a notification
      recipient list. Every notification channel remains disabled.
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

| Recorded at (UTC) | Run/change reference                    | AWS platform            | Google OIDC             | Groups/roster           | Messaging providers     | DNS/custom domain | Evidence summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | --------------------------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-15        | Issue #163 source only                  | `configured-unverified` | `configured-unverified` | `mocked`                | `mocked`                | `blocked`         | Deployable isolated configuration is under review. No AWS/GCP/DNS/provider write, resource readback, OAuth sign-in, TLS check, or live notification occurred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-08-15        | Issue #178 source only                  | `configured-unverified` | `configured-unverified` | `mocked`                | `mocked`                | `blocked`         | Supersedes only the architecture description from issue #163: reviewed source removes the cluster HTTP path in favor of private native PostgreSQL, a VPC connector/NAT egress path, and an exact-digest Fargate bootstrap gate. No AWS/GCP/DNS/provider write, native session, resource readback, OAuth sign-in, TLS check, or live notification is proved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-08-16        | Issue #204 source only                  | `configured-unverified` | `configured-unverified` | `configured-unverified` | `configured-unverified` | `blocked`         | Supersedes only the environment/email source description from issue #178: staff-minimized live-pilot tags and retained data safeguards replace synthetic-only lifecycle defaults. Read-only SES inventory proved production access and the existing verified `psd401.net` domain, while source defines a disabled canonical configuration set, encrypted event evidence, and a dark queue consumer with zero SES permission. No cloud/provider/recipient mutation, provider call, or notification send occurred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-08-21        | Deployed stack, access-sync task rev 27 | `live-verified`         | `configured-unverified` | `live-verified`         | `configured-unverified` | `live-verified`   | Supersedes only the platform, Groups/roster, and DNS columns from the 2026-08-16 issue #204 row. The deployed stack raises 13 CloudWatch alarms, all `OK`, each with one action, routed to two SNS topics carrying a confirmed SMS subscription, a confirmed email subscription, and the `psd-eoc-alarm-mailer` SES function. ECS task `psd-eoc-exploration-smoke-access-sync:27` read the retained Cloud Identity credential, called the provider, exited 0, and published access-membership snapshot version 176 from 1 active access group and 5 evaluated memberships at `2026-08-21T21:08:45.588Z`, `publication` `created`; evidence is counts and digests only, with no address, member payload, group ID, or token. Google OIDC advances from `blocked` to `configured-unverified` only: `GET https://eoc.psd401.net/auth/sign-in` returns `302` to the provider with the live client ID and registered callback, and the access gate no longer refuses afterwards, but no completed district sign-in is observed. Messaging providers are unchanged and unproved. |

## Current blockers

For issue #204, deployment and activation remain separate. The protected
workflow owner must first integrate and preview the retained queue, log, KMS,
SNS, and disabled SES resources without weakening its exact-digest/bootstrap/
IAM readback. Before a later email activation, PSD EOC still needs a production
durable SES send ledger, an executable worker and invocation verifier, exact
least-privilege `ses:SendEmail` authority, delivery-evidence consumption and
retention ownership, operational alarms, rollback, and a deployed readback.

The first controlled email must be selected at action time and stored only in
authorized application data, never source, issue text, workflow input, or
artifacts. The authenticated human must see the exact consequence preview and
confirm it in the app immediately before the send. A single authorized staff
target, SES provider acceptance, and human receipt are three different facts;
each remains `unknown` until separately proved. Expo push remains blocked on
issue #40 credentials and physical-device evidence. SMS remains blocked by the
account sandbox and missing verified destination, origination identity,
registration, pool/sender ID, and protection configuration.
