import { fileURLToPath } from 'node:url';

import { INTEGRATION_VERIFICATION_REFERENCE_PATTERN_SOURCE } from '@psd-eoc/contracts';

import {
  Arn,
  ArnFormat,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  CfnRule,
  CustomResource,
  Duration,
  Fn,
  IgnoreMode,
  RemovalPolicy,
  SecretValue,
  Stack,
  Tags,
  Validations,
  aws_apprunner as apprunner,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_ecr as ecr,
  aws_ecr_assets as ecrAssets,
  aws_events as events,
  aws_guardduty as guardduty,
  aws_events_targets as eventTargets,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_lambda_event_sources as lambdaEventSources,
  aws_logs as logs,
  aws_rds as rds,
  aws_route53 as route53,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_synthetics as synthetics,
  aws_ses as ses,
  aws_sns as sns,
  aws_sqs as sqs,
  aws_smsvoice as smsvoice,
  custom_resources as customResources,
} from 'aws-cdk-lib';
import type { CfnResource, StackProps } from 'aws-cdk-lib';
import { RegionInfo } from 'aws-cdk-lib/region-info';
import type { Construct } from 'constructs';

import {
  SES_CONFIGURATION_SET_NAME,
  SES_EVENT_DESTINATION_NAME,
  SES_EVENT_TOPIC_NAME,
} from '../config';
import {
  AURORA_MAX_CAPACITY_ACU,
  configureInfrastructureMonitoring,
} from '../monitoring';
import {
  DATABASE_NAME,
  DATABASE_PORT,
  DATABASE_SSL_ROOT_CERT,
  BOOTSTRAP_LOG_GROUP_NAME,
  DATABASE_IDENTIFIER,
  DATA_CLASSIFICATION,
  EMAIL_DEAD_LETTER_QUEUE_NAME,
  EMAIL_CALLBACK_QUEUE_NAME,
  EMAIL_CALLBACK_DEAD_LETTER_QUEUE_NAME,
  EMAIL_CALLBACK_WORKER_LOG_GROUP_NAME,
  EMAIL_QUEUE_NAME,
  DELIVERY_DEAD_LETTER_QUEUE_NAME,
  DELIVERY_QUEUE_MAX_RECEIVES,
  DELIVERY_QUEUE_NAME,
  EMAIL_WORKER_LOG_GROUP_NAME,
  PUSH_DEAD_LETTER_QUEUE_NAME,
  PUSH_QUEUE_NAME,
  PUSH_WORKER_LOG_GROUP_NAME,
  SMS_DEAD_LETTER_QUEUE_NAME,
  SMS_QUEUE_NAME,
  SMS_RECEIPT_DEAD_LETTER_QUEUE_NAME,
  SMS_RECEIPT_QUEUE_NAME,
  SMS_WORKER_LOG_GROUP_NAME,
  DEPLOYMENT_ENVIRONMENT,
  HEALTH_PATH,
  HEALTH_QUEUE_NAME,
  SERVER_REPOSITORY_NAME,
  readDeploymentIdentity,
  readFacilityContext,
  readSyntheticGroupContext,
  readThreatContext,
  readNeighborhoodContext,
} from './config';
import type { DeploymentTarget } from './config';

const SECRET_PREFIX = '/psd-eoc';
const APP_RUNNER_PORT = '3000';
const APPLICATION_SUBNET_GROUP_NAME = 'Application';
const BOOTSTRAP_CLUSTER_NAME = 'psd-eoc-bootstrap';
const BOOTSTRAP_CONTAINER_NAME = 'native-bootstrap';
const ACCESS_SYNC_CONTAINER_NAME = 'access-membership-sync';
const PUSH_WORKER_SERVICE_NAME = 'psd-eoc-expo-push-worker';
const SMS_WORKER_SERVICE_NAME = 'psd-eoc-aws-eum-sms-worker';
const EMAIL_WORKER_SERVICE_NAME = 'psd-eoc-email-worker';
const EMAIL_QUEUE_MAX_RECEIVES = 5;
const CURRENT_CDK_ASSET = 'CURRENT_CDK_ASSET';
const CDK_ASSET_REPOSITORY = 'CDK_ASSET_REPOSITORY';
const LEGACY_APPLICATION_REPOSITORY = 'LEGACY_APPLICATION_REPOSITORY';
export const APPLICATION_IMAGE_EXCLUDES = Object.freeze([
  '.git',
  '.github',
  '.agents',
  '.codex',
  '.verification',
  '**/.DS_Store',
  '**/.expo',
  '**/.env*',
  '**/.next',
  '**/.turbo',
  '**/*.log',
  '**/build',
  '**/cdk.out',
  '**/coverage',
  '**/dist',
  '**/node_modules',
  'docs',
  'infra',
  'packages/mcp',
  'packages/mobile',
  'scripts',
]);

export interface PsdEocStackProps extends StackProps {
  /** Cloud/provider identity read from deployment configuration. */
  readonly deploymentTarget: DeploymentTarget;
  /** Exact local Git commit packaged into the CDK image asset. */
  readonly sourceSha: string;
}

function secretJsonKeyArn(secret: secretsmanager.Secret, key: string): string {
  return Fn.join('', [secret.secretArn, `:${key}::`]);
}

function ecsSecretJsonKey(
  secret: secretsmanager.Secret,
  key: string,
): ecs.Secret {
  return ecs.Secret.fromSecretsManager(
    secret as unknown as secretsmanager.ISecret,
    key,
  );
}

/**
 * Stable AWS environment for a staff-minimized live pilot.
 *
 * CDK builds and publishes one content-addressed image asset. CloudFormation
 * runs the native database bootstrap from that exact image before it promotes
 * App Runner or any worker service to the same revision.
 */
