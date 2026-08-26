# Configuration and deployment index

This is the current index of portable tenant configuration and protected
deployment inputs. `infra/cdk.json` is the checked-in tenant manifest for this
deployment. `infra/bin/synthesize-example.ts` replaces its identity with a
reserved second-district fixture to prove the stack is portable without cloud
credentials or provider calls.

The documentation contract compares the marked lists below with the manifest
and `.github/workflows/deploy.yml`; changing a key in code without updating this
index fails `bun run verify:docs`.

## Tenant manifest: CDK context

<!-- docs-contract:cdk-context:start -->

- `psdEoc:applicationOrigin`
- `psdEoc:awsAccount`
- `psdEoc:awsAccountAlias`
- `psdEoc:awsRegion`
- `psdEoc:displayTimeZone`
- `psdEoc:facilities`
- `psdEoc:hostedDomain`
- `psdEoc:iosBundleId`
- `psdEoc:monitoringRunbookBaseUrl`
- `psdEoc:neighborhoods`
- `psdEoc:organizationName`
- `psdEoc:privacyContactUrl`
- `psdEoc:sesFromAddress`
- `psdEoc:sesIdentityDomain`
- `psdEoc:syntheticGroups`
<!-- docs-contract:cdk-context:end -->

Identity, target account/region, facility data, sender identity, and runbook
base URL are configuration. `readDeploymentTarget` and
`readDeploymentIdentity` validate these values during synthesis. Facilities,
neighborhoods, and synthetic groups are validated again before bootstrap.

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
- `TEST_DATABASE_URL`

## Protected GitHub deployment configuration

Repository/environment variables:

<!-- docs-contract:workflow-vars:start -->

- `APP_PUBLIC_ORIGIN`
- `APP_RUNNER_SERVICE_ARN`
- `AWS_ACCOUNT_ID`
- `AWS_DEPLOY_ROLE_ARN`
- `AWS_REGION`
- `ECR_REPOSITORY`
- `DIRECT_PUSH_CREDENTIAL_VERIFICATION_REFERENCE`
- `DIRECT_PUSH_ENABLED`
- `EXPO_CREDENTIAL_VERIFICATION_REFERENCE`
- `EXPO_PUSH_WORKER_ENABLED`
- `GOOGLE_GROUPS_SECRET_ARN`
- `GOOGLE_OAUTH_SECRET_ARN`
- `INITIAL_ACCESS_GROUP_ID`
- `INITIAL_ACCESS_GROUP_NAME`
- `PUSH_PROVIDER_CUTOVER`
- `STACK_NAME`
<!-- docs-contract:workflow-vars:end -->

Environment secrets:

<!-- docs-contract:workflow-secrets:start -->

- `INITIAL_ACCESS_GROUP_EMAIL`
- `INITIAL_MOBILE_TRANSITION_EMAIL_SHA256`
- `OPERATIONS_ALARM_EMAIL`
- `OPERATIONS_ALARM_SMS_NUMBER`
<!-- docs-contract:workflow-secrets:end -->

The deploy workflow has one manual input:

<!-- docs-contract:workflow-inputs:start -->

- `rollback_image_digest`
<!-- docs-contract:workflow-inputs:end -->

Empty `rollback_image_digest` builds and deploys the selected commit. A value
must be an existing immutable `sha256:` image digest. Rollback still uses the
current commit's bootstrap image so forward-only migrations never run from an
old application image.

## Synthesized CloudFormation parameters

The current synthesized stack contains exactly these parameters:

<!-- docs-contract:template-parameters:start -->

- `AppImageDigest`
- `BootstrapImageDigest`
- `BootstrapSourceSha`
- `BootstrapVersion`
- `DirectPushCredentialVerificationReference`
- `EnableDirectPush`
- `EnableExpoPushWorker`
- `ExpoCredentialVerificationReference`
- `GoogleGroupsSecretArn`
- `GoogleOauthSecretArn`
- `InitialAccessGroupEmail`
- `InitialAccessGroupId`
- `InitialAccessGroupName`
- `InitialMobileTransitionEmailSha256`
- `OperationsTeamAlarmEmail`
- `OperationsTeamAlarmSmsNumber`
- `ProvisionApplication`
- `PushProviderCutover`
- `RuntimeDatabaseIdleTimeoutSeconds`
- `SourceSha`
<!-- docs-contract:template-parameters:end -->

