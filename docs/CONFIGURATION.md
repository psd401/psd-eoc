# Configuration and deployment index

This is the current index of portable tenant configuration and direct CDK
deployment parameters. Tenant configuration is split across two files in
`infra/`. `cdk.json` is committed and holds only what any district can share:
CDK feature flags, the threat list, and the synthetic test groups. Everything
that identifies the operating district lives in git-ignored `cdk.local.json`.
The committed `cdk.local.example.json` lists every local key with a synthetic
"Example School District" tenant; a district copies it to `cdk.local.json` and
replaces every value before its first synthesis. `infra/bin/synthesize-example.ts`
builds a reserved second-district fixture to prove the stack is portable without
cloud credentials or provider calls.

The documentation contract compares the marked lists below with the keys in
`cdk.json` and `cdk.local.example.json`;
changing a key in code without updating this index fails `bun run verify:docs`.

## Tenant manifest: CDK context

<!-- docs-contract:cdk-context:start -->

- `psdEoc:applicationOrigin`
- `psdEoc:awsAccount`
- `psdEoc:awsAccountAlias`
- `psdEoc:awsOperatorProfile`
- `psdEoc:awsRegion`
- `psdEoc:awsSsoStartUrl`
- `psdEoc:displayTimeZone`
- `psdEoc:facilities`
- `psdEoc:gcpBillingAccount`
- `psdEoc:gcpOrganizationId`
- `psdEoc:gcpProjectId`
- `psdEoc:gcpTerraformAdminEmail`
- `psdEoc:gcpTerraformStateBucket`
- `psdEoc:hostedDomain`
- `psdEoc:hostedZoneId`
- `psdEoc:iosBundleId`
- `psdEoc:monitoringRunbookBaseUrl`
- `psdEoc:neighborhoods`
- `psdEoc:organizationName`
- `psdEoc:privacyContactUrl`
- `psdEoc:sesFromAddress`
- `psdEoc:sesIdentityDomain`
- `psdEoc:sesOperationsIdentityDomain`
- `psdEoc:smsSupportEmail`
- `psdEoc:smsSupportPhone`
- `psdEoc:sourceRepositoryUrl`
- `psdEoc:syntheticGroups`
- `psdEoc:threats`

<!-- docs-contract:cdk-context:end -->

### Local tenant context

`infra/cdk.local.json` carries every key above except `psdEoc:syntheticGroups`
and `psdEoc:threats`, which stay in `cdk.json`. Git ignores it;
`infra/src/tenant-context.ts` merges it with `cdk.json` for the CDK app and for
the operator scripts under `infra/src/ops`, `infra/gcp/scripts`, and
`scripts/ops`. Start from `infra/cdk.local.example.json`. Besides the stack's
identity, target, sender, and facility keys, it holds:

- `psdEoc:awsAccount` — the 12-digit deployment account
- `psdEoc:smsSupportPhone` — the E.164 support number in SMS consent copy
- `psdEoc:sesOperationsIdentityDomain` — the SES identity the scripts under
  `infra/src/ops` inspect and send their verification message from
- `psdEoc:awsOperatorProfile` and `psdEoc:awsSsoStartUrl` — the AWS CLI profile
  and IAM Identity Center start URL the GCP operator tooling requires
- `psdEoc:gcpBillingAccount`, `psdEoc:gcpOrganizationId`, `psdEoc:gcpProjectId`,
  `psdEoc:gcpTerraformStateBucket`, and `psdEoc:gcpTerraformAdminEmail` — the
  Google Cloud identity only the tooling under `infra/gcp` reads; it passes
  them to both Terraform roots as variables and the state bucket as
  `-backend-config`

Each key lives in exactly one file: the CDK app refuses to run when `cdk.json`
or a `-c` flag overrides a local key, and the merged reader refuses a key
defined in both, so the deployed stack and the operator scripts cannot
disagree. Synthesis and deployment fail without the file because
`readDeploymentTarget` and `readDeploymentIdentity` require its keys. CI never
has it: the stack tests read `cdk.local.example.json` and CI synthesizes the
second-district fixture. AWS operator scripts treat a missing file as the
reserved account `000000000000`, which matches no live credential, so they
refuse every AWS mutation until the file exists; the GCP tooling refuses to
start. `infra/cdk.context.json`, the context cache CDK may write beside it, is
ignored for the same reason: its keys embed the account. The stack names its
availability zones directly, so nothing depends on that cache.
`infra/gcp/aws.config` follows the same pattern; copy `aws.config.example` and
fill in the account.