export class PsdEocStack extends Stack {
  public constructor(scope: Construct, id: string, props: PsdEocStackProps) {
    super(scope, id, props);
    const deploymentIdentity = readDeploymentIdentity(this.node);
    const {
      account,
      accountAlias,
      monitoringRunbookBaseUrl,
      region,
      sesFromAddress,
      sesIdentityDomain,
      sourceRepositoryUrl,
    } = props.deploymentTarget;
    const { sourceSha } = props;
    if (!/^[a-f0-9]{40}$/u.test(sourceSha) || /^0{40}$/u.test(sourceSha)) {
      throw new Error(
        'PsdEoc sourceSha must identify one reviewed Git commit.',
      );
    }
    const partition = RegionInfo.get(region).partition;
    if (partition === undefined) {
      throw new Error(`AWS region ${region} has no known ARN partition.`);
    }

    Validations.of(this).acknowledge({
      id: 'CloudFormation-Validate::W3010',
      reason:
        'This isolated stack is fixed to one approved account and region; explicit AZs keep synthesis credentialless.',
    });

    if (
      Stack.of(this).account !== account ||
      Stack.of(this).region !== region
    ) {
      throw new Error(
        `PsdEoc must target AWS account ${account} (${accountAlias}) in ${region}.`,
      );
    }

    Tags.of(this).add('Application', 'PSD EOC Live Pilot');
    Tags.of(this).add('DataClassification', DATA_CLASSIFICATION);
    Tags.of(this).add('Environment', DEPLOYMENT_ENVIRONMENT);
    Tags.of(this).add('DataScope', 'staff-minimized');
    Tags.of(this).add('ExpectedAwsAccountAlias', accountAlias);
    Tags.of(this).add('ManagedBy', 'AWS CDK');

    const provisionApplication = new CfnParameter(
      this,
      'ProvisionApplication',
      {
        allowedValues: ['false', 'true'],
        description:
          'Explicitly set false for a dark data-plane deployment or true to run App Runner after the CDK-managed bootstrap succeeds.',
        type: 'String',
      },
    );
    const enableMediaMalwareScanning = new CfnParameter(
      this,
      'EnableMediaMalwareScanning',
      {
        allowedValues: ['false', 'true'],
        default: 'false',
        description:
          'Attach the GuardDuty malware-protection plan to the media bucket. Enable only after a deployment in which the scan role already exists: GuardDuty validates bucket ownership when the plan is created, and that check fails against a role IAM has not finished propagating.',
        type: 'String',
      },
    );
    const enableExpoPushWorker = new CfnParameter(
      this,
      'EnableExpoPushWorker',
      {
        allowedValues: ['false', 'true'],
        default: 'false',
        description:
          'Scale the isolated Expo push worker from zero to one only after credentials, exact builds, and the integration truth record are verified.',
        type: 'String',
      },
    );
    const expoCredentialVerificationReference = new CfnParameter(
      this,
      'ExpoCredentialVerificationReference',
      {
        allowedPattern: '^(UNVERIFIED|[A-Za-z0-9][A-Za-z0-9._:-]{0,254})$',
        default: 'UNVERIFIED',
        description:
          'Token-free reference to retained APNs, FCM, EAS, and Expo credential verification evidence.',
        maxLength: 255,
        type: 'String',
      },
    );
    const enableDirectPush = new CfnParameter(this, 'EnableDirectPush', {
      allowedValues: ['false', 'true'],
      default: 'false',
      description:
        'Authorize direct APNs and FCM provider I/O only after isolated credentials and retained verification evidence exist.',
      type: 'String',
    });
    const directPushCredentialVerificationReference = new CfnParameter(
      this,
      'DirectPushCredentialVerificationReference',
      {
        allowedPattern: `^(UNVERIFIED|${INTEGRATION_VERIFICATION_REFERENCE_PATTERN_SOURCE})$`,
        default: 'UNVERIFIED',
        description:
          'Token-free reference to retained direct APNs and FCM credential verification evidence.',
        maxLength: 255,
        type: 'String',
      },
    );
    const pushProviderCutover = new CfnParameter(this, 'PushProviderCutover', {
      allowedPattern:
        '^\\{"version":1,"ios":"(expo|direct)","android":"(expo|direct)"\\}$',
      default: '{"version":1,"ios":"expo","android":"expo"}',
      description:
        'Protected exact per-platform provider selection. Changing it affects only newly snapshotted push endpoints.',
      type: 'String',
    });
    const enableAwsEumSmsWorker = new CfnParameter(
      this,
      'EnableAwsEumSmsWorker',
      {
        allowedValues: ['false', 'true'],
        default: 'false',
        description:
          'Scale the isolated AWS End User Messaging SMS worker from zero only after carrier registration and live integration evidence are verified.',
        type: 'String',
      },
    );
    const provisionAwsEumSmsResources = new CfnParameter(
      this,
      'ProvisionAwsEumSmsResources',
      {
        allowedValues: ['false', 'true'],
        default: 'false',
        description:
          'Create and retain the carrier-approved SMS pool, opt-out list, protect configuration, and configuration set. This may stay true while the worker is dark.',
        type: 'String',
      },
    );
    const smsRegistrationVerificationReference = new CfnParameter(
      this,
      'SmsRegistrationVerificationReference',
      {
        allowedPattern: '^(UNVERIFIED|[A-Za-z0-9][A-Za-z0-9._:-]{15,254})$',
        constraintDescription:
          'must be UNVERIFIED or a 16-255 character token-free evidence reference',
        default: 'UNVERIFIED',
        description:
          'Token-free reference to retained carrier-registration approval evidence.',
        maxLength: 255,
        type: 'String',
      },
    );
    const smsOriginationIdentityArn = new CfnParameter(
      this,
      'SmsOriginationIdentityArn',
      {
        allowedPattern: `^(UNCONFIGURED|arn:${partition}:sms-voice:${region}:${account}:(phone-number|sender-id)/[A-Za-z0-9_./+-]+)$`,
        default: 'UNCONFIGURED',
        description:
          'Approved SMS origination phone-number or sender-id ARN from the completed carrier registration.',
        noEcho: true,
        type: 'String',
      },
    );
    const smsHelpMessage = new CfnParameter(this, 'SmsHelpMessage', {
      allowedPattern: '^(UNCONFIGURED|\\S(?:[\\s\\S]{0,158}\\S)?)$',
      constraintDescription:
        'must be UNCONFIGURED or a non-empty, trimmed message of at most 160 characters',
      default: 'UNCONFIGURED',
      description:
        'Carrier-reviewed HELP response for the configured tenant. Required only when enabling the SMS worker.',
      maxLength: 160,
      noEcho: true,
      type: 'String',
    });
    const smsStopMessage = new CfnParameter(this, 'SmsStopMessage', {
      allowedPattern: '^(UNCONFIGURED|\\S(?:[\\s\\S]{0,158}\\S)?)$',
      constraintDescription:
        'must be UNCONFIGURED or a non-empty, trimmed message of at most 160 characters',
      default: 'UNCONFIGURED',
      description:
        'Carrier-reviewed STOP response for the configured tenant. Required only when enabling the SMS worker.',
      maxLength: 160,
      noEcho: true,
      type: 'String',
    });
    const deliveryTestProductOwnerUserId = new CfnParameter(
      this,
      'DeliveryTestProductOwnerUserId',
      {
        allowedPattern:
          '^(UNCONFIGURED|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$',
        constraintDescription:
          'must be UNCONFIGURED or the staff user UUID authorized to configure delivery-test targets',
        default: 'UNCONFIGURED',
        description:
          'Staff user allowed to configure monthly delivery-test canary targets. The live-send confirmation stays a separate human action.',
        type: 'String',
      },
    );
    const smsDestinationCountryCode = new CfnParameter(
      this,
      'SmsDestinationCountryCode',
      {
        allowedPattern: '^(UNCONFIGURED|[A-Z]{2})$',
        default: 'UNCONFIGURED',
        description:
          'ISO 3166-1 alpha-2 destination country reviewed for the SMS protect configuration.',
        type: 'String',
      },
    );
    const enableEmailWorker = new CfnParameter(this, 'EnableEmailWorker', {
      allowedValues: ['false', 'true'],
      default: 'false',
      description:
        'Scale the isolated SES email worker from zero to one only after the sender, callback, and integration truth reference are verified.',
      type: 'String',
    });
    const sesCredentialVerificationReference = new CfnParameter(
      this,
      'SesCredentialVerificationReference',
      {
        allowedPattern: '^(UNVERIFIED|[A-Za-z0-9][A-Za-z0-9._:-]{15,254})$',
        default: 'UNVERIFIED',
        description:
          'Address-free reference to retained SES identity, production-access, callback, and suppression verification evidence.',
        maxLength: 255,
        type: 'String',
      },
    );
    const runtimeDatabaseIdleTimeoutSeconds = new CfnParameter(
      this,
      'RuntimeDatabaseIdleTimeoutSeconds',
      {
        default: 0,
        description:
          'App Runner PostgreSQL pool idle timeout in seconds; zero keeps the bounded pool connection open.',
        maxValue: 600,
        minValue: 0,
        type: 'Number',
      },
    );
    const rollbackApplicationImageDigest = new CfnParameter(
      this,
      'RollbackApplicationImageDigest',
      {
        allowedPattern: '^(CURRENT_CDK_ASSET|sha256:[0-9a-f]{64})$',
        default: CURRENT_CDK_ASSET,
        description:
          'Optional prior digest from the selected retained repository. Normal deployments use CURRENT_CDK_ASSET.',
        type: 'String',
      },
    );
    const rollbackApplicationRepository = new CfnParameter(
      this,
      'RollbackApplicationRepository',
      {
        allowedValues: [
          CURRENT_CDK_ASSET,
          CDK_ASSET_REPOSITORY,
          LEGACY_APPLICATION_REPOSITORY,
        ],
        default: CURRENT_CDK_ASSET,
        description:
          'Repository containing RollbackApplicationImageDigest, or CURRENT_CDK_ASSET for a normal deployment.',
        type: 'String',
      },
    );
    const googleOauthSecretArn = new CfnParameter(
      this,
      'GoogleOauthSecretArn',
      {
        // Pinned to the exact path the secret occupies.
        //
        // This was briefly widened to allow any depth of segment under
        // /psd-eoc/, because the secret then lived at
        // /psd-eoc/exploration-smoke/google-oauth and the stack rename would
        // otherwise have invalidated an ARN that had not moved. The secret has
        // since been copied to /psd-eoc/google-oauth, so the widening buys
        // nothing and only enlarges the set of ARNs CI will accept without
        // question. A wrong path should fail the deploy, not pass validation.
        allowedPattern: `^arn:${partition}:secretsmanager:${region}:${account}:secret:/psd-eoc/google-oauth-[A-Za-z0-9]{6}$`,
        constraintDescription:
          'Use the complete ARN of the reviewed production Google OAuth secret in the approved account and region.',
        description:
          'Complete ARN of the independently reviewed Google OAuth configuration. Google OIDC is the only live integration.',
        noEcho: true,
        type: 'String',
      },
    );
    const googleGroupsSecretArn = new CfnParameter(
      this,
      'GoogleGroupsSecretArn',
      {
        allowedPattern: `^arn:${partition}:secretsmanager:${region}:${account}:secret:/psd-eoc/google-groups-[A-Za-z0-9]{6}$`,
        constraintDescription:
          'Use the complete ARN of the reviewed /psd-eoc/google-groups secret in the approved account and region.',
        description:
          'Complete ARN of the Cloud Identity roster-reader credential. The complete ARN is required: importing this secret by name yields an ARN without the generated suffix, which the read grant can never match.',
        noEcho: true,
        type: 'String',
      },
    );
    // The first trusted group. Without it a rebuilt deployment admits nobody,
    // because the page that configures access groups sits behind sign-in. Empty
    // by default so an already-configured district passes nothing; supplying
    // only part of it is refused rather than producing a deployment that
    // silently cannot be signed into.
    const initialAccessGroupId = new CfnParameter(
      this,
      'InitialAccessGroupId',
      {
        default: '',
        description:
          'Cloud Identity group id whose membership grants administrator on a first run. Leave empty once access groups exist.',
        type: 'String',
      },
    );
    const initialAccessGroupEmail = new CfnParameter(
      this,
      'InitialAccessGroupEmail',
      {
        default: '',
        description:
          'Address of that group. Never committed; supplied per deployment.',
        noEcho: true,
        type: 'String',
      },
    );
    const initialAccessGroupName = new CfnParameter(
      this,
      'InitialAccessGroupName',
      {
        default: '',
        description: 'Display name for the first access group.',
        type: 'String',
      },
    );

    const initialMobileTransitionEmailSha256 = new CfnParameter(
      this,
      'InitialMobileTransitionEmailSha256',
      {
        allowedPattern: '^[0-9a-f]{64}$',
        constraintDescription:
          'Use one lowercase SHA-256 digest without the underlying email value.',
        description:
          'Protected selector digest for the one-time initial mobile access transition.',
        maxLength: 64,
        minLength: 64,
        noEcho: true,
        type: 'String',
      },
    );
    const shouldProvisionApplication = new CfnCondition(
      this,
      'ShouldProvisionApplication',
      {
        expression: Fn.conditionEquals(
          provisionApplication.valueAsString,
          'true',
        ),
      },
    );
    const shouldUseRollbackApplicationImage = new CfnCondition(
      this,
      'ShouldUseRollbackApplicationImage',
      {
        expression: Fn.conditionNot(
          Fn.conditionEquals(
            rollbackApplicationImageDigest.valueAsString,
            CURRENT_CDK_ASSET,
          ),
        ),
      },
    );
    const shouldUseLegacyRollbackRepository = new CfnCondition(
      this,
      'ShouldUseLegacyRollbackRepository',
      {
        expression: Fn.conditionEquals(
          rollbackApplicationRepository.valueAsString,
          LEGACY_APPLICATION_REPOSITORY,
        ),
      },
    );
    const shouldRunExpoPushWorker = new CfnCondition(
      this,
      'ShouldRunExpoPushWorker',
      {
        expression: Fn.conditionAnd(
          Fn.conditionEquals(enableExpoPushWorker.valueAsString, 'true'),
          Fn.conditionEquals(
            rollbackApplicationImageDigest.valueAsString,
            CURRENT_CDK_ASSET,
          ),
        ),
      },
    );
    const shouldAuthorizeDirectPush = new CfnCondition(
      this,
      'ShouldAuthorizeDirectPush',
      {
        expression: Fn.conditionEquals(enableDirectPush.valueAsString, 'true'),
      },
    );
    const shouldRunAwsEumSmsWorker = new CfnCondition(
      this,
      'ShouldRunAwsEumSmsWorker',
      {
        expression: Fn.conditionAnd(
          Fn.conditionEquals(enableAwsEumSmsWorker.valueAsString, 'true'),
          Fn.conditionEquals(
            rollbackApplicationImageDigest.valueAsString,
            CURRENT_CDK_ASSET,
          ),
        ),
      },
    );
    const shouldProvisionAwsEumSmsResources = new CfnCondition(
      this,
      'ShouldProvisionAwsEumSmsResources',
      {
        expression: Fn.conditionEquals(
          provisionAwsEumSmsResources.valueAsString,
          'true',
        ),
      },
    );
    const shouldScanMedia = new CfnCondition(this, 'ShouldScanMedia', {
      expression: Fn.conditionAnd(
        Fn.conditionEquals(enableMediaMalwareScanning.valueAsString, 'true'),
        shouldProvisionApplication,
      ),
    });
    const shouldRunEmailWorker = new CfnCondition(
      this,
      'ShouldRunEmailWorker',
      {
        expression: Fn.conditionAnd(
          Fn.conditionEquals(enableEmailWorker.valueAsString, 'true'),
          Fn.conditionEquals(
            rollbackApplicationImageDigest.valueAsString,
            CURRENT_CDK_ASSET,
          ),
        ),
      },
    );
    new CfnRule(this, 'ExpoPushWorkerRequiresLiveApplicationAndEvidence', {
      assertions: [
        {
          assert: Fn.conditionAnd(
            Fn.conditionEquals(provisionApplication.valueAsString, 'true'),
            Fn.conditionNot(
              Fn.conditionEquals(
                expoCredentialVerificationReference.valueAsString,
                'UNVERIFIED',
              ),
            ),
          ),
          assertDescription:
            'EnableExpoPushWorker=true requires the live application and retained credential-verification evidence.',
        },
      ],
      ruleCondition: Fn.conditionEquals(
        enableExpoPushWorker.valueAsString,
        'true',
      ),
    });
    new CfnRule(this, 'DirectPushRequiresWorkerAndEvidence', {
      assertions: [
        {
          assert: Fn.conditionAnd(
            Fn.conditionEquals(provisionApplication.valueAsString, 'true'),
            Fn.conditionEquals(enableExpoPushWorker.valueAsString, 'true'),
            Fn.conditionNot(
              Fn.conditionEquals(
                directPushCredentialVerificationReference.valueAsString,
                'UNVERIFIED',
              ),
            ),
          ),
          assertDescription:
            'EnableDirectPush=true requires the live push worker and retained direct-provider credential evidence.',
        },
      ],
      ruleCondition: Fn.conditionEquals(enableDirectPush.valueAsString, 'true'),
    });
    new CfnRule(this, 'DirectCutoverRequiresDirectPush', {
      assertions: [
        {
          assert: Fn.conditionEquals(enableDirectPush.valueAsString, 'true'),
          assertDescription:
            'Any direct platform cutover requires EnableDirectPush=true.',
        },
      ],
      ruleCondition: Fn.conditionOr(
        Fn.conditionEquals(
          pushProviderCutover.valueAsString,
          '{"version":1,"ios":"direct","android":"expo"}',
        ),
        Fn.conditionEquals(
          pushProviderCutover.valueAsString,
          '{"version":1,"ios":"expo","android":"direct"}',
        ),
        Fn.conditionEquals(
          pushProviderCutover.valueAsString,
          '{"version":1,"ios":"direct","android":"direct"}',
        ),
      ),
    });
    new CfnRule(this, 'SmsWorkerRequiresLiveApplicationAndEvidence', {
      assertions: [
        {
          assert: Fn.conditionAnd(
            Fn.conditionEquals(provisionApplication.valueAsString, 'true'),
            Fn.conditionEquals(
              provisionAwsEumSmsResources.valueAsString,
              'true',
            ),
            Fn.conditionNot(
              Fn.conditionEquals(
                smsRegistrationVerificationReference.valueAsString,
                'UNVERIFIED',
              ),
            ),
            Fn.conditionNot(
              Fn.conditionEquals(
                smsOriginationIdentityArn.valueAsString,
                'UNCONFIGURED',
              ),
            ),
            Fn.conditionNot(
              Fn.conditionEquals(smsHelpMessage.valueAsString, 'UNCONFIGURED'),
            ),
            Fn.conditionNot(
              Fn.conditionEquals(smsStopMessage.valueAsString, 'UNCONFIGURED'),
            ),
            Fn.conditionNot(
              Fn.conditionEquals(
                smsDestinationCountryCode.valueAsString,
                'UNCONFIGURED',
              ),
            ),
          ),
          assertDescription:
            'EnableAwsEumSmsWorker=true requires the live application, carrier approval evidence, an approved origination identity, and tenant-reviewed HELP/STOP messages.',
        },
      ],
      ruleCondition: Fn.conditionEquals(
        enableAwsEumSmsWorker.valueAsString,
        'true',
      ),
    });
    new CfnRule(this, 'SmsResourcesRequireCarrierEvidence', {
      assertions: [
        {
          assert: Fn.conditionAnd(
            Fn.conditionNot(
              Fn.conditionEquals(
                smsRegistrationVerificationReference.valueAsString,
                'UNVERIFIED',
              ),
            ),
            Fn.conditionNot(
              Fn.conditionEquals(
                smsOriginationIdentityArn.valueAsString,
                'UNCONFIGURED',
              ),
            ),
            Fn.conditionNot(
              Fn.conditionEquals(smsHelpMessage.valueAsString, 'UNCONFIGURED'),
            ),
            Fn.conditionNot(
              Fn.conditionEquals(smsStopMessage.valueAsString, 'UNCONFIGURED'),
            ),
            Fn.conditionNot(
              Fn.conditionEquals(
                smsDestinationCountryCode.valueAsString,
                'UNCONFIGURED',
              ),
            ),
          ),
          assertDescription:
            'ProvisionAwsEumSmsResources=true requires retained carrier approval and all carrier-reviewed pool inputs.',
        },
      ],
      ruleCondition: Fn.conditionEquals(
        provisionAwsEumSmsResources.valueAsString,
        'true',
      ),
    });
    new CfnRule(this, 'EmailWorkerRequiresLiveApplicationAndEvidence', {
      assertions: [
        {
          assert: Fn.conditionAnd(
            Fn.conditionEquals(provisionApplication.valueAsString, 'true'),
            Fn.conditionNot(
              Fn.conditionEquals(
                sesCredentialVerificationReference.valueAsString,
                'UNVERIFIED',
              ),
            ),
          ),
          assertDescription:
            'EnableEmailWorker=true requires the live application and retained SES/callback verification evidence.',
        },
      ],
      ruleCondition: Fn.conditionEquals(
        enableEmailWorker.valueAsString,
        'true',
      ),
    });
    new CfnRule(this, 'RollbackApplicationSelectionIsComplete', {
      assertions: [
        {
          assert: Fn.conditionOr(
            Fn.conditionAnd(
              Fn.conditionEquals(
                rollbackApplicationImageDigest.valueAsString,
                CURRENT_CDK_ASSET,
              ),
              Fn.conditionEquals(
                rollbackApplicationRepository.valueAsString,
                CURRENT_CDK_ASSET,
              ),
            ),
            Fn.conditionAnd(
              Fn.conditionNot(
                Fn.conditionEquals(
                  rollbackApplicationImageDigest.valueAsString,
                  CURRENT_CDK_ASSET,
                ),
              ),
              Fn.conditionNot(
                Fn.conditionEquals(
                  rollbackApplicationRepository.valueAsString,
                  CURRENT_CDK_ASSET,
                ),
              ),
            ),
          ),
          assertDescription:
            'Rollback application repository and image digest must be supplied together; normal deployments leave both on CURRENT_CDK_ASSET.',
        },
      ],
    });
    new CfnRule(this, 'RollbackRequiresPersistentlyDarkProviders', {
      assertions: [
        {
          assert: Fn.conditionAnd(
            Fn.conditionEquals(enableExpoPushWorker.valueAsString, 'false'),
            Fn.conditionEquals(enableDirectPush.valueAsString, 'false'),
            Fn.conditionEquals(enableAwsEumSmsWorker.valueAsString, 'false'),
            Fn.conditionEquals(enableEmailWorker.valueAsString, 'false'),
            Fn.conditionEquals(
              expoCredentialVerificationReference.valueAsString,
              'UNVERIFIED',
            ),
            Fn.conditionEquals(
              directPushCredentialVerificationReference.valueAsString,
              'UNVERIFIED',
            ),
            Fn.conditionEquals(
              sesCredentialVerificationReference.valueAsString,
              'UNVERIFIED',
            ),
            Fn.conditionEquals(
              pushProviderCutover.valueAsString,
              '{"version":1,"ios":"expo","android":"expo"}',
            ),
          ),
          assertDescription:
            'Rollback requires every provider-send enablement to remain false and push/email verification state to be reset before the older application is selected.',
        },
      ],
      ruleCondition: Fn.conditionNot(
        Fn.conditionEquals(
          rollbackApplicationImageDigest.valueAsString,
          CURRENT_CDK_ASSET,
        ),
      ),
    });
    const imageRepository = new ecr.Repository(this, 'ImageRepository', {
      encryption: ecr.RepositoryEncryption.AES_256,
      emptyOnDelete: false,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: RemovalPolicy.RETAIN,
      repositoryName: SERVER_REPOSITORY_NAME,
    });
    imageRepository.addLifecycleRule({
      description: 'Bound superseded live-pilot image retention.',
      maxImageCount: 10,
      rulePriority: 1,
    });

    // CDK builds and publishes this content-addressed asset before it starts
    // the CloudFormation update. The retained repository above remains in this
    // transition release so a failed update can restore the previous template
    // without colliding with an orphaned retained repository.
    const applicationImage = new ecrAssets.DockerImageAsset(
      this,
      'ApplicationImage',
      {
        buildArgs: {
          SOURCE_REPOSITORY_URL: sourceRepositoryUrl,
          SOURCE_SHA: sourceSha,
        },
        directory: fileURLToPath(new URL('../../..', import.meta.url)),
        exclude: [...APPLICATION_IMAGE_EXCLUDES],
        file: 'packages/server/container/psd-eoc.Dockerfile',
        ignoreMode: IgnoreMode.DOCKER,
        platform: ecrAssets.Platform.LINUX_AMD64,
      },
    );
    const describeApplicationImage: customResources.AwsSdkCall = {
      action: 'describeImages',
      parameters: {
        imageIds: [{ imageTag: applicationImage.imageTag }],
        repositoryName: applicationImage.repository.repositoryName,
      },
      outputPaths: ['imageDetails.0.imageDigest'],
      physicalResourceId: customResources.PhysicalResourceId.of(
        applicationImage.assetHash,
      ),
      service: 'ECR',
    };
    const applicationImageDigest = new customResources.AwsCustomResource(
      this,
      'ApplicationImageDigestLookup',
      {
        installLatestAwsSdk: false,
        onCreate: describeApplicationImage,
        onUpdate: describeApplicationImage,
        policy: customResources.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['ecr:DescribeImages'],
            resources: [applicationImage.repository.repositoryArn],
          }),
        ]),
      },
    );
    const applicationImageUri = Fn.join('', [
      applicationImage.repository.repositoryUri,
      '@',
      applicationImageDigest.getResponseField('imageDetails.0.imageDigest'),
    ]);
    const deployedApplicationImageUri = Fn.conditionIf(
      shouldUseRollbackApplicationImage.logicalId,
      Fn.join('', [
        Fn.conditionIf(
          shouldUseLegacyRollbackRepository.logicalId,
          imageRepository.repositoryUri,
          applicationImage.repository.repositoryUri,
        ).toString(),
        '@',
        rollbackApplicationImageDigest.valueAsString,
      ]),
      applicationImageUri,
    ).toString();

    const network = new ec2.Vpc(this, 'DatabaseNetwork', {
      availabilityZones: [`${region}a`, `${region}b`],
      ipAddresses: ec2.IpAddresses.cidr('10.43.0.0/24'),
      natGateways: 1,
      // Nothing in this stack uses the VPC default security group. Avoid the
      // CDK custom-resource Lambda that would otherwise mutate it; the Aurora
      // writer receives its own ingress-free security group below.
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        {
          cidrMask: 26,
          name: 'Database',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        {
          cidrMask: 28,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 28,
          name: APPLICATION_SUBNET_GROUP_NAME,
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });
    const applicationSubnets = network.selectSubnets({
      subnetGroupName: APPLICATION_SUBNET_GROUP_NAME,
    });

    const databaseEngine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_16_13,
    });
    const databaseParameterGroup = new rds.ParameterGroup(
      this,
      'DatabaseParameterGroup',
      {
        engine: databaseEngine,
        parameters: {
          'rds.force_ssl': '1',
        },
      },
    );
    const databaseAdminSecret = new secretsmanager.Secret(
      this,
      'DatabaseAdminSecret',
      {
        description:
          'Generated migration-only administrator credential for staff-minimized live-pilot data.',
        generateSecretString: {
          excludePunctuation: true,
          generateStringKey: 'password',
          passwordLength: 64,
          secretStringTemplate: JSON.stringify({ username: 'psd_eoc_admin' }),
        },
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: `${SECRET_PREFIX}/database/admin`,
      },
    );
    const databaseApplicationSecret = new secretsmanager.Secret(
      this,
      'DatabaseApplicationSecret',
      {
        description:
          'Generated application LOGIN credential; bootstrap grants only psd_eoc_app membership.',
        generateSecretString: {
          excludePunctuation: true,
          generateStringKey: 'password',
          passwordLength: 64,
          secretStringTemplate: JSON.stringify({
            username: 'psd_eoc_application',
          }),
        },
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: `${SECRET_PREFIX}/database/application`,
      },
    );
    const googleOidcCookieSecret = new secretsmanager.Secret(
      this,
      'GoogleOidcCookieSecret',
      {
        description:
          'Generated base64url key material for Google OIDC transient state.',
        generateSecretString: {
          // 44 characters, not 43. The reader requires *canonical* unpadded
          // base64url: it decodes the value and re-encodes it, and refuses
          // anything that does not round-trip. A 43-character string encodes
          // 32 bytes plus 2 leftover bits, so it only round-trips when those
          // bits happen to be zero — true for about a quarter of randomly
          // generated strings. At 44 characters the length is a multiple of
          // four, there are no leftover bits, and every generated value
          // round-trips. It decodes to 33 bytes, inside the required 32..64.
          //
          // The original 43 shipped and worked purely because the first
          // generated secret drew a lucky value. A rebuilt deployment had a
          // roughly three-in-four chance of a secret the application would
          // refuse at startup, surfacing only as a failed health check.
          excludePunctuation: true,
          passwordLength: 44,
        },
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: `${SECRET_PREFIX}/google-oidc-cookie-secret`,
      },
    );
    const apiSaltSecret = new secretsmanager.Secret(this, 'ApiSaltSecret', {
      description:
        'Generated application-only salt for API credential hashing.',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 64,
      },
      removalPolicy: RemovalPolicy.RETAIN,
      secretName: `${SECRET_PREFIX}/api-salt`,
    });
    // Credentials for the two internal worker routes. Both routes have existed
    // and refused every request, because nothing ever provisioned the bearer
    // they check against — they fail closed, so the effect was invisible until
    // a worker needed them.
    //
    // Generated rather than supplied: no human needs to know these, and a value
    // nobody types is a value nobody pastes somewhere it does not belong. Each
    // route gets its own so one can be rotated without disturbing the other.
    const deliveryStateWorkerSecret = new secretsmanager.Secret(
      this,
      'DeliveryStateWorkerSecret',
      {
        description:
          'Generated bearer a channel worker presents to the delivery-state writeback route.',
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 64,
        },
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: `${SECRET_PREFIX}/workers/delivery-state-token`,
      },
    );
    const attemptExecutionWorkerSecret = new secretsmanager.Secret(
      this,
      'AttemptExecutionWorkerSecret',
      {
        description:
          'Generated bearer a channel worker presents to the attempt-execution route.',
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 64,
        },
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: `${SECRET_PREFIX}/workers/attempt-execution-token`,
      },
    );
    const pushEndpointWorkerSecret = new secretsmanager.Secret(
      this,
      'PushEndpointWorkerSecret',
      {
        description:
          'Generated bearer for push endpoint eligibility and token-free invalidation routes.',
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 64,
        },
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: `${SECRET_PREFIX}/workers/push-endpoint-token`,
      },
    );
    const expoPushRuntimeWorkerSecret = new secretsmanager.Secret(
      this,
      'ExpoPushRuntimeWorkerSecret',
      {
        description:
          'Generated bearer for Expo provider claims, receipt state, retry schedules, and work resolution.',
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 64,
        },
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: `${SECRET_PREFIX}/workers/expo-push-runtime-token`,
      },
    );
    const emailRuntimeWorkerSecret = new secretsmanager.Secret(
      this,
      'EmailRuntimeWorkerSecret',
      {
        description:
          'Generated bearer for SES provider claims, retry resolution, and final-send authorization.',
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 64,
        },
        removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
        secretName: `${SECRET_PREFIX}/workers/email-runtime-token`,
      },
    );
    const smsRuntimeWorkerSecret = new secretsmanager.Secret(
      this,
      'SmsRuntimeWorkerSecret',
      {
        description:
          'Generated bearer for SMS provider claims, immutable retries, current destination policy, and lifecycle reconciliation.',
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 64,
        },
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: `${SECRET_PREFIX}/workers/sms-runtime-token`,
      },
    );
    const expoAccessTokenSecret = new secretsmanager.Secret(
      this,
      'ExpoAccessTokenSecret',
      {
        description:
          'Expo server access token and explicit verification status. Both fields must be replaced through Secrets Manager before the worker is enabled.',
        generateSecretString: {
          excludePunctuation: true,
          generateStringKey: 'accessToken',
          passwordLength: 64,
          secretStringTemplate: JSON.stringify({ status: 'UNCONFIGURED' }),
        },
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: `${SECRET_PREFIX}/providers/expo-access-token`,
      },
    );
    const apnsDirectCredentialSecret = new secretsmanager.Secret(
      this,
      'ApnsDirectCredentialSecret',
      {
        description:
          'Direct APNs provider identity. Replace every generated placeholder field through Secrets Manager before direct push is enabled.',
        generateSecretString: {
          excludePunctuation: true,
          generateStringKey: 'privateKey',
          passwordLength: 128,
          secretStringTemplate: JSON.stringify({
            environment: 'production',
            keyId: 'UNCONFIGURED',
            status: 'UNCONFIGURED',
            teamId: 'UNCONFIGURED',
            topic: 'UNCONFIGURED',
          }),
        },
        removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
        secretName: `${SECRET_PREFIX}/providers/apns-direct`,
      },
    );
    const fcmDirectCredentialSecret = new secretsmanager.Secret(
      this,
      'FcmDirectCredentialSecret',
      {
        description:
          'Direct FCM HTTP v1 sender identity. Replace every generated placeholder field through Secrets Manager before direct push is enabled.',
        generateSecretString: {
          excludePunctuation: true,
          generateStringKey: 'privateKey',
          passwordLength: 128,
          secretStringTemplate: JSON.stringify({
            clientEmail: 'UNCONFIGURED',
            environment: 'production',
            projectId: 'UNCONFIGURED',
            status: 'UNCONFIGURED',
          }),
        },
        removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
        secretName: `${SECRET_PREFIX}/providers/fcm-direct`,
      },
    );
    const bootstrapIdentitySecret = new secretsmanager.Secret(
      this,
      'BootstrapIdentitySecret',
      {
        description:
          'Bootstrap identity material supplied through NoEcho deployment parameters. Holds only the initial mobile transition digest; the approved-staff identity it also carried fed the access fixture, which is gone.',
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: `${SECRET_PREFIX}/bootstrap/approved-identity`,
        secretObjectValue: {
          initialMobileTransitionEmailSha256: SecretValue.unsafePlainText(
            initialMobileTransitionEmailSha256.valueAsString,
          ),
        },
      },
    );
    const initialAccessGroupSecret = new secretsmanager.Secret(
      this,
      'InitialAccessGroupSecret',
      {
        description:
          'First-run access-group email supplied through a NoEcho deployment parameter and readable only by the bootstrap task execution role.',
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: `${SECRET_PREFIX}/bootstrap/initial-access-group`,
        secretObjectValue: {
          email: SecretValue.unsafePlainText(
            initialAccessGroupEmail.valueAsString,
          ),
        },
      },
    );

    const databaseSecurityGroup = new ec2.SecurityGroup(
      this,
      'DatabaseSecurityGroup',
      {
        allowAllOutbound: false,
        // Also stale, and left for the same reason: two groups reach the writer
        // now, not one. See the note on psd-eoc-application above.
        description:
          'Isolated Aurora; accepts native PostgreSQL only from the application/bootstrap security group.',
        vpc: network as unknown as ec2.IVpc,
      },
    );
    const applicationSecurityGroup = new ec2.SecurityGroup(
      this,
      'ApplicationSecurityGroup',
      {
        allowAllOutbound: false,
        // This description is stale and deliberately left alone: App Runner
        // moved to psd-eoc-apprunner, so this group now serves the scheduled
        // access-membership-sync task and one-off bootstrap runs only.
        //
        // GroupDescription requires replacement. Correcting the wording forces
        // CloudFormation to replace this group *and* the database group beside
        // it, which the live Aurora cluster is attached to — and `cdk diff`
        // cannot even build a change set for it, so the real blast radius is
        // unverifiable up front. Replacing the database's security group on a
        // serving cluster is not a trade worth making for a sentence.
        //
        // Read the group names, not these descriptions: psd-eoc-application is
        // the task path, psd-eoc-apprunner is the service path.
        description:
          'Native PostgreSQL and HTTPS egress only for App Runner and one-off bootstrap tasks.',
        securityGroupName: 'psd-eoc-application',
        vpc: network as unknown as ec2.IVpc,
      },
    );
    applicationSecurityGroup.addEgressRule(
      databaseSecurityGroup,
      ec2.Port.tcp(DATABASE_PORT),
      'Native PostgreSQL TLS to the isolated Aurora writer only.',
    );
    applicationSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS through the NAT gateway for Google OAuth and AWS task dependencies.',
    );
    databaseSecurityGroup.addIngressRule(
      applicationSecurityGroup,
      ec2.Port.tcp(DATABASE_PORT),
      'Native PostgreSQL only from the application/bootstrap security group.',
    );

    const database = new rds.DatabaseCluster(this, 'Database', {
      backup: {
        retention: Duration.days(14),
      },
      clusterIdentifier: DATABASE_IDENTIFIER,
      copyTagsToSnapshot: true,
      credentials: rds.Credentials.fromSecret(
        databaseAdminSecret as unknown as secretsmanager.ISecret,
      ),
      defaultDatabaseName: DATABASE_NAME,
      deletionProtection: true,
      enableDataApi: false,
      engine: databaseEngine,
      parameterGroup: databaseParameterGroup,
      readers: [],
      // Retain staff-minimized access and append-only event truth. Any future
      // retirement is a separately reviewed human data-lifecycle decision.
      removalPolicy: RemovalPolicy.RETAIN,
      securityGroups: [databaseSecurityGroup],
      // Shared with the capacity alarm, which asks whether the cluster is
      // pinned at this value; see `AURORA_MAX_CAPACITY_ACU`.
      serverlessV2MaxCapacity: AURORA_MAX_CAPACITY_ACU,
      serverlessV2MinCapacity: 0.5,
      storageEncrypted: true,
      vpc: network as unknown as ec2.IVpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        autoMinorVersionUpgrade: true,
        availabilityZone: `${region}a`,
        enablePerformanceInsights: false,
        publiclyAccessible: false,
      }),
    });

    const healthQueue = new sqs.Queue(this, 'HealthQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      queueName: HEALTH_QUEUE_NAME,
      removalPolicy: RemovalPolicy.RETAIN,
      retentionPeriod: Duration.days(1),
      visibilityTimeout: Duration.seconds(30),
    });

    const emailSourceQueueIdentity = sqs.Queue.fromQueueArn(
      this,
      'EmailRedriveSourceQueue',
      this.formatArn({
        resource: EMAIL_QUEUE_NAME,
        service: 'sqs',
      }),
    );
    const emailDeadLetterQueue = new sqs.Queue(this, 'EmailDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      queueName: EMAIL_DEAD_LETTER_QUEUE_NAME,
      redriveAllowPolicy: {
        redrivePermission: sqs.RedrivePermission.BY_QUEUE,
        sourceQueues: [emailSourceQueueIdentity],
      },
      removalPolicy: RemovalPolicy.RETAIN,
      retentionPeriod: Duration.days(14),
    });
    const emailQueue = new sqs.Queue(this, 'EmailQueue', {
      deadLetterQueue: {
        maxReceiveCount: EMAIL_QUEUE_MAX_RECEIVES,
        queue: emailDeadLetterQueue,
      },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      queueName: EMAIL_QUEUE_NAME,
      removalPolicy: RemovalPolicy.RETAIN,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.seconds(120),
    });
    // One queue pair per channel, plus the delivery queue an authorized
    // notification batch lands on before it is split across channels. Email's
    // pair predates these and is defined above; the rest are built the same way
    // so the alarms, runbooks, and redrive permissions line up across channels.
    const channelQueuePairs = (
      [
        ['Delivery', DELIVERY_QUEUE_NAME, DELIVERY_DEAD_LETTER_QUEUE_NAME],
        ['Sms', SMS_QUEUE_NAME, SMS_DEAD_LETTER_QUEUE_NAME],
        [
          'SmsReceipt',
          SMS_RECEIPT_QUEUE_NAME,
          SMS_RECEIPT_DEAD_LETTER_QUEUE_NAME,
        ],
        ['Push', PUSH_QUEUE_NAME, PUSH_DEAD_LETTER_QUEUE_NAME],
      ] as const
    ).map(([id, queueName, deadLetterQueueName]) => {
      const redriveSource = sqs.Queue.fromQueueArn(
        this,
        `${id}RedriveSourceQueue`,
        this.formatArn({ resource: queueName, service: 'sqs' }),
      );
      const deadLetterQueue = new sqs.Queue(this, `${id}DeadLetterQueue`, {
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        queueName: deadLetterQueueName,
        redriveAllowPolicy: {
          redrivePermission: sqs.RedrivePermission.BY_QUEUE,
          sourceQueues: [redriveSource],
        },
        removalPolicy: RemovalPolicy.RETAIN,
        retentionPeriod: Duration.days(14),
      });
      const queue = new sqs.Queue(this, `${id}Queue`, {
        deadLetterQueue: {
          maxReceiveCount: DELIVERY_QUEUE_MAX_RECEIVES,
          queue: deadLetterQueue,
        },
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        queueName,
        removalPolicy: RemovalPolicy.RETAIN,
        retentionPeriod: Duration.days(4),
        visibilityTimeout: Duration.seconds(60),
      });
      return [id, { deadLetterQueue, queue }] as const;
    });
    const queuePairs = Object.fromEntries(channelQueuePairs) as Record<
      'Delivery' | 'Sms' | 'SmsReceipt' | 'Push',
      { deadLetterQueue: sqs.Queue; queue: sqs.Queue }
    >;
    const deliveryQueue = queuePairs.Delivery.queue;

    // Provider resources are synthesized now but created only when every
    // carrier-evidence gate above is explicitly enabled. The existing queue,
    // worker task, and runtime API remain reviewable while this condition is
    // false, without creating an origination path.
    const smsOptOutList = new smsvoice.CfnOptOutList(this, 'SmsOptOutList', {
      optOutListName: 'psd-eoc-sms',
    });
    smsOptOutList.cfnOptions.condition = shouldProvisionAwsEumSmsResources;
    smsOptOutList.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const smsProtectConfiguration = new smsvoice.CfnProtectConfiguration(
      this,
      'SmsProtectConfiguration',
      {
        countryRuleSet: {
          sms: [
            {
              countryCode: smsDestinationCountryCode.valueAsString,
              protectStatus: 'ALLOW',
            },
          ],
        },
        deletionProtectionEnabled: true,
      },
    );
    smsProtectConfiguration.cfnOptions.condition =
      shouldProvisionAwsEumSmsResources;
    smsProtectConfiguration.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const smsPool = new smsvoice.CfnPool(this, 'SmsPool', {
      deletionProtectionEnabled: true,
      mandatoryKeywords: {
        help: { message: smsHelpMessage.valueAsString },
        stop: { message: smsStopMessage.valueAsString },
      },
      optOutListName: smsOptOutList.ref,
      originationIdentities: [smsOriginationIdentityArn.valueAsString],
      selfManagedOptOutsEnabled: false,
      sharedRoutesEnabled: false,
    });
    smsPool.cfnOptions.condition = shouldProvisionAwsEumSmsResources;
    smsPool.applyRemovalPolicy(RemovalPolicy.RETAIN);
    smsPool.addResourceDependency(smsOptOutList);
    const smsConfigurationSet = new smsvoice.CfnConfigurationSet(
      this,
      'SmsConfigurationSet',
      {
        configurationSetName: 'psd-eoc-sms',
        messageFeedbackEnabled: false,
        protectConfigurationId:
          smsProtectConfiguration.attrProtectConfigurationId,
      },
    );
    smsConfigurationSet.cfnOptions.condition =
      shouldProvisionAwsEumSmsResources;
    smsConfigurationSet.applyRemovalPolicy(RemovalPolicy.RETAIN);
    smsConfigurationSet.addResourceDependency(smsProtectConfiguration);

    const smsDeliveryEventRule = new events.Rule(this, 'SmsDeliveryEventRule', {
      description:
        'Routes AWS End User Messaging delivery receipts to their retained queue.',
      enabled: false,
      eventPattern: {
        source: ['aws.sms-voice'],
        detailType: ['Text Message Delivery Status Updated'],
      },
      ruleName: 'psd-eoc-sms-delivery-events',
    });
    smsDeliveryEventRule.addTarget(
      new eventTargets.SqsQueue(queuePairs.SmsReceipt.queue),
    );
    const smsDeliveryEventCfnRule = smsDeliveryEventRule.node
      .defaultChild as events.CfnRule;
    smsDeliveryEventCfnRule.state = Fn.conditionIf(
      shouldRunAwsEumSmsWorker.logicalId,
      'ENABLED',
      'DISABLED',
    ).toString();

    const smsOptOutSchedule = new events.Rule(this, 'SmsOptOutSchedule', {
      description:
        'Reconciles the AWS-managed STOP list into append-only endpoint policy evidence.',
      enabled: false,
      ruleName: 'psd-eoc-sms-opt-out-reconciliation',
      schedule: events.Schedule.rate(Duration.minutes(15)),
    });
    smsOptOutSchedule.addTarget(
      new eventTargets.SqsQueue(queuePairs.Sms.queue, {
        message: events.RuleTargetInput.fromObject({
          kind: 'sms-opt-out-reconciliation',
        }),
      }),
    );
    const smsOptOutScheduleCfnRule = smsOptOutSchedule.node
      .defaultChild as events.CfnRule;
    smsOptOutScheduleCfnRule.state = Fn.conditionIf(
      shouldRunAwsEumSmsWorker.logicalId,
      'ENABLED',
      'DISABLED',
    ).toString();

    // Alarm routing. The operations key encrypts both topics so CloudWatch can
    // publish to them without the topics being world-writable, and the two
    // topics separate "look at this soon" from "wake somebody up".
    const operationsKey = new kms.Key(this, 'OperationsKey', {
      description: 'Encrypts PSD EOC operational alarm notifications.',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Deliberately not encrypted, unlike the log groups this key still covers.
    //
    // Encrypted with a customer-managed key, neither topic could deliver an
    // email subscription confirmation: the subscription was created with the
    // right address and stayed PendingConfirmation indefinitely, with no error
    // recorded anywhere and no KMS call ever made. Granting sns.amazonaws.com
    // use of the key did not change it. The two topics in this account that do
    // reach the same mailbox — TechAlerts and GuardDuty_To_Email — are both
    // unencrypted.
    //
    // The trade is worth stating rather than hiding. An alarm notification
    // carries an alarm name, a state, a metric and a runbook anchor; it carries
    // no student data, no recipient, and no provider payload, because none of
    // those may appear in an alarm at all. What encryption at rest bought here
    // was close to nothing, and it cost the one property this path exists for:
    // that it still works when other things are broken. Publishing is still
    // restricted by each topic's access policy.
    const operationsAlarmTopic = new sns.Topic(this, 'OperationsAlarmTopic', {
      displayName: 'PSD EOC operations',
      topicName: 'psd-eoc-operations-alarms',
    });
    const criticalAlarmTopic = new sns.Topic(this, 'CriticalAlarmTopic', {
      displayName: 'PSD EOC critical',
      topicName: 'psd-eoc-critical-alarms',
    });
    // Where alarms go when they clear.
    //
    // Recoveries used to publish to the alarm's own topic, so a flapping alarm
    // paged twice per cycle and texted twice per cycle. One poison message in
    // the email queue produced 79 of those in a fortnight. The recovery is
    // still mailed -- an operator wants to know a thing fixed itself -- but it
    // is not a page, so this topic has no SMS subscription.
    const recoveryAlarmTopic = new sns.Topic(this, 'RecoveryAlarmTopic', {
      displayName: 'PSD EOC recoveries',
      topicName: 'psd-eoc-alarm-recoveries',
    });

    // The delivery queue's consumer. It moves each authorized batch to the
    // queue for its channel and does nothing else — no database, no provider,
    // no VPC, and no authority to change what it forwards.
    const deliveryRouterLogGroup = new logs.LogGroup(
      this,
      'DeliveryRouterLogGroup',
      {
        logGroupName: '/psd-eoc/workers/delivery-router',
        removalPolicy: RemovalPolicy.RETAIN,
        retention: logs.RetentionDays.TWO_WEEKS,
      },
    );
    const deliveryRouter = new lambda.Function(this, 'DeliveryRouter', {
      code: lambda.Code.fromAsset(
        fileURLToPath(new URL('../../lambda/delivery-router', import.meta.url)),
      ),
      description:
        'Routes one authorized notification batch from the delivery queue to its channel queue.',
      environment: {
        EMAIL_QUEUE_URL: emailQueue.queueUrl,
        PUSH_QUEUE_URL: queuePairs.Push.queue.queueUrl,
        SMS_QUEUE_URL: queuePairs.Sms.queue.queueUrl,
      },
      functionName: 'psd-eoc-delivery-router',
      handler: 'index.handler',
      logGroup: deliveryRouterLogGroup,
      memorySize: 256,
      reservedConcurrentExecutions: 5,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
    });
    deliveryQueue.grantConsumeMessages(deliveryRouter);
    for (const pair of [
      { queue: emailQueue },
      queuePairs.Push,
      queuePairs.Sms,
    ]) {
      pair.queue.grantSendMessages(deliveryRouter);
    }
    deliveryRouter.addEventSource(
      new lambdaEventSources.SqsEventSource(deliveryQueue, {
        batchSize: 10,
        // One unroutable batch must not drag its siblings back onto the queue;
        // the handler reports failures per message.
        reportBatchItemFailures: true,
      }),
    );

    const emailWorkerLogGroup = new logs.LogGroup(this, 'EmailWorkerLogGroup', {
      logGroupName: EMAIL_WORKER_LOG_GROUP_NAME,
      removalPolicy: RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.TWO_WEEKS,
    });
    const emailCallbackWorkerLogGroup = new logs.LogGroup(
      this,
      'EmailCallbackWorkerLogGroup',
      {
        logGroupName: EMAIL_CALLBACK_WORKER_LOG_GROUP_NAME,
        removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
        retention: logs.RetentionDays.TWO_WEEKS,
      },
    );
    const emailWorkerRole = new iam.Role(this, 'EmailWorkerRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description:
        'Consumes and retries only the SES email queue and sends through one configured sender and configuration set.',
    });
    iam.Grant.addToPrincipal({
      actions: [
        'sqs:ChangeMessageVisibility',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
        'sqs:GetQueueUrl',
        'sqs:ReceiveMessage',
      ],
      grantee: emailWorkerRole,
      resourceArns: [emailQueue.queueArn],
    });

    const emailConfigurationSetArn = Arn.format(
      {
        account,
        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
        partition,
        region,
        resource: 'configuration-set',
        resourceName: SES_CONFIGURATION_SET_NAME,
        service: 'ses',
      },
      this,
    );
    const emailIdentityArn = Arn.format(
      {
        account,
        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
        partition,
        region,
        resource: 'identity',
        resourceName: sesIdentityDomain,
        service: 'ses',
      },
      this,
    );
    emailWorkerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        conditions: {
          StringEquals: { 'ses:FromAddress': sesFromAddress },
        },
        resources: [emailIdentityArn, emailConfigurationSetArn],
        sid: 'SendOnlyConfiguredSesEmail',
      }),
    );
    const emailEventsKey = new kms.Key(this, 'EmailEventsKey', {
      description:
        'Encrypts configured-unverified SES event evidence for the live pilot.',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    emailEventsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        conditions: {
          StringEquals: {
            'AWS:SourceAccount': account,
            'AWS:SourceArn': emailConfigurationSetArn,
          },
        },
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        resources: ['*'],
        sid: 'AllowSesEmailEventEncryption',
      }),
    );
    const emailConfigurationSet = new ses.CfnConfigurationSet(
      this,
      'EmailConfigurationSet',
      {
        name: SES_CONFIGURATION_SET_NAME,
        reputationOptions: {
          reputationMetricsEnabled: true,
        },
        sendingOptions: {
          sendingEnabled: true,
        },
      },
    );
    emailConfigurationSet.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const emailCallbackSourceQueueIdentity = sqs.Queue.fromQueueArn(
      this,
      'EmailCallbackRedriveSourceQueue',
      this.formatArn({
        resource: EMAIL_CALLBACK_QUEUE_NAME,
        service: 'sqs',
      }),
    );
    const emailCallbackDeadLetterQueue = new sqs.Queue(
      this,
      'EmailCallbackDeadLetterQueue',
      {
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        queueName: EMAIL_CALLBACK_DEAD_LETTER_QUEUE_NAME,
        redriveAllowPolicy: {
          redrivePermission: sqs.RedrivePermission.BY_QUEUE,
          sourceQueues: [emailCallbackSourceQueueIdentity],
        },
        retentionPeriod: Duration.days(14),
      },
    );
    emailCallbackDeadLetterQueue.applyRemovalPolicy(
      RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    );
    const emailCallbackQueue = new sqs.Queue(this, 'EmailCallbackQueue', {
      deadLetterQueue: {
        maxReceiveCount: EMAIL_QUEUE_MAX_RECEIVES,
        queue: emailCallbackDeadLetterQueue,
      },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      queueName: EMAIL_CALLBACK_QUEUE_NAME,
      retentionPeriod: Duration.days(14),
      visibilityTimeout: Duration.minutes(2),
    });
    emailCallbackQueue.applyRemovalPolicy(
      RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    );
    const emailEventsTopic = new sns.Topic(this, 'EmailEventsTopic', {
      displayName: 'PSD EOC live-pilot SES event evidence',
      enforceSSL: true,
      masterKey: emailEventsKey,
      topicName: SES_EVENT_TOPIC_NAME,
    });
    emailEventsTopic.applyRemovalPolicy(RemovalPolicy.RETAIN);
    emailEventsTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        conditions: {
          StringEquals: {
            'AWS:SourceAccount': account,
            'AWS:SourceArn': emailConfigurationSetArn,
          },
        },
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        resources: [emailEventsTopic.topicArn],
        sid: 'AllowSesConfigurationSetEvents',
      }),
    );
    emailCallbackQueue.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        conditions: {
          ArnEquals: { 'aws:SourceArn': emailEventsTopic.topicArn },
        },
        principals: [new iam.ServicePrincipal('sns.amazonaws.com')],
        resources: [emailCallbackQueue.queueArn],
        sid: 'AllowOnlySesEventTopicDelivery',
      }),
    );
    const emailEventsQueueSubscription = new sns.CfnSubscription(
      this,
      'EmailEventsQueueSubscription',
      {
        endpoint: emailCallbackQueue.queueArn,
        protocol: 'sqs',
        rawMessageDelivery: false,
        topicArn: emailEventsTopic.topicArn,
      },
    );
    emailEventsQueueSubscription.addResourceDependency(
      emailCallbackQueue.node.defaultChild as sqs.CfnQueue,
    );
    const emailEventDestination = new ses.CfnConfigurationSetEventDestination(
      this,
      'EmailConfigurationSetEventDestination',
      {
        configurationSetName: emailConfigurationSet.ref,
        eventDestination: {
          enabled: true,
          matchingEventTypes: [
            'SEND',
            'DELIVERY',
            'BOUNCE',
            'COMPLAINT',
            'REJECT',
          ],
          name: SES_EVENT_DESTINATION_NAME,
          snsDestination: { topicArn: emailEventsTopic.topicArn },
        },
      },
    );
    emailEventDestination.addResourceDependency(emailConfigurationSet);

    const googleOauthSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'GoogleOauthSecret',
      googleOauthSecretArn.valueAsString,
    );
    // Import by complete ARN, never by name. fromSecretNameV2 yields a
    // secretArn without the generated six-character suffix; the ECS secret
    // reference then requests that suffix-less ARN while grantRead authorizes
    // `<arn>-??????`. The two can never match, and the task fails to start
    // with a ResourceInitializationError that names no cause. See issue #271.
    const googleGroupsSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'GoogleGroupsSecret',
      googleGroupsSecretArn.valueAsString,
    );
    // The connector gets its own security group rather than sharing the one the
    // bootstrap tasks use.
    //
    // App Runner treats a VPC connector as immutable — any change replaces it —
    // and it refuses to create a replacement whose subnet and security-group
    // combination matches a connector that already exists. Sharing a group with
    // the bootstrap tasks therefore made the live connector collide with its own
    // replacement, so nothing about it could ever be edited without first
    // deleting it and taking the running service's network down with it. That
    // is what pinned a stale tag onto this stack for two days.
    //
    // Separate groups also describe the two egress paths honestly: they happen
    // to need the same rules today, but a one-off migration task and a
    // continuously running web service are not the same trust boundary.
    const appRunnerConnectorSecurityGroup = new ec2.SecurityGroup(
      this,
      'AppRunnerConnectorSecurityGroup',
      {
        allowAllOutbound: false,
        description:
          'Native PostgreSQL and HTTPS egress for the App Runner service.',
        securityGroupName: 'psd-eoc-apprunner',
        vpc: network as unknown as ec2.IVpc,
      },
    );
    appRunnerConnectorSecurityGroup.addEgressRule(
      databaseSecurityGroup,
      ec2.Port.tcp(DATABASE_PORT),
      'Native PostgreSQL TLS to the isolated Aurora writer only.',
    );
    appRunnerConnectorSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS through the NAT gateway for Google OAuth and AWS dependencies.',
    );
    databaseSecurityGroup.addIngressRule(
      appRunnerConnectorSecurityGroup,
      ec2.Port.tcp(DATABASE_PORT),
      'Native PostgreSQL TLS from the App Runner service only.',
    );
    const appRunnerVpcConnector = new apprunner.CfnVpcConnector(
      this,
      'AppRunnerVpcConnector',
      {
        securityGroups: [appRunnerConnectorSecurityGroup.securityGroupId],
        subnets: applicationSubnets.subnetIds,
        // Not 'psd-eoc-vpc'. App Runner creates the replacement before deleting
        // the original, so a connector being replaced collides with its own
        // name. Renaming it alongside the dedicated security group breaks that,
        // and 'psd-eoc-apprunner' says what it actually connects.
        vpcConnectorName: 'psd-eoc-apprunner',
      },
    );
    // Editable at last: the connector's replacement no longer collides with the
    // live one now that it carries its own security group.
    Tags.of(appRunnerVpcConnector).add('Application', 'PSD EOC', {
      priority: 300,
    });
    Tags.of(appRunnerVpcConnector).add('DataClassification', 'synthetic-only', {
      priority: 300,
    });
    Tags.of(appRunnerVpcConnector).add('Environment', 'production', {
      priority: 300,
    });
    Tags.of(appRunnerVpcConnector).remove('DataScope', { priority: 300 });

    const bootstrapLogGroup = new logs.LogGroup(this, 'BootstrapLogGroup', {
      logGroupName: BOOTSTRAP_LOG_GROUP_NAME,
      removalPolicy: RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.TWO_WEEKS,
    });
    const bootstrapCluster = new ecs.Cluster(this, 'BootstrapEcsCluster', {
      clusterName: BOOTSTRAP_CLUSTER_NAME,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
      vpc: network as unknown as ec2.IVpc,
    });
    const bootstrapTaskExecutionRole = new iam.Role(
      this,
      'BootstrapTaskExecutionRole',
      {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        description:
          'Pulls the reviewed bootstrap image, reads only bootstrap secrets, and writes bounded bootstrap logs.',
      },
    );
    const bootstrapTaskRole = new iam.Role(this, 'BootstrapTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description:
        'No-authority task role for the native PostgreSQL bootstrap container.',
    });
    const bootstrapTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      'BootstrapTaskDefinition',
      {
        cpu: 256,
        executionRole: bootstrapTaskExecutionRole,
        family: 'psd-eoc-bootstrap',
        memoryLimitMiB: 512,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskRole: bootstrapTaskRole,
      },
    );
    bootstrapTaskDefinition.addVolume({ name: 'native-bootstrap-tmp' });
    const bootstrapContainer = bootstrapTaskDefinition.addContainer(
      BOOTSTRAP_CONTAINER_NAME,
      {
        command: [
          'timeout',
          '-s',
          'TERM',
          '-k',
          '30s',
          '25m',
          'bun',
          'packages/server/scripts/operations/bootstrap.ts',
        ],
        environment: {
          AWS_ACCOUNT_ID: account,
          AWS_REGION: region,
          DATABASE_DRIVER: 'postgres',
          DATABASE_HOST: database.clusterEndpoint.hostname,
          DATABASE_IDLE_TIMEOUT_SECONDS: '20',
          DATABASE_MAX_CONNECTIONS: '1',
          DATABASE_NAME: DATABASE_NAME,
          DATABASE_PORT: String(DATABASE_PORT),
          DATABASE_SSL_ROOT_CERT: DATABASE_SSL_ROOT_CERT,
          DATABASE_CONNECT_TIMEOUT_SECONDS: '10',
          PSD_EOC_FACILITIES: readFacilityContext(this.node),
          PSD_EOC_NEIGHBORHOODS: readNeighborhoodContext(this.node),
          PSD_EOC_SYNTHETIC_GROUPS: readSyntheticGroupContext(this.node),
          PSD_EOC_THREATS: readThreatContext(this.node),
          PSD_EOC_INITIAL_ACCESS_GROUP_ID: initialAccessGroupId.valueAsString,
          PSD_EOC_INITIAL_ACCESS_GROUP_NAME:
            initialAccessGroupName.valueAsString,
          SOURCE_SHA: sourceSha,
          TMPDIR: '/tmp',
        },
        essential: true,
        image: ecs.ContainerImage.fromRegistry(applicationImageUri),
        logging: ecs.LogDrivers.awsLogs({
          logGroup: bootstrapLogGroup,
          streamPrefix: BOOTSTRAP_CONTAINER_NAME,
        }),
        readonlyRootFilesystem: true,
        secrets: {
          DATABASE_ADMIN_PASSWORD: ecsSecretJsonKey(
            databaseAdminSecret,
            'password',
          ),
          DATABASE_ADMIN_USERNAME: ecsSecretJsonKey(
            databaseAdminSecret,
            'username',
          ),
          DATABASE_APPLICATION_PASSWORD: ecsSecretJsonKey(
            databaseApplicationSecret,
            'password',
          ),
          DATABASE_APPLICATION_USERNAME: ecsSecretJsonKey(
            databaseApplicationSecret,
            'username',
          ),
          PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL: ecsSecretJsonKey(
            initialAccessGroupSecret,
            'email',
          ),
        },
      },
    );
    bootstrapContainer.addMountPoints({
      containerPath: '/tmp',
      readOnly: false,
      sourceVolume: 'native-bootstrap-tmp',
    });
    applicationImage.repository.grantPull(bootstrapTaskExecutionRole);
    databaseAdminSecret.grantRead(bootstrapTaskExecutionRole);
    databaseApplicationSecret.grantRead(bootstrapTaskExecutionRole);
    initialAccessGroupSecret.grantRead(bootstrapTaskExecutionRole);

    // The push task is fully deployed but scaled to zero by default. This lets
    // infrastructure, IAM, alarms, and image composition be reviewed without
    // consuming a retained queue item or crossing the Expo provider boundary.
    const pushWorkerLogGroup = new logs.LogGroup(this, 'PushWorkerLogGroup', {
      logGroupName: PUSH_WORKER_LOG_GROUP_NAME,
      removalPolicy: RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.TWO_WEEKS,
    });
    const pushWorkerSecurityGroup = new ec2.SecurityGroup(
      this,
      'PushWorkerSecurityGroup',
      {
        allowAllOutbound: false,
        // CloudFormation replaces an EC2 security group when its description
        // changes. Preserve the deployed value because this group has a fixed
        // physical name and cannot be created alongside its replacement.
        description:
          'HTTPS-only egress for the isolated Expo push worker; no database route.',
        securityGroupName: 'psd-eoc-push-worker',
        vpc: network as unknown as ec2.IVpc,
      },
    );
    pushWorkerSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS to the server, Expo, ECR, logs, Secrets Manager, and SQS through NAT.',
    );
    const pushWorkerTaskExecutionRole = new iam.Role(
      this,
      'PushWorkerTaskExecutionRole',
      {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        description:
          'Pulls the reviewed image and injects only mobile push worker credentials.',
      },
    );
    const pushWorkerTaskRole = new iam.Role(this, 'PushWorkerTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description:
        'Consumes and retries only the mobile push queue; provider access uses protected runtime credentials.',
    });
    const pushWorkerTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      'PushWorkerTaskDefinition',
      {
        cpu: 256,
        executionRole: pushWorkerTaskExecutionRole,
        family: 'psd-eoc-expo-push-worker',
        memoryLimitMiB: 512,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskRole: pushWorkerTaskRole,
      },
    );
    pushWorkerTaskDefinition.addVolume({ name: 'push-worker-tmp' });
    const pushWorkerContainer = pushWorkerTaskDefinition.addContainer(
      'expo-push-worker',
      {
        command: ['bun', 'workers/push/service.ts'],
        environment: {
          AWS_REGION: region,
          NODE_ENV: 'production',
          PSD_EOC_EXPO_CREDENTIAL_VERIFICATION_REFERENCE:
            expoCredentialVerificationReference.valueAsString,
          PSD_EOC_EXPO_PUSH_PROVIDER_AUTHORIZED: Fn.conditionIf(
            shouldRunExpoPushWorker.logicalId,
            'true',
            'false',
          ).toString(),
          PSD_EOC_EXPO_PUSH_RUNTIME_MODE: Fn.conditionIf(
            shouldRunExpoPushWorker.logicalId,
            'enabled',
            'dark',
          ).toString(),
          PSD_EOC_DIRECT_PUSH_CREDENTIAL_VERIFICATION_REFERENCE:
            directPushCredentialVerificationReference.valueAsString,
          PSD_EOC_DIRECT_PUSH_PROVIDER_AUTHORIZED: Fn.conditionIf(
            shouldAuthorizeDirectPush.logicalId,
            'true',
            'false',
          ).toString(),
          PSD_EOC_PUSH_PROVIDER_CUTOVER: pushProviderCutover.valueAsString,
          PSD_EOC_SERVICE_ORIGIN: deploymentIdentity.applicationOrigin,
          PSD_EOC_IOS_BUNDLE_ID: deploymentIdentity.iosBundleId,
          PUSH_QUEUE_URL: queuePairs.Push.queue.queueUrl,
          PUSH_DEAD_LETTER_QUEUE_URL: queuePairs.Push.deadLetterQueue.queueUrl,
          SOURCE_SHA: sourceSha,
          TMPDIR: '/tmp',
        },
        essential: true,
        image: ecs.ContainerImage.fromRegistry(applicationImageUri),
        logging: ecs.LogDrivers.awsLogs({
          logGroup: pushWorkerLogGroup,
          streamPrefix: 'expo-push-worker',
        }),
        readonlyRootFilesystem: true,
        secrets: {
          APNS_CREDENTIAL_STATUS: ecs.Secret.fromSecretsManager(
            apnsDirectCredentialSecret as unknown as secretsmanager.ISecret,
            'status',
          ),
          APNS_ENVIRONMENT: ecs.Secret.fromSecretsManager(
            apnsDirectCredentialSecret as unknown as secretsmanager.ISecret,
            'environment',
          ),
          APNS_KEY_ID: ecs.Secret.fromSecretsManager(
            apnsDirectCredentialSecret as unknown as secretsmanager.ISecret,
            'keyId',
          ),
          APNS_PRIVATE_KEY: ecs.Secret.fromSecretsManager(
            apnsDirectCredentialSecret as unknown as secretsmanager.ISecret,
            'privateKey',
          ),
          APNS_TEAM_ID: ecs.Secret.fromSecretsManager(
            apnsDirectCredentialSecret as unknown as secretsmanager.ISecret,
            'teamId',
          ),
          APNS_TOPIC: ecs.Secret.fromSecretsManager(
            apnsDirectCredentialSecret as unknown as secretsmanager.ISecret,
            'topic',
          ),
          EXPO_ACCESS_TOKEN: ecs.Secret.fromSecretsManager(
            expoAccessTokenSecret as unknown as secretsmanager.ISecret,
            'accessToken',
          ),
          PSD_EOC_EXPO_CREDENTIAL_STATUS: ecs.Secret.fromSecretsManager(
            expoAccessTokenSecret as unknown as secretsmanager.ISecret,
            'status',
          ),
          PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN: ecs.Secret.fromSecretsManager(
            attemptExecutionWorkerSecret as unknown as secretsmanager.ISecret,
          ),
          PSD_EOC_DELIVERY_STATE_WORKER_TOKEN: ecs.Secret.fromSecretsManager(
            deliveryStateWorkerSecret as unknown as secretsmanager.ISecret,
          ),
          PSD_EOC_EXPO_PUSH_RUNTIME_WORKER_TOKEN: ecs.Secret.fromSecretsManager(
            expoPushRuntimeWorkerSecret as unknown as secretsmanager.ISecret,
          ),
          PSD_EOC_PUSH_ENDPOINT_WORKER_TOKEN: ecs.Secret.fromSecretsManager(
            pushEndpointWorkerSecret as unknown as secretsmanager.ISecret,
          ),
          FCM_CLIENT_EMAIL: ecs.Secret.fromSecretsManager(
            fcmDirectCredentialSecret as unknown as secretsmanager.ISecret,
            'clientEmail',
          ),
          FCM_CREDENTIAL_STATUS: ecs.Secret.fromSecretsManager(
            fcmDirectCredentialSecret as unknown as secretsmanager.ISecret,
            'status',
          ),
          FCM_ENVIRONMENT: ecs.Secret.fromSecretsManager(
            fcmDirectCredentialSecret as unknown as secretsmanager.ISecret,
            'environment',
          ),
          FCM_PRIVATE_KEY: ecs.Secret.fromSecretsManager(
            fcmDirectCredentialSecret as unknown as secretsmanager.ISecret,
            'privateKey',
          ),
          FCM_PROJECT_ID: ecs.Secret.fromSecretsManager(
            fcmDirectCredentialSecret as unknown as secretsmanager.ISecret,
            'projectId',
          ),
        },
      },
    );
    pushWorkerContainer.addMountPoints({
      containerPath: '/tmp',
      readOnly: false,
      sourceVolume: 'push-worker-tmp',
    });
    applicationImage.repository.grantPull(pushWorkerTaskExecutionRole);
    for (const secret of [
      apnsDirectCredentialSecret,
      expoAccessTokenSecret,
      fcmDirectCredentialSecret,
      attemptExecutionWorkerSecret,
      deliveryStateWorkerSecret,
      expoPushRuntimeWorkerSecret,
      pushEndpointWorkerSecret,
    ]) {
      secret.grantRead(pushWorkerTaskExecutionRole);
    }
    queuePairs.Push.queue.grantConsumeMessages(pushWorkerTaskRole);
    queuePairs.Push.queue.grantSendMessages(pushWorkerTaskRole);
    // Retiring an undeliverable message writes it to the dead-letter queue
    // directly rather than waiting out five receives; see
    // `workers/shared/terminal-failure.ts`.
    queuePairs.Push.deadLetterQueue.grantSendMessages(pushWorkerTaskRole);
    const pushWorkerService = new ecs.FargateService(
      this,
      'PushWorkerService',
      {
        assignPublicIp: false,
        cluster: bootstrapCluster as unknown as ecs.ICluster,
        circuitBreaker: { rollback: true },
        desiredCount: 0,
        enableExecuteCommand: false,
        maxHealthyPercent: 200,
        minHealthyPercent: 100,
        securityGroups: [pushWorkerSecurityGroup],
        serviceName: PUSH_WORKER_SERVICE_NAME,
        taskDefinition: pushWorkerTaskDefinition,
        vpcSubnets: { subnetGroupName: APPLICATION_SUBNET_GROUP_NAME },
      },
    );
    const pushWorkerCfnService = pushWorkerService.node
      .defaultChild as ecs.CfnService;
    pushWorkerCfnService.desiredCount = Fn.conditionIf(
      shouldRunExpoPushWorker.logicalId,
      1,
      0,
    ) as unknown as number;

    // The SMS worker shares no database route and has no provider credentials.
    // Its task role can call only the exact retained queue, pool, and opt-out
    // list. Desired count and every provider opt-in remain one condition.
    const smsWorkerLogGroup = new logs.LogGroup(this, 'SmsWorkerLogGroup', {
      logGroupName: SMS_WORKER_LOG_GROUP_NAME,
      removalPolicy: RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.TWO_WEEKS,
    });
    const smsWorkerSecurityGroup = new ec2.SecurityGroup(
      this,
      'SmsWorkerSecurityGroup',
      {
        allowAllOutbound: false,
        description:
          'HTTPS-only egress for the isolated AWS End User Messaging SMS worker; no database route.',
        securityGroupName: 'psd-eoc-sms-worker',
        vpc: network as unknown as ec2.IVpc,
      },
    );
    smsWorkerSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS to the server and AWS APIs through NAT.',
    );
    const smsWorkerTaskExecutionRole = new iam.Role(
      this,
      'SmsWorkerTaskExecutionRole',
      {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        description:
          'Pulls the reviewed image and injects only internal SMS worker bearers.',
      },
    );
    const smsWorkerTaskRole = new iam.Role(this, 'SmsWorkerTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description:
        'Consumes the SMS queue and can send only through the conditionally provisioned pool and inspect its exact opt-out list.',
    });
    queuePairs.Sms.queue.grantConsumeMessages(smsWorkerTaskRole);
    queuePairs.Sms.queue.grantSendMessages(smsWorkerTaskRole);
    queuePairs.Sms.deadLetterQueue.grantSendMessages(smsWorkerTaskRole);
    queuePairs.SmsReceipt.queue.grantConsumeMessages(smsWorkerTaskRole);
    queuePairs.SmsReceipt.deadLetterQueue.grantSendMessages(smsWorkerTaskRole);
    smsWorkerTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['sms-voice:SendTextMessage'],
        resources: [
          Fn.conditionIf(
            shouldRunAwsEumSmsWorker.logicalId,
            smsPool.attrArn,
            Arn.format(
              {
                account,
                partition,
                region,
                resource: 'pool',
                resourceName: 'UNCONFIGURED',
                service: 'sms-voice',
              },
              this,
            ),
          ).toString(),
        ],
      }),
    );
    smsWorkerTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['sms-voice:DescribeOptedOutNumbers'],
        resources: [
          Fn.conditionIf(
            shouldRunAwsEumSmsWorker.logicalId,
            smsOptOutList.attrArn,
            Arn.format(
              {
                account,
                partition,
                region,
                resource: 'opt-out-list',
                resourceName: 'UNCONFIGURED',
                service: 'sms-voice',
              },
              this,
            ),
          ).toString(),
        ],
      }),
    );
    const smsWorkerTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      'SmsWorkerTaskDefinition',
      {
        cpu: 256,
        executionRole: smsWorkerTaskExecutionRole,
        family: 'psd-eoc-aws-eum-sms-worker',
        memoryLimitMiB: 512,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskRole: smsWorkerTaskRole,
      },
    );
    smsWorkerTaskDefinition.addVolume({ name: 'sms-worker-tmp' });
    const smsWorkerContainer = smsWorkerTaskDefinition.addContainer(
      'aws-eum-sms-worker',
      {
        command: ['bun', 'workers/sms/service.ts'],
        environment: {
          AWS_ACCOUNT_ID: account,
          AWS_REGION: region,
          NODE_ENV: 'production',
          PSD_EOC_SERVICE_ORIGIN: deploymentIdentity.applicationOrigin,
          PSD_EOC_SMS_CONFIGURATION_SET_NAME: Fn.conditionIf(
            shouldRunAwsEumSmsWorker.logicalId,
            smsConfigurationSet.ref,
            'UNCONFIGURED',
          ).toString(),
          PSD_EOC_SMS_CONFIGURATION_STATUS: Fn.conditionIf(
            shouldRunAwsEumSmsWorker.logicalId,
            'verified',
            'unconfigured',
          ).toString(),
          PSD_EOC_SMS_DELIVERY_EVENT_RULE_ARN: smsDeliveryEventRule.ruleArn,
          PSD_EOC_SMS_MAX_PRICE: '0.05',
          PSD_EOC_SMS_OPT_OUT_LIST_ARN: Fn.conditionIf(
            shouldRunAwsEumSmsWorker.logicalId,
            smsOptOutList.attrArn,
            'UNCONFIGURED',
          ).toString(),
          PSD_EOC_SMS_OPT_OUT_LIST_NAME: Fn.conditionIf(
            shouldRunAwsEumSmsWorker.logicalId,
            smsOptOutList.ref,
            'UNCONFIGURED',
          ).toString(),
          PSD_EOC_SMS_OPT_OUT_SCHEDULE_RULE_ARN: smsOptOutSchedule.ruleArn,
          PSD_EOC_SMS_ORIGINATION_IDENTITY: Fn.conditionIf(
            shouldRunAwsEumSmsWorker.logicalId,
            smsPool.attrArn,
            'UNCONFIGURED',
          ).toString(),
          PSD_EOC_SMS_PROTECT_CONFIGURATION_ID: Fn.conditionIf(
            shouldRunAwsEumSmsWorker.logicalId,
            smsProtectConfiguration.attrProtectConfigurationId,
            'UNCONFIGURED',
          ).toString(),
          PSD_EOC_SMS_PROVIDER_AUTHORIZED: Fn.conditionIf(
            shouldRunAwsEumSmsWorker.logicalId,
            'true',
            'false',
          ).toString(),
          PSD_EOC_SMS_REGISTRATION_VERIFICATION_REFERENCE:
            smsRegistrationVerificationReference.valueAsString,
          PSD_EOC_SMS_RUNTIME_MODE: Fn.conditionIf(
            shouldRunAwsEumSmsWorker.logicalId,
            'enabled',
            'dark',
          ).toString(),
          PSD_EOC_SMS_TTL_SECONDS: '300',
          SMS_QUEUE_ARN: queuePairs.Sms.queue.queueArn,
          SMS_QUEUE_URL: queuePairs.Sms.queue.queueUrl,
          SMS_RECEIPT_QUEUE_ARN: queuePairs.SmsReceipt.queue.queueArn,
          SMS_RECEIPT_QUEUE_URL: queuePairs.SmsReceipt.queue.queueUrl,
          SMS_DEAD_LETTER_QUEUE_URL: queuePairs.Sms.deadLetterQueue.queueUrl,
          SMS_RECEIPT_DEAD_LETTER_QUEUE_URL:
            queuePairs.SmsReceipt.deadLetterQueue.queueUrl,
          SOURCE_SHA: sourceSha,
          TMPDIR: '/tmp',
        },
        essential: true,
        image: ecs.ContainerImage.fromRegistry(applicationImageUri),
        logging: ecs.LogDrivers.awsLogs({
          logGroup: smsWorkerLogGroup,
          streamPrefix: 'aws-eum-sms-worker',
        }),
        readonlyRootFilesystem: true,
        secrets: {
          PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN: ecs.Secret.fromSecretsManager(
            attemptExecutionWorkerSecret as unknown as secretsmanager.ISecret,
          ),
          PSD_EOC_DELIVERY_STATE_WORKER_TOKEN: ecs.Secret.fromSecretsManager(
            deliveryStateWorkerSecret as unknown as secretsmanager.ISecret,
          ),
          PSD_EOC_SMS_RUNTIME_WORKER_TOKEN: ecs.Secret.fromSecretsManager(
            smsRuntimeWorkerSecret as unknown as secretsmanager.ISecret,
          ),
        },
      },
    );
    smsWorkerContainer.addMountPoints({
      containerPath: '/tmp',
      readOnly: false,
      sourceVolume: 'sms-worker-tmp',
    });
    applicationImage.repository.grantPull(smsWorkerTaskExecutionRole);
    for (const secret of [
      attemptExecutionWorkerSecret,
      deliveryStateWorkerSecret,
      smsRuntimeWorkerSecret,
    ]) {
      secret.grantRead(smsWorkerTaskExecutionRole);
    }
    const smsWorkerService = new ecs.FargateService(this, 'SmsWorkerService', {
      assignPublicIp: false,
      cluster: bootstrapCluster as unknown as ecs.ICluster,
      circuitBreaker: { rollback: true },
      desiredCount: 0,
      enableExecuteCommand: false,
      maxHealthyPercent: 200,
      minHealthyPercent: 100,
      securityGroups: [smsWorkerSecurityGroup],
      serviceName: SMS_WORKER_SERVICE_NAME,
      taskDefinition: smsWorkerTaskDefinition,
      vpcSubnets: { subnetGroupName: APPLICATION_SUBNET_GROUP_NAME },
    });
    const smsWorkerCfnService = smsWorkerService.node
      .defaultChild as ecs.CfnService;
    smsWorkerCfnService.desiredCount = Fn.conditionIf(
      shouldRunAwsEumSmsWorker.logicalId,
      1,
      0,
    ) as unknown as number;

    const emailWorkerSecurityGroup = new ec2.SecurityGroup(
      this,
      'EmailWorkerSecurityGroup',
      {
        allowAllOutbound: false,
        description:
          'HTTPS-only egress for the isolated SES email worker; no database route.',
        securityGroupName: 'psd-eoc-email-worker',
        vpc: network as unknown as ec2.IVpc,
      },
    );
    emailWorkerSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS to the server, SES, ECR, logs, Secrets Manager, and SQS through NAT.',
    );
    const emailWorkerTaskExecutionRole = new iam.Role(
      this,
      'EmailWorkerTaskExecutionRole',
      {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        description:
          'Pulls the reviewed image and injects only email worker route credentials.',
      },
    );
    const emailWorkerTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      'EmailWorkerTaskDefinition',
      {
        cpu: 256,
        executionRole: emailWorkerTaskExecutionRole,
        family: 'psd-eoc-email-worker',
        memoryLimitMiB: 512,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskRole: emailWorkerRole,
      },
    );
    emailWorkerTaskDefinition.addVolume({ name: 'email-worker-tmp' });
    const emailWorkerContainer = emailWorkerTaskDefinition.addContainer(
      'ses-email-worker',
      {
        command: ['bun', 'workers/email/service.ts'],
        environment: {
          AWS_REGION: region,
          EMAIL_QUEUE_ARN: emailQueue.queueArn,
          EMAIL_QUEUE_URL: emailQueue.queueUrl,
          EMAIL_DEAD_LETTER_QUEUE_ARN: emailDeadLetterQueue.queueArn,
          EMAIL_DEAD_LETTER_QUEUE_URL: emailDeadLetterQueue.queueUrl,
          NODE_ENV: 'production',
          PSD_EOC_EMAIL_RUNTIME_MODE: Fn.conditionIf(
            shouldRunEmailWorker.logicalId,
            'enabled',
            'dark',
          ).toString(),
          PSD_EOC_SERVICE_ORIGIN: deploymentIdentity.applicationOrigin,
          PSD_EOC_SES_CREDENTIAL_STATUS: Fn.conditionIf(
            shouldRunEmailWorker.logicalId,
            'verified',
            'unverified',
          ).toString(),
          PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE:
            sesCredentialVerificationReference.valueAsString,
          PSD_EOC_SES_FROM_ADDRESS: sesFromAddress,
          PSD_EOC_SES_PROVIDER_AUTHORIZED: Fn.conditionIf(
            shouldRunEmailWorker.logicalId,
            'true',
            'false',
          ).toString(),
          SOURCE_SHA: sourceSha,
          TMPDIR: '/tmp',
        },
        essential: true,
        image: ecs.ContainerImage.fromRegistry(applicationImageUri),
        logging: ecs.LogDrivers.awsLogs({
          logGroup: emailWorkerLogGroup,
          streamPrefix: 'ses-email-worker',
        }),
        readonlyRootFilesystem: true,
        secrets: {
          PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN: ecs.Secret.fromSecretsManager(
            attemptExecutionWorkerSecret as unknown as secretsmanager.ISecret,
          ),
          PSD_EOC_DELIVERY_STATE_WORKER_TOKEN: ecs.Secret.fromSecretsManager(
            deliveryStateWorkerSecret as unknown as secretsmanager.ISecret,
          ),
          PSD_EOC_EMAIL_RUNTIME_WORKER_TOKEN: ecs.Secret.fromSecretsManager(
            emailRuntimeWorkerSecret as unknown as secretsmanager.ISecret,
          ),
        },
      },
    );
    emailWorkerContainer.addMountPoints({
      containerPath: '/tmp',
      readOnly: false,
      sourceVolume: 'email-worker-tmp',
    });
    applicationImage.repository.grantPull(emailWorkerTaskExecutionRole);
    for (const secret of [
      attemptExecutionWorkerSecret,
      deliveryStateWorkerSecret,
      emailRuntimeWorkerSecret,
    ]) {
      secret.grantRead(emailWorkerTaskExecutionRole);
    }
    emailQueue.grantConsumeMessages(emailWorkerRole);
    emailQueue.grantSendMessages(emailWorkerRole);
    emailDeadLetterQueue.grantSendMessages(emailWorkerRole);
    const emailWorkerService = new ecs.FargateService(
      this,
      'EmailWorkerService',
      {
        assignPublicIp: false,
        cluster: bootstrapCluster as unknown as ecs.ICluster,
        circuitBreaker: { rollback: true },
        desiredCount: 0,
        enableExecuteCommand: false,
        maxHealthyPercent: 200,
        minHealthyPercent: 100,
        securityGroups: [emailWorkerSecurityGroup],
        serviceName: EMAIL_WORKER_SERVICE_NAME,
        taskDefinition: emailWorkerTaskDefinition,
        vpcSubnets: { subnetGroupName: APPLICATION_SUBNET_GROUP_NAME },
      },
    );
    const emailWorkerCfnService = emailWorkerService.node
      .defaultChild as ecs.CfnService;
    emailWorkerCfnService.desiredCount = Fn.conditionIf(
      shouldRunEmailWorker.logicalId,
      1,
      0,
    ) as unknown as number;

    const emailCallbackWorkerRole = new iam.Role(
      this,
      'EmailCallbackWorkerRole',
      {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        description:
          'Consumes only the durable SES callback queue and forwards signed envelopes to the application verifier.',
      },
    );
    const emailCallbackWorkerExecutionRole = new iam.Role(
      this,
      'EmailCallbackWorkerExecutionRole',
      {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        description:
          'Pulls the current callback-compatible image without notification-provider authority.',
      },
    );
    const emailCallbackWorkerTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      'EmailCallbackWorkerTaskDefinition',
      {
        cpu: 256,
        executionRole: emailCallbackWorkerExecutionRole,
        family: 'psd-eoc-email-callback-worker',
        memoryLimitMiB: 512,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskRole: emailCallbackWorkerRole,
      },
    );
    emailCallbackWorkerTaskDefinition.addVolume({
      name: 'email-callback-worker-tmp',
    });
    const emailCallbackWorkerContainer =
      emailCallbackWorkerTaskDefinition.addContainer(
        'ses-email-callback-worker',
        {
          command: ['bun', 'workers/email/callback-service.ts'],
          environment: {
            AWS_REGION: region,
            EMAIL_CALLBACK_QUEUE_ARN: emailCallbackQueue.queueArn,
            EMAIL_CALLBACK_QUEUE_URL: emailCallbackQueue.queueUrl,
            NODE_ENV: 'production',
            PSD_EOC_EMAIL_CALLBACK_RUNTIME_MODE: 'enabled',
            PSD_EOC_SERVICE_ORIGIN: deploymentIdentity.applicationOrigin,
            PSD_EOC_SES_SNS_TOPIC_ARN: emailEventsTopic.topicArn,
            SOURCE_SHA: sourceSha,
            TMPDIR: '/tmp',
          },
          essential: true,
          image: ecs.ContainerImage.fromRegistry(applicationImageUri),
          logging: ecs.LogDrivers.awsLogs({
            logGroup: emailCallbackWorkerLogGroup,
            streamPrefix: 'ses-email-callback-worker',
          }),
          readonlyRootFilesystem: true,
        },
      );
    emailCallbackWorkerContainer.addMountPoints({
      containerPath: '/tmp',
      readOnly: false,
      sourceVolume: 'email-callback-worker-tmp',
    });
    applicationImage.repository.grantPull(emailCallbackWorkerExecutionRole);
    emailCallbackQueue.grantConsumeMessages(emailCallbackWorkerRole);
    const emailCallbackWorkerService = new ecs.FargateService(
      this,
      'EmailCallbackWorkerService',
      {
        assignPublicIp: false,
        cluster: bootstrapCluster as unknown as ecs.ICluster,
        circuitBreaker: { rollback: true },
        desiredCount: 0,
        enableExecuteCommand: false,
        maxHealthyPercent: 200,
        minHealthyPercent: 100,
        securityGroups: [emailWorkerSecurityGroup],
        serviceName: 'psd-eoc-email-callback-worker',
        taskDefinition: emailCallbackWorkerTaskDefinition,
        vpcSubnets: { subnetGroupName: APPLICATION_SUBNET_GROUP_NAME },
      },
    );
    const emailCallbackWorkerCfnService = emailCallbackWorkerService.node
      .defaultChild as ecs.CfnService;
    emailCallbackWorkerCfnService.desiredCount = Fn.conditionIf(
      shouldProvisionApplication.logicalId,
      1,
      0,
    ) as unknown as number;

    const accessSyncTaskExecutionRole = new iam.Role(
      this,
      'AccessSyncTaskExecutionRole',
      {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        description:
          'Pulls the reviewed access-sync image, injects only the application database and Google Groups credentials, and writes aggregate logs.',
      },
    );
    const accessSyncTaskRole = new iam.Role(this, 'AccessSyncTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description:
        'No-authority task role for protected access-membership publication.',
    });
    const accessSyncTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      'AccessSyncTaskDefinition',
      {
        cpu: 256,
        executionRole: accessSyncTaskExecutionRole,
        family: 'psd-eoc-access-sync',
        memoryLimitMiB: 512,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskRole: accessSyncTaskRole,
      },
    );
    accessSyncTaskDefinition.addVolume({ name: 'access-sync-tmp' });
    const accessSyncContainer = accessSyncTaskDefinition.addContainer(
      ACCESS_SYNC_CONTAINER_NAME,
      {
        command: [
          'bun',
          'packages/server/scripts/operations/sync-access-membership.ts',
        ],
        environment: {
          AWS_ACCOUNT_ID: account,
          AWS_REGION: region,
          DATABASE_DRIVER: 'postgres',
          DATABASE_HOST: database.clusterEndpoint.hostname,
          DATABASE_IDLE_TIMEOUT_SECONDS: '20',
          DATABASE_MAX_CONNECTIONS: '1',
          DATABASE_NAME: DATABASE_NAME,
          DATABASE_PORT: String(DATABASE_PORT),
          DATABASE_SSL_ROOT_CERT: DATABASE_SSL_ROOT_CERT,
          DATABASE_CONNECT_TIMEOUT_SECONDS: '10',
          // The sync resolves every member address against this district's
          // staff domain before admitting it, so the task cannot run without
          // it. It became required when the auth values moved to configuration
          // and was never added here, which broke every run from that deploy
          // onward: `GOOGLE_OIDC_HOSTED_DOMAIN must be configured.`
          GOOGLE_OIDC_HOSTED_DOMAIN: deploymentIdentity.hostedDomain,
          // This task publishes a roster snapshot after refreshing membership,
          // and capturing a push endpoint requires knowing which provider this
          // deployment sends on. Without it every publication throws
          // `LOCAL_CONTACT_CAPTURE_INVALID` and the run publishes nothing --
          // caught and logged, so the symptom would be a roster that silently
          // never advances. Exactly the shape of the hosted-domain omission
          // recorded above.
          PSD_EOC_PUSH_PROVIDER_CUTOVER: pushProviderCutover.valueAsString,
          SOURCE_SHA: sourceSha,
          TMPDIR: '/tmp',
        },
        essential: true,
        image: ecs.ContainerImage.fromRegistry(applicationImageUri),
        logging: ecs.LogDrivers.awsLogs({
          logGroup: bootstrapLogGroup,
          streamPrefix: ACCESS_SYNC_CONTAINER_NAME,
        }),
        readonlyRootFilesystem: true,
        secrets: {
          DATABASE_PASSWORD: ecsSecretJsonKey(
            databaseApplicationSecret,
            'password',
          ),
          DATABASE_USERNAME: ecsSecretJsonKey(
            databaseApplicationSecret,
            'username',
          ),
          GOOGLE_ROSTER_CONFIG:
            ecs.Secret.fromSecretsManager(googleGroupsSecret),
          PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256: ecsSecretJsonKey(
            bootstrapIdentitySecret,
            'initialMobileTransitionEmailSha256',
          ),
        },
      },
    );
    accessSyncContainer.addMountPoints({
      containerPath: '/tmp',
      readOnly: false,
      sourceVolume: 'access-sync-tmp',
    });
    applicationImage.repository.grantPull(accessSyncTaskExecutionRole);
    databaseApplicationSecret.grantRead(accessSyncTaskExecutionRole);
    bootstrapIdentitySecret.grantRead(accessSyncTaskExecutionRole);
    googleGroupsSecret.grantRead(accessSyncTaskExecutionRole);

    // Membership carries a freshness bound: sign-in refuses a group whose
    // membership has not been read inside MEMBERSHIP_FRESHNESS_MS. EventBridge
    // refreshes it well inside that bound so several failed runs can occur
    // before sign-in fails closed.
    const accessSyncSchedule = new events.Rule(this, 'AccessSyncSchedule', {
      description:
        'Refreshes access-group membership from Google Cloud Identity so sign-in keeps working; reads only, and publishes one complete snapshot or none.',
      enabled: true,
      ruleName: 'psd-eoc-access-membership-sync-every-two-hours',
      schedule: events.Schedule.expression('cron(0 */2 * * ? *)'),
    });
    accessSyncSchedule.addTarget(
      new eventTargets.EcsTask({
        assignPublicIp: false,
        // `exactOptionalPropertyTypes` rejects the concrete construct against
        // CDK's interface, whose optional members are not declared `| undefined`.
        // Same reason as every other cast in this file.
        cluster: bootstrapCluster as unknown as ecs.ICluster,
        // The task reaches Google over the NAT path this security group already
        // allows, and Aurora over the same private route the application uses.
        securityGroups: [applicationSecurityGroup],
        subnetSelection: { subnetGroupName: APPLICATION_SUBNET_GROUP_NAME },
        taskCount: 1,
        taskDefinition:
          accessSyncTaskDefinition as unknown as ecs.ITaskDefinition,
        // The run identity is generated by the task, because EventBridge cannot
        // template a UUID into a container override. Its idempotency key is
        // bucketed to this interval, so an at-least-once redelivery of one
        // occurrence republishes nothing.
        retryAttempts: 2,
      }),
    );
    const accessSyncCfnRule = accessSyncSchedule.node
      .defaultChild as events.CfnRule;

    // CloudFormation owns the migration ordering. The provider starts the
    // exact digest-pinned task above and remains incomplete until that task
    // exits successfully. Runtime services depend on this resource, so a
    // failed forward migration leaves the previous application revision live.
    const bootstrapDeploymentLogGroup = new logs.LogGroup(
      this,
      'BootstrapDeploymentLogGroup',
      {
        logGroupName: '/psd-eoc/deployment/bootstrap',
        removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
        retention: logs.RetentionDays.TWO_WEEKS,
      },
    );
    const bootstrapDeploymentCode = lambda.Code.fromAsset(
      fileURLToPath(
        new URL('../../lambda/bootstrap-deployment', import.meta.url),
      ),
    );
    const bootstrapDeploymentStart = new lambda.Function(
      this,
      'BootstrapDeploymentStart',
      {
        code: bootstrapDeploymentCode,
        description:
          'Starts one digest-pinned native bootstrap task for a CloudFormation deployment.',
        functionName: 'psd-eoc-bootstrap-deployment-start',
        handler: 'index.onEvent',
        logGroup: bootstrapDeploymentLogGroup,
        memorySize: 256,
        reservedConcurrentExecutions: 1,
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: Duration.seconds(30),
      },
    );
    bootstrapDeploymentStart.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        conditions: {
          ArnEquals: { 'ecs:cluster': bootstrapCluster.clusterArn },
        },
        resources: [bootstrapTaskDefinition.taskDefinitionArn],
      }),
    );
    bootstrapDeploymentStart.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
        },
        resources: [
          bootstrapTaskExecutionRole.roleArn,
          bootstrapTaskRole.roleArn,
        ],
      }),
    );
    bootstrapDeploymentStart.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: [this.stackId],
      }),
    );
    const bootstrapDeploymentCheck = new lambda.Function(
      this,
      'BootstrapDeploymentCheck',
      {
        code: bootstrapDeploymentCode,
        description:
          'Waits for the deployment bootstrap task to stop successfully.',
        functionName: 'psd-eoc-bootstrap-deployment-check',
        handler: 'index.isComplete',
        logGroup: bootstrapDeploymentLogGroup,
        memorySize: 256,
        reservedConcurrentExecutions: 1,
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: Duration.seconds(30),
      },
    );
    bootstrapDeploymentCheck.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:DescribeTasks', 'ecs:StopTask'],
        conditions: {
          ArnEquals: { 'ecs:cluster': bootstrapCluster.clusterArn },
        },
        resources: ['*'],
      }),
    );
    const bootstrapDeploymentProvider = new customResources.Provider(
      this,
      'BootstrapDeploymentProvider',
      {
        isCompleteHandler: bootstrapDeploymentCheck,
        logGroup: bootstrapDeploymentLogGroup,
        onEventHandler: bootstrapDeploymentStart,
        queryInterval: Duration.seconds(10),
        totalTimeout: Duration.minutes(30),
      },
    );
    const bootstrapDeployment = new CustomResource(
      this,
      'BootstrapDeployment',
      {
        properties: {
          ClusterArn: bootstrapCluster.clusterArn,
          ContainerName: BOOTSTRAP_CONTAINER_NAME,
          DeploymentRevision: sourceSha,
          SecurityGroupId: applicationSecurityGroup.securityGroupId,
          SubnetIds: applicationSubnets.subnetIds,
          TaskDefinitionArn: bootstrapTaskDefinition.taskDefinitionArn,
        },
        resourceType: 'Custom::PsdEocBootstrapDeployment',
        serviceToken: bootstrapDeploymentProvider.serviceToken,
      },
    );
    const bootstrapDeploymentResource = bootstrapDeployment.node
      .defaultChild as CfnResource;
    for (const service of [
      pushWorkerCfnService,
      smsWorkerCfnService,
      emailWorkerCfnService,
      emailCallbackWorkerCfnService,
    ]) {
      service.addResourceDependency(bootstrapDeploymentResource);
    }
    accessSyncCfnRule.addResourceDependency(bootstrapDeploymentResource);

    const rollbackImageValidationHandler = new lambda.Function(
      this,
      'RollbackImageValidationHandler',
      {
        code: bootstrapDeploymentCode,
        description:
          'Derives reviewed source identity from one selected immutable rollback image.',
        functionName: 'psd-eoc-rollback-image-validation',
        handler: 'index.resolveRollbackImage',
        logGroup: bootstrapDeploymentLogGroup,
        memorySize: 256,
        reservedConcurrentExecutions: 1,
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: Duration.seconds(30),
      },
    );
    rollbackImageValidationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        resources: [
          applicationImage.repository.repositoryArn,
          imageRepository.repositoryArn,
        ],
      }),
    );
    rollbackImageValidationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:DescribeServices'],
        conditions: {
          ArnEquals: { 'ecs:cluster': bootstrapCluster.clusterArn },
        },
        resources: [
          PUSH_WORKER_SERVICE_NAME,
          SMS_WORKER_SERVICE_NAME,
          EMAIL_WORKER_SERVICE_NAME,
        ].flatMap((serviceName) => [
          this.formatArn({
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            resource: 'service',
            resourceName: `${BOOTSTRAP_CLUSTER_NAME}/${serviceName}`,
            service: 'ecs',
          }),
          this.formatArn({
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            resource: 'service',
            resourceName: serviceName,
            service: 'ecs',
          }),
        ]),
      }),
    );
    const rollbackImageValidationProvider = new customResources.Provider(
      this,
      'RollbackImageValidationProvider',
      {
        logGroup: bootstrapDeploymentLogGroup,
        onEventHandler: rollbackImageValidationHandler,
      },
    );
    const rollbackImageValidation = new CustomResource(
      this,
      'RollbackImageValidation',
      {
        properties: {
          CurrentSourceSha: sourceSha,
          ExpectedSourceRepositoryUrl: sourceRepositoryUrl,
          ImageDigest: rollbackApplicationImageDigest.valueAsString,
          Operation: 'ROLLBACK_IMAGE_VALIDATION',
          RepositoryKind: rollbackApplicationRepository.valueAsString,
          RepositoryName: Fn.conditionIf(
            shouldUseLegacyRollbackRepository.logicalId,
            imageRepository.repositoryName,
            applicationImage.repository.repositoryName,
          ).toString(),
        },
        resourceType: 'Custom::PsdEocRollbackImageValidation',
        serviceToken: rollbackImageValidationProvider.serviceToken,
      },
    );
    const deployedApplicationSourceSha =
      rollbackImageValidation.getAttString('SourceSha');
    const rollbackQuiescence = new CustomResource(this, 'RollbackQuiescence', {
      properties: {
        ClusterArn: bootstrapCluster.clusterArn,
        DeploymentRevision: sourceSha,
        DirectPushCredentialVerificationReference:
          directPushCredentialVerificationReference.valueAsString,
        EnableAwsEumSmsWorker: enableAwsEumSmsWorker.valueAsString,
        EnableDirectPush: enableDirectPush.valueAsString,
        EnableEmailWorker: enableEmailWorker.valueAsString,
        EnableExpoPushWorker: enableExpoPushWorker.valueAsString,
        ExpoCredentialVerificationReference:
          expoCredentialVerificationReference.valueAsString,
        Operation: 'ROLLBACK_QUIESCENCE',
        PushProviderCutover: pushProviderCutover.valueAsString,
        RollbackSelected: Fn.conditionIf(
          shouldUseRollbackApplicationImage.logicalId,
          'true',
          'false',
        ),
        ServiceNames: [
          PUSH_WORKER_SERVICE_NAME,
          SMS_WORKER_SERVICE_NAME,
          EMAIL_WORKER_SERVICE_NAME,
        ],
        SesCredentialVerificationReference:
          sesCredentialVerificationReference.valueAsString,
      },
      resourceType: 'Custom::PsdEocRollbackQuiescence',
      serviceToken: rollbackImageValidationProvider.serviceToken,
    });
    const rollbackQuiescenceResource = rollbackQuiescence.node
      .defaultChild as CfnResource;
    for (const service of [
      pushWorkerCfnService,
      smsWorkerCfnService,
      emailWorkerCfnService,
    ]) {
      service.addResourceDependency(rollbackQuiescenceResource);
    }

    const imageAccessRole = new iam.Role(this, 'AppRunnerImageAccessRole', {
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
      description:
        'Reads only the digest-pinned server image from its isolated ECR repository.',
    });
    const imagePullGrants = [
      applicationImage.repository.grantPull(imageAccessRole),
      imageRepository.grantPull(imageAccessRole),
    ];

    // Private storage for photos staff attach to an event.
    //
    // Versioned because the media store treats a sanitized object as immutable
    // truth: it writes with IfNoneMatch and refuses to replace one, and
    // versioning is the retained defense behind that refusal rather than
    // permission to overwrite.
    const mediaObjects = new s3.Bucket(this, 'MediaObjects', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      // A staff photo is uploaded by the browser straight to S3 with a signed
      // grant, so the upload is cross-origin and the bucket has to say so.
      // Without this the upload fails at the transport with no provider
      // answer, which the event room reports as an upload that ended without
      // a confirmed result.
      //
      // One origin: this deployment's own. PUT for the upload, GET for the
      // signed read-back, HEAD for the size probe the client makes first. The
      // allowed headers are exactly what the signed request carries.
      cors: [
        {
          allowedOrigins: [deploymentIdentity.applicationOrigin],
          allowedMethods: [
            s3.HttpMethods.PUT,
            s3.HttpMethods.GET,
            s3.HttpMethods.HEAD,
          ],
          allowedHeaders: [
            'content-type',
            'if-none-match',
            'x-amz-checksum-sha256',
            'x-amz-sdk-checksum-algorithm',
          ],
          exposedHeaders: ['etag'],
          maxAge: 3_000,
        },
      ],
    });
    (mediaObjects.node.defaultChild as s3.CfnBucket).cfnOptions.condition =
      shouldProvisionApplication;
    const mediaBucketPolicy = mediaObjects.policy;
    if (mediaBucketPolicy !== undefined) {
      (
        mediaBucketPolicy.node.defaultChild as s3.CfnBucketPolicy
      ).cfnOptions.condition = shouldProvisionApplication;
    }

    // GuardDuty Malware Protection scans each uploaded object and records the
    // result as an object tag. The media capability reads that tag and refuses
    // to publish a photo until it says the object is clean, so without this
    // plan every upload stays pending and no photo is ever posted.
    const mediaScanRole = new iam.Role(this, 'MediaMalwareScanRole', {
      // Scoped to this account so the plan's role cannot be assumed on behalf
      // of another account's GuardDuty.
      assumedBy: new iam.ServicePrincipal(
        'malware-protection-plan.guardduty.amazonaws.com',
        {
          conditions: {
            StringEquals: { 'aws:SourceAccount': Stack.of(this).account },
          },
        },
      ),
      description:
        'GuardDuty Malware Protection for the private event media bucket.',
    });
    (mediaScanRole.node.defaultChild as iam.CfnRole).cfnOptions.condition =
      shouldProvisionApplication;
    mediaScanRole.addToPolicy(
      new iam.PolicyStatement({
        // GuardDuty validates that the caller owns the bucket before it will
        // attach a plan, and refuses the plan outright without the ownership
        // and versioning reads. Omitting them fails at CreateMalwareProtectionPlan
        // rather than at scan time.
        actions: [
          's3:GetBucketLocation',
          's3:GetBucketOwnershipControls',
          's3:GetBucketVersioning',
          's3:ListBucket',
          's3:ListBucketVersions',
          's3:GetObject',
          's3:GetObjectVersion',
          's3:GetObjectTagging',
          's3:GetObjectVersionTagging',
          's3:PutObjectTagging',
          's3:PutObjectVersionTagging',
          // GuardDuty learns about a new object through EventBridge, and turns
          // that delivery on itself when the plan is created. Without the
          // notification pair it refuses the plan outright rather than
          // attaching one that would never see an upload.
          's3:GetBucketNotification',
          's3:PutBucketNotification',
        ],
        resources: [mediaObjects.bucketArn, mediaObjects.arnForObjects('*')],
      }),
    );
    // GuardDuty proves it can write to the bucket by putting a single
    // validation object and removing it again, and reports the plan as
    // degraded when it cannot. Scoped to that one key: the scan role can
    // write its own probe and nothing else, and cannot touch a staff photo.
    mediaScanRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:DeleteObject'],
        resources: [
          mediaObjects.arnForObjects(
            'malware-protection-resource-validation-object*',
          ),
        ],
      }),
    );
    mediaScanRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'events:PutRule',
          'events:DeleteRule',
          'events:PutTargets',
          'events:RemoveTargets',
        ],
        resources: ['*'],
        conditions: {
          StringLike: {
            'events:ManagedBy':
              'malware-protection-plan.guardduty.amazonaws.com',
          },
        },
      }),
    );
    const mediaScanPolicy = mediaScanRole.node.tryFindChild('DefaultPolicy') as
      | iam.Policy
      | undefined;
    if (mediaScanPolicy !== undefined) {
      (
        mediaScanPolicy.node.defaultChild as iam.CfnPolicy
      ).cfnOptions.condition = shouldProvisionApplication;
    }
    // The plan is created in a later deployment than the role it uses.
    //
    // GuardDuty validates that the caller owns the bucket at the moment the
    // plan is created, and that check runs against IAM's view of the role. In
    // the same update that creates the role and its policy, that view is not
    // yet consistent, and the create fails with "does not have the required
    // permissions to validate S3 bucket ownership" -- which then rolls back
    // every unrelated change in the deployment. Enabling this only once the
    // role already exists removes the race rather than retrying into it.
    const mediaScanPlan = new guardduty.CfnMalwareProtectionPlan(
      this,
      'MediaMalwareScanPlan',
      {
        role: mediaScanRole.roleArn,
        protectedResource: {
          s3Bucket: { bucketName: mediaObjects.bucketName },
        },
        actions: { tagging: { status: 'ENABLED' } },
      },
    );
    mediaScanPlan.cfnOptions.condition = shouldScanMedia;
    if (mediaScanPolicy !== undefined) {
      mediaScanPlan.node.addDependency(mediaScanPolicy);
    }

    const runtimeRole = new iam.Role(this, 'AppRunnerRuntimeRole', {
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
      description:
        'Least-privilege live-pilot runtime; it has no notification-provider write authority.',
    });
    const runtimeGrants = [
      databaseApplicationSecret.grantRead(runtimeRole),
      bootstrapIdentitySecret.grantRead(runtimeRole),
      googleOauthSecret.grantRead(runtimeRole),
      googleOidcCookieSecret.grantRead(runtimeRole),
      // The admin forms resolve a Google Group address to its ID through the
      // same read-only roster-reader credential the scheduled sync uses.
      googleGroupsSecret.grantRead(runtimeRole),
      apiSaltSecret.grantRead(runtimeRole),
      deliveryStateWorkerSecret.grantRead(runtimeRole),
      attemptExecutionWorkerSecret.grantRead(runtimeRole),
      pushEndpointWorkerSecret.grantRead(runtimeRole),
      expoPushRuntimeWorkerSecret.grantRead(runtimeRole),
      emailRuntimeWorkerSecret.grantRead(runtimeRole),
      smsRuntimeWorkerSecret.grantRead(runtimeRole),
      iam.Grant.addToPrincipal({
        actions: ['sqs:GetQueueAttributes'],
        grantee: runtimeRole,
        resourceArns: [healthQueue.queueArn],
      }),
      // The application both probes and writes to the delivery queue: the
      // health route reads its attributes, and an activation sends the
      // notification batch to it after the event transaction commits. Without
      // the read the health check fails and App Runner rolls the deployment
      // back; without the send the outbox row is written and never moves.
      iam.Grant.addToPrincipal({
        actions: ['sqs:GetQueueAttributes', 'sqs:SendMessage'],
        grantee: runtimeRole,
        resourceArns: [deliveryQueue.queueArn],
      }),
      // The readiness page sees counts only. It may list subscriptions on the
      // two alarm topics, but cannot subscribe, publish, mutate, or read any
      // other notification-provider topic.
      iam.Grant.addToPrincipal({
        actions: ['sns:ListSubscriptionsByTopic'],
        grantee: runtimeRole,
        resourceArns: [
          operationsAlarmTopic.topicArn,
          criticalAlarmTopic.topicArn,
        ],
      }),
    ];

    // The media grant lives in its own policy rather than the role's default
    // one. The bucket is conditional on the application being provisioned, and
    // the default policy is not: a reference from an unconditional resource to
    // a conditional one is a template CloudFormation refuses to validate.
    //
    // The application signs upload and read grants, writes the sanitized
    // object, and reads the malware-scan tag. It never deletes -- a media
    // record is append-only truth.
    const mediaAccessPolicy = new iam.Policy(this, 'AppRunnerMediaAccess', {
      roles: [runtimeRole],
      statements: [
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:GetObjectTagging', 's3:PutObject'],
          resources: [mediaObjects.arnForObjects('*')],
        }),
      ],
    });
    (
      mediaAccessPolicy.node.defaultChild as iam.CfnPolicy
    ).cfnOptions.condition = shouldProvisionApplication;

    const appRunnerScaling = new apprunner.CfnAutoScalingConfiguration(
      this,
      'AppRunnerScaling',
      {
        autoScalingConfigurationName: 'psd-eoc-single',
        maxConcurrency: 10,
        maxSize: 1,
        minSize: 1,
      },
    );
    appRunnerScaling.cfnOptions.condition = shouldProvisionApplication;

    const appRunnerService = new apprunner.CfnService(
      this,
      'AppRunnerService',
      {
        autoScalingConfigurationArn:
          appRunnerScaling.attrAutoScalingConfigurationArn,
        healthCheckConfiguration: {
          healthyThreshold: 1,
          interval: 10,
          path: HEALTH_PATH,
          protocol: 'HTTP',
          timeout: 5,
          unhealthyThreshold: 5,
        },
        instanceConfiguration: {
          cpu: '1 vCPU',
          instanceRoleArn: runtimeRole.roleArn,
          memory: '2 GB',
        },
        networkConfiguration: {
          egressConfiguration: {
            egressType: 'VPC',
            vpcConnectorArn: appRunnerVpcConnector.attrVpcConnectorArn,
          },
        },
        serviceName: 'psd-eoc',
        sourceConfiguration: {
          authenticationConfiguration: {
            accessRoleArn: imageAccessRole.roleArn,
          },
          autoDeploymentsEnabled: false,
          imageRepository: {
            imageConfiguration: {
              port: APP_RUNNER_PORT,
              runtimeEnvironmentSecrets: [
                {
                  name: 'API_SALT',
                  value: apiSaltSecret.secretArn,
                },
                {
                  name: 'GOOGLE_OAUTH_CONFIG',
                  value: googleOauthSecret.secretArn,
                },
                {
                  name: 'GOOGLE_OIDC_COOKIE_SECRET',
                  value: googleOidcCookieSecret.secretArn,
                },
                {
                  name: 'GOOGLE_ROSTER_CONFIG',
                  value: googleGroupsSecret.secretArn,
                },
                {
                  name: 'DATABASE_PASSWORD',
                  value: secretJsonKeyArn(
                    databaseApplicationSecret,
                    'password',
                  ),
                },
                {
                  name: 'DATABASE_USERNAME',
                  value: secretJsonKeyArn(
                    databaseApplicationSecret,
                    'username',
                  ),
                },
                {
                  name: 'PSD_EOC_DELIVERY_STATE_WORKER_TOKEN',
                  value: deliveryStateWorkerSecret.secretArn,
                },
                {
                  name: 'PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN',
                  value: attemptExecutionWorkerSecret.secretArn,
                },
                {
                  name: 'PSD_EOC_PUSH_ENDPOINT_WORKER_TOKEN',
                  value: pushEndpointWorkerSecret.secretArn,
                },
                {
                  name: 'PSD_EOC_EXPO_PUSH_RUNTIME_WORKER_TOKEN',
                  value: expoPushRuntimeWorkerSecret.secretArn,
                },
                {
                  name: 'PSD_EOC_EMAIL_RUNTIME_WORKER_TOKEN',
                  value: emailRuntimeWorkerSecret.secretArn,
                },
                {
                  name: 'PSD_EOC_SMS_RUNTIME_WORKER_TOKEN',
                  value: smsRuntimeWorkerSecret.secretArn,
                },
                {
                  name: 'PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256',
                  value: secretJsonKeyArn(
                    bootstrapIdentitySecret,
                    'initialMobileTransitionEmailSha256',
                  ),
                },
              ],
              runtimeEnvironmentVariables: [
                {
                  name: 'AWS_REGION',
                  value: region,
                },
                // Who this deployment serves, from cdk.json context.
                {
                  name: 'GOOGLE_OIDC_APPLICATION_ORIGIN',
                  value: deploymentIdentity.applicationOrigin,
                },
                {
                  name: 'GOOGLE_OIDC_HOSTED_DOMAIN',
                  value: deploymentIdentity.hostedDomain,
                },
                {
                  name: 'PSD_EOC_IOS_BUNDLE_ID',
                  value: deploymentIdentity.iosBundleId,
                },
                {
                  name: 'PSD_EOC_ORGANIZATION_NAME',
                  value: deploymentIdentity.organizationName,
                },
                {
                  name: 'PSD_EOC_PRIVACY_CONTACT_URL',
                  value: deploymentIdentity.privacyContactUrl,
                },
                {
                  name: 'PSD_EOC_PRODUCT_OWNER_USER_ID',
                  value: deliveryTestProductOwnerUserId.valueAsString,
                },
                {
                  name: 'PSD_EOC_SMS_SUPPORT_EMAIL',
                  value: deploymentIdentity.smsSupportEmail,
                },
                {
                  name: 'PSD_EOC_SMS_SUPPORT_PHONE',
                  value: deploymentIdentity.smsSupportPhone,
                },
                {
                  name: 'PSD_EOC_DISPLAY_TIME_ZONE',
                  value: deploymentIdentity.displayTimeZone,
                },
                {
                  name: 'PSD_EOC_PUSH_PROVIDER_CUTOVER',
                  value: pushProviderCutover.valueAsString,
                },
                {
                  name: 'PSD_EOC_DIRECT_PUSH_CREDENTIAL_VERIFICATION_REFERENCE',
                  value:
                    directPushCredentialVerificationReference.valueAsString,
                },
                {
                  name: 'DATABASE_DRIVER',
                  value: 'postgres',
                },
                {
                  name: 'DATABASE_HOST',
                  value: database.clusterEndpoint.hostname,
                },
                {
                  name: 'DATABASE_PORT',
                  value: String(DATABASE_PORT),
                },
                {
                  name: 'DATABASE_NAME',
                  value: DATABASE_NAME,
                },
                {
                  name: 'DATABASE_SSL_ROOT_CERT',
                  value: DATABASE_SSL_ROOT_CERT,
                },
                {
                  name: 'DATABASE_MAX_CONNECTIONS',
                  value: '1',
                },
                {
                  name: 'DATABASE_CONNECT_TIMEOUT_SECONDS',
                  value: '10',
                },
                {
                  name: 'DATABASE_IDLE_TIMEOUT_SECONDS',
                  value: runtimeDatabaseIdleTimeoutSeconds.valueAsString,
                },
                {
                  name: 'MEDIA_BUCKET_NAME',
                  value: mediaObjects.bucketName,
                },
                {
                  name: 'DELIVERY_QUEUE_URL',
                  value: deliveryQueue.queueUrl,
                },
                {
                  name: 'PSD_EOC_OPERATIONS_ALARM_TOPIC_ARN',
                  value: operationsAlarmTopic.topicArn,
                },
                {
                  name: 'PSD_EOC_CRITICAL_ALARM_TOPIC_ARN',
                  value: criticalAlarmTopic.topicArn,
                },
                {
                  name: 'NODE_ENV',
                  value: 'production',
                },
                {
                  name: 'PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE',
                  value: sesCredentialVerificationReference.valueAsString,
                },
                {
                  name: 'PSD_EOC_EMAIL_WORKER_ENABLED',
                  value: Fn.conditionIf(
                    shouldRunEmailWorker.logicalId,
                    'true',
                    'false',
                  ).toString(),
                },
                {
                  name: 'PSD_EOC_SES_SNS_TOPIC_ARN',
                  value: emailEventsTopic.topicArn,
                },
                {
                  name: 'PSD_EOC_SMS_REGISTRATION_VERIFICATION_REFERENCE',
                  value: smsRegistrationVerificationReference.valueAsString,
                },
                {
                  name: 'PSD_EOC_SMS_DESTINATION_COUNTRY_CODE',
                  value: smsDestinationCountryCode.valueAsString,
                },
                {
                  name: 'PSD_EOC_SMS_WORKER_READY',
                  value: Fn.conditionIf(
                    shouldRunAwsEumSmsWorker.logicalId,
                    'true',
                    'false',
                  ).toString(),
                },
                {
                  name: 'RUNTIME_SECRET_ARN',
                  value: apiSaltSecret.secretArn,
                },
                {
                  name: 'SOURCE_SHA',
                  value: deployedApplicationSourceSha,
                },
              ],
            },
            imageIdentifier: deployedApplicationImageUri,
            imageRepositoryType: 'ECR',
          },
        },
      },
    );
    appRunnerService.cfnOptions.condition = shouldProvisionApplication;
    appRunnerService.addResourceDependency(bootstrapDeploymentResource);
    appRunnerService.addResourceDependency(rollbackQuiescenceResource);
    // Same constraint as the VPC connector above: App Runner replaces the
    // service when its tags change, so this was retired in the same outage.
    Tags.of(appRunnerService).add('Application', 'PSD EOC', {
      priority: 300,
    });
    Tags.of(appRunnerService).add('DataClassification', 'synthetic-only', {
      priority: 300,
    });
    Tags.of(appRunnerService).add('Environment', 'production', {
      priority: 300,
    });
    Tags.of(appRunnerService).remove('DataScope', { priority: 300 });
    for (const grant of imagePullGrants) grant.applyBefore(appRunnerService);
    for (const grant of runtimeGrants) grant.applyBefore(appRunnerService);

    // The public name and the service it names are deployed together.
    //
    // This record used to be made by hand. Nothing then kept it pointing at
    // the running service, and when it drifted every alarm stayed green while
    // nobody could reach the application: App Runner was healthy, its health
    // check passed, and the name resolved to a service that no longer existed.
    // Deriving the record from the service removes the chance of the two
    // disagreeing.
    const applicationHostname = new URL(deploymentIdentity.applicationOrigin)
      .hostname;
    const publicHostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      'ApplicationHostedZone',
      {
        hostedZoneId: deploymentIdentity.hostedZoneId,
        zoneName: deploymentIdentity.hostedDomain,
      },
    );
    const applicationRecord = new route53.CnameRecord(
      this,
      'ApplicationDomainRecord',
      {
        zone: publicHostedZone,
        recordName: applicationHostname,
        domainName: appRunnerService.attrServiceUrl,
        // Short enough that a correction is visible in minutes rather than a
        // working day.
        ttl: Duration.minutes(5),
        comment: 'Managed by the PSD EOC deployment. Do not edit by hand.',
      },
    );
    applicationRecord.node.addDependency(appRunnerService);
    // The service this names is conditional, so the name is too. A deployment
    // without the application must not publish a record pointing at nothing.
    (
      applicationRecord.node.defaultChild as route53.CfnRecordSet
    ).cfnOptions.condition = shouldProvisionApplication;

    // Reachability by name, which no other alarm covers.
    //
    // Every other alarm reads a service metric, so all of them report a
    // healthy application even when its public name does not resolve. This one
    // asks the question a person asks: does the application answer at its own
    // address. Route 53 health checks publish only into us-east-1 and a
    // CloudWatch alarm cannot read another region's metric, so the probe runs
    // here instead.
    const reachabilityArtifacts = new s3.Bucket(this, 'ReachabilityArtifacts', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    });
    (
      reachabilityArtifacts.node.defaultChild as s3.CfnBucket
    ).cfnOptions.condition = shouldProvisionApplication;
    const reachabilityRole = new iam.Role(this, 'ReachabilityRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    (reachabilityRole.node.defaultChild as iam.CfnRole).cfnOptions.condition =
      shouldProvisionApplication;
    reachabilityArtifacts.grantWrite(reachabilityRole);
    reachabilityRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': 'CloudWatchSynthetics' },
        },
      }),
    );
    reachabilityRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [
          Stack.of(this).formatArn({
            service: 'logs',
            resource: 'log-group',
            resourceName: '/aws/lambda/cwsyn-*',
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // Both generated policies reference the conditional bucket, so they carry
    // the same condition. Without it CloudFormation would resolve a reference
    // to a resource that was never created.
    const artifactsBucketPolicy = reachabilityArtifacts.policy;
    if (artifactsBucketPolicy !== undefined) {
      (
        artifactsBucketPolicy.node.defaultChild as s3.CfnBucketPolicy
      ).cfnOptions.condition = shouldProvisionApplication;
    }
    const reachabilityPolicy = reachabilityRole.node.tryFindChild(
      'DefaultPolicy',
    ) as iam.Policy | undefined;
    if (reachabilityPolicy !== undefined) {
      (
        reachabilityPolicy.node.defaultChild as iam.CfnPolicy
      ).cfnOptions.condition = shouldProvisionApplication;
    }

    const reachabilityCanary = new synthetics.CfnCanary(
      this,
      'ApplicationReachabilityCanary',
      {
        name: 'psd-eoc-reachability',
        artifactS3Location: `s3://${reachabilityArtifacts.bucketName}/reachability`,
        executionRoleArn: reachabilityRole.roleArn,
        runtimeVersion: 'syn-nodejs-puppeteer-9.1',
        schedule: { expression: 'rate(5 minutes)' },
        startCanaryAfterCreation: true,
        runConfig: { timeoutInSeconds: 60 },
        successRetentionPeriod: 7,
        failureRetentionPeriod: 31,
        code: {
          handler: 'index.handler',
          script: [
            "const https = require('https');",
            "const synthetics = require('Synthetics');",
            "const log = require('SyntheticsLogger');",
            `const HOSTNAME = ${JSON.stringify(applicationHostname)};`,
            `const PATH = ${JSON.stringify(HEALTH_PATH)};`,
            'exports.handler = async function () {',
            '  await synthetics.executeStep("public-health", async function () {',
            '    await new Promise(function (resolve, reject) {',
            '      const request = https.request(',
            '        { hostname: HOSTNAME, path: PATH, method: "GET", timeout: 15000 },',
            '        function (response) {',
            '          response.resume();',
            '          if (response.statusCode === 200) {',
            '            log.info("reachable");',
            '            resolve();',
            '            return;',
            '          }',
            '          reject(new Error("Unexpected status " + response.statusCode));',
            '        },',
            '      );',
            '      request.on("timeout", function () {',
            '        request.destroy(new Error("Timed out reaching the public address."));',
            '      });',
            '      request.on("error", reject);',
            '      request.end();',
            '    });',
            '  });',
            '};',
          ].join('\n'),
        },
      },
    );
    reachabilityCanary.node.addDependency(applicationRecord);
    reachabilityCanary.cfnOptions.condition = shouldProvisionApplication;

    const unreachableAlarm = new cloudwatch.Alarm(
      this,
      'ApplicationUnreachableAlarm',
      {
        alarmName: 'psd-eoc-public-unreachable',
        alarmDescription:
          'The application did not answer at its public address. The service can be healthy while its name is wrong: compare the DNS record against the App Runner service URL.',
        metric: new cloudwatch.Metric({
          namespace: 'CloudWatchSynthetics',
          metricName: 'SuccessPercent',
          dimensionsMap: { CanaryName: 'psd-eoc-reachability' },
          statistic: 'Average',
          period: Duration.minutes(5),
        }),
        threshold: 100,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      },
    );
    unreachableAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(criticalAlarmTopic),
    );
    (
      unreachableAlarm.node.defaultChild as cloudwatch.CfnAlarm
    ).cfnOptions.condition = shouldProvisionApplication;

    // Alarms. Until the canary and the metrics collector have the credentials
    // they need, only infrastructure publishers and metrics conditionally
    // paired with the channel workers are deployed; see infrastructure
    // monitoring.
    configureInfrastructureMonitoring(this, {
      applicationCondition: shouldProvisionApplication,
      appRunnerService,
      bootstrapLogGroup,
      channelQueues: {
        email: { deadLetterQueue: emailDeadLetterQueue, queue: emailQueue },
        push: queuePairs.Push,
        sms: queuePairs.Sms,
      },
      criticalAlarmTopic,
      recoveryAlarmTopic,
      database,
      displayTimeZone: deploymentIdentity.displayTimeZone,
      delivery: queuePairs.Delivery,
      emailCallbackDeadLetterQueue,
      emailCallbackWorkerLogGroup,
      emailWorkerCondition: shouldRunEmailWorker,
      emailWorkerLogGroup,
      smsReceipt: queuePairs.SmsReceipt,
      operationsAlarmTopic,
      operationsKey,
      monitoringRunbookBaseUrl,
      pushWorkerCondition: shouldRunExpoPushWorker,
      pushWorkerLogGroup,
      sesIdentityDomain,
      smsWorkerCondition: shouldRunAwsEumSmsWorker,
      smsWorkerLogGroup,
    });

    new CfnOutput(this, 'DeploymentAccount', {
      value: account,
    });
    new CfnOutput(this, 'DeploymentRegion', {
      value: region,
    });
    new CfnOutput(this, 'ExpectedAwsAccountAlias', {
      value: accountAlias,
    });
    new CfnOutput(this, 'EnvironmentName', {
      value: DEPLOYMENT_ENVIRONMENT,
    });
    new CfnOutput(this, 'DataClassification', {
      value: DATA_CLASSIFICATION,
    });
    new CfnOutput(this, 'ImageRepositoryArn', {
      value: imageRepository.repositoryArn,
    });
    new CfnOutput(this, 'ImageRepositoryUri', {
      value: imageRepository.repositoryUri,
    });
    new CfnOutput(this, 'DeploymentBootstrapImageDigest', {
      value: applicationImageDigest.getResponseField(
        'imageDetails.0.imageDigest',
      ),
    });
    new CfnOutput(this, 'DeploymentSourceSha', {
      value: sourceSha,
    });
    new CfnOutput(this, 'DeployedApplicationImageDigest', {
      value: Fn.conditionIf(
        shouldUseRollbackApplicationImage.logicalId,
        rollbackApplicationImageDigest.valueAsString,
        applicationImageDigest.getResponseField('imageDetails.0.imageDigest'),
      ).toString(),
    });
    new CfnOutput(this, 'DeployedApplicationSourceSha', {
      value: deployedApplicationSourceSha,
    });
    new CfnOutput(this, 'DatabaseClusterArn', {
      value: database.clusterArn,
    });
    new CfnOutput(this, 'DatabaseName', {
      value: DATABASE_NAME,
    });
    new CfnOutput(this, 'DatabaseAdminSecretArn', {
      value: databaseAdminSecret.secretArn,
    });
    new CfnOutput(this, 'DatabaseApplicationSecretArn', {
      value: databaseApplicationSecret.secretArn,
    });
    new CfnOutput(this, 'ApprovedIdentitySecretArn', {
      value: bootstrapIdentitySecret.secretArn,
    });
    new CfnOutput(this, 'BootstrapEcsClusterArn', {
      value: bootstrapCluster.clusterArn,
    });
    new CfnOutput(this, 'BootstrapTaskDefinitionArn', {
      value: bootstrapTaskDefinition.taskDefinitionArn,
    });
    new CfnOutput(this, 'BootstrapPrivateSubnetIds', {
      value: Fn.join(',', applicationSubnets.subnetIds),
    });
    new CfnOutput(this, 'BootstrapSecurityGroupId', {
      value: applicationSecurityGroup.securityGroupId,
    });
    new CfnOutput(this, 'BootstrapLogGroupName', {
      value: bootstrapLogGroup.logGroupName,
    });
    new CfnOutput(this, 'BootstrapTaskExecutionRoleArn', {
      value: bootstrapTaskExecutionRole.roleArn,
    });
    new CfnOutput(this, 'BootstrapTaskRoleArn', {
      value: bootstrapTaskRole.roleArn,
    });
    new CfnOutput(this, 'AccessSyncTaskDefinitionArn', {
      value: accessSyncTaskDefinition.taskDefinitionArn,
    });
    new CfnOutput(this, 'AccessSyncTaskExecutionRoleArn', {
      value: accessSyncTaskExecutionRole.roleArn,
    });
    new CfnOutput(this, 'AccessSyncTaskRoleArn', {
      value: accessSyncTaskRole.roleArn,
    });
    new CfnOutput(this, 'AppRunnerVpcConnectorArn', {
      value: appRunnerVpcConnector.attrVpcConnectorArn,
    });
    new CfnOutput(this, 'HealthQueueArn', {
      value: healthQueue.queueArn,
    });
    new CfnOutput(this, 'HealthQueueUrl', {
      value: healthQueue.queueUrl,
    });
    new CfnOutput(this, 'EmailQueueArn', {
      value: emailQueue.queueArn,
    });
    new CfnOutput(this, 'EmailQueueUrl', {
      value: emailQueue.queueUrl,
    });
    new CfnOutput(this, 'EmailDeadLetterQueueArn', {
      value: emailDeadLetterQueue.queueArn,
    });
    new CfnOutput(this, 'EmailCallbackQueueArn', {
      value: emailCallbackQueue.queueArn,
    });
    new CfnOutput(this, 'EmailCallbackQueueUrl', {
      value: emailCallbackQueue.queueUrl,
    });
    new CfnOutput(this, 'EmailCallbackDeadLetterQueueArn', {
      value: emailCallbackDeadLetterQueue.queueArn,
    });
    new CfnOutput(this, 'EmailWorkerRoleArn', {
      value: emailWorkerRole.roleArn,
    });
    new CfnOutput(this, 'EmailWorkerLogGroupName', {
      value: emailWorkerLogGroup.logGroupName,
    });
    new CfnOutput(this, 'EmailWorkerTaskDefinitionArn', {
      value: emailWorkerTaskDefinition.taskDefinitionArn,
    });
    new CfnOutput(this, 'EmailWorkerServiceArn', {
      value: emailWorkerService.serviceArn,
    });
    new CfnOutput(this, 'EmailWorkerTaskExecutionRoleArn', {
      value: emailWorkerTaskExecutionRole.roleArn,
    });
    new CfnOutput(this, 'EmailCallbackWorkerServiceArn', {
      value: emailCallbackWorkerService.serviceArn,
    });
    new CfnOutput(this, 'EmailCallbackWorkerLogGroupName', {
      value: emailCallbackWorkerLogGroup.logGroupName,
    });
    new CfnOutput(this, 'EmailWorkerDeploymentState', {
      value: Fn.conditionIf(
        shouldRunEmailWorker.logicalId,
        'enabled',
        'dark-scaled-to-zero',
      ).toString(),
    });
    new CfnOutput(this, 'PushQueueArn', {
      value: queuePairs.Push.queue.queueArn,
    });
    new CfnOutput(this, 'PushQueueUrl', {
      value: queuePairs.Push.queue.queueUrl,
    });
    new CfnOutput(this, 'PushDeadLetterQueueArn', {
      value: queuePairs.Push.deadLetterQueue.queueArn,
    });
    new CfnOutput(this, 'PushWorkerTaskDefinitionArn', {
      value: pushWorkerTaskDefinition.taskDefinitionArn,
    });
    new CfnOutput(this, 'PushWorkerServiceArn', {
      value: pushWorkerService.serviceArn,
    });
    new CfnOutput(this, 'PushWorkerTaskRoleArn', {
      value: pushWorkerTaskRole.roleArn,
    });
    new CfnOutput(this, 'PushWorkerTaskExecutionRoleArn', {
      value: pushWorkerTaskExecutionRole.roleArn,
    });
    new CfnOutput(this, 'PushWorkerLogGroupName', {
      value: pushWorkerLogGroup.logGroupName,
    });
    new CfnOutput(this, 'ExpoAccessTokenSecretArn', {
      value: expoAccessTokenSecret.secretArn,
    });
    new CfnOutput(this, 'PushWorkerDeploymentState', {
      value: Fn.conditionIf(
        shouldRunExpoPushWorker.logicalId,
        'enabled',
        'dark-scaled-to-zero',
      ).toString(),
    });
    new CfnOutput(this, 'PushIntegrationTruth', {
      value: 'mocked',
    });
    new CfnOutput(this, 'SesIdentityArn', {
      value: emailIdentityArn,
    });
    new CfnOutput(this, 'SesIdentityDomain', {
      value: sesIdentityDomain,
    });
    new CfnOutput(this, 'SesFromAddress', {
      value: sesFromAddress,
    });
    new CfnOutput(this, 'SesConfigurationSetName', {
      value: emailConfigurationSet.ref,
    });
    new CfnOutput(this, 'SesEmailEventsTopicArn', {
      value: emailEventsTopic.topicArn,
    });
    new CfnOutput(this, 'SesEmailEventsKeyArn', {
      value: emailEventsKey.keyArn,
    });
    new CfnOutput(this, 'SesEmailEventDestinationName', {
      value: SES_EVENT_DESTINATION_NAME,
    });
    new CfnOutput(this, 'SesEmailEventDestinationManagement', {
      value: 'cloudformation',
    });
    new CfnOutput(this, 'SesIntegrationTruth', {
      value: Fn.conditionIf(
        shouldRunEmailWorker.logicalId,
        'configured-awaiting-human-verification',
        'configured-unverified',
      ).toString(),
    });
    new CfnOutput(this, 'EmailChannelState', {
      value: Fn.conditionIf(
        shouldRunEmailWorker.logicalId,
        'awaiting-human-verification',
        'disabled',
      ).toString(),
    });
    new CfnOutput(this, 'RuntimeRoleArn', {
      value: runtimeRole.roleArn,
    });
    new CfnOutput(this, 'AppRunnerImageAccessRoleArn', {
      value: imageAccessRole.roleArn,
    });
    new CfnOutput(this, 'AppRunnerServiceArn', {
      condition: shouldProvisionApplication,
      value: appRunnerService.attrServiceArn,
    });
    new CfnOutput(this, 'AppRunnerServiceUrl', {
      condition: shouldProvisionApplication,
      value: `https://${appRunnerService.attrServiceUrl}`,
    });
    new CfnOutput(this, 'AppRunnerHealthCheckUrl', {
      condition: shouldProvisionApplication,
      value: `https://${appRunnerService.attrServiceUrl}${HEALTH_PATH}`,
    });
  }
}
