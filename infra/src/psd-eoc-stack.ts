import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  Validations,
  aws_apprunner as apprunner,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_rds as rds,
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
  GITHUB_MAIN_REF,
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_SUBJECT,
  GITHUB_OWNER_ID,
  GITHUB_REPOSITORY,
  GITHUB_REPOSITORY_ID,
  NOTIFICATION_CHANNELS,
  SES_IDENTITY_DOMAIN,
} from './config';

const CDK_BOOTSTRAP_QUALIFIER = 'hnb659fds';
const MAX_QUEUE_RECEIVES = 5;

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

    const mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      autoDeleteObjects: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      bucketKeyEnabled: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: dataKey,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: true,
    });

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
    const criticalAlarmTopic = new sns.Topic(this, 'CriticalAlarmTopic', {
      displayName: 'PSD EOC critical alarms',
      enforceSSL: true,
      masterKey: operationsKey,
      topicName: 'psd-eoc-critical-alarms',
    });
    criticalAlarmTopic.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const appImageIdentifier = new CfnParameter(this, 'AppImageIdentifier', {
      allowedPattern:
        '^338414773271\\.dkr\\.ecr\\.us-west-2\\.amazonaws\\.com\\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$',
      constraintDescription:
        'Use an immutable image digest from a private ECR repository in account 338414773271 and us-west-2.',
      description:
        'Approved PSD EOC server image URI pinned by sha256 digest; required only for a manually approved deployment.',
      type: 'String',
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
      mediaBucket.grantRead(appRunnerInstanceRole),
      mediaBucket.grantPut(appRunnerInstanceRole),
      fanout.queue.grantSendMessages(appRunnerInstanceRole),
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
              ],
              runtimeEnvironmentVariables: [
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
              ],
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

    const emailIdentity = new ses.CfnEmailIdentity(this, 'EmailIdentity', {
      dkimAttributes: {
        signingEnabled: true,
      },
      dkimSigningAttributes: {
        nextSigningKeyLength: 'RSA_2048_BIT',
      },
      emailIdentity: SES_IDENTITY_DOMAIN,
      feedbackAttributes: {
        emailForwardingEnabled: true,
      },
    });
    emailIdentity.applyRemovalPolicy(RemovalPolicy.RETAIN);

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
            [`${GITHUB_OIDC_ISSUER}:ref`]: GITHUB_MAIN_REF,
            [`${GITHUB_OIDC_ISSUER}:repository`]: GITHUB_REPOSITORY,
            [`${GITHUB_OIDC_ISSUER}:repository_id`]: GITHUB_REPOSITORY_ID,
            [`${GITHUB_OIDC_ISSUER}:repository_owner_id`]: GITHUB_OWNER_ID,
            [`${GITHUB_OIDC_ISSUER}:sub`]: GITHUB_OIDC_SUBJECT,
          },
        },
      ),
      description:
        'Future CDK deployment role restricted to psd401/psd-eoc main via GitHub OIDC.',
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
      new CfnOutput(this, `SesDkimRecordName${index + 1}`, {
        description: 'Create this SES Easy DKIM CNAME record manually.',
        value: recordName,
      });
      new CfnOutput(this, `SesDkimRecordValue${index + 1}`, {
        description: 'Value for the corresponding SES Easy DKIM CNAME record.',
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
    const deadLetterQueue = new sqs.Queue(this, `${idPrefix}DeadLetterQueue`, {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      queueName: `${queueName}-dlq`,
      retentionPeriod: Duration.days(14),
    });
    deadLetterQueue.applyRemovalPolicy(RemovalPolicy.RETAIN);

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

    return { deadLetterQueue, queue };
  }

  private cdkBootstrapRoleArns(): string[] {
    return ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(
      (rolePurpose) =>
        `arn:aws:iam::${DEPLOYMENT_ACCOUNT}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-${rolePurpose}-role-${DEPLOYMENT_ACCOUNT}-${DEPLOYMENT_REGION}`,
    );
  }
}