Identity, target account/region, facility data, sender identity, and runbook
base URL are configuration. `readDeploymentTarget` and
`readDeploymentIdentity` validate these values during synthesis. Facilities,
neighborhoods, synthetic groups, and threats are validated again before
bootstrap.

`psdEoc:facilities` lists the district's schools: each entry has a `code`
(upper-case letters, digits, and hyphens), a `name`, optionally
`active: false` for a site that no longer hosts events, and optionally
`isolated: true`. An isolated facility's events reach its own building
sources only, never the district-wide others lists; it exists for a place
whose drills must not page the district, such as the site an app store
reviewer runs a drill at (see the
[app store review account](runbooks/app-store-review.md) runbook). The
bootstrap creates any facility the database lacks and never edits one that
exists.

`psdEoc:threats` is the list an operator chooses from before the response
when starting an incident or a drill; operators see it alphabetically, with
an entry that requires a description last, whatever order it is declared in. Each entry has a lower-case
`key` the bootstrap matches on, a `name`, and optionally `requiresDetail: true`
for an entry such as "Other" that cannot be chosen without a typed
description. The bootstrap creates any threat the database lacks and never
edits one that exists, so a rebuilt database regains the district's list and a
later configuration change never reshuffles or renames what operators have
learned.

`psdEoc:hostedZoneId` names the Route 53 zone that answers for the hosted
domain. The deployment writes the application's public record there from the
running service, so the two cannot drift. A record for the same name kept
anywhere else — a split-horizon resolver inside the district network, for
example — will shadow it, and `scripts/ops/public-address.ts` reports that from
wherever it is run.

## Local runtime environment

`.env.example` is a complete non-routable local identity. The synthetic
database helper copies it to ignored root and server `.env.local` files and
replaces only the loopback database URLs with Docker's assigned port. Required
names are:

- `DATABASE_DRIVER`
- `DATABASE_URL`
- `GOOGLE_OIDC_APPLICATION_ORIGIN`
- `GOOGLE_OIDC_HOSTED_DOMAIN`
- `PSD_EOC_DISPLAY_TIME_ZONE`
- `PSD_EOC_IOS_BUNDLE_ID`
- `PSD_EOC_ORGANIZATION_NAME`
- `PSD_EOC_PRIVACY_CONTACT_URL`
- `PSD_EOC_SMS_SUPPORT_EMAIL`
- `PSD_EOC_SMS_SUPPORT_PHONE`
- `TEST_DATABASE_URL`

## Direct CDK deployment boundary

The repository has no deployment workflow and no GitHub deployment
environment, variables, secrets, or OIDC role. An operator authenticates to
AWS locally with short-lived credentials and supplies deployment values
directly to `cdk deploy`. Sensitive values remain in AWS Secrets Manager or the
operator's local environment and are never committed.

CDK derives the exact Git commit from the local checkout, refuses a dirty
protected deployment, builds and publishes the server image as a
content-addressed CDK asset, resolves that asset to an immutable ECR digest,
and runs the native bootstrap task. CloudFormation does not promote App Runner,
the channel workers, the callback worker, or the access-sync schedule until the
bootstrap container exits successfully. No separate image-build, image-push,
migration, or promotion command exists.

## Synthesized CloudFormation parameters

The current synthesized stack contains exactly these parameters:

<!-- docs-contract:template-parameters:start -->

- `BootstrapVersion`
- `EnableAwsEumSmsWorker`
- `EnableDirectPush`
- `EnableEmailWorker`
- `EnableExpoPushWorker`
- `EnableMediaMalwareScanning`
- `GoogleGroupsSecretArn`
- `GoogleOauthSecretArn`
- `InitialAccessGroupEmail`
- `InitialAccessGroupId`
- `InitialAccessGroupName`
- `InitialMobileTransitionEmailSha256`
- `OperationsTeamAlarmEmail`
- `OperationsTeamAlarmSmsNumber`
- `ProvisionApplication`
- `ProvisionAwsEumSmsResources`
- `PushProviderCutover`
- `RollbackApplicationImageDigest`
- `RollbackApplicationRepository`
- `RuntimeDatabaseIdleTimeoutSeconds`
- `SmsDestinationCountryCode`
- `SmsHelpMessage`
- `SmsOriginationIdentityArn`
- `SmsStopMessage`

