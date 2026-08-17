import {
  CfnCondition,
  CfnOutput,
  CfnParameter,
  CfnRule,
  Duration,
  Fn,
  RemovalPolicy,
  SecretValue,
  Stack,
  Tags,
  Validations,
  aws_apprunner as apprunner,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_rds as rds,
  aws_secretsmanager as secretsmanager,
  aws_ses as ses,
  aws_sns as sns,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import {
  SES_CONFIGURATION_SET_NAME,
  SES_EVENT_DESTINATION_NAME,
  SES_EVENT_TOPIC_NAME,
} from '../config';
import {
  EXPLORATION_SMOKE_ACCOUNT,
  EXPLORATION_SMOKE_ACCOUNT_ALIAS,
  EXPLORATION_SMOKE_BOOTSTRAP_LOG_GROUP_NAME,
  EXPLORATION_SMOKE_DATABASE_IDENTIFIER,
  EXPLORATION_SMOKE_DATABASE_NAME,
  EXPLORATION_SMOKE_DATABASE_PORT,
  EXPLORATION_SMOKE_DATABASE_SSL_ROOT_CERT,
  EXPLORATION_SMOKE_DATA_CLASSIFICATION,
  EXPLORATION_SMOKE_EMAIL_DEAD_LETTER_QUEUE_NAME,
  EXPLORATION_SMOKE_EMAIL_QUEUE_NAME,
  EXPLORATION_SMOKE_EMAIL_WORKER_LOG_GROUP_NAME,
  EXPLORATION_SMOKE_ENVIRONMENT,
  EXPLORATION_SMOKE_HEALTH_PATH,
  EXPLORATION_SMOKE_IMAGE_DIGEST_SENTINEL,
  EXPLORATION_SMOKE_QUEUE_NAME,
  EXPLORATION_SMOKE_REGION,
  EXPLORATION_SMOKE_REPOSITORY_NAME,
  EXPLORATION_SMOKE_SES_FROM_ADDRESS,
  EXPLORATION_SMOKE_SES_IDENTITY_DOMAIN,
  EXPLORATION_SMOKE_SES_VERIFICATION_REFERENCE,
} from './config';

const SECRET_PREFIX = '/psd-eoc/exploration-smoke';
const APP_RUNNER_PORT = '3000';
const APPLICATION_SUBNET_GROUP_NAME = 'Application';
const BOOTSTRAP_CONTAINER_NAME = 'native-bootstrap';
const EMAIL_QUEUE_MAX_RECEIVES = 5;

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

    Tags.of(this).add('Application', 'PSD EOC Live Pilot');
    Tags.of(this).add(
      'DataClassification',
      EXPLORATION_SMOKE_DATA_CLASSIFICATION,
    );
    Tags.of(this).add('Environment', EXPLORATION_SMOKE_ENVIRONMENT);
    Tags.of(this).add('DataScope', 'staff-minimized');
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
    const bootstrapImageDigest = new CfnParameter(
      this,
      'BootstrapImageDigest',
      {
        allowedPattern: '^sha256:[0-9a-f]{64}$',
        constraintDescription:
          'Use one non-sentinel lowercase SHA-256 digest in sha256:<64 hex characters> form.',
        description:
          "Immutable candidate digest already present in this stack's ECR repository. The native bootstrap task uses this digest before AppImageDigest is promoted.",
        type: 'String',
      },
    );
    const runtimeDatabaseIdleTimeoutSeconds = new CfnParameter(
      this,
      'RuntimeDatabaseIdleTimeoutSeconds',
      {
        default: 0,
        description:
          'App Runner PostgreSQL pool idle timeout. Phase A preserves the currently live value; phase B promotes the candidate-required zero value.',
        maxValue: 600,
        minValue: 0,
        type: 'Number',
      },
    );
    const sourceSha = new CfnParameter(this, 'SourceSha', {
      allowedPattern: '^[0-9a-f]{40}$',
      constraintDescription:
        'Use the exact lowercase 40-character Git commit SHA represented by AppImageDigest.',
      description:
        'Reviewed source commit represented by the currently deployed AppImageDigest. Preserve this value until bootstrap succeeds.',
      type: 'String',
    });
    const bootstrapSourceSha = new CfnParameter(this, 'BootstrapSourceSha', {
      allowedPattern: '^[0-9a-f]{40}$',
      constraintDescription:
        'Use the exact lowercase 40-character Git commit SHA represented by BootstrapImageDigest.',
      description:
        'Reviewed candidate source commit represented by BootstrapImageDigest.',
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
    const approvedStaffEmail = new CfnParameter(this, 'ApprovedStaffEmail', {
      allowedPattern: '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,63}$',
      constraintDescription: 'Use one approved staff email address.',
      description:
        'Approved staff email assigned to the bootstrap administrator identity.',
      maxLength: 320,
      minLength: 3,
      noEcho: true,
      type: 'String',
    });
    const approvedStaffDisplayName = new CfnParameter(
      this,
      'ApprovedStaffDisplayName',
      {
        allowedPattern: "^[A-Za-z0-9 .,'()&-]{1,160}$",
        constraintDescription:
          'Use one approved display name containing letters, digits, spaces, or common name punctuation.',
        description:
          'Approved staff display name assigned to the bootstrap administrator identity.',
        maxLength: 160,
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
    new CfnRule(this, 'BootstrapRequiresPublishedDigest', {
      assertions: [
        {
          assert: Fn.conditionNot(
            Fn.conditionEquals(
              bootstrapImageDigest.valueAsString,
              EXPLORATION_SMOKE_IMAGE_DIGEST_SENTINEL,
            ),
          ),
          assertDescription:
            'BootstrapImageDigest must identify a published candidate image and cannot use the all-zero sentinel.',
        },
      ],
    });
    for (const [ruleId, parameter, description] of [
      [
        'ApplicationRequiresReviewedSource',
        sourceSha,
        'SourceSha must identify reviewed deployed source and cannot use the all-zero sentinel.',
      ],
      [
        'BootstrapRequiresReviewedSource',
        bootstrapSourceSha,
        'BootstrapSourceSha must identify reviewed candidate source and cannot use the all-zero sentinel.',
      ],
    ] as const) {
      new CfnRule(this, ruleId, {
        assertions: [
          {
            assert: Fn.conditionNot(
              Fn.conditionEquals(parameter.valueAsString, '0'.repeat(40)),
            ),
            assertDescription: description,
          },
        ],
      });
    }

    const imageRepository = new ecr.Repository(this, 'ImageRepository', {
      encryption: ecr.RepositoryEncryption.AES_256,
      emptyOnDelete: false,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: RemovalPolicy.RETAIN,
      repositoryName: EXPLORATION_SMOKE_REPOSITORY_NAME,
    });
    imageRepository.addLifecycleRule({
      description: 'Bound superseded live-pilot image retention.',
      maxImageCount: 10,
      rulePriority: 1,
    });

    const network = new ec2.Vpc(this, 'DatabaseNetwork', {
      availabilityZones: [
        `${EXPLORATION_SMOKE_REGION}a`,
        `${EXPLORATION_SMOKE_REGION}b`,
      ],
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
          'Generated base64url-compatible key material for exploration Google OIDC transient state.',
        generateSecretString: {
          excludePunctuation: true,
          passwordLength: 43,
        },
        removalPolicy: RemovalPolicy.RETAIN,
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
      removalPolicy: RemovalPolicy.RETAIN,
      secretName: `${SECRET_PREFIX}/api-salt`,
    });
    const bootstrapIdentitySecret = new secretsmanager.Secret(
      this,
      'BootstrapIdentitySecret',
      {
        description:
          'Approved staff-only live-pilot bootstrap identity, supplied only through NoEcho deployment parameters.',
        removalPolicy: RemovalPolicy.RETAIN,
        secretName: `${SECRET_PREFIX}/bootstrap/approved-identity`,
        secretObjectValue: {
          googleSubject: SecretValue.unsafePlainText(
            approvedGoogleSubject.valueAsString,
          ),
          staffDisplayName: SecretValue.unsafePlainText(
            approvedStaffDisplayName.valueAsString,
          ),
          staffEmail: SecretValue.unsafePlainText(
            approvedStaffEmail.valueAsString,
          ),
        },
      },
    );

    const databaseSecurityGroup = new ec2.SecurityGroup(
      this,
      'DatabaseSecurityGroup',
      {
        allowAllOutbound: false,
        description:
          'Isolated Aurora; accepts native PostgreSQL only from the exploration application/bootstrap security group.',
        vpc: network as unknown as ec2.IVpc,
      },
    );
    const applicationSecurityGroup = new ec2.SecurityGroup(
      this,
      'ApplicationSecurityGroup',
      {
        allowAllOutbound: false,
        description:
          'Native PostgreSQL and HTTPS egress only for App Runner and one-off bootstrap tasks.',
        securityGroupName: 'psd-eoc-exploration-smoke-application',
        vpc: network as unknown as ec2.IVpc,
      },
    );
    applicationSecurityGroup.addEgressRule(
      databaseSecurityGroup,
      ec2.Port.tcp(EXPLORATION_SMOKE_DATABASE_PORT),
      'Native PostgreSQL TLS to the isolated Aurora writer only.',
    );
    applicationSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS through the NAT gateway for Google OAuth and AWS task dependencies.',
    );
    databaseSecurityGroup.addIngressRule(
      applicationSecurityGroup,
      ec2.Port.tcp(EXPLORATION_SMOKE_DATABASE_PORT),
      'Native PostgreSQL only from the exploration application/bootstrap security group.',
    );

    const database = new rds.DatabaseCluster(this, 'Database', {
      backup: {
        retention: Duration.days(14),
      },
      clusterIdentifier: EXPLORATION_SMOKE_DATABASE_IDENTIFIER,
      copyTagsToSnapshot: true,
      credentials: rds.Credentials.fromSecret(
        databaseAdminSecret as unknown as secretsmanager.ISecret,
      ),
      defaultDatabaseName: EXPLORATION_SMOKE_DATABASE_NAME,
      deletionProtection: true,
      enableDataApi: false,
      engine: databaseEngine,
      parameterGroup: databaseParameterGroup,
      readers: [],
      // Retain staff-minimized access and append-only event truth. Any future
      // retirement is a separately reviewed human data-lifecycle decision.
      removalPolicy: RemovalPolicy.RETAIN,
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
      removalPolicy: RemovalPolicy.RETAIN,
      retentionPeriod: Duration.days(1),
      visibilityTimeout: Duration.seconds(30),
    });

    const emailSourceQueueIdentity = sqs.Queue.fromQueueArn(
      this,
      'EmailRedriveSourceQueue',
      this.formatArn({
        resource: EXPLORATION_SMOKE_EMAIL_QUEUE_NAME,
        service: 'sqs',
      }),
    );
    const emailDeadLetterQueue = new sqs.Queue(this, 'EmailDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      queueName: EXPLORATION_SMOKE_EMAIL_DEAD_LETTER_QUEUE_NAME,
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
      queueName: EXPLORATION_SMOKE_EMAIL_QUEUE_NAME,
      removalPolicy: RemovalPolicy.RETAIN,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.seconds(60),
    });
    const emailWorkerLogGroup = new logs.LogGroup(this, 'EmailWorkerLogGroup', {
      logGroupName: EXPLORATION_SMOKE_EMAIL_WORKER_LOG_GROUP_NAME,
      removalPolicy: RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.TWO_WEEKS,
    });
    const emailWorkerRole = new iam.Role(this, 'EmailWorkerRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description:
        'Dark live-pilot email worker; consumes only its queue and has no SES send authority.',
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

    const emailConfigurationSetArn = `arn:aws:ses:${EXPLORATION_SMOKE_REGION}:${EXPLORATION_SMOKE_ACCOUNT}:configuration-set/${SES_CONFIGURATION_SET_NAME}`;
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
            'AWS:SourceAccount': EXPLORATION_SMOKE_ACCOUNT,
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
          sendingEnabled: false,
        },
      },
    );
    emailConfigurationSet.applyRemovalPolicy(RemovalPolicy.RETAIN);
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
            'AWS:SourceAccount': EXPLORATION_SMOKE_ACCOUNT,
            'AWS:SourceArn': emailConfigurationSetArn,
          },
        },
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        resources: [emailEventsTopic.topicArn],
        sid: 'AllowSesConfigurationSetEvents',
      }),
    );

    const googleOauthSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'GoogleOauthSecret',
      googleOauthSecretArn.valueAsString,
    );
    const appRunnerVpcConnector = new apprunner.CfnVpcConnector(
      this,
      'AppRunnerVpcConnector',
      {
        securityGroups: [applicationSecurityGroup.securityGroupId],
        subnets: applicationSubnets.subnetIds,
        vpcConnectorName: 'psd-eoc-exploration-smoke-native',
      },
    );
    // App Runner replaces a VPC connector when its tags change, but rejects a
    // replacement with the same subnet/security-group combination as the live
    // connector. Keep this immutable bridge on its original tags while the
    // rest of the stack carries the live-pilot classification.
    Tags.of(appRunnerVpcConnector).add(
      'Application',
      'PSD EOC Exploration Smoke',
      { priority: 300 },
    );
    Tags.of(appRunnerVpcConnector).add('DataClassification', 'synthetic-only', {
      priority: 300,
    });
    Tags.of(appRunnerVpcConnector).add('Environment', 'exploration-smoke', {
      priority: 300,
    });
    Tags.of(appRunnerVpcConnector).remove('DataScope', { priority: 300 });

    const bootstrapLogGroup = new logs.LogGroup(this, 'BootstrapLogGroup', {
      logGroupName: EXPLORATION_SMOKE_BOOTSTRAP_LOG_GROUP_NAME,
      removalPolicy: RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.TWO_WEEKS,
    });
    const bootstrapCluster = new ecs.Cluster(this, 'BootstrapEcsCluster', {
      clusterName: 'psd-eoc-exploration-smoke-native-bootstrap',
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
        family: 'psd-eoc-exploration-smoke-native-bootstrap',
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
          'bun',
          'packages/server/scripts/exploration-smoke/bootstrap.ts',
        ],
        environment: {
          AWS_ACCOUNT_ID: EXPLORATION_SMOKE_ACCOUNT,
          AWS_REGION: EXPLORATION_SMOKE_REGION,
          DATABASE_DRIVER: 'postgres',
          DATABASE_HOST: database.clusterEndpoint.hostname,
          DATABASE_IDLE_TIMEOUT_SECONDS: '20',
          DATABASE_MAX_CONNECTIONS: '1',
          DATABASE_NAME: EXPLORATION_SMOKE_DATABASE_NAME,
          DATABASE_PORT: String(EXPLORATION_SMOKE_DATABASE_PORT),
          DATABASE_SSL_ROOT_CERT: EXPLORATION_SMOKE_DATABASE_SSL_ROOT_CERT,
          DATABASE_CONNECT_TIMEOUT_SECONDS: '10',
          SOURCE_SHA: bootstrapSourceSha.valueAsString,
          TMPDIR: '/tmp',
        },
        essential: true,
        image: ecs.ContainerImage.fromRegistry(
          Fn.join('', [
            imageRepository.repositoryUri,
            '@',
            bootstrapImageDigest.valueAsString,
          ]),
        ),
        logging: ecs.LogDrivers.awsLogs({
          logGroup: bootstrapLogGroup,
          streamPrefix: BOOTSTRAP_CONTAINER_NAME,
        }),
        readonlyRootFilesystem: true,
        secrets: {
          APPROVED_GOOGLE_SUBJECT: ecsSecretJsonKey(
            bootstrapIdentitySecret,
            'googleSubject',
          ),
          APPROVED_STAFF_DISPLAY_NAME: ecsSecretJsonKey(
            bootstrapIdentitySecret,
            'staffDisplayName',
          ),
          APPROVED_STAFF_EMAIL: ecsSecretJsonKey(
            bootstrapIdentitySecret,
            'staffEmail',
          ),
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
        },
      },
    );
    bootstrapContainer.addMountPoints({
      containerPath: '/tmp',
      readOnly: false,
      sourceVolume: 'native-bootstrap-tmp',
    });
    imageRepository.grantPull(bootstrapTaskExecutionRole);
    databaseAdminSecret.grantRead(bootstrapTaskExecutionRole);
    databaseApplicationSecret.grantRead(bootstrapTaskExecutionRole);
    bootstrapIdentitySecret.grantRead(bootstrapTaskExecutionRole);

    const imageAccessRole = new iam.Role(this, 'AppRunnerImageAccessRole', {
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
      description:
        'Reads only the digest-pinned exploration server image from its isolated ECR repository.',
    });
    const imagePullGrant = imageRepository.grantPull(imageAccessRole);

    const runtimeRole = new iam.Role(this, 'AppRunnerRuntimeRole', {
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
      description:
        'Least-privilege live-pilot runtime; it has no notification-provider authority.',
    });
    const runtimeGrants = [
      databaseApplicationSecret.grantRead(runtimeRole),
      bootstrapIdentitySecret.grantRead(runtimeRole),
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
        networkConfiguration: {
          egressConfiguration: {
            egressType: 'VPC',
            vpcConnectorArn: appRunnerVpcConnector.attrVpcConnectorArn,
          },
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
                  name: 'PSD_EOC_BOOTSTRAP_ADMIN_SUBJECTS',
                  value: secretJsonKeyArn(
                    bootstrapIdentitySecret,
                    'googleSubject',
                  ),
                },
              ],
              runtimeEnvironmentVariables: [
                {
                  name: 'AWS_REGION',
                  value: EXPLORATION_SMOKE_REGION,
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
                  value: String(EXPLORATION_SMOKE_DATABASE_PORT),
                },
                {
                  name: 'DATABASE_NAME',
                  value: EXPLORATION_SMOKE_DATABASE_NAME,
                },
                {
                  name: 'DATABASE_SSL_ROOT_CERT',
                  value: EXPLORATION_SMOKE_DATABASE_SSL_ROOT_CERT,
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
                  name: 'FANOUT_QUEUE_URL',
                  value: healthQueue.queueUrl,
                },
                {
                  name: 'NODE_ENV',
                  value: 'production',
                },
                {
                  name: 'PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE',
                  value: EXPLORATION_SMOKE_SES_VERIFICATION_REFERENCE,
                },
                {
                  name: 'RUNTIME_SECRET_ARN',
                  value: apiSaltSecret.secretArn,
                },
                {
                  name: 'SOURCE_SHA',
                  value: sourceSha.valueAsString,
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
    // App Runner replaces a service when its tags change. Keep the existing
    // service's immutable legacy tags while its reviewed runtime configuration
    // and every non-service dark resource carry the live-pilot classification.
    Tags.of(appRunnerService).add('Application', 'PSD EOC Exploration Smoke', {
      priority: 300,
    });
    Tags.of(appRunnerService).add('DataClassification', 'synthetic-only', {
      priority: 300,
    });
    Tags.of(appRunnerService).add('Environment', 'exploration-smoke', {
      priority: 300,
    });
    Tags.of(appRunnerService).remove('DataScope', { priority: 300 });
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
    new CfnOutput(this, 'BootstrapCandidateImageDigest', {
      value: bootstrapImageDigest.valueAsString,
    });
    new CfnOutput(this, 'DeployedAppImageDigest', {
      value: appImageDigest.valueAsString,
    });
    new CfnOutput(this, 'BootstrapCandidateSourceSha', {
      value: bootstrapSourceSha.valueAsString,
    });
    new CfnOutput(this, 'DeployedAppSourceSha', {
      value: sourceSha.valueAsString,
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
    new CfnOutput(this, 'EmailWorkerRoleArn', {
      value: emailWorkerRole.roleArn,
    });
    new CfnOutput(this, 'EmailWorkerLogGroupName', {
      value: emailWorkerLogGroup.logGroupName,
    });
    new CfnOutput(this, 'SesIdentityArn', {
      value: `arn:aws:ses:${EXPLORATION_SMOKE_REGION}:${EXPLORATION_SMOKE_ACCOUNT}:identity/${EXPLORATION_SMOKE_SES_IDENTITY_DOMAIN}`,
    });
    new CfnOutput(this, 'SesIdentityDomain', {
      value: EXPLORATION_SMOKE_SES_IDENTITY_DOMAIN,
    });
    new CfnOutput(this, 'SesFromAddress', {
      value: EXPLORATION_SMOKE_SES_FROM_ADDRESS,
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
      value: 'external-readback',
    });
    new CfnOutput(this, 'SesIntegrationTruth', {
      value: 'configured-unverified',
    });
    new CfnOutput(this, 'EmailChannelState', {
      value: 'disabled',
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
