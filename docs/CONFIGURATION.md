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
- `GOOGLE_GROUPS_SECRET_ARN`
- `GOOGLE_OAUTH_SECRET_ARN`
- `INITIAL_ACCESS_GROUP_ID`
- `INITIAL_ACCESS_GROUP_NAME`
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
- `GoogleGroupsSecretArn`
- `GoogleOauthSecretArn`
- `InitialAccessGroupEmail`
- `InitialAccessGroupId`
- `InitialAccessGroupName`
- `InitialMobileTransitionEmailSha256`
- `OperationsTeamAlarmEmail`
- `OperationsTeamAlarmSmsNumber`
- `ProvisionApplication`
- `RuntimeDatabaseIdleTimeoutSeconds`
- `SourceSha`
<!-- docs-contract:template-parameters:end -->

`BootstrapVersion` is the CDK-generated bootstrap-stack compatibility
parameter and has a default. The workflow supplies the other 14 explicitly.

### Parameters supplied by the workflow

<!-- docs-contract:workflow-parameters:start -->

- `AppImageDigest`
- `BootstrapImageDigest`
- `BootstrapSourceSha`
- `GoogleGroupsSecretArn`
- `GoogleOauthSecretArn`
- `InitialAccessGroupEmail`
- `InitialAccessGroupId`
- `InitialAccessGroupName`
- `InitialMobileTransitionEmailSha256`
- `OperationsTeamAlarmEmail`
- `OperationsTeamAlarmSmsNumber`
- `ProvisionApplication`
- `RuntimeDatabaseIdleTimeoutSeconds`
- `SourceSha`
<!-- docs-contract:workflow-parameters:end -->

The source also defines three canary-only parameters inside the full monitoring
composition: `MonitoringCanaryCredentialSecretArn`,
`MonitoringCanaryFacilityId`, and `MonitoringCanaryEventTypeVersionId`. The
current stack calls `configureInfrastructureMonitoring`, not the full canary
composition, so the deploy workflow does not supply them.

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