<!-- docs-contract:template-parameters:end -->

`BootstrapVersion` is the CDK-generated bootstrap-stack compatibility
parameter and has a default. Push and SMS workers, direct-provider enablement,
and their evidence inputs default to safe, dark, or unconfigured states when
optional values are absent. Parameters without defaults must be supplied
directly to `cdk deploy`.

Normal deployments leave both rollback parameters at `CURRENT_CDK_ASSET`.
They exist only to recover App Runner to an exact digest already retained in
either the CDK asset repository (`CDK_ASSET_REPOSITORY`) or the transition-era
application repository (`LEGACY_APPLICATION_REPOSITORY`). A rollback supplies
the repository selector and digest on the same direct CDK command. CloudFormation
derives the source commit from the selected immutable image and refuses a
missing, ambiguous, malformed, or unsupported provenance record. The database
bootstrap, callback worker, and access-sync task stay on the current CDK asset,
while a CloudFormation quiescence barrier proves that every provider-send
worker is at zero before App Runner can select the older digest.

Intentional rollback requires a previously completed, persistently dark
baseline from the same current reviewed infrastructure commit. If the deployed
stack does not already meet that exact baseline, create it with two direct CDK
updates:

1. Leave both rollback parameters at `CURRENT_CDK_ASSET`. Persist `false` for
   `EnableExpoPushWorker`, `EnableDirectPush`, `EnableAwsEumSmsWorker`, and
   `EnableEmailWorker`; reset the Expo, direct-push, and SES verification
   references to `UNVERIFIED`; reset `PushProviderCutover` to its all-Expo
   default; and wait for that update and all three send services to reach zero.
2. Keep that dark configuration unchanged and run the direct CDK command again
   with the selected rollback repository and digest. The preflight compares the
   custom resource's previously persisted properties and the pre-update ECS
   counts before App Runner or any send service can change. A one-step rollback
   from provider-live state is rejected. An already-dark deployment at the same
   infrastructure revision satisfies step 1 without a no-op update.

If the second update fails, CloudFormation therefore returns to the already-dark
first update rather than restoring live provider workers. Clearing the rollback
selector later also remains dark until a separately approved deployment
explicitly re-enables a provider. `EnableAwsEumSmsWorker=false` remains the
send boundary.

The source also defines three canary-only parameters inside the full monitoring
composition: `MonitoringCanaryCredentialSecretArn`,
`MonitoringCanaryFacilityId`, and `MonitoringCanaryEventTypeVersionId`. The
current stack calls `configureInfrastructureMonitoring`, not the full canary
composition, so they are not current stack parameters.

## Mobile app identifiers

The mobile client is published by each district under its own store
identities. These values in `packages/mobile/app.json` and
`packages/mobile/eas.json` belong to this deployment and are replaced when a
district forks the repository:

- `expo.name`, `expo.slug`, and `expo.scheme` — the app name and URL scheme
- `expo.ios.bundleIdentifier` and `expo.android.package` — the store bundle
  identifier, which must match `psdEoc:iosBundleId` in the tenant manifest
- `expo.extra.eas.projectId` and `expo.owner` — the district's own Expo
  Application Services project and account
- `submit.production.ios.ascAppId` — the App Store Connect app record

`EXPO_PUBLIC_PSD_EOC_API_BASE_URL` is set per EAS build profile and points the
client at that district's server origin. The
[App Store setup runbook](runbooks/appstore-setup.md) covers the store records
themselves.

## Expo push activation boundary

The stack always creates the worker definition, protected secrets, queue/DLQ,
log group, and conditional queue, DLQ, provider latency, incomplete handoff,
stuck-outbox, receipt polling, and worker-health alarms. Its desired count
is controlled by `EnableExpoPushWorker`, which defaults to false. The worker
then performs independent fail-closed startup checks for the credential
evidence reference and exact `verified` structured-secret status; those checks
happen after a task starts and do not change desired count. The mobile client
also denies registration unless the public build opt-in is exactly `true` and
the server accepts the exact native build tuple from its protected allowlist.

