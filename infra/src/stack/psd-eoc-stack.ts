import { fileURLToPath } from 'node:url';

import {
  Arn,
  ArnFormat,
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
  aws_events as events,
  aws_events_targets as eventTargets,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_lambda_event_sources as lambdaEventSources,
  aws_logs as logs,
  aws_rds as rds,
  aws_secretsmanager as secretsmanager,
  aws_ses as ses,
  aws_sns as sns,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { RegionInfo } from 'aws-cdk-lib/region-info';
import type { Construct } from 'constructs';

import {
  SES_CONFIGURATION_SET_NAME,
  SES_EVENT_DESTINATION_NAME,
  SES_EVENT_TOPIC_NAME,
} from '../config';
import {
  configureFailureDrillMonitoring,
  configureInfrastructureMonitoring,
} from '../monitoring';
import {
  DATABASE_PORT,
  DATABASE_SSL_ROOT_CERT,
  DELIVERY_QUEUE_MAX_RECEIVES,
  HEALTH_PATH,
  IMAGE_DIGEST_SENTINEL,
  PRODUCTION_DEPLOYMENT_PROFILE,
  SES_VERIFICATION_REFERENCE,
  readDeploymentIdentity,
  readFacilityContext,
  readNeighborhoodContext,
  readSyntheticGroupContext,
  stackResourceConfiguration,
} from './config';
import type { DeploymentProfile, DeploymentTarget } from './config';

const APP_RUNNER_PORT = '3000';
const APPLICATION_SUBNET_GROUP_NAME = 'Application';
const BOOTSTRAP_CONTAINER_NAME = 'native-bootstrap';
const ACCESS_SYNC_CONTAINER_NAME = 'access-membership-sync';
const EMAIL_QUEUE_MAX_RECEIVES = 5;

export interface PsdEocStackProps extends StackProps {
  /** Cloud/provider identity read from deployment configuration. */
  readonly deploymentTarget: DeploymentTarget;
  /** Synth-time profile. Production remains the default for compatibility. */
  readonly deploymentProfile?: DeploymentProfile;
  /**
   * Tenant configuration for a disposable drill. This deliberately bypasses
   * CDK CLI context, which can contain the production tenant's values.
   */
  readonly failureDrillContext?: {
    tryGetContext(key: string): unknown;
  };
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
 * The first deployment sets ProvisionApplication=false so CloudFormation can
 * create the ECR repository. After the reviewed image is pushed by digest and
 * the database is bootstrapped, an update with ProvisionApplication=true adds
 * the single App Runner service. The same stack owns both phases.
 */
export class PsdEocStack extends Stack {
  public constructor(scope: Construct, id: string, props: PsdEocStackProps) {
    super(scope, id, props);
    const deploymentProfile =
      props.deploymentProfile ?? PRODUCTION_DEPLOYMENT_PROFILE;
    const failureDrill = deploymentProfile.kind === 'failure-drill';
    if (failureDrill !== (props.failureDrillContext !== undefined)) {
      throw new Error(
        failureDrill
          ? 'A failure-drill stack requires an explicit synthetic tenant context.'
          : 'A synthetic tenant context may only be used by a failure-drill stack.',
      );
    }
    const deploymentContext = props.failureDrillContext ?? this.node;
    const resourceConfiguration = stackResourceConfiguration(deploymentProfile);
    const stateRemovalPolicy = failureDrill
      ? RemovalPolicy.DESTROY
      : RemovalPolicy.RETAIN;
    const deploymentIdentity = readDeploymentIdentity(deploymentContext);
    const facilityContext = readFacilityContext(deploymentContext);
    const neighborhoodContext = readNeighborhoodContext(deploymentContext);
    const syntheticGroupContext = readSyntheticGroupContext(deploymentContext);
    const {
      account,
      accountAlias,
      monitoringRunbookBaseUrl,
      region,
      sesFromAddress,
      sesIdentityDomain,
    } = props.deploymentTarget;
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

    Tags.of(this).add('Application', resourceConfiguration.applicationLabel);
    Tags.of(this).add(
      'DataClassification',
      resourceConfiguration.dataClassification,
    );
    Tags.of(this).add('Environment', resourceConfiguration.environmentName);
    Tags.of(this).add(
      'DataScope',
      failureDrill ? 'synthetic-only' : 'staff-minimized',
    );
    if (failureDrill) {
      Tags.of(this).add('FailureDrillRunId', deploymentProfile.runId);
      Tags.of(this).add('ProviderMode', 'mocked');
    }
    if (!failureDrill) {
      Tags.of(this).add('ExpectedAwsAccountAlias', accountAlias);
    }
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
      default: IMAGE_DIGEST_SENTINEL,
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
    const googleOauthSecretArn = failureDrill
      ? undefined
      : new CfnParameter(this, 'GoogleOauthSecretArn', {
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
        });
    const googleGroupsSecretArn = failureDrill
      ? undefined
      : new CfnParameter(this, 'GoogleGroupsSecretArn', {
          allowedPattern: `^arn:${partition}:secretsmanager:${region}:${account}:secret:/psd-eoc/google-groups-[A-Za-z0-9]{6}$`,
          constraintDescription:
            'Use the complete ARN of the reviewed /psd-eoc/google-groups secret in the approved account and region.',
          description:
            'Complete ARN of the Cloud Identity roster-reader credential. The complete ARN is required: importing this secret by name yields an ARN without the generated suffix, which the read grant can never match.',
          noEcho: true,
          type: 'String',
        });
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
    const failureDrillOperatorToken = failureDrill
      ? new CfnParameter(this, 'FailureDrillOperatorToken', {
          allowedPattern: '^[A-Za-z0-9_-]{43,128}$',
          constraintDescription:
            'Use an ephemeral high-entropy base64url token generated for this exact drill run.',
          description:
            'One-run credential for issuing a synthetic browser session inside the failure-drill artifact.',
          maxLength: 128,
          minLength: 43,
          noEcho: true,
          type: 'String',
        })
      : undefined;
    const failureDrillApplicationOrigin = failureDrill
      ? new CfnParameter(this, 'FailureDrillApplicationOrigin', {
          allowedPattern: `^https://(?:${deploymentProfile.runId}\\.example\\.invalid|[a-z0-9][a-z0-9-]{0,62}\\.${region}\\.awsapprunner\\.com)$`,
          constraintDescription:
            "Use this run's inert bootstrap origin or the exact regional App Runner origin created by this stack.",
          description:
            'Two-phase drill origin. The workflow replaces the inert bootstrap value with the exact generated App Runner URL before any operator route is usable.',
          type: 'String',
        })
      : undefined;
    const failureDrillOperatorRoleName = failureDrill
      ? new CfnParameter(this, 'FailureDrillOperatorRoleName', {
          allowedPattern: '^[A-Za-z0-9+=,.@_-]{1,64}$',
          constraintDescription:
            'Use the exact pre-existing GitHub OIDC deployment role name.',
          description:
            'Role that receives one-stack ECS execution and evidence-read authority until cleanup.',
          type: 'String',
        })
      : undefined;
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
              IMAGE_DIGEST_SENTINEL,
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
              IMAGE_DIGEST_SENTINEL,
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
      emptyOnDelete: failureDrill,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: stateRemovalPolicy,
      repositoryName: resourceConfiguration.imageRepositoryName,
    });
    imageRepository.addLifecycleRule({
      description: failureDrill
        ? 'Remove superseded one-run drill artifacts.'
        : 'Bound superseded live-pilot image retention.',
      maxImageCount: failureDrill ? 2 : 10,
      rulePriority: 1,
    });

    const network = new ec2.Vpc(this, 'DatabaseNetwork', {
      availabilityZones: [`${region}a`, `${region}b`],
      ipAddresses: ec2.IpAddresses.cidr('10.43.0.0/24'),
      natGateways: failureDrill ? 0 : 1,
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
        ...(failureDrill
          ? []
          : [
              {
                cidrMask: 28,
                name: 'Public',
                subnetType: ec2.SubnetType.PUBLIC,
              },
            ]),
        {
          cidrMask: failureDrill ? 27 : 28,
          name: APPLICATION_SUBNET_GROUP_NAME,
          subnetType: failureDrill
            ? ec2.SubnetType.PRIVATE_ISOLATED
            : ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });
    const applicationSubnets = network.selectSubnets({
      subnetGroupName: APPLICATION_SUBNET_GROUP_NAME,
    });
    if (failureDrill) {
      const endpointSecurityGroup = new ec2.SecurityGroup(
        this,
        'FailureDrillEndpointSecurityGroup',
        {
          allowAllOutbound: false,
          description:
            'Accepts HTTPS only inside the disposable drill VPC for private AWS service endpoints.',
          vpc: network as unknown as ec2.IVpc,
        },
      );
      endpointSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(network.vpcCidrBlock),
        ec2.Port.tcp(443),
        'Private HTTPS from synthetic application and worker subnets only.',
      );
      network.addGatewayEndpoint('FailureDrillS3Endpoint', {
        service: ec2.GatewayVpcEndpointAwsService.S3,
        subnets: [{ subnetGroupName: APPLICATION_SUBNET_GROUP_NAME }],
      });
      for (const [id, service] of [
        ['CloudWatchLogs', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
        [
          'CloudWatchMonitoring',
          ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING,
        ],
        ['EcrApi', ec2.InterfaceVpcEndpointAwsService.ECR],
        ['EcrDocker', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
        ['Ecs', ec2.InterfaceVpcEndpointAwsService.ECS],
        ['Rds', ec2.InterfaceVpcEndpointAwsService.RDS],
        ['SecretsManager', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
        ['Sqs', ec2.InterfaceVpcEndpointAwsService.SQS],
      ] as const) {
        network.addInterfaceEndpoint(`FailureDrill${id}Endpoint`, {
          privateDnsEnabled: true,
          securityGroups: [endpointSecurityGroup],
          service,
          subnets: { subnetGroupName: APPLICATION_SUBNET_GROUP_NAME },
        });
      }
    }

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
        removalPolicy: stateRemovalPolicy,
        secretName: `${resourceConfiguration.secretPrefix}/database/admin`,
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
        removalPolicy: stateRemovalPolicy,
        secretName: `${resourceConfiguration.secretPrefix}/database/application`,
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
        removalPolicy: stateRemovalPolicy,
        secretName: `${resourceConfiguration.secretPrefix}/google-oidc-cookie-secret`,
      },
    );
    const apiSaltSecret = new secretsmanager.Secret(this, 'ApiSaltSecret', {
      description:
        'Generated application-only salt for API credential hashing.',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 64,
      },
      removalPolicy: stateRemovalPolicy,
      secretName: `${resourceConfiguration.secretPrefix}/api-salt`,
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
        removalPolicy: stateRemovalPolicy,
        secretName: `${resourceConfiguration.secretPrefix}/workers/delivery-state-token`,
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
        removalPolicy: stateRemovalPolicy,
        secretName: `${resourceConfiguration.secretPrefix}/workers/attempt-execution-token`,
      },
    );

    const bootstrapIdentitySecret = new secretsmanager.Secret(
      this,
      'BootstrapIdentitySecret',
      {
        description:
          'Bootstrap identity material supplied through NoEcho deployment parameters. Holds only the initial mobile transition digest; the approved-staff identity it also carried fed the access fixture, which is gone.',
        removalPolicy: stateRemovalPolicy,
        secretName: `${resourceConfiguration.secretPrefix}/bootstrap/approved-identity`,
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
        removalPolicy: stateRemovalPolicy,
        secretName: `${resourceConfiguration.secretPrefix}/bootstrap/initial-access-group`,
        secretObjectValue: {
          email: SecretValue.unsafePlainText(
            initialAccessGroupEmail.valueAsString,
          ),
        },
      },
    );
    const failureDrillOperatorSecret = failureDrill
      ? new secretsmanager.Secret(this, 'FailureDrillOperatorSecret', {
          description:
            'Ephemeral one-run credential for synthetic failure-drill browser setup.',
          removalPolicy: stateRemovalPolicy,
          secretName: `${resourceConfiguration.secretPrefix}/operator-token`,
          secretStringValue: SecretValue.unsafePlainText(
            failureDrillOperatorToken!.valueAsString,
          ),
        })
      : undefined;

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
        securityGroupName: resourceConfiguration.applicationSecurityGroupName,
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
      failureDrill
        ? 'HTTPS to private AWS service endpoints; the subnet has no internet route.'
        : 'HTTPS through the NAT gateway for Google OAuth and AWS task dependencies.',
    );
    databaseSecurityGroup.addIngressRule(
      applicationSecurityGroup,
      ec2.Port.tcp(DATABASE_PORT),
      'Native PostgreSQL only from the application/bootstrap security group.',
    );

    const database = new rds.DatabaseCluster(this, 'Database', {
      backup: { retention: Duration.days(failureDrill ? 1 : 14) },
      clusterIdentifier: resourceConfiguration.databaseIdentifier,
      copyTagsToSnapshot: true,
      credentials: rds.Credentials.fromSecret(
        databaseAdminSecret as unknown as secretsmanager.ISecret,
      ),
      defaultDatabaseName: resourceConfiguration.databaseName,
      deletionProtection: !failureDrill,
      enableDataApi: false,
      engine: databaseEngine,
      parameterGroup: databaseParameterGroup,
      readers: failureDrill
        ? [
            rds.ClusterInstance.serverlessV2('FailureDrillReader', {
              autoMinorVersionUpgrade: true,
              availabilityZone: `${region}b`,
              enablePerformanceInsights: false,
              publiclyAccessible: false,
              scaleWithWriter: true,
            }),
          ]
        : [],
      // Retain staff-minimized access and append-only event truth. Any future
      // retirement is a separately reviewed human data-lifecycle decision.
      removalPolicy: stateRemovalPolicy,
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
        availabilityZone: `${region}a`,
        enablePerformanceInsights: false,
        publiclyAccessible: false,
      }),
    });

    const healthQueue = new sqs.Queue(this, 'HealthQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      queueName: resourceConfiguration.healthQueueName,
      removalPolicy: stateRemovalPolicy,
      retentionPeriod: Duration.days(1),
      visibilityTimeout: Duration.seconds(30),
    });

    const emailSourceQueueIdentity = sqs.Queue.fromQueueArn(
      this,
      'EmailRedriveSourceQueue',
      this.formatArn({
        resource: resourceConfiguration.emailQueueName,
        service: 'sqs',
      }),
    );
    const emailDeadLetterQueue = new sqs.Queue(this, 'EmailDeadLetterQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      queueName: resourceConfiguration.emailDeadLetterQueueName,
      redriveAllowPolicy: {
        redrivePermission: sqs.RedrivePermission.BY_QUEUE,
        sourceQueues: [emailSourceQueueIdentity],
      },
      removalPolicy: stateRemovalPolicy,
      retentionPeriod: Duration.days(14),
    });
    const emailQueue = new sqs.Queue(this, 'EmailQueue', {
      deadLetterQueue: {
        maxReceiveCount: EMAIL_QUEUE_MAX_RECEIVES,
        queue: emailDeadLetterQueue,
      },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      queueName: resourceConfiguration.emailQueueName,
      removalPolicy: stateRemovalPolicy,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.seconds(60),
    });
    const failureDrillMockProviderQueue = failureDrill
      ? new sqs.Queue(this, 'FailureDrillMockProviderQueue', {
          contentBasedDeduplication: false,
          encryption: sqs.QueueEncryption.SQS_MANAGED,
          enforceSSL: true,
          fifo: true,
          queueName: `${resourceConfiguration.prefix}-mock-provider.fifo`,
          removalPolicy: stateRemovalPolicy,
          retentionPeriod: Duration.days(1),
          visibilityTimeout: Duration.seconds(60),
        })
      : undefined;
    // One queue pair per channel, plus the delivery queue an authorized
    // notification batch lands on before it is split across channels. Email's
    // pair predates these and is defined above; the rest are built the same way
    // so the alarms, runbooks, and redrive permissions line up across channels.
    const channelQueuePairs = (
      [
        [
          'Delivery',
          resourceConfiguration.deliveryQueueName,
          resourceConfiguration.deliveryDeadLetterQueueName,
        ],
        [
          'Sms',
          resourceConfiguration.smsQueueName,
          resourceConfiguration.smsDeadLetterQueueName,
        ],
        [
          'Push',
          resourceConfiguration.pushQueueName,
          resourceConfiguration.pushDeadLetterQueueName,
        ],
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
        removalPolicy: stateRemovalPolicy,
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
        removalPolicy: stateRemovalPolicy,
        retentionPeriod: Duration.days(4),
        visibilityTimeout: Duration.seconds(60),
      });
      return [id, { deadLetterQueue, queue }] as const;
    });
    const queuePairs = Object.fromEntries(channelQueuePairs) as Record<
      'Delivery' | 'Sms' | 'Push',
      { deadLetterQueue: sqs.Queue; queue: sqs.Queue }
    >;
    const deliveryQueue = queuePairs.Delivery.queue;

    // Alarm routing. The operations key encrypts both topics so CloudWatch can
    // publish to them without the topics being world-writable, and the two
    // topics separate "look at this soon" from "wake somebody up".
    const operationsKey = new kms.Key(this, 'OperationsKey', {
      description: 'Encrypts PSD EOC operational alarm notifications.',
      enableKeyRotation: true,
      removalPolicy: stateRemovalPolicy,
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
      displayName: `${resourceConfiguration.applicationLabel} operations`,
      topicName: resourceConfiguration.operationsAlarmTopicName,
    });
    const criticalAlarmTopic = new sns.Topic(this, 'CriticalAlarmTopic', {
      displayName: `${resourceConfiguration.applicationLabel} critical`,
      topicName: resourceConfiguration.criticalAlarmTopicName,
    });

    // The delivery queue's consumer. It moves each authorized batch to the
    // queue for its channel and does nothing else — no database, no provider,
    // no VPC, and no authority to change what it forwards.
    const deliveryRouterLogGroup = new logs.LogGroup(
      this,
      'DeliveryRouterLogGroup',
      {
        logGroupName: resourceConfiguration.deliveryRouterLogGroupName,
        removalPolicy: stateRemovalPolicy,
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
      functionName: resourceConfiguration.deliveryRouterFunctionName,
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
      logGroupName: resourceConfiguration.emailWorkerLogGroupName,
      removalPolicy: stateRemovalPolicy,
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

    let emailConfigurationSet: ses.CfnConfigurationSet | undefined;
    let emailEventsKey: kms.Key | undefined;
    let emailEventsTopic: sns.Topic | undefined;
    if (!failureDrill) {
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
      emailEventsKey = new kms.Key(this, 'EmailEventsKey', {
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
      emailConfigurationSet = new ses.CfnConfigurationSet(
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
      emailEventsTopic = new sns.Topic(this, 'EmailEventsTopic', {
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
    }

    const googleOauthSecret = (failureDrill
      ? new secretsmanager.Secret(this, 'GoogleOauthSecret', {
          description:
            'Generated unroutable OAuth fixture for this synthetic drill only.',
          generateSecretString: {
            excludePunctuation: true,
            generateStringKey: 'clientSecret',
            passwordLength: 64,
            secretStringTemplate: JSON.stringify({
              clientId: '100000000000-syntheticweb.apps.googleusercontent.com',
              iosBundleId: deploymentIdentity.iosBundleId,
              iosClientId:
                '100000000000-syntheticios.apps.googleusercontent.com',
              webClientId:
                '100000000000-syntheticweb.apps.googleusercontent.com',
            }),
          },
          removalPolicy: stateRemovalPolicy,
          secretName: `${resourceConfiguration.secretPrefix}/google-oauth-mock`,
        })
      : secretsmanager.Secret.fromSecretCompleteArn(
          this,
          'GoogleOauthSecret',
          googleOauthSecretArn!.valueAsString,
        )) as unknown as secretsmanager.ISecret;
    const googleGroupsSecret = (failureDrill
      ? new secretsmanager.Secret(this, 'GoogleGroupsSecret', {
          description:
            'Generated inert roster fixture marker for this synthetic drill only.',
          generateSecretString: {
            excludePunctuation: true,
            generateStringKey: 'privateKey',
            passwordLength: 64,
            secretStringTemplate: JSON.stringify({
              clientEmail: 'roster@example.invalid',
              delegatedAdminEmail: 'operator@example.invalid',
              groupEmails: ['staff@example.invalid'],
              mode: 'mocked',
            }),
          },
          removalPolicy: stateRemovalPolicy,
          secretName: `${resourceConfiguration.secretPrefix}/google-groups-mock`,
        })
      : secretsmanager.Secret.fromSecretCompleteArn(
          this,
          'GoogleGroupsSecret',
          googleGroupsSecretArn!.valueAsString,
        )) as unknown as secretsmanager.ISecret;
    // Import by complete ARN, never by name. fromSecretNameV2 yields a
    // secretArn without the generated six-character suffix; the ECS secret
    // reference then requests that suffix-less ARN while grantRead authorizes
    // `<arn>-??????`. The two can never match, and the task fails to start
    // with a ResourceInitializationError that names no cause. See issue #271.
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
        securityGroupName: resourceConfiguration.appRunnerSecurityGroupName,
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
      failureDrill
        ? 'HTTPS to private AWS service endpoints; the subnet has no internet route.'
        : 'HTTPS through the NAT gateway for Google OAuth and AWS dependencies.',
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
        vpcConnectorName: resourceConfiguration.appRunnerVpcConnectorName,
      },
    );
    // Editable at last: the connector's replacement no longer collides with the
    // live one now that it carries its own security group.
    Tags.of(appRunnerVpcConnector).add(
      'Application',
      failureDrill ? resourceConfiguration.applicationLabel : 'PSD EOC',
      {
        priority: 300,
      },
    );
    Tags.of(appRunnerVpcConnector).add('DataClassification', 'synthetic-only', {
      priority: 300,
    });
    Tags.of(appRunnerVpcConnector).add(
      'Environment',
      failureDrill ? resourceConfiguration.environmentName : 'production',
      { priority: 300 },
    );
    Tags.of(appRunnerVpcConnector).remove('DataScope', { priority: 300 });

    const bootstrapLogGroup = new logs.LogGroup(this, 'BootstrapLogGroup', {
      logGroupName: resourceConfiguration.bootstrapLogGroupName,
      removalPolicy: stateRemovalPolicy,
      retention: logs.RetentionDays.TWO_WEEKS,
    });
    const bootstrapCluster = new ecs.Cluster(this, 'BootstrapEcsCluster', {
      clusterName: resourceConfiguration.bootstrapClusterName,
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
        family: resourceConfiguration.bootstrapFamily,
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
        command: ['bun', 'packages/server/scripts/operations/bootstrap.ts'],
        environment: {
          AWS_ACCOUNT_ID: account,
          AWS_REGION: region,
          DATABASE_DRIVER: 'postgres',
          DATABASE_HOST: database.clusterEndpoint.hostname,
          DATABASE_IDLE_TIMEOUT_SECONDS: '20',
          DATABASE_MAX_CONNECTIONS: '1',
          DATABASE_NAME: resourceConfiguration.databaseName,
          DATABASE_PORT: String(DATABASE_PORT),
          DATABASE_SSL_ROOT_CERT: DATABASE_SSL_ROOT_CERT,
          DATABASE_CONNECT_TIMEOUT_SECONDS: '10',
          PSD_EOC_FACILITIES: facilityContext,
          PSD_EOC_NEIGHBORHOODS: neighborhoodContext,
          PSD_EOC_SYNTHETIC_GROUPS: syntheticGroupContext,
          PSD_EOC_INITIAL_ACCESS_GROUP_ID: initialAccessGroupId.valueAsString,
          PSD_EOC_INITIAL_ACCESS_GROUP_NAME:
            initialAccessGroupName.valueAsString,
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
    imageRepository.grantPull(bootstrapTaskExecutionRole);
    databaseAdminSecret.grantRead(bootstrapTaskExecutionRole);
    databaseApplicationSecret.grantRead(bootstrapTaskExecutionRole);
    initialAccessGroupSecret.grantRead(bootstrapTaskExecutionRole);

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
        family: resourceConfiguration.accessSyncFamily,
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
          DATABASE_NAME: resourceConfiguration.databaseName,
          DATABASE_PORT: String(DATABASE_PORT),
          DATABASE_SSL_ROOT_CERT: DATABASE_SSL_ROOT_CERT,
          DATABASE_CONNECT_TIMEOUT_SECONDS: '10',
          // The sync resolves every member address against this district's
          // staff domain before admitting it, so the task cannot run without
          // it. It became required when the auth values moved to configuration
          // and was never added here, which broke every run from that deploy
          // onward: `GOOGLE_OIDC_HOSTED_DOMAIN must be configured.`
          GOOGLE_OIDC_HOSTED_DOMAIN: deploymentIdentity.hostedDomain,
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
    imageRepository.grantPull(accessSyncTaskExecutionRole);
    databaseApplicationSecret.grantRead(accessSyncTaskExecutionRole);
    bootstrapIdentitySecret.grantRead(accessSyncTaskExecutionRole);
    googleGroupsSecret.grantRead(accessSyncTaskExecutionRole);

    // Membership carries a freshness bound: sign-in refuses a group whose
    // membership has not been read inside MEMBERSHIP_FRESHNESS_MS, so that a
    // neglected deployment fails closed instead of running forever on a stale
    // answer. That bound is only safe if something actually refreshes it.
    //
    // Until now that something was a GitHub Actions workflow, and it declared
    // an environment gated on a named human reviewer. Every scheduled run
    // parked waiting for an approval a cron trigger cannot give and was
    // cancelled when the next one queued behind it. Membership aged toward the
    // bound with nothing refreshing it, which turned a safety property into the
    // outage it exists to prevent.
    //
    // EventBridge runs the same task, on the same interval, with no human in
    // the loop. The interval stays well inside the freshness bound so a single
    // failed run — or several — never denies anyone.
    const accessSyncSchedule = new events.Rule(this, 'AccessSyncSchedule', {
      description:
        'Refreshes access-group membership from Google Cloud Identity so sign-in keeps working; reads only, and publishes one complete snapshot or none.',
      enabled: !failureDrill,
      ruleName: resourceConfiguration.accessSyncRuleName,
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

    let failureDrillTaskDefinition: ecs.FargateTaskDefinition | undefined;
    let failureDrillLogGroup: logs.LogGroup | undefined;
    if (failureDrill) {
      failureDrillLogGroup = new logs.LogGroup(this, 'FailureDrillLogGroup', {
        logGroupName: resourceConfiguration.failureDrillLogGroupName,
        removalPolicy: stateRemovalPolicy,
        retention: logs.RetentionDays.ONE_WEEK,
      });
      const failureDrillTaskExecutionRole = new iam.Role(
        this,
        'FailureDrillTaskExecutionRole',
        {
          assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
          description:
            'Pulls the one-run drill artifact, injects synthetic-stack credentials, and writes evidence logs.',
        },
      );
      const failureDrillTaskRole = new iam.Role(this, 'FailureDrillTaskRole', {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        description:
          'Fault authority restricted to this disposable synthetic stack.',
      });
      const failureDrillWorkerTaskExecutionRole = new iam.Role(
        this,
        'FailureDrillWorkerTaskExecutionRole',
        {
          assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
          description:
            'Pulls the one-run drill artifact and injects only the application database credential for a mock worker.',
        },
      );
      const failureDrillWorkerTaskRole = new iam.Role(
        this,
        'FailureDrillWorkerTaskRole',
        {
          assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
          description:
            'Writes only one-run mock-provider FIFO evidence; has no fault-orchestration authority.',
        },
      );
      const failureDrillWorkerTaskDefinition = new ecs.FargateTaskDefinition(
        this,
        'FailureDrillWorkerTaskDefinition',
        {
          cpu: 256,
          executionRole: failureDrillWorkerTaskExecutionRole,
          family: resourceConfiguration.failureDrillWorkerFamily,
          memoryLimitMiB: 512,
          runtimePlatform: {
            cpuArchitecture: ecs.CpuArchitecture.X86_64,
            operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
          },
          taskRole: failureDrillWorkerTaskRole,
        },
      );
      failureDrillWorkerTaskDefinition.addVolume({
        name: 'failure-drill-worker-tmp',
      });
      const failureDrillWorkerContainer =
        failureDrillWorkerTaskDefinition.addContainer('failure-drill-worker', {
          command: [
            'bun',
            'scripts/ops/failure-drills/deployed-mock-worker.ts',
          ],
          environment: {
            AWS_REGION: region,
            DATABASE_DRIVER: 'postgres',
            DATABASE_HOST: database.clusterEndpoint.hostname,
            DATABASE_NAME: resourceConfiguration.databaseName,
            DATABASE_PORT: String(DATABASE_PORT),
            DATABASE_SSL_ROOT_CERT: DATABASE_SSL_ROOT_CERT,
            GOOGLE_OIDC_HOSTED_DOMAIN: deploymentIdentity.hostedDomain,
            PSD_EOC_FAILURE_DRILL_DEPLOYMENT_CLASS: 'non-production',
            PSD_EOC_FAILURE_DRILL_MOCK_PROVIDER_QUEUE_URL:
              failureDrillMockProviderQueue!.queueUrl,
            PSD_EOC_FAILURE_DRILL_PROVIDER_MODE: 'mocked',
            PSD_EOC_FAILURE_DRILL_ROSTER_POPULATION: 'synthetic',
            PSD_EOC_FAILURE_DRILL_RUN_ID: deploymentProfile.runId,
            TMPDIR: '/tmp',
          },
          essential: true,
          image: ecs.ContainerImage.fromRegistry(
            Fn.join('', [
              imageRepository.repositoryUri,
              '@',
              appImageDigest.valueAsString,
            ]),
          ),
          logging: ecs.LogDrivers.awsLogs({
            logGroup: failureDrillLogGroup,
            streamPrefix: 'worker',
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
          },
        });
      failureDrillWorkerContainer.addMountPoints({
        containerPath: '/tmp',
        readOnly: false,
        sourceVolume: 'failure-drill-worker-tmp',
      });
      failureDrillTaskDefinition = new ecs.FargateTaskDefinition(
        this,
        'FailureDrillTaskDefinition',
        {
          cpu: 512,
          executionRole: failureDrillTaskExecutionRole,
          family: resourceConfiguration.failureDrillFamily,
          memoryLimitMiB: 1024,
          runtimePlatform: {
            cpuArchitecture: ecs.CpuArchitecture.X86_64,
            operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
          },
          taskRole: failureDrillTaskRole,
        },
      );
      failureDrillTaskDefinition.addVolume({ name: 'failure-drill-tmp' });
      const failureDrillContainer = failureDrillTaskDefinition.addContainer(
        'failure-drill-runner',
        {
          command: [
            'bun',
            'scripts/ops/failure-drills/failure-drill-runner.ts',
          ],
          environment: {
            AWS_ACCOUNT_ID: account,
            AWS_REGION: region,
            DATABASE_DRIVER: 'postgres',
            DATABASE_HOST: database.clusterEndpoint.hostname,
            DATABASE_NAME: resourceConfiguration.databaseName,
            DATABASE_PORT: String(DATABASE_PORT),
            DATABASE_SSL_ROOT_CERT: DATABASE_SSL_ROOT_CERT,
            DELIVERY_DEAD_LETTER_QUEUE_URL:
              queuePairs.Delivery.deadLetterQueue.queueUrl,
            DELIVERY_QUEUE_URL: deliveryQueue.queueUrl,
            EMAIL_DEAD_LETTER_QUEUE_URL: emailDeadLetterQueue.queueUrl,
            EMAIL_QUEUE_URL: emailQueue.queueUrl,
            GOOGLE_OIDC_APPLICATION_ORIGIN:
              failureDrillApplicationOrigin!.valueAsString,
            GOOGLE_OIDC_HOSTED_DOMAIN: deploymentIdentity.hostedDomain,
            PSD_EOC_FAILURE_DRILL_APP_ORIGIN:
              failureDrillApplicationOrigin!.valueAsString,
            PSD_EOC_FAILURE_DRILL_CLUSTER_ARN: bootstrapCluster.clusterArn,
            PSD_EOC_FAILURE_DRILL_CLUSTER_IDENTIFIER:
              resourceConfiguration.databaseIdentifier,
            PSD_EOC_FAILURE_DRILL_DEPLOYMENT_CLASS: 'non-production',
            PSD_EOC_FAILURE_DRILL_IMAGE_DIGEST: appImageDigest.valueAsString,
            PSD_EOC_FAILURE_DRILL_PROVIDER_MODE: 'mocked',
            PSD_EOC_FAILURE_DRILL_ROSTER_POPULATION: 'synthetic',
            PSD_EOC_FAILURE_DRILL_RUN_ID: deploymentProfile.runId,
            PSD_EOC_FAILURE_DRILL_SECURITY_GROUP_ID:
              applicationSecurityGroup.securityGroupId,
            PSD_EOC_FAILURE_DRILL_STACK_ID: this.stackId,
            PSD_EOC_FAILURE_DRILL_STACK_NAME: this.stackName,
            PSD_EOC_FAILURE_DRILL_SUBNET_IDS: Fn.join(
              ',',
              applicationSubnets.subnetIds,
            ),
            PSD_EOC_FAILURE_DRILL_MOCK_PROVIDER_QUEUE_URL:
              failureDrillMockProviderQueue!.queueUrl,
            PSD_EOC_FAILURE_DRILL_WORKER_TASK_DEFINITION:
              failureDrillWorkerTaskDefinition.taskDefinitionArn,
            PUSH_DEAD_LETTER_QUEUE_URL:
              queuePairs.Push.deadLetterQueue.queueUrl,
            PUSH_QUEUE_URL: queuePairs.Push.queue.queueUrl,
            SMS_DEAD_LETTER_QUEUE_URL: queuePairs.Sms.deadLetterQueue.queueUrl,
            SMS_QUEUE_URL: queuePairs.Sms.queue.queueUrl,
            SOURCE_SHA: sourceSha.valueAsString,
            TMPDIR: '/tmp',
          },
          essential: true,
          image: ecs.ContainerImage.fromRegistry(
            Fn.join('', [
              imageRepository.repositoryUri,
              '@',
              appImageDigest.valueAsString,
            ]),
          ),
          logging: ecs.LogDrivers.awsLogs({
            logGroup: failureDrillLogGroup,
            streamPrefix: 'runner',
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
            DATABASE_PASSWORD: ecsSecretJsonKey(
              databaseApplicationSecret,
              'password',
            ),
            DATABASE_USERNAME: ecsSecretJsonKey(
              databaseApplicationSecret,
              'username',
            ),
            PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN: ecs.Secret.fromSecretsManager(
              failureDrillOperatorSecret! as unknown as secretsmanager.ISecret,
            ),
          },
        },
      );
      failureDrillContainer.addMountPoints({
        containerPath: '/tmp',
        readOnly: false,
        sourceVolume: 'failure-drill-tmp',
      });
      imageRepository.grantPull(failureDrillTaskExecutionRole);
      imageRepository.grantPull(failureDrillWorkerTaskExecutionRole);
      databaseAdminSecret.grantRead(failureDrillTaskExecutionRole);
      databaseApplicationSecret.grantRead(failureDrillTaskExecutionRole);
      databaseApplicationSecret.grantRead(failureDrillWorkerTaskExecutionRole);
      failureDrillOperatorSecret!.grantRead(failureDrillTaskExecutionRole);
      iam.Grant.addToPrincipal({
        actions: ['sqs:SendMessage'],
        grantee: failureDrillWorkerTaskRole,
        resourceArns: [failureDrillMockProviderQueue!.queueArn],
      });
      iam.Grant.addToPrincipal({
        actions: [
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
          'sqs:ReceiveMessage',
          'sqs:StartMessageMoveTask',
        ],
        grantee: failureDrillTaskRole,
        resourceArns: [emailDeadLetterQueue.queueArn],
      });
      iam.Grant.addToPrincipal({
        actions: [
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
          'sqs:ReceiveMessage',
          'sqs:SendMessage',
        ],
        grantee: failureDrillTaskRole,
        resourceArns: [emailQueue.queueArn],
      });
      iam.Grant.addToPrincipal({
        actions: [
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
          'sqs:ReceiveMessage',
        ],
        grantee: failureDrillTaskRole,
        resourceArns: [failureDrillMockProviderQueue!.queueArn],
      });
      iam.Grant.addToPrincipal({
        actions: ['rds:FailoverDBCluster'],
        grantee: failureDrillTaskRole,
        resourceArns: [database.clusterArn],
      });
      failureDrillTaskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['rds:DescribeDBClusters'],
          resources: ['*'],
          sid: 'DescribeAuroraForExactSyntheticFailover',
        }),
      );
      failureDrillTaskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['cloudwatch:DescribeAlarms'],
          resources: ['*'],
          sid: 'ReadSyntheticAlarmState',
        }),
      );
      failureDrillTaskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['ecs:RunTask'],
          resources: [failureDrillWorkerTaskDefinition.taskDefinitionArn],
          conditions: {
            ArnEquals: { 'ecs:cluster': bootstrapCluster.clusterArn },
          },
          sid: 'RunExactSyntheticWorkerTasks',
        }),
      );
      const failureDrillTaskArn = Arn.format(
        {
          account,
          arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          partition,
          region,
          resource: 'task',
          resourceName: `${resourceConfiguration.bootstrapClusterName}/*`,
          service: 'ecs',
        },
        this,
      );
      failureDrillTaskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['ecs:DescribeTasks'],
          resources: [failureDrillTaskArn],
          conditions: {
            ArnEquals: { 'ecs:cluster': bootstrapCluster.clusterArn },
          },
          sid: 'ObserveExactSyntheticWorkerTasks',
        }),
      );
      failureDrillTaskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          conditions: {
            StringEquals: {
              'iam:PassedToService': 'ecs-tasks.amazonaws.com',
            },
          },
          resources: [
            failureDrillWorkerTaskExecutionRole.roleArn,
            failureDrillWorkerTaskRole.roleArn,
          ],
          sid: 'PassExactSyntheticWorkerRoles',
        }),
      );
      const operatorRole = iam.Role.fromRoleName(
        this,
        'FailureDrillOperatorRole',
        failureDrillOperatorRoleName!.valueAsString,
      );
      const operatorPolicy = new iam.Policy(
        this,
        'FailureDrillOperatorPolicy',
        {
          policyName: `${resourceConfiguration.prefix}-operator`,
          roles: [operatorRole],
          statements: [
            new iam.PolicyStatement({
              actions: [
                'ecr:BatchCheckLayerAvailability',
                'ecr:BatchGetImage',
                'ecr:CompleteLayerUpload',
                'ecr:DescribeImages',
                'ecr:DescribeRepositories',
                'ecr:InitiateLayerUpload',
                'ecr:PutImage',
                'ecr:UploadLayerPart',
              ],
              resources: [imageRepository.repositoryArn],
            }),
            new iam.PolicyStatement({
              actions: ['ecs:RunTask'],
              conditions: {
                ArnEquals: { 'ecs:cluster': bootstrapCluster.clusterArn },
              },
              resources: [
                bootstrapTaskDefinition.taskDefinitionArn,
                failureDrillTaskDefinition.taskDefinitionArn,
              ],
            }),
            new iam.PolicyStatement({
              actions: ['ecs:ListTasks'],
              conditions: {
                ArnEquals: { 'ecs:cluster': bootstrapCluster.clusterArn },
              },
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              actions: ['ecs:DescribeTasks', 'ecs:StopTask'],
              conditions: {
                ArnEquals: { 'ecs:cluster': bootstrapCluster.clusterArn },
              },
              resources: [failureDrillTaskArn],
            }),
            new iam.PolicyStatement({
              actions: ['iam:PassRole'],
              conditions: {
                StringEquals: {
                  'iam:PassedToService': 'ecs-tasks.amazonaws.com',
                },
              },
              resources: [
                bootstrapTaskExecutionRole.roleArn,
                bootstrapTaskRole.roleArn,
                failureDrillTaskExecutionRole.roleArn,
                failureDrillTaskRole.roleArn,
              ],
            }),
            new iam.PolicyStatement({
              actions: ['logs:FilterLogEvents', 'logs:GetLogEvents'],
              resources: [
                `${bootstrapLogGroup.logGroupArn}:*`,
                `${failureDrillLogGroup.logGroupArn}:*`,
              ],
            }),
          ],
        },
      );
      operatorPolicy.node.addDependency(failureDrillTaskDefinition);
    }

    const imageAccessRole = new iam.Role(this, 'AppRunnerImageAccessRole', {
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
      description:
        'Reads only the digest-pinned server image from its isolated ECR repository.',
    });
    const imagePullGrant = imageRepository.grantPull(imageAccessRole);

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
      apiSaltSecret.grantRead(runtimeRole),
      deliveryStateWorkerSecret.grantRead(runtimeRole),
      attemptExecutionWorkerSecret.grantRead(runtimeRole),
      ...(failureDrillOperatorSecret
        ? [failureDrillOperatorSecret.grantRead(runtimeRole)]
        : []),
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

    const appRunnerScaling = new apprunner.CfnAutoScalingConfiguration(
      this,
      'AppRunnerScaling',
      {
        autoScalingConfigurationName:
          resourceConfiguration.appRunnerScalingName,
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
        serviceName: resourceConfiguration.appRunnerServiceName,
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
                  name: 'PSD_EOC_DELIVERY_STATE_WORKER_TOKEN',
                  value: deliveryStateWorkerSecret.secretArn,
                },
                {
                  name: 'PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN',
                  value: attemptExecutionWorkerSecret.secretArn,
                },
                {
                  name: 'PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256',
                  value: secretJsonKeyArn(
                    bootstrapIdentitySecret,
                    'initialMobileTransitionEmailSha256',
                  ),
                },
                ...(failureDrillOperatorSecret
                  ? [
                      {
                        name: 'PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN',
                        value: failureDrillOperatorSecret.secretArn,
                      },
                    ]
                  : []),
              ],
              runtimeEnvironmentVariables: [
                {
                  name: 'AWS_REGION',
                  value: region,
                },
                // Who this deployment serves, from cdk.json context.
                {
                  name: 'GOOGLE_OIDC_APPLICATION_ORIGIN',
                  value:
                    failureDrillApplicationOrigin?.valueAsString ??
                    deploymentIdentity.applicationOrigin,
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
                  name: 'PSD_EOC_DISPLAY_TIME_ZONE',
                  value: deploymentIdentity.displayTimeZone,
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
                  value: resourceConfiguration.databaseName,
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
                  value: SES_VERIFICATION_REFERENCE,
                },
                {
                  name: 'RUNTIME_SECRET_ARN',
                  value: apiSaltSecret.secretArn,
                },
                {
                  name: 'SOURCE_SHA',
                  value: sourceSha.valueAsString,
                },
                ...(failureDrill
                  ? [
                      {
                        name: 'AWS_ACCOUNT_ID',
                        value: account,
                      },
                      {
                        name: 'PSD_EOC_FAILURE_DRILL_DEPLOYMENT_CLASS',
                        value: 'non-production',
                      },
                      {
                        name: 'PSD_EOC_FAILURE_DRILL_PROVIDER_MODE',
                        value: 'mocked',
                      },
                      {
                        name: 'PSD_EOC_FAILURE_DRILL_ROSTER_POPULATION',
                        value: 'synthetic',
                      },
                      {
                        name: 'PSD_EOC_FAILURE_DRILL_RUN_ID',
                        value: deploymentProfile.runId,
                      },
                    ]
                  : []),
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
    // Same constraint as the VPC connector above: App Runner replaces the
    // service when its tags change, so this was retired in the same outage.
    Tags.of(appRunnerService).add(
      'Application',
      failureDrill ? resourceConfiguration.applicationLabel : 'PSD EOC',
      { priority: 300 },
    );
    Tags.of(appRunnerService).add('DataClassification', 'synthetic-only', {
      priority: 300,
    });
    Tags.of(appRunnerService).add(
      'Environment',
      failureDrill ? resourceConfiguration.environmentName : 'production',
      { priority: 300 },
    );
    Tags.of(appRunnerService).remove('DataScope', { priority: 300 });
    imagePullGrant.applyBefore(appRunnerService);
    for (const grant of runtimeGrants) grant.applyBefore(appRunnerService);

    // Alarms. Until the canary and the metrics collector have the credentials
    // they need, only the tier with a real publisher is deployed; see
    // `configureInfrastructureMonitoring`.
    if (!failureDrill) {
      configureInfrastructureMonitoring(this, {
        applicationCondition: shouldProvisionApplication,
        appRunnerService,
        channelQueues: {
          email: { deadLetterQueue: emailDeadLetterQueue, queue: emailQueue },
          push: queuePairs.Push,
          sms: queuePairs.Sms,
        },
        criticalAlarmTopic,
        database,
        displayTimeZone: deploymentIdentity.displayTimeZone,
        delivery: queuePairs.Delivery,
        operationsAlarmTopic,
        operationsKey,
        monitoringRunbookBaseUrl,
        sesIdentityDomain,
      });
    } else {
      configureFailureDrillMonitoring(this, {
        applicationCondition: shouldProvisionApplication,
        appRunnerService,
        database,
        deadLetterQueues: [
          queuePairs.Delivery.deadLetterQueue,
          emailDeadLetterQueue,
          queuePairs.Push.deadLetterQueue,
          queuePairs.Sms.deadLetterQueue,
        ],
        namePrefix: resourceConfiguration.prefix,
      });
    }

    new CfnOutput(this, 'DeploymentAccount', {
      value: account,
    });
    new CfnOutput(this, 'DeploymentRegion', {
      value: region,
    });
    if (!failureDrill) {
      new CfnOutput(this, 'ExpectedAwsAccountAlias', {
        value: accountAlias,
      });
    }
    new CfnOutput(this, 'EnvironmentName', {
      value: resourceConfiguration.environmentName,
    });
    new CfnOutput(this, 'DataClassification', {
      value: resourceConfiguration.dataClassification,
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
      value: resourceConfiguration.databaseName,
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
    new CfnOutput(this, 'EmailWorkerRoleArn', {
      value: emailWorkerRole.roleArn,
    });
    new CfnOutput(this, 'EmailWorkerLogGroupName', {
      value: emailWorkerLogGroup.logGroupName,
    });
    if (!failureDrill) {
      new CfnOutput(this, 'SesIdentityArn', {
        value: Arn.format(
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
        ),
      });
      new CfnOutput(this, 'SesIdentityDomain', {
        value: sesIdentityDomain,
      });
      new CfnOutput(this, 'SesFromAddress', {
        value: sesFromAddress,
      });
      new CfnOutput(this, 'SesConfigurationSetName', {
        value: emailConfigurationSet!.ref,
      });
      new CfnOutput(this, 'SesEmailEventsTopicArn', {
        value: emailEventsTopic!.topicArn,
      });
      new CfnOutput(this, 'SesEmailEventsKeyArn', {
        value: emailEventsKey!.keyArn,
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
    }
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
    if (failureDrill) {
      new CfnOutput(this, 'FailureDrillRunId', {
        value: deploymentProfile.runId,
      });
      new CfnOutput(this, 'FailureDrillTaskDefinitionArn', {
        value: failureDrillTaskDefinition!.taskDefinitionArn,
      });
      new CfnOutput(this, 'FailureDrillLogGroupName', {
        value: failureDrillLogGroup!.logGroupName,
      });
      new CfnOutput(this, 'FailureDrillProviderMode', { value: 'mocked' });
      new CfnOutput(this, 'FailureDrillRosterPopulation', {
        value: 'synthetic',
      });
    }
  }
}
