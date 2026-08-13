import {
  ArnFormat,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Resource,
  Stack,
  Tags,
  Validations,
  aws_apprunner as apprunner,
  aws_ec2 as ec2,
  aws_guardduty as guardduty,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_rds as rds,
  aws_route53 as route53,
  aws_s3 as s3,
  aws_secretsmanager as secretsmanager,
  aws_ses as ses,
  aws_sns as sns,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import {
  APP_RUNNER_HEALTH_CHECK_PATH,
  DEPLOYMENT_ACCOUNT,
  DEPLOYMENT_REGION,
  GITHUB_DEPLOY_JOB_WORKFLOW_REF,
  GITHUB_MAIN_REF,
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_SUBJECT,
  GITHUB_OWNER_ID,
  GITHUB_REPOSITORY,
  GITHUB_REPOSITORY_ID,
  NOTIFICATION_CHANNELS,
  SES_CONFIGURATION_SET_NAME,
  SES_EVENT_DESTINATION_NAME,
  SES_EVENT_TOPIC_NAME,
  SES_EVENT_TYPES,
  SES_IDENTITY_DOMAIN,
  SES_MAIL_FROM_DOMAIN,
  SES_PARENT_HOSTED_ZONE_ID,
  SES_PARENT_HOSTED_ZONE_NAME,
} from './config';
import { configureMonitoring } from './monitoring';

const CDK_BOOTSTRAP_QUALIFIER = 'hnb659fds';
const MAX_QUEUE_RECEIVES = 5;
const MEDIA_QUARANTINE_PREFIX = 'quarantine/';
const MEDIA_QUARANTINE_RETENTION_DAYS = 1;
const MEDIA_UPLOAD_CORS_MAX_AGE_SECONDS = 300;
const GUARDDUTY_MANAGED_RULE_PREFIX =
  'DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*';

interface QueueWithDeadLetterQueue {
  readonly deadLetterQueue: sqs.Queue;
  readonly queue: sqs.Queue;
}

export class PsdEocStack extends Stack {
  public constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    Validations.of(this).acknowledge({
      id: 'CloudFormation-Validate::W3010',
      reason:
        'This stack is bound to one approved account and region; explicit AZs prove writer/reader separation and keep CI synthesis credentialless.',
    });

    if (
      Stack.of(this).account !== DEPLOYMENT_ACCOUNT ||
      Stack.of(this).region !== DEPLOYMENT_REGION
    ) {
      throw new Error(
        `PsdEoc must target AWS account ${DEPLOYMENT_ACCOUNT} in ${DEPLOYMENT_REGION}.`,
      );
    }

    Tags.of(this).add('Application', 'PSD EOC');
    Tags.of(this).add('DataScope', 'staff-minimized');
    Tags.of(this).add('ManagedBy', 'AWS CDK');

    const dataKey = new kms.Key(this, 'DataEncryptionKey', {
      alias: 'alias/psd-eoc/data',
      description: 'Encrypts retained PSD EOC database and media data.',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const operationsKey = new kms.Key(this, 'OperationsEncryptionKey', {
      alias: 'alias/psd-eoc/operations',
      description: 'Encrypts PSD EOC operational logs and alarm topics.',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    operationsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: [
          'kms:Encrypt*',
          'kms:Decrypt*',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*',
        ],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT}:log-group:/psd-eoc/*`,
          },
        },
        principals: [
          new iam.ServicePrincipal(`logs.${DEPLOYMENT_REGION}.amazonaws.com`),
        ],
        resources: ['*'],
        sid: 'AllowCloudWatchLogsEncryption',
      }),
    );

    const writerAvailabilityZone = `${DEPLOYMENT_REGION}a`;
    const readerAvailabilityZone = `${DEPLOYMENT_REGION}b`;
    const network = new ec2.Vpc(this, 'Network', {
      availabilityZones: [writerAvailabilityZone, readerAvailabilityZone],
      ipAddresses: ec2.IpAddresses.cidr('10.42.0.0/20'),
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Database',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
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
          track_commit_timestamp: '1',
        },
      },
    );
    const databaseCredentialsSecret = new secretsmanager.Secret(
      this,
      'DatabaseCredentialsSecret',
      {
        description: 'Generated credentials for the PSD EOC Aurora cluster.',
        generateSecretString: {
          excludePunctuation: true,
          generateStringKey: 'password',
          passwordLength: 64,
          secretStringTemplate: JSON.stringify({ username: 'psd_eoc_admin' }),
        },
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: '/psd-eoc/database/admin',
      },
    );

    const database = new rds.DatabaseCluster(this, 'Database', {
      backup: {
        retention: Duration.days(35),
      },
      cloudwatchLogsExports: ['postgresql'],
      copyTagsToSnapshot: true,
      credentials: rds.Credentials.fromSecret(
        databaseCredentialsSecret as unknown as secretsmanager.ISecret,
      ),
      defaultDatabaseName: 'psd_eoc',
      deletionProtection: true,
      enableDataApi: true,
      engine: databaseEngine,
      parameterGroup: databaseParameterGroup,
      readers: [
        rds.ClusterInstance.serverlessV2('Reader', {
          autoMinorVersionUpgrade: true,
          availabilityZone: readerAvailabilityZone,
          enablePerformanceInsights: true,
          publiclyAccessible: false,
          scaleWithWriter: true,
        }),
      ],
      removalPolicy: RemovalPolicy.RETAIN,
      serverlessV2MaxCapacity: 4,
      // A positive minimum keeps Aurora available; auto-pause is intentionally
      // not configured anywhere in this stack.
      serverlessV2MinCapacity: 0.5,
      storageEncrypted: true,
      storageEncryptionKey: dataKey,
      // aws-cdk-lib's Vpc/IVpc declarations are structurally incompatible when
      // TypeScript's exactOptionalPropertyTypes flag is enabled.
      vpc: network as unknown as ec2.IVpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        autoMinorVersionUpgrade: true,
        availabilityZone: writerAvailabilityZone,
        enablePerformanceInsights: true,
        publiclyAccessible: false,
      }),
    });

    const databaseApplicationSecret = new secretsmanager.Secret(
      this,
      'DatabaseApplicationSecret',
      {
        description:
          'BLOCKED until this LOGIN is provisioned with only psd_eoc_app role membership.',
        generateSecretString: {
          excludePunctuation: true,
          generateStringKey: 'password',
          passwordLength: 64,
          secretStringTemplate: JSON.stringify({
            username: 'psd_eoc_application',
          }),
        },
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: '/psd-eoc/database/application',
      },
    );

    const mediaUploadAllowedOrigin = new CfnParameter(
      this,
      'MediaUploadAllowedOrigin',
      {
        allowedPattern:
          '^https://[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?$',
        constraintDescription:
          'Use exactly one HTTPS origin with no path, query, fragment, credentials, or wildcard.',
        description:
          'Approved PSD EOC web origin allowed to PUT directly to private media upload URLs.',
        type: 'String',
      },
    );

    const mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      autoDeleteObjects: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      bucketKeyEnabled: true,
      cors: [
        {
          allowedHeaders: ['content-type', 'if-none-match'],
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: [mediaUploadAllowedOrigin.valueAsString],
          exposedHeaders: ['ETag', 'x-amz-checksum-sha256'],
          maxAge: MEDIA_UPLOAD_CORS_MAX_AGE_SECONDS,
        },
      ],
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: dataKey,
      enforceSSL: true,
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: Duration.days(
            MEDIA_QUARANTINE_RETENTION_DAYS,
          ),
          expiration: Duration.days(MEDIA_QUARANTINE_RETENTION_DAYS),
          id: 'ExpireAbandonedQuarantineMedia',
          noncurrentVersionExpiration: Duration.days(
            MEDIA_QUARANTINE_RETENTION_DAYS,
          ),
          prefix: MEDIA_QUARANTINE_PREFIX,
        },
      ],
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: true,
    });
    this.retainGeneratedPolicy(mediaBucket);
    mediaBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        conditions: {
          Bool: {
            's3:ObjectCreationOperation': 'true',
          },
          Null: {
            's3:if-none-match': 'true',
          },
        },
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        resources: [mediaBucket.arnForObjects(`${MEDIA_QUARANTINE_PREFIX}*`)],
        sid: 'DenyUnconditionalQuarantineMediaWrite',
      }),
    );
    mediaBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        conditions: {
          Bool: {
            's3:ObjectCreationOperation': 'true',
          },
          Null: {
            's3:if-none-match': 'true',
          },
        },
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        resources: [mediaBucket.arnForObjects('ready/*')],
        sid: 'DenyUnconditionalReadyMediaWrite',
      }),
    );
    mediaBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        resources: [mediaBucket.arnForObjects('ready/*')],
        sid: 'DenyReadyMediaDeletion',
      }),
    );

    const guardDutyManagedRuleArn = Stack.of(this).formatArn({
      account: DEPLOYMENT_ACCOUNT,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      region: DEPLOYMENT_REGION,
      resource: 'rule',
      resourceName: GUARDDUTY_MANAGED_RULE_PREFIX,
      service: 'events',
    });
    const mediaMalwareProtectionPlanArn = Stack.of(this).formatArn({
      account: DEPLOYMENT_ACCOUNT,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      region: DEPLOYMENT_REGION,
      resource: 'malware-protection-plan',
      resourceName: '*',
      service: 'guardduty',
    });
    const mediaMalwareScanRole = new iam.Role(this, 'MediaMalwareScanRole', {
      assumedBy: new iam.ServicePrincipal(
        'malware-protection-plan.guardduty.amazonaws.com',
        {
          conditions: {
            ArnLike: {
              'aws:SourceArn': mediaMalwareProtectionPlanArn,
            },
            StringEquals: {
              'aws:SourceAccount': DEPLOYMENT_ACCOUNT,
            },
          },
        },
      ),
      description:
        'Allows GuardDuty to scan and tag only PSD EOC quarantine uploads.',
      inlinePolicies: {
        MediaMalwareProtection: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'events:PutRule',
                'events:DeleteRule',
                'events:PutTargets',
                'events:RemoveTargets',
              ],
              conditions: {
                StringLike: {
                  'events:ManagedBy':
                    'malware-protection-plan.guardduty.amazonaws.com',
                },
              },
              resources: [guardDutyManagedRuleArn],
              sid: 'AllowManagedRuleToSendS3EventsToGuardDuty',
            }),
            new iam.PolicyStatement({
              actions: ['events:DescribeRule', 'events:ListTargetsByRule'],
              resources: [guardDutyManagedRuleArn],
              sid: 'AllowGuardDutyToMonitorEventBridgeManagedRule',
            }),
            new iam.PolicyStatement({
              actions: [
                's3:PutObjectTagging',
                's3:GetObjectTagging',
                's3:PutObjectVersionTagging',
                's3:GetObjectVersionTagging',
              ],
              resources: [
                mediaBucket.arnForObjects(`${MEDIA_QUARANTINE_PREFIX}*`),
              ],
              sid: 'AllowPostScanTag',
            }),
            new iam.PolicyStatement({
              actions: ['s3:PutBucketNotification', 's3:GetBucketNotification'],
              resources: [mediaBucket.bucketArn],
              sid: 'AllowEnableS3EventBridgeEvents',
            }),
            new iam.PolicyStatement({
              actions: ['s3:PutObject'],
              resources: [
                mediaBucket.arnForObjects(
                  'malware-protection-resource-validation-object',
                ),
              ],
              sid: 'AllowPutValidationObject',
            }),
            new iam.PolicyStatement({
              actions: ['s3:ListBucket'],
              conditions: {
                StringLike: {
                  's3:prefix': `${MEDIA_QUARANTINE_PREFIX}*`,
                },
              },
              resources: [mediaBucket.bucketArn],
              sid: 'AllowCheckBucketOwnership',
            }),
            new iam.PolicyStatement({
              actions: ['s3:GetObject', 's3:GetObjectVersion'],
              resources: [
                mediaBucket.arnForObjects(`${MEDIA_QUARANTINE_PREFIX}*`),
              ],
              sid: 'AllowMalwareScan',
            }),
            new iam.PolicyStatement({
              actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
              conditions: {
                StringLike: {
                  'kms:ViaService': `s3.${DEPLOYMENT_REGION}.amazonaws.com`,
                },
              },
              resources: [dataKey.keyArn],
              sid: 'AllowDecryptForMalwareScan',
            }),
          ],
        }),
      },
    });
    mediaBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: [
          's3:PutObjectTagging',
          's3:PutObjectVersionTagging',
          's3:DeleteObjectTagging',
          's3:DeleteObjectVersionTagging',
        ],
        conditions: {
          ArnNotEquals: {
            'aws:PrincipalArn': mediaMalwareScanRole.roleArn,
          },
        },
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        resources: [mediaBucket.arnForObjects(`${MEDIA_QUARANTINE_PREFIX}*`)],
        sid: 'DenyQuarantineScanTagMutationOutsideGuardDuty',
      }),
    );
    mediaBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        conditions: {
          ArnNotEquals: {
            'aws:PrincipalArn': mediaMalwareScanRole.roleArn,
          },
          StringNotEquals: {
            's3:ExistingObjectTag/GuardDutyMalwareScanStatus':
              'NO_THREATS_FOUND',
          },
        },
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        resources: [mediaBucket.arnForObjects(`${MEDIA_QUARANTINE_PREFIX}*`)],
        sid: 'DenyQuarantineReadUnlessGuardDutyMarkedClean',
      }),
    );
    const mediaMalwareProtectionPlan = new guardduty.CfnMalwareProtectionPlan(
      this,
      'MediaMalwareProtectionPlan',
      {
        actions: {
          tagging: {
            status: 'ENABLED',
          },
        },
        protectedResource: {
          s3Bucket: {
            bucketName: mediaBucket.bucketName,
            objectPrefixes: [MEDIA_QUARANTINE_PREFIX],
          },
        },
        role: mediaMalwareScanRole.roleArn,
      },
    );
    // AWS recommends an explicit IaC dependency so the role and its inline
    // permissions can propagate before GuardDuty validates the plan.
    mediaMalwareProtectionPlan.node.addDependency(mediaMalwareScanRole);

    const fanout = this.createQueueWithDeadLetterQueue(
      'Fanout',
      'psd-eoc-fanout',
    );
    const channelQueues = Object.fromEntries(
      NOTIFICATION_CHANNELS.map((channel) => [
        channel,
        this.createQueueWithDeadLetterQueue(
          `${channel.charAt(0).toUpperCase()}${channel.slice(1)}`,
          `psd-eoc-${channel}`,
        ),
      ]),
    ) as Record<
      (typeof NOTIFICATION_CHANNELS)[number],
      QueueWithDeadLetterQueue
    >;

    const googleOauthSecret = new secretsmanager.Secret(
      this,
      'GoogleOauthSecret',
      {
        description:
          'BLOCKED placeholder for approved Google OAuth configuration.',
        generateSecretString: {
          excludePunctuation: true,
          generateStringKey: 'clientSecret',
          passwordLength: 64,
          secretStringTemplate: JSON.stringify({
            clientId: 'BLOCKED_UNTIL_GOOGLE_OAUTH_IS_APPROVED',
          }),
        },
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: '/psd-eoc/google-oauth',
      },
    );
    const expoAccessTokenSecret = new secretsmanager.Secret(
      this,
      'ExpoAccessTokenSecret',
      {
        description:
          'BLOCKED placeholder; no live Expo provider token is present.',
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 64,
        },
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: '/psd-eoc/expo-access-token',
      },
    );
    const apiSaltSecret = new secretsmanager.Secret(this, 'ApiSaltSecret', {
      description: 'Generated salt for PSD EOC API credential hashing.',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 64,
      },
      removalPolicy: RemovalPolicy.RETAIN,
      secretName: '/psd-eoc/api-salt',
    });
    const deliveryStateWorkerTokenSecret = new secretsmanager.Secret(
      this,
      'DeliveryStateWorkerTokenSecret',
      {
        description:
          'Generated bearer used only by notification workers for append-only delivery-state writeback.',
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 64,
        },
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: '/psd-eoc/delivery-state-worker-token',
      },
    );

    const logGroupDefinitions = [
      ['ApplicationLogGroup', '/psd-eoc/application'],
      ['DispatcherLogGroup', '/psd-eoc/dispatcher'],
      ['PushWorkerLogGroup', '/psd-eoc/workers/push'],
      ['EmailWorkerLogGroup', '/psd-eoc/workers/email'],
      ['SmsWorkerLogGroup', '/psd-eoc/workers/sms'],
    ] as const;
    for (const [logGroupId, logGroupName] of logGroupDefinitions) {
      new logs.LogGroup(this, logGroupId, {
        encryptionKey: operationsKey,
        logGroupName,
        removalPolicy: RemovalPolicy.RETAIN,
        retention: logs.RetentionDays.INFINITE,
      });
    }

    const operationsAlarmTopic = new sns.Topic(this, 'OperationsAlarmTopic', {
      displayName: 'PSD EOC operations alarms',
      enforceSSL: true,
      masterKey: operationsKey,
      topicName: 'psd-eoc-operations-alarms',
    });
    operationsAlarmTopic.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.retainGeneratedPolicy(operationsAlarmTopic);
    const criticalAlarmTopic = new sns.Topic(this, 'CriticalAlarmTopic', {
      displayName: 'PSD EOC critical alarms',
      enforceSSL: true,
      masterKey: operationsKey,
      topicName: 'psd-eoc-critical-alarms',
    });
    criticalAlarmTopic.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.retainGeneratedPolicy(criticalAlarmTopic);

    const appImageIdentifier = new CfnParameter(this, 'AppImageIdentifier', {
      allowedPattern: `^${DEPLOYMENT_ACCOUNT}\\.dkr\\.ecr\\.${DEPLOYMENT_REGION}\\.amazonaws\\.com\\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$`,
      constraintDescription: `Use an immutable image digest from a private ECR repository in account ${DEPLOYMENT_ACCOUNT} and ${DEPLOYMENT_REGION}.`,
      description:
        'Approved PSD EOC server image URI pinned by sha256 digest; required only for a manually approved deployment.',
      type: 'String',
    });
    const productOwnerUserId = new CfnParameter(
      this,
      'DeliveryTestProductOwnerUserId',
      {
        allowedPattern:
          '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        constraintDescription:
          'Use the authenticated product-owner UUID authorized to manage canary eligibility and target versions.',
        description:
          'Product-owner user UUID for monthly delivery-test target administration.',
        type: 'String',
      },
    );
    const credentialVerificationReferenceParameters = Object.freeze({
      push: new CfnParameter(this, 'ExpoCredentialVerificationReference', {
        allowedPattern: '^(?:UNVERIFIED|[A-Za-z0-9][A-Za-z0-9._:-]{15,254})$',
        default: 'UNVERIFIED',
        description:
          'Non-secret reference that must exactly match the current Expo live-verification evidence; UNVERIFIED fails closed.',
        type: 'String',
      }),
      email: new CfnParameter(this, 'SesCredentialVerificationReference', {
        allowedPattern: '^(?:UNVERIFIED|[A-Za-z0-9][A-Za-z0-9._:-]{15,254})$',
        default: 'UNVERIFIED',
        description:
          'Non-secret reference that must exactly match the current SES live-verification evidence; UNVERIFIED fails closed.',
        type: 'String',
      }),
      sms: new CfnParameter(this, 'SmsCredentialVerificationReference', {
        allowedPattern: '^(?:UNVERIFIED|[A-Za-z0-9][A-Za-z0-9._:-]{15,254})$',
        default: 'UNVERIFIED',
        description:
          'Non-secret reference that must exactly match the current SMS live-verification evidence; UNVERIFIED fails closed.',
        type: 'String',
      }),
    });

    const appRunnerImageRole = new iam.Role(this, 'AppRunnerImageRole', {
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
      description: 'Allows App Runner to read the approved private ECR image.',
    });
    appRunnerImageRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'service-role/AWSAppRunnerServicePolicyForECRAccess',
      ),
    );

    const appRunnerInstanceRole = new iam.Role(this, 'AppRunnerInstanceRole', {
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
      description:
        'Least-privilege runtime role for the PSD EOC web and capability service.',
    });
    const appRunnerRuntimeGrants = [
      // DatabaseCluster.grantDataApiAccess also grants the cluster's admin
      // secret. Grant only the Data API operations so the runtime can never
      // obtain administrator credentials.
      iam.Grant.addToPrincipal({
        actions: [
          'rds-data:BatchExecuteStatement',
          'rds-data:BeginTransaction',
          'rds-data:CommitTransaction',
          'rds-data:ExecuteStatement',
          'rds-data:RollbackTransaction',
        ],
        grantee: appRunnerInstanceRole,
        resourceArns: [database.clusterArn],
      }),
      databaseApplicationSecret.grantRead(appRunnerInstanceRole),
      googleOauthSecret.grantRead(appRunnerInstanceRole),
      apiSaltSecret.grantRead(appRunnerInstanceRole),
      deliveryStateWorkerTokenSecret.grantRead(appRunnerInstanceRole),
      iam.Grant.addToPrincipal({
        actions: ['s3:GetObject', 's3:PutObject'],
        grantee: appRunnerInstanceRole,
        resourceArns: [
          mediaBucket.arnForObjects(`${MEDIA_QUARANTINE_PREFIX}*`),
          mediaBucket.arnForObjects('ready/*'),
        ],
      }),
      iam.Grant.addToPrincipal({
        actions: ['s3:GetObjectTagging'],
        grantee: appRunnerInstanceRole,
        resourceArns: [
          mediaBucket.arnForObjects(`${MEDIA_QUARANTINE_PREFIX}*`),
        ],
      }),
      iam.Grant.addToPrincipal({
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `s3.${DEPLOYMENT_REGION}.amazonaws.com`,
          },
        },
        grantee: appRunnerInstanceRole,
        resourceArns: [dataKey.keyArn],
      }),
      fanout.queue.grantSendMessages(appRunnerInstanceRole),
      iam.Grant.addToPrincipal({
        actions: ['sqs:GetQueueAttributes'],
        grantee: appRunnerInstanceRole,
        resourceArns: [fanout.queue.queueArn],
      }),
    ];

    const appRunnerScaling = new apprunner.CfnAutoScalingConfiguration(
      this,
      'AppRunnerScaling',
      {
        autoScalingConfigurationName: 'psd-eoc-high-availability',
        maxConcurrency: 100,
        maxSize: 10,
        minSize: 2,
      },
    );

    const runtimeEnvironmentVariables: apprunner.CfnService.KeyValuePairProperty[] =
      [
        {
          name: 'AWS_REGION',
          value: DEPLOYMENT_REGION,
        },
        {
          name: 'DATABASE_DRIVER',
          value: 'aws-data-api',
        },
        {
          name: 'DATABASE_NAME',
          value: 'psd_eoc',
        },
        {
          name: 'DATABASE_RESOURCE_ARN',
          value: database.clusterArn,
        },
        {
          name: 'DATABASE_SECRET_ARN',
          value: databaseApplicationSecret.secretArn,
        },
        {
          name: 'MEDIA_BUCKET_NAME',
          value: mediaBucket.bucketName,
        },
        {
          name: 'FANOUT_QUEUE_URL',
          value: fanout.queue.queueUrl,
        },
        {
          name: 'PSD_EOC_PRODUCT_OWNER_USER_ID',
          value: productOwnerUserId.valueAsString,
        },
        {
          name: 'PSD_EOC_EXPO_CREDENTIAL_VERIFICATION_REFERENCE',
          value: credentialVerificationReferenceParameters.push.valueAsString,
        },
        {
          name: 'PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE',
          value: credentialVerificationReferenceParameters.email.valueAsString,
        },
        {
          name: 'PSD_EOC_SMS_CREDENTIAL_VERIFICATION_REFERENCE',
          value: credentialVerificationReferenceParameters.sms.valueAsString,
        },
      ];
    const appRunnerService = new apprunner.CfnService(
      this,
      'AppRunnerService',
      {
        autoScalingConfigurationArn:
          appRunnerScaling.attrAutoScalingConfigurationArn,
        healthCheckConfiguration: {
          healthyThreshold: 1,
          interval: 5,
          path: APP_RUNNER_HEALTH_CHECK_PATH,
          protocol: 'HTTP',
          timeout: 2,
          unhealthyThreshold: 5,
        },
        instanceConfiguration: {
          cpu: '1 vCPU',
          instanceRoleArn: appRunnerInstanceRole.roleArn,
          memory: '2 GB',
        },
        serviceName: 'psd-eoc',
        sourceConfiguration: {
          authenticationConfiguration: {
            accessRoleArn: appRunnerImageRole.roleArn,
          },
          autoDeploymentsEnabled: false,
          imageRepository: {
            imageConfiguration: {
              port: '3000',
              runtimeEnvironmentSecrets: [
                {
                  name: 'GOOGLE_OAUTH_CONFIG',
                  value: googleOauthSecret.secretArn,
                },
                {
                  name: 'API_SALT',
                  value: apiSaltSecret.secretArn,
                },
                {
                  name: 'PSD_EOC_DELIVERY_STATE_WORKER_TOKEN',
                  value: deliveryStateWorkerTokenSecret.secretArn,
                },
              ],
              runtimeEnvironmentVariables,
            },
            imageIdentifier: appImageIdentifier.valueAsString,
            imageRepositoryType: 'ECR',
          },
        },
      },
    );
    for (const grant of appRunnerRuntimeGrants) {
      grant.applyBefore(appRunnerService);
    }

    const monitoringRuntime = configureMonitoring(this, {
      appRunnerService,
      channelQueues,
      criticalAlarmTopic,
      database,
      fanout,
      operationsAlarmTopic,
      operationsKey,
    });
    runtimeEnvironmentVariables.push(
      {
        name: 'CANARY_FACILITY_ID',
        value: monitoringRuntime.canaryFacilityId,
      },
      {
        name: 'CANARY_EVENT_TYPE_VERSION_ID',
        value: monitoringRuntime.canaryEventTypeVersionId,
      },
    );

    const emailConfigurationSetArn = `arn:aws:ses:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT}:configuration-set/${SES_CONFIGURATION_SET_NAME}`;
    operationsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        conditions: {
          StringEquals: {
            'AWS:SourceAccount': DEPLOYMENT_ACCOUNT,
            'AWS:SourceArn': emailConfigurationSetArn,
          },
        },
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        resources: ['*'],
        sid: 'AllowSesEmailEventEncryption',
      }),
    );

    const parentHostedZone =
      route53.PublicHostedZone.fromPublicHostedZoneAttributes(
        this,
        'ParentHostedZone',
        {
          hostedZoneId: SES_PARENT_HOSTED_ZONE_ID,
          zoneName: SES_PARENT_HOSTED_ZONE_NAME,
        },
      );
    const alertsHostedZone = new route53.PublicHostedZone(
      this,
      'AlertsHostedZone',
      {
        comment: 'Delegated DNS zone for PSD EOC transactional email.',
        zoneName: SES_IDENTITY_DOMAIN,
      },
    );
    alertsHostedZone.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const alertsNameServers = alertsHostedZone.hostedZoneNameServers;
    if (alertsNameServers === undefined) {
      throw new Error(
        'The public alerts hosted zone must expose name servers.',
      );
    }
    const alertsZoneDelegation = new route53.ZoneDelegationRecord(
      this,
      'AlertsZoneDelegation',
      {
        comment: 'Delegates alerts.psd401.net to the retained PSD EOC zone.',
        nameServers: alertsNameServers,
        recordName: SES_IDENTITY_DOMAIN,
        ttl: Duration.minutes(5),
        zone: parentHostedZone,
      },
    );
    alertsZoneDelegation.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const emailConfigurationSet = new ses.CfnConfigurationSet(
      this,
      'EmailConfigurationSet',
      {
        name: SES_CONFIGURATION_SET_NAME,
        reputationOptions: {
          reputationMetricsEnabled: true,
        },
      },
    );
    emailConfigurationSet.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const emailEventsTopic = new sns.Topic(this, 'EmailEventsTopic', {
      displayName: 'PSD EOC SES delivery events',
      enforceSSL: true,
      masterKey: operationsKey,
      topicName: SES_EVENT_TOPIC_NAME,
    });
    emailEventsTopic.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const emailEventsPublishPolicy = emailEventsTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        conditions: {
          StringEquals: {
            'AWS:SourceAccount': DEPLOYMENT_ACCOUNT,
            'AWS:SourceArn': emailConfigurationSetArn,
          },
        },
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        resources: [emailEventsTopic.topicArn],
        sid: 'AllowSesConfigurationSetEvents',
      }),
    );
    this.retainGeneratedPolicy(emailEventsTopic);

    const emailEventDestination = new ses.CfnConfigurationSetEventDestination(
      this,
      'EmailEventDestination',
      {
        configurationSetName: emailConfigurationSet.ref,
        eventDestination: {
          enabled: true,
          matchingEventTypes: [...SES_EVENT_TYPES],
          name: SES_EVENT_DESTINATION_NAME,
          snsDestination: {
            topicArn: emailEventsTopic.topicArn,
          },
        },
      },
    );
    emailEventDestination.applyRemovalPolicy(RemovalPolicy.RETAIN);
    if (emailEventsPublishPolicy.policyDependable !== undefined) {
      emailEventDestination.node.addDependency(
        emailEventsPublishPolicy.policyDependable,
      );
    }

    const emailIdentity = new ses.CfnEmailIdentity(this, 'EmailIdentity', {
      configurationSetAttributes: {
        configurationSetName: emailConfigurationSet.ref,
      },
      dkimAttributes: {
        signingEnabled: true,
      },
      dkimSigningAttributes: {
        nextSigningKeyLength: 'RSA_2048_BIT',
      },
      emailIdentity: SES_IDENTITY_DOMAIN,
      feedbackAttributes: {
        emailForwardingEnabled: false,
      },
      mailFromAttributes: {
        behaviorOnMxFailure: 'REJECT_MESSAGE',
        mailFromDomain: SES_MAIL_FROM_DOMAIN,
      },
    });
    emailIdentity.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const mailFromMxRecord = new route53.CfnRecordSet(
      this,
      'SesMailFromMxRecord',
      {
        hostedZoneId: alertsHostedZone.hostedZoneId,
        name: `${SES_MAIL_FROM_DOMAIN}.`,
        resourceRecords: [
          `10 feedback-smtp.${DEPLOYMENT_REGION}.amazonses.com.`,
        ],
        ttl: '300',
        type: 'MX',
      },
    );
    mailFromMxRecord.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const mailFromSpfRecord = new route53.CfnRecordSet(
      this,
      'SesMailFromSpfRecord',
      {
        hostedZoneId: alertsHostedZone.hostedZoneId,
        name: `${SES_MAIL_FROM_DOMAIN}.`,
        resourceRecords: ['"v=spf1 include:amazonses.com ~all"'],
        ttl: '300',
        type: 'TXT',
      },
    );
    mailFromSpfRecord.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const githubOidcProvider =
      iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
        this,
        'SharedGithubOidcProvider',
        `arn:aws:iam::${DEPLOYMENT_ACCOUNT}:oidc-provider/${GITHUB_OIDC_ISSUER}`,
      );
    const githubDeployRole = new iam.Role(this, 'GithubActionsDeployRole', {
      assumedBy: new iam.WebIdentityPrincipal(
        githubOidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            [`${GITHUB_OIDC_ISSUER}:aud`]: 'sts.amazonaws.com',
            [`${GITHUB_OIDC_ISSUER}:job_workflow_ref`]:
              GITHUB_DEPLOY_JOB_WORKFLOW_REF,
            [`${GITHUB_OIDC_ISSUER}:ref`]: GITHUB_MAIN_REF,
            [`${GITHUB_OIDC_ISSUER}:repository`]: GITHUB_REPOSITORY,
            [`${GITHUB_OIDC_ISSUER}:repository_id`]: GITHUB_REPOSITORY_ID,
            [`${GITHUB_OIDC_ISSUER}:repository_owner_id`]: GITHUB_OWNER_ID,
            [`${GITHUB_OIDC_ISSUER}:sub`]: GITHUB_OIDC_SUBJECT,
          },
        },
      ),
      description:
        'Future CDK deployment role restricted to the approved psd-eoc reusable workflow on main.',
      maxSessionDuration: Duration.hours(1),
      roleName: 'PsdEocGithubActionsDeploy',
    });
    githubDeployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: this.cdkBootstrapRoleArns(),
      }),
    );

    new CfnOutput(this, 'DatabaseClusterArn', {
      value: database.clusterArn,
    });
    new CfnOutput(this, 'DatabaseAdminSecretArn', {
      value: databaseCredentialsSecret.secretArn,
    });
    new CfnOutput(this, 'DatabaseApplicationSecretArn', {
      value: databaseApplicationSecret.secretArn,
    });
    new CfnOutput(this, 'MediaBucketName', {
      value: mediaBucket.bucketName,
    });
    new CfnOutput(this, 'FanoutQueueUrl', {
      value: fanout.queue.queueUrl,
    });
    for (const channel of NOTIFICATION_CHANNELS) {
      const outputPrefix = `${channel.charAt(0).toUpperCase()}${channel.slice(1)}`;
      new CfnOutput(this, `${outputPrefix}QueueUrl`, {
        value: channelQueues[channel].queue.queueUrl,
      });
      new CfnOutput(this, `${outputPrefix}DeadLetterQueueArn`, {
        value: channelQueues[channel].deadLetterQueue.queueArn,
      });
    }
    new CfnOutput(this, 'AppRunnerServiceUrl', {
      value: `https://${appRunnerService.attrServiceUrl}`,
    });
    new CfnOutput(this, 'AppRunnerHealthCheckUrl', {
      value: `https://${appRunnerService.attrServiceUrl}${APP_RUNNER_HEALTH_CHECK_PATH}`,
    });
    new CfnOutput(this, 'OperationsAlarmTopicArn', {
      value: operationsAlarmTopic.topicArn,
    });
    new CfnOutput(this, 'CriticalAlarmTopicArn', {
      value: criticalAlarmTopic.topicArn,
    });
    new CfnOutput(this, 'GithubActionsDeployRoleArn', {
      value: githubDeployRole.roleArn,
    });
    new CfnOutput(this, 'SesIdentityDomain', {
      value: SES_IDENTITY_DOMAIN,
    });
    new CfnOutput(this, 'AlertsHostedZoneId', {
      description: 'Route 53 hosted-zone ID for alerts.psd401.net.',
      value: alertsHostedZone.hostedZoneId,
    });
    new CfnOutput(this, 'AlertsHostedZoneNameServers', {
      description:
        'Comma-separated authoritative name servers for alerts.psd401.net.',
      value: Fn.join(',', alertsNameServers),
    });
    new CfnOutput(this, 'SesMailFromDomain', {
      value: SES_MAIL_FROM_DOMAIN,
    });
    new CfnOutput(this, 'SesConfigurationSetName', {
      value: emailConfigurationSet.ref,
    });
    new CfnOutput(this, 'SesEmailEventsTopicArn', {
      value: emailEventsTopic.topicArn,
    });

    const dkimRecords = [
      [
        emailIdentity.attrDkimDnsTokenName1,
        emailIdentity.attrDkimDnsTokenValue1,
      ],
      [
        emailIdentity.attrDkimDnsTokenName2,
        emailIdentity.attrDkimDnsTokenValue2,
      ],
      [
        emailIdentity.attrDkimDnsTokenName3,
        emailIdentity.attrDkimDnsTokenValue3,
      ],
    ] as const;
    dkimRecords.forEach(([recordName, recordValue], index) => {
      const dkimRecord = new route53.CfnRecordSet(
        this,
        `SesDkimRecord${index + 1}`,
        {
          hostedZoneId: alertsHostedZone.hostedZoneId,
          name: recordName,
          resourceRecords: [recordValue],
          ttl: '300',
          type: 'CNAME',
        },
      );
      dkimRecord.applyRemovalPolicy(RemovalPolicy.RETAIN);
      new CfnOutput(this, `SesDkimRecordName${index + 1}`, {
        description:
          'SES Easy DKIM CNAME name published automatically in Route 53.',
        value: recordName,
      });
      new CfnOutput(this, `SesDkimRecordValue${index + 1}`, {
        description:
          'SES Easy DKIM CNAME value published automatically in Route 53.',
        value: recordValue,
      });
    });

    // This token must never reach the application service. It is retained here
    // only as a fail-closed placeholder for the future push-worker issue.
    void expoAccessTokenSecret;
  }

  private createQueueWithDeadLetterQueue(
    idPrefix: string,
    queueName: string,
  ): QueueWithDeadLetterQueue {
    // The source queue has a fixed physical name, so its ARN can be declared
    // without a CloudFormation reference. That keeps this deny-by-default
    // allow-list from forming a dependency cycle with the source queue's
    // RedrivePolicy reference back to the DLQ.
    const sourceQueueIdentity = sqs.Queue.fromQueueArn(
      this,
      `${idPrefix}RedriveSourceQueue`,
      this.formatArn({ service: 'sqs', resource: queueName }),
    );
    const deadLetterQueue = new sqs.Queue(this, `${idPrefix}DeadLetterQueue`, {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      queueName: `${queueName}-dlq`,
      redriveAllowPolicy: {
        redrivePermission: sqs.RedrivePermission.BY_QUEUE,
        sourceQueues: [sourceQueueIdentity],
      },
      retentionPeriod: Duration.days(14),
    });
    deadLetterQueue.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.retainGeneratedPolicy(deadLetterQueue);

    const queue = new sqs.Queue(this, `${idPrefix}Queue`, {
      deadLetterQueue: {
        maxReceiveCount: MAX_QUEUE_RECEIVES,
        queue: deadLetterQueue,
      },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      queueName,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.seconds(60),
    });
    queue.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.retainGeneratedPolicy(queue);

    return { deadLetterQueue, queue };
  }

  private retainGeneratedPolicy(resource: Construct): void {
    const policy = resource.node.tryFindChild('Policy');
    if (!(policy instanceof Resource)) {
      throw new Error(
        `${resource.node.path} must synthesize a retained transport-security policy.`,
      );
    }
    policy.applyRemovalPolicy(RemovalPolicy.RETAIN);
  }

  private cdkBootstrapRoleArns(): string[] {
    return ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(
      (rolePurpose) =>
        `arn:aws:iam::${DEPLOYMENT_ACCOUNT}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-${rolePurpose}-role-${DEPLOYMENT_ACCOUNT}-${DEPLOYMENT_REGION}`,
    );
  }
}