Before setting `EXPO_PUSH_WORKER_ENABLED` to `true`, an operator must establish
all of these protected values without copying their contents into a terminal
log, ticket, workflow, or source file:

- `/psd-eoc/providers/expo-access-token` is one JSON secret containing the
  exact keys `accessToken` and `status`; `status` must be exactly `verified`.
  The stack-generated `UNCONFIGURED` value makes worker startup fail closed.
- `EXPO_CREDENTIAL_VERIFICATION_REFERENCE` is a bounded, non-secret reference
  to retained EAS/APNs/FCM credential and exact-build evidence. `UNVERIFIED` is
  rejected.

Development and preview EAS profiles set push registration to `false`;
production sets the public client opt-in to `true`. Registration itself is
authorized by the caller's authenticated staff session.

There is deliberately no per-build allowlist. One used to exist: every shipped
application version and native build number had to be added by hand to a
protected secret before any device running that build could register for push
or receive a send. It failed silently — a release that nobody remembered to add
looked completely normal until someone installed it and found notifications
dead — and the only thing it defended against was a staff member running a
modified client they could already read everything through. Do not reintroduce
a mechanism that requires a manual step per release to keep emergency
notifications working.

Enabling the worker can consume retained queue items. While its desired count
is still zero, review the queue and append-only attempt state by sanitized ID,
establish a quiescence fence, and reconcile every retained or ambiguous item.
Do not purge, redrive, replay, or inspect message bodies. Physical proof still
requires an authenticated human to start one bounded drill in the running
application on each approved device.

## Direct APNs/FCM activation and cutover

Direct provider delivery is an additional dark boundary on the same push
worker. `DIRECT_PUSH_ENABLED` defaults to `false`; when false, the task cannot
construct either direct transport even if credentials exist. Enabling it also
requires the Expo worker to be enabled, a bounded retained evidence reference,
and both protected provider secrets to report exact `verified` status. The
tenant cutover defaults to Expo on both platforms:

```json
{ "version": 1, "ios": "expo", "android": "expo" }
```

`PUSH_PROVIDER_CUTOVER` accepts only that canonical shape, with each platform
set independently to `expo` or `direct`. For future audience snapshots,
`direct` resolves to APNs on iOS and FCM on Android. Missing, partial, mixed,
or malformed configuration denies selection. A dispatch already contains its
immutable endpoint provider, so changing the cutover never rewrites history
and never reroutes ambiguous work.

The retained Secrets Manager values are server-runtime credentials, separate
from anything EAS uses to sign a mobile build:

- `/psd-eoc/providers/apns-direct` contains exactly `status`, `keyId`,
  `teamId`, `topic`, `environment`, and `privateKey`. `environment` is
  `development` or `production`; `topic` must equal the configured iOS bundle
  ID. The private key is an APNs token-signing key in PEM form.
- `/psd-eoc/providers/fcm-direct` contains exactly `status`, `projectId`,
  `clientEmail`, `environment`, and `privateKey`. The identity must be scoped
  to sending FCM HTTP v1 messages in the isolated Firebase project. The
  private key is a service-account key in PEM form.

Only the push ECS execution role can read these two secrets. They are not
available to App Runner, mobile builds, logs, metrics, deployment output, or
evidence. The checked-in secret values are non-credential placeholders and
make startup fail closed. Store the secret contents through an approved
secret-input path, validate rotation without printing them, then set
`DIRECT_PUSH_CREDENTIAL_VERIFICATION_REFERENCE` to a non-secret retained
record identifier. Use [the direct push runbook](runbooks/provider-direct-push.md)
for activation, per-platform cutover, credential rotation, and rollback.

Dual-registration builds submit one Expo fallback endpoint plus one native
endpoint (`apns` for iOS, `fcm` for Android) only after the same build opt-in,
authentication, permission, enrollment, and server allowlist gates. The
allowlist must authorize each exact provider and service environment for the
same build identity. Endpoint replacement and invalidation are provider-scoped,
so rotating a native token cannot retire its Expo fallback.

Cut over only one platform at a time after isolated provider evidence. To roll
back, set that platform to `expo` and deploy normally; this affects only future
snapshots. Keep direct authorization, credentials, native registrations, and
history available for at least seven calendar days after both platform
cutovers and until three bounded synthetic runs per platform have no
unexplained `unknown` outcome. Never automatically replay an ambiguous direct
attempt, and never send two copies to one endpoint to collect comparison data.