`BootstrapVersion` is the CDK-generated bootstrap-stack compatibility
parameter and has a default. Expo and direct-provider enablement and evidence
parameters default to their safe, dark values when protected workflow
variables are absent. The workflow supplies every non-bootstrap parameter.

### Parameters supplied by the workflow

<!-- docs-contract:workflow-parameters:start -->

- `AppImageDigest`
- `BootstrapImageDigest`
- `BootstrapSourceSha`
- `DirectPushCredentialVerificationReference`
- `EnableDirectPush`
- `EnableExpoPushWorker`
- `ExpoCredentialVerificationReference`
- `GoogleGroupsSecretArn`
- `GoogleOauthSecretArn`
- `InitialAccessGroupEmail`
- `InitialAccessGroupId`
- `InitialAccessGroupName`
- `InitialMobileTransitionEmailSha256`
- `OperationsTeamAlarmEmail`
- `OperationsTeamAlarmSmsNumber`
- `ProvisionApplication`
- `PushProviderCutover`
- `RuntimeDatabaseIdleTimeoutSeconds`
- `SourceSha`
<!-- docs-contract:workflow-parameters:end -->

The source also defines three canary-only parameters inside the full monitoring
composition: `MonitoringCanaryCredentialSecretArn`,
`MonitoringCanaryFacilityId`, and `MonitoringCanaryEventTypeVersionId`. The
current stack calls `configureInfrastructureMonitoring`, not the full canary
composition, so the deploy workflow does not supply them.

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
- `/psd-eoc/mobile/push-build-allowlist` is a JSON array of exact build
  authorizations. Each entry contains `platform`, the literal provider `expo`,
  and `build.applicationId`, `build.applicationVersion`,
  `build.nativeBuildVersion`, `build.expoProjectId`, and the literal
  `build.updateMode` value `embedded-only`.
- `EXPO_CREDENTIAL_VERIFICATION_REFERENCE` is a bounded, non-secret reference
  to retained EAS/APNs/FCM credential and exact-build evidence. `UNVERIFIED` is
  rejected.

For example, this is the shape of one synthetic allowlist entry; it is not an
approved build:

```json
[
  {
    "platform": "ios",
    "provider": "expo",
    "serviceEnvironment": "production",
    "build": {
      "applicationId": "org.example.eoc",
      "applicationVersion": "1.2.3",
      "nativeBuildVersion": "42",
      "expoProjectId": "00000000-0000-4000-8000-000000000278",
      "updateMode": "embedded-only"
    }
  }
]
```

Development and preview EAS profiles set push registration to `false`.
Production sets the public client opt-in to `true`, but that flag alone grants
nothing: a missing, malformed, duplicate, or nonmatching protected server
allowlist denies registration.

Enabling the worker can consume retained queue items. While its desired count
is still zero, review the queue and append-only attempt state by sanitized ID,
establish a quiescence fence, and reconcile every retained or ambiguous item.
Do not purge, redrive, replay, or inspect message bodies. Physical proof still
requires an authenticated human to initiate one bounded drill in the running
application on each approved device. The delivery-test target mode for this
drill is `controlled-push-canary`, which permits exactly one current
product-owner-approved push endpoint without requiring the unrelated email
provider; ordinary delivery-test target sets still require push and email.

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

## Validate without a provider

Run the same credential-free second-district synthesis used by CI:

```sh
bun run --cwd infra synth:example
```

This synthesizes and asserts the template in memory. It does not contact AWS,
Google, a notification provider, DNS, or a live recipient.

## Deploy

Production deploys use the GitHub Actions `Deploy` workflow and OIDC. Select a
commit and run the workflow; leave `rollback_image_digest` empty for a normal
deploy. The workflow validates protected configuration, builds an immutable
image, stages and runs the current bootstrap/migrations, then updates the
application and verifies its digest and health. There are no static AWS keys
and no supported manual `cdk deploy` path.

Current deployed and provider state belongs only in
[the readiness register](INTEGRATIONS.md), not in this index.
