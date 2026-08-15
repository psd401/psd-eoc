import {
  CfnCondition,
  CfnOutput,
  CfnParameter,
  CfnRule,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  Tags,
  Validations,
  aws_apprunner as apprunner,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_rds as rds,
  aws_secretsmanager as secretsmanager,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import {
  EXPLORATION_SMOKE_ACCOUNT,
  EXPLORATION_SMOKE_ACCOUNT_ALIAS,
  EXPLORATION_SMOKE_DATABASE_IDENTIFIER,
  EXPLORATION_SMOKE_DATABASE_NAME,
  EXPLORATION_SMOKE_DATA_CLASSIFICATION,
  EXPLORATION_SMOKE_ENVIRONMENT,
  EXPLORATION_SMOKE_HEALTH_PATH,
  EXPLORATION_SMOKE_IMAGE_DIGEST_SENTINEL,
  EXPLORATION_SMOKE_QUEUE_NAME,
  EXPLORATION_SMOKE_REGION,
  EXPLORATION_SMOKE_REPOSITORY_NAME,
} from './config';

const SECRET_PREFIX = '/psd-eoc/exploration-smoke';
const APP_RUNNER_PORT = '3000';

/**
 * Small, disposable AWS environment for synthetic staff exploration only.
 *
 * The first deployment sets ProvisionApplication=false so CloudFormation can
 * create the ECR repository. After the reviewed image is pushed by digest and
 * the database is bootstrapped, an update with ProvisionApplication=true adds
 * the single App Runner service. The same stack owns both phases.
 */
export class ExplorationSmokeStack extends Stack {
  public constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    Validations.of(this).acknowledge({
      id: 'CloudFormation-Validate::W3010',
      reason:
        'This isolated stack is fixed to one approved account and region; explicit AZs keep synthesis credentialless.',
    });

    if (
      Stack.of(this).account !== EXPLORATION_SMOKE_ACCOUNT ||
      Stack.of(this).region !== EXPLORATION_SMOKE_REGION
    ) {
      throw new Error(
        `PsdEocExplorationSmoke must target AWS account ${EXPLORATION_SMOKE_ACCOUNT} (${EXPLORATION_SMOKE_ACCOUNT_ALIAS}) in ${EXPLORATION_SMOKE_REGION}.`,
      );
    }

    Tags.of(this).add('Application', 'PSD EOC Exploration Smoke');
    Tags.of(this).add(
      'DataClassification',
      EXPLORATION_SMOKE_DATA_CLASSIFICATION,
    );
    Tags.of(this).add('Environment', EXPLORATION_SMOKE_ENVIRONMENT);
    Tags.of(this).add(
      'ExpectedAwsAccountAlias',
      EXPLORATION_SMOKE_ACCOUNT_ALIAS,
    );
    Tags.of(this).add('ManagedBy', 'AWS CDK');

    const provisionApplication = new CfnParameter(
      this,
      'ProvisionApplication',
      {
        allowedValues: ['false', 'true'],
        description:
          'Explicitly set false for first-phase repository/data-plane provisioning or true for the reviewed digest-pinned App Runner service.',
        type: 'String',
      },
    );
    const appImageDigest = new CfnParameter(this, 'AppImageDigest', {
      allowedPattern: '^sha256:[0-9a-f]{64}$',
      constraintDescription:
        'Use one lowercase SHA-256 digest in sha256:<64 hex characters> form.',
      default: EXPLORATION_SMOKE_IMAGE_DIGEST_SENTINEL,
      description:
        "Immutable digest already present in this stack's ECR repository; the all-zero sentinel is accepted only while ProvisionApplication=false.",
      type: 'String',
    });
    const googleOauthSecretArn = new CfnParameter(
      this,
      'GoogleOauthSecretArn',
      {
        allowedPattern: `^arn:aws:secretsmanager:${EXPLORATION_SMOKE_REGION}:${EXPLORATION_SMOKE_ACCOUNT}:secret:${SECRET_PREFIX}/google-oauth-[A-Za-z0-9]{6}$`,
        constraintDescription:
          'Use the complete ARN of the reviewed exploration-smoke Google OAuth secret in the approved account and region.',
        description:
          'Complete ARN of the independently reviewed Google OAuth configuration. Google OIDC is the only live integration.',
        noEcho: true,
        type: 'String',
      },
    );
    const approvedGoogleSubject = new CfnParameter(
      this,
      'ApprovedGoogleSubject',
      {
        allowedPattern: '^[A-Za-z0-9._:@+-]{1,255}$',
        constraintDescription:
          'Use one approved immutable Google subject without whitespace or commas.',
        description:
          'Approved immutable Google subject eligible for human-session bootstrap recovery after ordinary access-group authorization.',
        maxLength: 255,
        minLength: 1,
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
    new CfnRule(this, 'ApplicationRequiresPublishedDigest', {
      assertions: [
        {
          assert: Fn.conditionNot(
            Fn.conditionEquals(
              appImageDigest.valueAsString,
              EXPLORATION_SMOKE_IMAGE_DIGEST_SENTINEL,
            ),
          ),
          assertDescription:
            'ProvisionApplication=true requires a non-sentinel immutable image digest.',
        },
      ],
      ruleCondition: Fn.conditionEquals(
        provisionApplication.valueAsString,
        'true',
      ),
    });

    const imageRepository = new ecr.Repository(this, 'ImageRepository', {
      encryption: ecr.RepositoryEncryption.AES_256,
      emptyOnDelete: false,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: RemovalPolicy.DESTROY,
      repositoryName: EXPLORATION_SMOKE_REPOSITORY_NAME,
    });
    imageRepository.addLifecycleRule({
      description: 'Bound synthetic exploration image retention.',
      maxImageCount: 10,
      rulePriority: 1,
    });

    const network = new ec2.Vpc(this, 'DatabaseNetwork', {
      availabilityZones: [
        `${EXPLORATION_SMOKE_REGION}a`,
        `${EXPLORATION_SMOKE_REGION}b`,
      ],
      ipAddresses: ec2.IpAddresses.cidr('10.43.0.0/24'),
      natGateways: 0,
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
    const databaseAdminSecret = new secretsmanager.Secret(
      this,
      'DatabaseAdminSecret',
      {
        description:
          'Generated migration-only administrator credential for synthetic exploration data.',
        generateSecretString: {
          excludePunctuation: true,
          generateStringKey: 'password',
          passwordLength: 64,
          secretStringTemplate: JSON.stringify({ username: 'psd_eoc_admin' }),
        },
        removalPolicy: RemovalPolicy.DESTROY,
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
        removalPolicy: RemovalPolicy.DESTROY,
        secretName: `${SECRET_PREFIX}/database/application`,
      },
    );
    const googleOidcCookieSecret = new secretsmanager.Secret(
      this,
      'GoogleOidcCookieSecret',
      {
        description:
          'Generated base64url-compatible key material for exploration Google OIDC transient state.',
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 43,
        },
        removalPolicy: RemovalPolicy.DESTROY,
        secretName: `${SECRET_PREFIX}/google-oidc-cookie-secret`,
      },
    );
    const apiSaltSecret = new secretsmanager.Secret(this, 'ApiSaltSecret', {
      description:
        'Generated application-only salt for exploration API credential hashing.',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 64,
      },
      removalPolicy: RemovalPolicy.DESTROY,
      secretName: `${SECRET_PREFIX}/api-salt`,
    });

    const databaseSecurityGroup = new ec2.SecurityGroup(
      this,
      'DatabaseSecurityGroup',
      {
        allowAllOutbound: false,
        description:
          'Ingress-free Aurora security group for Data API-only exploration access.',
        securityGroupName: 'psd-eoc-exploration-smoke-database',
        vpc: network as unknown as ec2.IVpc,
      },
    );

    const database = new rds.DatabaseCluster(this, 'Database', {
      backup: {
        retention: Duration.days(1),
      },
      clusterIdentifier: EXPLORATION_SMOKE_DATABASE_IDENTIFIER,
      copyTagsToSnapshot: true,
      credentials: rds.Credentials.fromSecret(
        databaseAdminSecret as unknown as secretsmanager.ISecret,
      ),
      defaultDatabaseName: EXPLORATION_SMOKE_DATABASE_NAME,
      deletionProtection: false,
      enableDataApi: true,
      engine: databaseEngine,
      parameterGroup: databaseParameterGroup,
      readers: [],
      // Preserve the append-only synthetic event journal on stack deletion
      // without retaining a running cluster. Snapshot cleanup remains an
      // explicit, separately reviewed human action.
      removalPolicy: RemovalPolicy.SNAPSHOT,
      securityGroups: [databaseSecurityGroup],
      serverlessV2MaxCapacity: 1,
      serverlessV2MinCapacity: 0.5,
      storageEncrypted: true,
      vpc: network as unknown as ec2.IVpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        autoMinorVersionUpgrade: true,
        availabilityZone: `${EXPLORATION_SMOKE_REGION}a`,
        enablePerformanceInsights: false,
        publiclyAccessible: false,
      }),
    });

    const healthQueue = new sqs.Queue(this, 'HealthQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      queueName: EXPLORATION_SMOKE_QUEUE_NAME,
      removalPolicy: RemovalPolicy.DESTROY,
      retentionPeriod: Duration.days(1),
      visibilityTimeout: Duration.seconds(30),
    });

    const googleOauthSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'GoogleOauthSecret',
      googleOauthSecretArn.valueAsString,
    );
    const imageAccessRole = new iam.Role(this, 'AppRunnerImageAccessRole', {
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
      description:
        'Reads only the digest-pinned exploration server image from its isolated ECR repository.',
    });
    const imagePullGrant = imageRepository.grantPull(imageAccessRole);

    const runtimeRole = new iam.Role(this, 'AppRunnerRuntimeRole', {
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
      description:
        'Least-privilege synthetic exploration runtime; it has no notification-send authority.',
    });
    const runtimeGrants = [
      iam.Grant.addToPrincipal({
        actions: [
          'rds-data:BatchExecuteStatement',
          'rds-data:BeginTransaction',
          'rds-data:CommitTransaction',
          'rds-data:ExecuteStatement',
          'rds-data:RollbackTransaction',
        ],
        grantee: runtimeRole,
        resourceArns: [database.clusterArn],
      }),
      databaseApplicationSecret.grantRead(runtimeRole),
      googleOauthSecret.grantRead(runtimeRole),
      googleOidcCookieSecret.grantRead(runtimeRole),
      apiSaltSecret.grantRead(runtimeRole),
      iam.Grant.addToPrincipal({
        actions: ['sqs:GetQueueAttributes'],
        grantee: runtimeRole,
        resourceArns: [healthQueue.queueArn],
      }),
    ];

    const appRunnerScaling = new apprunner.CfnAutoScalingConfiguration(
      this,
      'AppRunnerScaling',
      {
        autoScalingConfigurationName: 'psd-eoc-exploration-smoke-single',
        maxConcurrency: 80,
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
          path: EXPLORATION_SMOKE_HEALTH_PATH,
          protocol: 'HTTP',
          timeout: 5,
          unhealthyThreshold: 5,
        },
        instanceConfiguration: {
          cpu: '1 vCPU',
          instanceRoleArn: runtimeRole.roleArn,
          memory: '2 GB',
        },
        serviceName: 'psd-eoc-exploration-smoke',
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
              ],
              runtimeEnvironmentVariables: [
                {
                  name: 'AWS_REGION',
                  value: EXPLORATION_SMOKE_REGION,
                },
                {
                  name: 'DATABASE_DRIVER',
                  value: 'aws-data-api',
                },
                {
                  name: 'DATABASE_NAME',
                  value: EXPLORATION_SMOKE_DATABASE_NAME,
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
                  name: 'FANOUT_QUEUE_URL',
                  value: healthQueue.queueUrl,
                },
                {
                  name: 'NODE_ENV',
                  value: 'production',
                },
                {
                  name: 'PSD_EOC_BOOTSTRAP_ADMIN_SUBJECTS',
                  value: approvedGoogleSubject.valueAsString,
                },
              ],
            },
            imageIdentifier: Fn.join('', [
              imageRepository.repositoryUri,
              '@',
              appImageDigest.valueAsString,
            ]),
            imageRepositoryType: 'ECR',
          },
        },
      },
    );
    appRunnerService.cfnOptions.condition = shouldProvisionApplication;
    imagePullGrant.applyBefore(appRunnerService);
    for (const grant of runtimeGrants) grant.applyBefore(appRunnerService);

    new CfnOutput(this, 'DeploymentAccount', {
      value: EXPLORATION_SMOKE_ACCOUNT,
    });
    new CfnOutput(this, 'DeploymentRegion', {
      value: EXPLORATION_SMOKE_REGION,
    });
    new CfnOutput(this, 'ExpectedAwsAccountAlias', {
      value: EXPLORATION_SMOKE_ACCOUNT_ALIAS,
    });
    new CfnOutput(this, 'EnvironmentName', {
      value: EXPLORATION_SMOKE_ENVIRONMENT,
    });
    new CfnOutput(this, 'DataClassification', {
      value: EXPLORATION_SMOKE_DATA_CLASSIFICATION,
    });
    new CfnOutput(this, 'ImageRepositoryArn', {
      value: imageRepository.repositoryArn,
    });
    new CfnOutput(this, 'ImageRepositoryUri', {
      value: imageRepository.repositoryUri,
    });
    new CfnOutput(this, 'DatabaseClusterArn', {
      value: database.clusterArn,
    });
    new CfnOutput(this, 'DatabaseName', {
      value: EXPLORATION_SMOKE_DATABASE_NAME,
    });
    new CfnOutput(this, 'DatabaseAdminSecretArn', {
      value: databaseAdminSecret.secretArn,
    });
    new CfnOutput(this, 'DatabaseApplicationSecretArn', {
      value: databaseApplicationSecret.secretArn,
    });
    new CfnOutput(this, 'HealthQueueArn', {
      value: healthQueue.queueArn,
    });
    new CfnOutput(this, 'HealthQueueUrl', {
      value: healthQueue.queueUrl,
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
      value: `https://${appRunnerService.attrServiceUrl}${EXPLORATION_SMOKE_HEALTH_PATH}`,
    });
  }
}