## SES email activation boundary

The stack enables the retained SES configuration set and connects its encrypted
SNS event topic to a retained SQS callback queue. A separately permissioned
consumer forwards each unmodified envelope to the application's signature-
verifying, idempotent callback and deletes it only after durable acceptance.
That consumer has no SES authority and follows the application independently
of send enablement. The email send task definition and service always exist for
review, but desired count is zero unless `EMAIL_WORKER_ENABLED` is exactly
`true`.

After deployment, an authenticated administrator sets the email channel to
**Enabled** on the integrations page. That one action enables the channel; it
does not send a message. All provider I/O remains behind the activation
preview and the authenticated human activation action. The worker rechecks
that exact endpoint and channel state immediately before SES.

Before changing `EMAIL_WORKER_ENABLED` from its default `false`, inspect the
retained email queue and append-only attempt/evidence state by sanitized ID. Do
not purge, replay, redrive, or inspect email send-queue message bodies. An
ambiguous SES call retains its irreversible provider-I/O claim and must be
reconciled rather than resent. A permanent bounce or complaint suppresses the
canonical address across later roster snapshots before any future retry. Both
SQS consumers retry at most five receives before their retained DLQs. After the
callback cause is fixed, its signed, idempotent messages may be redriven only
to the callback source queue; this never invokes SES. The DLQ alarms are the
forced-failure signals.

The first physical delivery proof is still a human acceptance step in the
running application: one exact recipient, DRILL copy visible in the preview and
message, and evidence read as queued → provider accepted → delivered or
bounced.

## AWS End User Messaging SMS activation boundary

The SMS work queue/DLQ, EventBridge-only receipt queue/DLQ, runtime bearer,
task definition, service, and HTTPS-only network boundary are always
reviewable. The worker may publish retries only to the work queue; it has no
receipt-queue publish permission. `EnableAwsEumSmsWorker` defaults to
false and resolves the service desired count to zero. Provider resources have
a separate monotonic deployment switch: `ProvisionAwsEumSmsResources` may stay
true while the worker is dark, so disabling a worker never attempts to delete
the retained, deletion-protected carrier pool.

Before provisioning those resources, retain carrier approval under
`SMS_REGISTRATION_VERIFICATION_REFERENCE` and supply the approved origination
ARN, destination country code, and carrier-reviewed HELP/STOP responses as
direct CDK parameters. CloudFormation then creates the
AWS-managed opt-out list, pool, protect configuration, configuration set,
delivery-event bridge, and scheduled STOP reconciliation. Shared routes and
self-managed opt-outs are disabled.

Immediately before provider I/O, the server parses the E.164 destination and
requires its country to equal `SMS_DESTINATION_COUNTRY_CODE`. This is the
authoritative country boundary because AWS protect configurations default
omitted countries to allow. The fixed five-minute lifetime includes time spent
waiting in SQS and all retries; it is not restarted when the worker resumes.

`EnableAwsEumSmsWorker` runs the worker; the SMS channel itself is enabled by
an authenticated administrator on the integrations page. A real handset drill
is still human-only: an authenticated human starts it in the running
application, and no automation sends a real message.

## Validate without a provider

Run the same credential-free second-district synthesis used by CI:

```sh
bun run --cwd infra synth:example
```

This synthesizes and asserts the template in memory. It does not contact AWS,
Google, a notification provider, DNS, or a live recipient.

## Deploy

From the repository root, use a locally authenticated AWS session. Set the
protected-target environment values from the same approved local operator
configuration as the AWS profile, then run one command:

```sh
AWS_PROFILE=<profile> AWS_ACCOUNT_ID=<account> AWS_REGION=<region> APP_PUBLIC_ORIGIN=<origin> bun run --cwd infra deploy -- PsdEoc --profile <profile> --region <region>
```

Supply required and changed values from the parameter list above with CDK's
`--parameters` option on that same command. The deploy script also refuses a
dirty worktree, so the runtime revision and container label cannot claim a Git
commit whose bytes were locally modified. No GitHub repository configuration
participates in the deployment.

Current deployed and provider state belongs only in
[the readiness register](INTEGRATIONS.md), not in this index.
