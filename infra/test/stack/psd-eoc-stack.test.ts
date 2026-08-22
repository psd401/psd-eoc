import { describe, expect, it } from 'bun:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import {
  AWS_ACCOUNT,
  AWS_ACCOUNT_ALIAS,
  BOOTSTRAP_LOG_GROUP_NAME,
  DATABASE_IDENTIFIER,
  DATABASE_NAME,
  DATABASE_PORT,
  DATABASE_SSL_ROOT_CERT,
  DATA_CLASSIFICATION,
  EMAIL_DEAD_LETTER_QUEUE_NAME,
  EMAIL_QUEUE_NAME,
  EMAIL_WORKER_LOG_GROUP_NAME,
  DEPLOYMENT_ENVIRONMENT,
  HEALTH_PATH,
  IMAGE_DIGEST_SENTINEL,
  HEALTH_QUEUE_NAME,
  AWS_REGION,
  SERVER_REPOSITORY_NAME,
  SES_FROM_ADDRESS,
  SES_IDENTITY_DOMAIN,
  SES_VERIFICATION_REFERENCE,
  STACK_NAME,
} from '../../src/stack/config';
import { PsdEocStack } from '../../src/stack/psd-eoc-stack';
import {
  SES_CONFIGURATION_SET_NAME,
  SES_EVENT_DESTINATION_NAME,
  SES_EVENT_TOPIC_NAME,
} from '../../src/config';

type JsonRecord = Record<string, unknown>;

interface SynthesizedResource extends JsonRecord {
  readonly Condition?: unknown;
  readonly DeletionPolicy?: unknown;
  readonly DependsOn?: unknown;
  readonly Properties?: unknown;
  readonly Type?: unknown;
  readonly UpdateReplacePolicy?: unknown;
}

function asRecord(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected object, received ${JSON.stringify(value)}`);
  }
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected array, received ${JSON.stringify(value)}`);
  }
  return value;
}

function asStringArray(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  if (!values.every((item) => typeof item === 'string')) {
    throw new TypeError(
      `Expected string or string array, received ${JSON.stringify(value)}`,
    );
  }
  return values as string[];
}

function resourceEntries(
  resourceType: string,
): Array<[string, SynthesizedResource]> {
  return Object.entries(template.findResources(resourceType)).map(
    ([logicalId, resource]) => [logicalId, asRecord(resource)],
  );
}

function onlyResource(resourceType: string): SynthesizedResource {
  const resources = resourceEntries(resourceType);
  expect(resources).toHaveLength(1);
  const resource = resources[0];
  if (resource === undefined) {
    throw new Error(`Expected one ${resourceType} resource.`);
  }
  return resource[1];
}

function taskDefinitionByFamily(family: string): SynthesizedResource {
  const tasks = resourceEntries('AWS::ECS::TaskDefinition').filter(
    ([, resource]) => properties(resource).Family === family,
  );
  expect(tasks).toHaveLength(1);
  const task = tasks[0];
  if (task === undefined) throw new Error(`Missing task family ${family}.`);
  return task[1];
}

function properties(resource: SynthesizedResource): JsonRecord {
  return asRecord(resource.Properties);
}

function roleLogicalIdForServicePrincipal(service: string): string {
  const role = resourceEntries('AWS::IAM::Role').find(([, resource]) =>
    JSON.stringify(properties(resource).AssumeRolePolicyDocument).includes(
      service,
    ),
  );
  if (role === undefined) {
    throw new Error(`Missing role for ${service}.`);
  }
  return role[0];
}

function roleLogicalIdForDescription(description: string): string {
  const role = resourceEntries('AWS::IAM::Role').find(([, resource]) =>
    String(properties(resource).Description).includes(description),
  );
  if (role === undefined) {
    throw new Error(`Missing role with description containing ${description}.`);
  }
  return role[0];
}

function inlineStatementsForRole(roleLogicalId: string): JsonRecord[] {
  return resourceEntries('AWS::IAM::Policy')
    .filter(([, resource]) =>
      JSON.stringify(properties(resource).Roles).includes(roleLogicalId),
    )
    .flatMap(([, resource]) =>
      asArray(asRecord(properties(resource).PolicyDocument).Statement).map(
        asRecord,
      ),
    );
}

function allAllowedActions(statements: readonly JsonRecord[]): string[] {
  return statements
    .filter((statement) => statement.Effect === 'Allow')
    .flatMap((statement) => asStringArray(statement.Action));
}

function tagsByKey(resource: SynthesizedResource): Map<string, unknown> {
  return new Map(
    asArray(properties(resource).Tags).map((tag) => {
      const record = asRecord(tag);
      return [String(record.Key), record.Value];
    }),
  );
}

const app = new App({
  context: {
    'psdEoc:applicationOrigin': 'https://eoc.example.invalid',
    'psdEoc:hostedDomain': 'example.invalid',
    'psdEoc:iosBundleId': 'invalid.example.eoc',
  },
});
const stack = new PsdEocStack(app, STACK_NAME, {
  env: {
    account: AWS_ACCOUNT,
    region: AWS_REGION,
  },
  stackName: STACK_NAME,
});
const template = Template.fromStack(stack);
const synthesized = asRecord(template.toJSON());
const resources = asRecord(synthesized.Resources);

describe('deployment boundary', () => {
  it('labels the immutable server image as the staff-minimized live pilot', async () => {
    const dockerfile = await Bun.file(
      new URL(
        '../../../packages/server/container/psd-eoc.Dockerfile',
        import.meta.url,
      ),
    ).text();

    expect(dockerfile).toContain(
      'org.opencontainers.image.title="PSD EOC live pilot"',
    );
    expect(dockerfile).toContain('net.psd401.environment="live-pilot"');
    expect(dockerfile).toContain(
      'net.psd401.data-classification="staff-minimized"',
    );
    expect(dockerfile).not.toContain('synthetic-only');
  });

  it('rejects every account and region except the approved psd401 target', () => {
    expect(AWS_ACCOUNT_ALIAS).toBe('psd401');
    expect(AWS_ACCOUNT).toBe('338414773271');
    expect(AWS_REGION).toBe('us-west-2');

    expect(
      () =>
        new PsdEocStack(
          new App({
            context: {
              'psdEoc:applicationOrigin': 'https://eoc.example.invalid',
              'psdEoc:hostedDomain': 'example.invalid',
              'psdEoc:iosBundleId': 'invalid.example.eoc',
            },
          }),
          'WrongAccount',
          {
            env: { account: '000000000000', region: AWS_REGION },
          },
        ),
    ).toThrow(`AWS account ${AWS_ACCOUNT} (${AWS_ACCOUNT_ALIAS})`);
    expect(
      () =>
        new PsdEocStack(
          new App({
            context: {
              'psdEoc:applicationOrigin': 'https://eoc.example.invalid',
              'psdEoc:hostedDomain': 'example.invalid',
              'psdEoc:iosBundleId': 'invalid.example.eoc',
            },
          }),
          'WrongRegion',
          {
            env: { account: AWS_ACCOUNT, region: 'us-east-1' },
          },
        ),
    ).toThrow(`in ${AWS_REGION}`);
  });

  it('requires separate reviewed bootstrap and deploy digests plus protected identity', () => {
    const parameters = asRecord(synthesized.Parameters);
    const provision = asRecord(parameters.ProvisionApplication);
    const appDigest = asRecord(parameters.AppImageDigest);
    const bootstrapDigest = asRecord(parameters.BootstrapImageDigest);
    const runtimeIdleTimeout = asRecord(
      parameters.RuntimeDatabaseIdleTimeoutSeconds,
    );
    const sourceSha = asRecord(parameters.SourceSha);
    const bootstrapSourceSha = asRecord(parameters.BootstrapSourceSha);
    const oauthArn = asRecord(parameters.GoogleOauthSecretArn);
    const transitionEmailDigest = asRecord(
      parameters.InitialMobileTransitionEmailSha256,
    );

    expect(provision.AllowedValues).toEqual(['false', 'true']);
    expect(provision).not.toHaveProperty('Default');
    expect(appDigest.Default).toBe(IMAGE_DIGEST_SENTINEL);
    expect(appDigest.AllowedPattern).toBe('^sha256:[0-9a-f]{64}$');
    expect(bootstrapDigest.AllowedPattern).toBe('^sha256:[0-9a-f]{64}$');
    expect(bootstrapDigest).not.toHaveProperty('Default');
    expect(runtimeIdleTimeout).toMatchObject({
      Default: 0,
      MaxValue: 600,
      MinValue: 0,
      Type: 'Number',
    });
    expect(sourceSha.AllowedPattern).toBe('^[0-9a-f]{40}$');
    expect(sourceSha).not.toHaveProperty('Default');
    expect(bootstrapSourceSha.AllowedPattern).toBe('^[0-9a-f]{40}$');
    expect(bootstrapSourceSha).not.toHaveProperty('Default');
    expect(oauthArn.NoEcho).toBe(true);
    expect(oauthArn.AllowedPattern).toBe(
      '^arn:aws:secretsmanager:us-west-2:338414773271:secret:/psd-eoc/google-oauth-[A-Za-z0-9]{6}$',
    );
    // The approved-staff identity fed the removed access fixture. The
    // bootstrap container's environment schema is strict, so leaving these
    // behind would fail the migration task rather than be ignored.
    expect(parameters).not.toHaveProperty('ApprovedGoogleSubject');
    expect(parameters).not.toHaveProperty('ApprovedStaffEmail');
    expect(parameters).not.toHaveProperty('ApprovedStaffDisplayName');
    expect(transitionEmailDigest).toMatchObject({
      AllowedPattern: '^[0-9a-f]{64}$',
      MaxLength: 64,
      MinLength: 64,
      NoEcho: true,
      Type: 'String',
    });
    expect(transitionEmailDigest).not.toHaveProperty('Default');

    const rules = asRecord(synthesized.Rules);
    const digestRule = asRecord(rules.ApplicationRequiresPublishedDigest);
    expect(digestRule.RuleCondition).toEqual({
      'Fn::Equals': [{ Ref: 'ProvisionApplication' }, 'true'],
    });
    expect(JSON.stringify(digestRule.Assertions)).toContain(
      IMAGE_DIGEST_SENTINEL,
    );
    const bootstrapRule = asRecord(rules.BootstrapRequiresPublishedDigest);
    expect(bootstrapRule).not.toHaveProperty('RuleCondition');
    expect(JSON.stringify(bootstrapRule.Assertions)).toContain(
      IMAGE_DIGEST_SENTINEL,
    );
    expect(
      JSON.stringify(
        asRecord(rules.ApplicationRequiresReviewedSource).Assertions,
      ),
    ).toContain('0'.repeat(40));
    expect(
      JSON.stringify(
        asRecord(rules.BootstrapRequiresReviewedSource).Assertions,
      ),
    ).toContain('0'.repeat(40));

    const conditions = asRecord(synthesized.Conditions);
    expect(conditions.ShouldProvisionApplication).toEqual({
      'Fn::Equals': [{ Ref: 'ProvisionApplication' }, 'true'],
    });
    expect(onlyResource('AWS::AppRunner::Service').Condition).toBe(
      'ShouldProvisionApplication',
    );
    expect(
      onlyResource('AWS::AppRunner::AutoScalingConfiguration').Condition,
    ).toBe('ShouldProvisionApplication');
  });

  it('tags every stateful or executable resource except the immutable App Runner identities as the live pilot', () => {
    const taggableTypes = [
      'AWS::AppRunner::AutoScalingConfiguration',
      'AWS::ECR::Repository',
      'AWS::ECS::Cluster',
      'AWS::ECS::TaskDefinition',
      'AWS::IAM::Role',
      'AWS::Logs::LogGroup',
      'AWS::RDS::DBCluster',
      'AWS::RDS::DBInstance',
      'AWS::SecretsManager::Secret',
      'AWS::SQS::Queue',
    ];
    for (const type of taggableTypes) {
      for (const [, resource] of resourceEntries(type)) {
        const tags = tagsByKey(resource);
        expect(tags.get('Environment')).toBe(DEPLOYMENT_ENVIRONMENT);
        expect(tags.get('DataClassification')).toBe(DATA_CLASSIFICATION);
        expect(tags.get('ExpectedAwsAccountAlias')).toBe(AWS_ACCOUNT_ALIAS);
      }
    }
  });
});

describe('minimal isolated resource shape', () => {
  it('creates one bounded native application, bootstrap, and dark email topology', () => {
    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.resourceCountIs('AWS::RDS::DBCluster', 1);
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.resourceCountIs('AWS::AppRunner::Service', 1);
    template.resourceCountIs('AWS::AppRunner::AutoScalingConfiguration', 1);
    template.resourceCountIs('AWS::AppRunner::VpcConnector', 1);
    template.resourceCountIs('AWS::ECS::Cluster', 1);
    template.resourceCountIs('AWS::ECS::TaskDefinition', 2);
    template.resourceCountIs('AWS::ECS::Service', 0);
    // Five log groups: bootstrap, access sync, the Aurora failover bridge, the
    // delivery router, and the alarm mailer.
    template.resourceCountIs('AWS::Logs::LogGroup', 5);
    // Nine queues: the health queue, plus a source/dead-letter pair each for
    // delivery, email, SMS, and push.
    template.resourceCountIs('AWS::SQS::Queue', 9);
    // Seven: the five the application has always had, plus one generated
    // bearer for each internal worker route.
    template.resourceCountIs('AWS::SecretsManager::Secret', 7);
    // Two keys: SES event evidence, and operational alarm notifications.
    template.resourceCountIs('AWS::KMS::Key', 2);
    template.resourceCountIs('AWS::SES::ConfigurationSet', 1);
    template.resourceCountIs('AWS::SES::ConfigurationSetEventDestination', 0);
    // Three topics: SES event evidence, and the two alarm routes.
    template.resourceCountIs('AWS::SNS::Topic', 3);

    const repository = properties(onlyResource('AWS::ECR::Repository'));
    expect(repository.RepositoryName).toBe(SERVER_REPOSITORY_NAME);
    expect(repository.ImageTagMutability).toBe('IMMUTABLE');
    expect(repository.ImageScanningConfiguration).toEqual({ ScanOnPush: true });
    expect(JSON.stringify(repository.LifecyclePolicy)).toContain(
      'imageCountMoreThan',
    );

    const queues = new Map(
      resourceEntries('AWS::SQS::Queue').map(([, resource]) => [
        String(properties(resource).QueueName),
        resource,
      ]),
    );
    const healthQueue = properties(queues.get(HEALTH_QUEUE_NAME) ?? {});
    expect(healthQueue.SqsManagedSseEnabled).toBe(true);
    expect(healthQueue.MessageRetentionPeriod).toBe(86_400);
    expect(healthQueue.VisibilityTimeout).toBe(30);
    expect(healthQueue).not.toHaveProperty('RedrivePolicy');

    const emailQueue = properties(queues.get(EMAIL_QUEUE_NAME) ?? {});
    expect(emailQueue.SqsManagedSseEnabled).toBe(true);
    expect(emailQueue.MessageRetentionPeriod).toBe(345_600);
    expect(emailQueue.VisibilityTimeout).toBe(60);
    expect(emailQueue.RedrivePolicy).toEqual({
      deadLetterTargetArn: {
        'Fn::GetAtt': [expect.stringContaining('EmailDeadLetterQueue'), 'Arn'],
      },
      maxReceiveCount: 5,
    });

    const emailDeadLetterQueue = properties(
      queues.get(EMAIL_DEAD_LETTER_QUEUE_NAME) ?? {},
    );
    expect(emailDeadLetterQueue.SqsManagedSseEnabled).toBe(true);
    expect(emailDeadLetterQueue.MessageRetentionPeriod).toBe(1_209_600);
    const redriveAllowPolicy = asRecord(
      emailDeadLetterQueue.RedriveAllowPolicy,
    );
    expect(redriveAllowPolicy.redrivePermission).toBe('byQueue');
    expect(asArray(redriveAllowPolicy.sourceQueueArns)).toHaveLength(1);
    expect(JSON.stringify(redriveAllowPolicy.sourceQueueArns)).toContain(
      `:sqs:${AWS_REGION}:${AWS_ACCOUNT}:${EMAIL_QUEUE_NAME}`,
    );

    for (const queue of queues.values()) {
      expect(queue.DeletionPolicy).toBe('Retain');
      expect(queue.UpdateReplacePolicy).toBe('Retain');
    }
  });

  it('preserves Aurora and database subnets while enabling only native PostgreSQL', () => {
    const clusterResource = onlyResource('AWS::RDS::DBCluster');
    const cluster = properties(clusterResource);
    const scaling = asRecord(cluster.ServerlessV2ScalingConfiguration);
    const writerResource = onlyResource('AWS::RDS::DBInstance');
    const writer = properties(writerResource);

    expect(cluster.DBClusterIdentifier).toBe(DATABASE_IDENTIFIER);
    expect(cluster.DatabaseName).toBe(DATABASE_NAME);
    expect(cluster.Engine).toBe('aurora-postgresql');
    expect(cluster.EnableHttpEndpoint).toBe(false);
    expect(cluster.StorageEncrypted).toBe(true);
    expect(cluster.DeletionProtection).toBe(true);
    expect(cluster.BackupRetentionPeriod).toBe(14);
    expect(scaling).toEqual({ MaxCapacity: 1, MinCapacity: 0.5 });
    expect(clusterResource.DeletionPolicy).toBe('Retain');
    expect(clusterResource.UpdateReplacePolicy).toBe('Retain');

    expect(writer.DBInstanceClass).toBe('db.serverless');
    expect(writer.PromotionTier).toBe(0);
    expect(writer.PubliclyAccessible).toBe(false);
    expect(writer.AvailabilityZone).toBe(`${AWS_REGION}a`);
    expect(writerResource.DeletionPolicy).toBe('Retain');
    expect(writerResource.UpdateReplacePolicy).toBe('Retain');

    expect(cluster.DBSubnetGroupName).toEqual({
      Ref: 'DatabaseSubnets56F17B9A',
    });
    expect(resources).toHaveProperty(
      'DatabaseNetworkDatabaseSubnet1Subnet13C96DD5',
    );
    expect(
      properties(
        asRecord(resources.DatabaseNetworkDatabaseSubnet1Subnet13C96DD5),
      ).CidrBlock,
    ).toBe('10.43.0.0/26');
    expect(resources).toHaveProperty(
      'DatabaseNetworkDatabaseSubnet2SubnetDA89C5FC',
    );
    expect(
      properties(
        asRecord(resources.DatabaseNetworkDatabaseSubnet2SubnetDA89C5FC),
      ).CidrBlock,
    ).toBe('10.43.0.64/26');
    expect(resources).toHaveProperty('DatabaseB269D8BB');
    expect(resources).toHaveProperty('DatabaseWriter7794273E');

    template.resourceCountIs('AWS::EC2::Subnet', 6);
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.resourceCountIs('AWS::EC2::InternetGateway', 1);
    // Three functions, all outside the VPC and none able to reach the database.
    // Only the alarm mailer may reach a provider, and only SES, and only from
    // the operational alarm address.
    template.resourceCountIs('AWS::Lambda::Function', 3);
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 0);

    template.resourceCountIs('AWS::EC2::SecurityGroup', 2);
    const securityGroups = resourceEntries('AWS::EC2::SecurityGroup');
    const databaseSecurityGroup = securityGroups.find(([, resource]) =>
      String(properties(resource).GroupDescription).startsWith(
        'Isolated Aurora',
      ),
    );
    const applicationSecurityGroup = securityGroups.find(
      ([, resource]) =>
        properties(resource).GroupName === 'psd-eoc-application',
    );
    expect(databaseSecurityGroup).toBeDefined();
    expect(applicationSecurityGroup).toBeDefined();
    if (databaseSecurityGroup === undefined) {
      throw new Error('Missing database security group.');
    }
    if (applicationSecurityGroup === undefined) {
      throw new Error('Missing application security group.');
    }
    expect(properties(databaseSecurityGroup[1])).not.toHaveProperty(
      'GroupName',
    );

    const ingress = properties(onlyResource('AWS::EC2::SecurityGroupIngress'));
    expect(ingress.FromPort).toBe(DATABASE_PORT);
    expect(ingress.ToPort).toBe(DATABASE_PORT);
    expect(ingress.IpProtocol).toBe('tcp');
    expect(JSON.stringify(ingress.GroupId)).toContain(databaseSecurityGroup[0]);
    expect(JSON.stringify(ingress.SourceSecurityGroupId)).toContain(
      applicationSecurityGroup[0],
    );
    expect(ingress).not.toHaveProperty('CidrIp');

    const databaseEgress = properties(
      onlyResource('AWS::EC2::SecurityGroupEgress'),
    );
    expect(databaseEgress.FromPort).toBe(DATABASE_PORT);
    expect(databaseEgress.ToPort).toBe(DATABASE_PORT);
    expect(JSON.stringify(databaseEgress.DestinationSecurityGroupId)).toContain(
      databaseSecurityGroup[0],
    );
  });

  it('generates credentials and stores the NoEcho bootstrap identity as JSON', () => {
    const secrets = resourceEntries('AWS::SecretsManager::Secret');
    const byName = new Map(
      secrets.map(([, resource]) => [properties(resource).Name, resource]),
    );
    expect([...byName.keys()].sort()).toEqual(
      [
        '/psd-eoc/api-salt',
        '/psd-eoc/bootstrap/approved-identity',
        '/psd-eoc/database/admin',
        '/psd-eoc/database/application',
        '/psd-eoc/google-oidc-cookie-secret',
        '/psd-eoc/workers/attempt-execution-token',
        '/psd-eoc/workers/delivery-state-token',
      ].sort(),
    );
    for (const name of [
      '/psd-eoc/api-salt',
      '/psd-eoc/database/admin',
      '/psd-eoc/database/application',
      '/psd-eoc/google-oidc-cookie-secret',
      '/psd-eoc/workers/attempt-execution-token',
      '/psd-eoc/workers/delivery-state-token',
    ]) {
      const resource = byName.get(name);
      expect(resource).toBeDefined();
      const secret = properties(resource ?? {});
      expect(secret.GenerateSecretString).toBeDefined();
      expect(secret).not.toHaveProperty('SecretString');
      expect(resource?.DeletionPolicy).toBe('Retain');
      expect(resource?.UpdateReplacePolicy).toBe('Retain');
    }

    const identity = byName.get('/psd-eoc/bootstrap/approved-identity');
    expect(identity).toBeDefined();
    const identitySecretString = JSON.stringify(
      properties(identity ?? {}).SecretString,
    );
    expect(identitySecretString).not.toContain('googleSubject');
    expect(identitySecretString).not.toContain('staffDisplayName');
    expect(identitySecretString).not.toContain('staffEmail');
    expect(identitySecretString).toContain(
      'initialMobileTransitionEmailSha256',
    );
    expect(identitySecretString).toContain(
      'InitialMobileTransitionEmailSha256',
    );
    expect(synthesized).not.toHaveProperty('Transform');
    expect(identity?.DeletionPolicy).toBe('Retain');
    expect(identity?.UpdateReplacePolicy).toBe('Retain');

    const admin = asRecord(
      properties(byName.get('/psd-eoc/database/admin') ?? {})
        .GenerateSecretString,
    );
    expect(admin.SecretStringTemplate).toBe(
      JSON.stringify({ username: 'psd_eoc_admin' }),
    );
    expect(admin.ExcludePunctuation).toBe(true);

    const application = asRecord(
      properties(byName.get('/psd-eoc/database/application') ?? {})
        .GenerateSecretString,
    );
    expect(application.SecretStringTemplate).toBe(
      JSON.stringify({ username: 'psd_eoc_application' }),
    );
    expect(application.ExcludePunctuation).toBe(true);

    const cookie = asRecord(
      properties(byName.get('/psd-eoc/google-oidc-cookie-secret') ?? {})
        .GenerateSecretString,
    );
    // 44, not 43: the reader requires canonical unpadded base64url and a
    // 43-character value only round-trips when its two leftover bits happen
    // to be zero, which is true of about a quarter of generated secrets.
    expect(cookie.PasswordLength).toBe(44);
    expect(cookie.ExcludePunctuation).toBe(true);
  });
});

describe('App Runner runtime safety boundary', () => {
  it('pins the service and preserves the exact prior live App Runner identity contracts', () => {
    const scaling = properties(
      onlyResource('AWS::AppRunner::AutoScalingConfiguration'),
    );
    expect(scaling.MinSize).toBe(1);
    expect(scaling.MaxSize).toBe(1);
    expect(scaling.MaxConcurrency).toBe(10);

    const service = onlyResource('AWS::AppRunner::Service');
    const serviceProperties = properties(service);
    const source = asRecord(serviceProperties.SourceConfiguration);
    const image = asRecord(source.ImageRepository);

    expect(source.AutoDeploymentsEnabled).toBe(false);
    expect(image.ImageRepositoryType).toBe('ECR');
    expect(JSON.stringify(image.ImageIdentifier)).toContain('ImageRepository');
    expect(JSON.stringify(image.ImageIdentifier)).toContain('AppImageDigest');
    expect(JSON.stringify(image.ImageIdentifier)).not.toContain(
      'BootstrapImageDigest',
    );
    expect(JSON.stringify(image.ImageIdentifier)).toContain('"@"');
    expect(JSON.stringify(image.ImageIdentifier)).not.toContain(':latest');
    expect(serviceProperties.Tags).toEqual([
      {
        Key: 'Application',
        Value: 'PSD EOC Exploration Smoke',
      },
      {
        Key: 'DataClassification',
        Value: 'synthetic-only',
      },
      {
        Key: 'Environment',
        Value: 'production',
      },
      {
        Key: 'ExpectedAwsAccountAlias',
        Value: 'psd401',
      },
      {
        Key: 'ManagedBy',
        Value: 'AWS CDK',
      },
    ]);
    expect(asRecord(serviceProperties.HealthCheckConfiguration).Path).toBe(
      HEALTH_PATH,
    );
    const egress = asRecord(
      asRecord(serviceProperties.NetworkConfiguration).EgressConfiguration,
    );
    expect(egress.EgressType).toBe('VPC');
    expect(egress.VpcConnectorArn).toEqual({
      'Fn::GetAtt': ['AppRunnerVpcConnector', 'VpcConnectorArn'],
    });

    const connector = properties(onlyResource('AWS::AppRunner::VpcConnector'));
    expect(asArray(connector.Subnets)).toHaveLength(2);
    expect(JSON.stringify(connector.Subnets)).toContain(
      'DatabaseNetworkApplicationSubnet1',
    );
    expect(JSON.stringify(connector.Subnets)).toContain(
      'DatabaseNetworkApplicationSubnet2',
    );
    expect(asArray(connector.SecurityGroups)).toHaveLength(1);
    expect(JSON.stringify(connector.SecurityGroups)).toContain(
      'ApplicationSecurityGroup',
    );
    expect(connector.Tags).toEqual([
      {
        Key: 'Application',
        Value: 'PSD EOC Exploration Smoke',
      },
      {
        Key: 'DataClassification',
        Value: 'synthetic-only',
      },
      {
        Key: 'Environment',
        Value: 'production',
      },
      {
        Key: 'ExpectedAwsAccountAlias',
        Value: 'psd401',
      },
      {
        Key: 'ManagedBy',
        Value: 'AWS CDK',
      },
    ]);
  });

  it('injects only the required live-pilot runtime and Google OIDC contract', () => {
    const service = properties(onlyResource('AWS::AppRunner::Service'));
    const image = asRecord(
      asRecord(service.SourceConfiguration).ImageRepository,
    );
    const configuration = asRecord(image.ImageConfiguration);
    const variables = new Map(
      asArray(configuration.RuntimeEnvironmentVariables).map((item) => {
        const pair = asRecord(item);
        return [String(pair.Name), pair.Value];
      }),
    );
    const secrets = new Map(
      asArray(configuration.RuntimeEnvironmentSecrets).map((item) => {
        const pair = asRecord(item);
        return [String(pair.Name), pair.Value];
      }),
    );

    expect([...variables.keys()].sort()).toEqual(
      [
        'AWS_REGION',
        'DATABASE_CONNECT_TIMEOUT_SECONDS',
        'DATABASE_DRIVER',
        'DATABASE_HOST',
        'GOOGLE_OIDC_APPLICATION_ORIGIN',
        'GOOGLE_OIDC_HOSTED_DOMAIN',
        'DATABASE_IDLE_TIMEOUT_SECONDS',
        'DATABASE_MAX_CONNECTIONS',
        'DATABASE_NAME',
        'DATABASE_PORT',
        'DATABASE_SSL_ROOT_CERT',
        'DELIVERY_QUEUE_URL',
        'NODE_ENV',
        'PSD_EOC_IOS_BUNDLE_ID',
        'PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE',
        'RUNTIME_SECRET_ARN',
        'SOURCE_SHA',
      ].sort(),
    );
    expect(variables.get('AWS_REGION')).toBe(AWS_REGION);
    expect(variables.get('DATABASE_DRIVER')).toBe('postgres');
    expect(variables.get('DATABASE_HOST')).toEqual({
      'Fn::GetAtt': ['DatabaseB269D8BB', 'Endpoint.Address'],
    });
    expect(variables.get('DATABASE_PORT')).toBe(String(DATABASE_PORT));
    expect(variables.get('DATABASE_NAME')).toBe(DATABASE_NAME);
    expect(variables.get('DATABASE_SSL_ROOT_CERT')).toBe(
      DATABASE_SSL_ROOT_CERT,
    );
    expect(variables.get('DATABASE_MAX_CONNECTIONS')).toBe('1');
    expect(variables.get('DATABASE_CONNECT_TIMEOUT_SECONDS')).toBe('10');
    expect(variables.get('DATABASE_IDLE_TIMEOUT_SECONDS')).toEqual({
      Ref: 'RuntimeDatabaseIdleTimeoutSeconds',
    });
    expect(variables.get('SOURCE_SHA')).toEqual({ Ref: 'SourceSha' });
    expect(variables.get('PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE')).toBe(
      SES_VERIFICATION_REFERENCE,
    );
    expect(variables.get('RUNTIME_SECRET_ARN')).toEqual({
      Ref: expect.stringContaining('ApiSaltSecret'),
    });
    expect([...secrets.keys()].sort()).toEqual(
      [
        'API_SALT',
        'DATABASE_PASSWORD',
        'DATABASE_USERNAME',
        'GOOGLE_OAUTH_CONFIG',
        'GOOGLE_OIDC_COOKIE_SECRET',
        'PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN',
        'PSD_EOC_DELIVERY_STATE_WORKER_TOKEN',
        'PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256',
      ].sort(),
    );
    expect(secrets.get('GOOGLE_OAUTH_CONFIG')).toEqual({
      Ref: 'GoogleOauthSecretArn',
    });
    expect(JSON.stringify(secrets.get('DATABASE_USERNAME'))).toContain(
      ':username::',
    );
    expect(JSON.stringify(secrets.get('DATABASE_PASSWORD'))).toContain(
      ':password::',
    );
    expect(
      JSON.stringify(
        secrets.get('PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256'),
      ),
    ).toContain(':initialMobileTransitionEmailSha256::');

    const serialized = JSON.stringify(configuration);
    expect(serialized).not.toContain('aws-data-api');
    expect(serialized).not.toContain('DATABASE_RESOURCE_ARN');
    expect(serialized).not.toContain('DATABASE_SECRET_ARN');
    expect(serialized).not.toContain('BootstrapSourceSha');
    expect(serialized).not.toContain('ApprovedGoogleSubject');
    expect(serialized).not.toContain('GOOGLE_ROSTER_CONFIG');
    expect(serialized).not.toContain('EXPO');
    expect(serialized).not.toContain('SES_ACCESS_KEY');
    expect(serialized).not.toContain('SES_SECRET');
    expect(serialized).not.toContain('SES_SESSION');
    expect(serialized).not.toContain('SES_SEND');
    expect(serialized).not.toContain('SMS');
    expect(serialized).not.toContain('MEDIA_BUCKET');

    // The application holds both internal worker bearers, because verifying a
    // bearer means comparing against it. That is not a provider credential and
    // is not what this list guards: the runtime still holds nothing that can
    // reach SES, SMS, Expo, or object storage. Both arrive as resolved secret
    // references rather than plain environment values.
    for (const name of [
      'PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN',
      'PSD_EOC_DELIVERY_STATE_WORKER_TOKEN',
    ]) {
      expect(secrets.has(name)).toBe(true);
      expect(variables.has(name)).toBe(false);
    }
  });

  it('gives the runtime only application-secret and health-read permissions', () => {
    const runtimeRole = roleLogicalIdForServicePrincipal(
      'tasks.apprunner.amazonaws.com',
    );
    const statements = inlineStatementsForRole(runtimeRole);
    const actions = [...new Set(allAllowedActions(statements))].sort();

    expect(actions).toEqual(
      [
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'sqs:GetQueueAttributes',
        'sqs:SendMessage',
      ].sort(),
    );
    // sqs:SendMessage is deliberate and is not a provider grant: an activation
    // hands its own notification batch to its own delivery queue after the
    // event commits. Reaching a person still requires a channel worker, and the
    // runtime has no provider authority at all — asserted just below.
    expect(actions).not.toContain('ses:SendEmail');
    expect(actions).not.toContain('ses:SendRawEmail');
    expect(actions.some((action) => action.startsWith('rds-data:'))).toBe(
      false,
    );
    expect(actions.every((action) => !action.includes('*'))).toBe(true);
    for (const forbiddenPrefix of [
      'events:',
      'lambda:',
      'ses:',
      'sns:',
      's3:',
    ]) {
      expect(actions.some((action) => action.startsWith(forbiddenPrefix))).toBe(
        false,
      );
    }

    // The runtime reads the health queue's attributes, and both reads and
    // writes the delivery queue. It can reach no other queue.
    const queueStatements = statements.filter((statement) =>
      asStringArray(statement.Action).some((action) =>
        action.startsWith('sqs:'),
      ),
    );
    const queueTargets = JSON.stringify(
      queueStatements.map((statement) => statement.Resource),
    );
    expect(queueTargets).toContain('HealthQueue');
    expect(queueTargets).toContain('DeliveryQueue');
    for (const unreachable of ['EmailQueue', 'SmsQueue', 'PushQueue']) {
      expect(queueTargets).not.toContain(unreachable);
    }
    const sendStatement = statements.find((statement) =>
      asStringArray(statement.Action).includes('sqs:SendMessage'),
    );
    expect(sendStatement?.Resource).toEqual({
      'Fn::GetAtt': [expect.stringContaining('DeliveryQueue'), 'Arn'],
    });

    const secretStatements = statements.filter((statement) =>
      asStringArray(statement.Action).includes('secretsmanager:GetSecretValue'),
    );
    expect(secretStatements.length).toBeGreaterThan(0);
    const secretResources = JSON.stringify(
      secretStatements.map((statement) => statement.Resource),
    );
    expect(secretResources).toContain('DatabaseApplicationSecret');
    expect(secretResources).toContain('BootstrapIdentitySecret');
    expect(secretResources).toContain('GoogleOauthSecretArn');
    expect(secretResources).toContain('GoogleOidcCookieSecret');
    expect(secretResources).toContain('ApiSaltSecret');
    expect(secretResources).not.toContain('DatabaseAdminSecret');

    const service = onlyResource('AWS::AppRunner::Service');
    const dependencies = asStringArray(service.DependsOn);
    expect(
      dependencies.some((dependency) =>
        dependency.includes('AppRunnerRuntimeRoleDefaultPolicy'),
      ),
    ).toBe(true);
  });

  it('gives the dark email worker only exact queue-consumer permissions', () => {
    const emailWorkerRole = roleLogicalIdForDescription(
      'Dark live-pilot email worker',
    );
    const statements = inlineStatementsForRole(emailWorkerRole);
    const actions = [...new Set(allAllowedActions(statements))].sort();

    expect(actions).toEqual(
      [
        'sqs:ChangeMessageVisibility',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
        'sqs:GetQueueUrl',
        'sqs:ReceiveMessage',
      ].sort(),
    );
    expect(actions.some((action) => action.startsWith('ses:'))).toBe(false);
    expect(actions.some((action) => action.startsWith('sns:'))).toBe(false);
    expect(actions.some((action) => action.startsWith('secretsmanager:'))).toBe(
      false,
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]?.Resource).toEqual({
      'Fn::GetAtt': [expect.stringContaining('EmailQueue'), 'Arn'],
    });
  });

  it('limits the App Runner image role to the isolated ECR pull contract', () => {
    const imageRole = roleLogicalIdForServicePrincipal(
      'build.apprunner.amazonaws.com',
    );
    const statements = inlineStatementsForRole(imageRole);
    const actions = allAllowedActions(statements).sort();
    expect(actions).toEqual(
      [
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage',
        'ecr:GetAuthorizationToken',
        'ecr:GetDownloadUrlForLayer',
      ].sort(),
    );
    const repositoryStatement = statements.find((statement) =>
      asStringArray(statement.Action).includes('ecr:BatchGetImage'),
    );
    expect(repositoryStatement?.Resource).toEqual({
      'Fn::GetAtt': [expect.stringContaining('ImageRepository'), 'Arn'],
    });
    const authorization = statements.find((statement) =>
      asStringArray(statement.Action).includes('ecr:GetAuthorizationToken'),
    );
    expect(authorization?.Resource).toBe('*');
  });
});

describe('one-off native bootstrap boundary', () => {
  it('pins the task to the candidate digest with native TLS and secret JSON keys', () => {
    const task = properties(taskDefinitionByFamily('psd-eoc-bootstrap'));
    expect(task.Cpu).toBe('256');
    expect(task.Memory).toBe('512');
    expect(task.NetworkMode).toBe('awsvpc');
    expect(task.RequiresCompatibilities).toEqual(['FARGATE']);
    const containers = asArray(task.ContainerDefinitions).map(asRecord);
    expect(containers).toHaveLength(1);
    const container = containers[0];
    if (container === undefined)
      throw new Error('Missing bootstrap container.');

    expect(container.Name).toBe('native-bootstrap');
    expect(container.Command).toEqual([
      'bun',
      'packages/server/scripts/operations/bootstrap.ts',
    ]);
    expect(container.ReadonlyRootFilesystem).toBe(true);
    expect(container).not.toHaveProperty('Privileged');
    expect(JSON.stringify(container.Image)).toContain('BootstrapImageDigest');
    expect(JSON.stringify(container.Image)).not.toContain('AppImageDigest');
    expect(JSON.stringify(container.Image)).toContain('"@"');

    const environment = new Map(
      asArray(container.Environment).map((item) => {
        const pair = asRecord(item);
        return [String(pair.Name), pair.Value];
      }),
    );
    expect(environment.get('DATABASE_DRIVER')).toBe('postgres');
    expect(environment.get('DATABASE_HOST')).toEqual({
      'Fn::GetAtt': ['DatabaseB269D8BB', 'Endpoint.Address'],
    });
    expect(environment.get('DATABASE_PORT')).toBe('5432');
    expect(environment.get('DATABASE_NAME')).toBe(DATABASE_NAME);
    expect(environment.get('DATABASE_SSL_ROOT_CERT')).toBe(
      DATABASE_SSL_ROOT_CERT,
    );
    expect(environment.get('DATABASE_MAX_CONNECTIONS')).toBe('1');
    expect(environment.get('DATABASE_CONNECT_TIMEOUT_SECONDS')).toBe('10');
    expect(environment.get('DATABASE_IDLE_TIMEOUT_SECONDS')).toBe('20');
    expect(environment.get('SOURCE_SHA')).toEqual({
      Ref: 'BootstrapSourceSha',
    });
    expect(JSON.stringify(environment)).not.toContain('DATABASE_RESOURCE_ARN');
    expect(JSON.stringify(environment)).not.toContain('aws-data-api');

    const secrets = new Map(
      asArray(container.Secrets).map((item) => {
        const pair = asRecord(item);
        return [String(pair.Name), pair.ValueFrom];
      }),
    );
    expect([...secrets.keys()].sort()).toEqual(
      [
        'DATABASE_ADMIN_PASSWORD',
        'DATABASE_ADMIN_USERNAME',
        'DATABASE_APPLICATION_PASSWORD',
        'DATABASE_APPLICATION_USERNAME',
      ].sort(),
    );
    for (const [name, key] of [
      ['DATABASE_ADMIN_PASSWORD', 'password'],
      ['DATABASE_ADMIN_USERNAME', 'username'],
      ['DATABASE_APPLICATION_PASSWORD', 'password'],
      ['DATABASE_APPLICATION_USERNAME', 'username'],
    ] as const) {
      expect(JSON.stringify(secrets.get(name))).toContain(`:${key}::`);
    }

    const logging = asRecord(container.LogConfiguration);
    expect(logging.LogDriver).toBe('awslogs');
    expect(asRecord(logging.Options)['awslogs-stream-prefix']).toBe(
      'native-bootstrap',
    );
    const logGroupResource = resourceEntries('AWS::Logs::LogGroup').find(
      ([, resource]) =>
        properties(resource).LogGroupName === BOOTSTRAP_LOG_GROUP_NAME,
    )?.[1];
    expect(logGroupResource).toBeDefined();
    const logGroup = properties(logGroupResource ?? {});
    expect(logGroup.LogGroupName).toBe(BOOTSTRAP_LOG_GROUP_NAME);
    expect(logGroup.RetentionInDays).toBe(14);
    expect(logGroupResource?.DeletionPolicy).toBe('Retain');
    expect(logGroupResource?.UpdateReplacePolicy).toBe('Retain');

    const emailLogGroupResource = resourceEntries('AWS::Logs::LogGroup').find(
      ([, resource]) =>
        properties(resource).LogGroupName === EMAIL_WORKER_LOG_GROUP_NAME,
    )?.[1];
    expect(emailLogGroupResource).toBeDefined();
    const emailLogGroup = properties(emailLogGroupResource ?? {});
    expect(emailLogGroup.RetentionInDays).toBe(14);
    expect(emailLogGroupResource?.DeletionPolicy).toBe('Retain');
    expect(emailLogGroupResource?.UpdateReplacePolicy).toBe('Retain');
  });

  it('keeps bootstrap secret reads on the execution role and task role empty', () => {
    const executionRole = roleLogicalIdForDescription(
      'Pulls the reviewed bootstrap image',
    );
    const executionStatements = inlineStatementsForRole(executionRole);
    const executionActions = [
      ...new Set(allAllowedActions(executionStatements)),
    ].sort();
    expect(executionActions).toEqual(
      [
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage',
        'ecr:GetAuthorizationToken',
        'ecr:GetDownloadUrlForLayer',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
      ].sort(),
    );
    expect(
      executionActions.some((action) => action.startsWith('rds-data:')),
    ).toBe(false);
    const secretResources = JSON.stringify(
      executionStatements
        .filter((statement) =>
          asStringArray(statement.Action).includes(
            'secretsmanager:GetSecretValue',
          ),
        )
        .map((statement) => statement.Resource),
    );
    expect(secretResources).toContain('DatabaseAdminSecret');
    expect(secretResources).toContain('DatabaseApplicationSecret');
    expect(secretResources).toContain('BootstrapIdentitySecret');
    expect(secretResources).not.toContain('GoogleOauthSecretArn');
    expect(secretResources).not.toContain('GoogleOidcCookieSecret');
    expect(secretResources).not.toContain('ApiSaltSecret');

    const taskRole = roleLogicalIdForDescription('No-authority task role');
    expect(inlineStatementsForRole(taskRole)).toEqual([]);
    expect(
      resourceEntries('AWS::IAM::Policy').some(([, policy]) =>
        JSON.stringify(properties(policy).Roles).includes(taskRole),
      ),
    ).toBe(false);
  });

  it('refreshes membership on a schedule no human has to approve', () => {
    // The previous trigger was a GitHub Actions workflow whose environment
    // required a named reviewer, so every scheduled run parked waiting for an
    // approval a cron cannot give. Membership then aged past the freshness
    // bound in trusted-group-access.ts and refused everyone.
    const named = resourceEntries('AWS::Events::Rule').filter(
      ([, resource]) =>
        properties(resource).Name ===
        'psd-eoc-access-membership-sync-every-two-hours',
    );
    expect(named).toHaveLength(1);
    const ruleEntry = named[0];
    if (ruleEntry === undefined)
      throw new Error('Missing the access-sync schedule.');
    const rule = properties(ruleEntry[1]);
    expect(rule.State).toBe('ENABLED');
    // Well inside MEMBERSHIP_FRESHNESS_MS (24h), so several consecutive
    // failures still deny nobody.
    expect(rule.ScheduleExpression).toBe('cron(0 */2 * * ? *)');

    const targets = asArray(rule.Targets).map(asRecord);
    expect(targets).toHaveLength(1);
    const target = targets[0];
    if (target === undefined) throw new Error('Missing access-sync target.');
    expect(JSON.stringify(target.Arn)).toContain('BootstrapEcsCluster');

    const ecsParameters = asRecord(target.EcsParameters);
    expect(ecsParameters.LaunchType).toBe('FARGATE');
    expect(ecsParameters.TaskCount).toBe(1);
    expect(JSON.stringify(ecsParameters.TaskDefinitionArn)).toContain(
      'AccessSyncTaskDefinition',
    );
    const network = asRecord(
      asRecord(ecsParameters.NetworkConfiguration).AwsVpcConfiguration,
    );
    // Private subnets reaching Google only through the NAT path.
    expect(network.AssignPublicIp).toBe('DISABLED');
    expect(JSON.stringify(network.SecurityGroups)).toContain(
      'ApplicationSecurityGroup',
    );
    expect(asArray(network.Subnets)).toHaveLength(2);
    expect(JSON.stringify(network.Subnets)).toContain('ApplicationSubnet');
  });

  it('gives the scheduler only the authority to start that one task', () => {
    const eventsRole = roleLogicalIdForServicePrincipal('events.amazonaws.com');
    const statements = inlineStatementsForRole(eventsRole);
    expect([...new Set(allAllowedActions(statements))].sort()).toEqual(
      ['ecs:RunTask', 'ecs:TagResource', 'iam:PassRole'].sort(),
    );

    const runTask = statements.filter((statement) =>
      asStringArray(statement.Action).includes('ecs:RunTask'),
    );
    expect(runTask).toHaveLength(1);
    const runTaskStatement = runTask[0];
    if (runTaskStatement === undefined)
      throw new Error('Missing ecs:RunTask statement.');
    // Scoped to the exact task definition, inside the exact cluster.
    expect(JSON.stringify(runTaskStatement.Resource)).toContain(
      'AccessSyncTaskDefinition',
    );
    expect(JSON.stringify(runTaskStatement.Condition)).toContain(
      'BootstrapEcsCluster',
    );

    // It may hand over the two access-sync roles and nothing else — notably not
    // the App Runner runtime role or the database admin path.
    const passRole = JSON.stringify(
      statements
        .filter((statement) =>
          asStringArray(statement.Action).includes('iam:PassRole'),
        )
        .map((statement) => statement.Resource),
    );
    expect(passRole).toContain('AccessSyncTaskExecutionRole');
    expect(passRole).toContain('AccessSyncTaskRole');
    expect(passRole).not.toContain('AppRunnerRuntimeRole');
    expect(passRole).not.toContain('BootstrapTaskRole');
  });
});

describe('protected access-membership publication boundary', () => {
  it('pins a dedicated private task to app credentials and the whole readonly Groups secret', () => {
    const task = properties(taskDefinitionByFamily('psd-eoc-access-sync'));
    expect(task.Cpu).toBe('256');
    expect(task.Memory).toBe('512');
    expect(task.NetworkMode).toBe('awsvpc');
    expect(task.RequiresCompatibilities).toEqual(['FARGATE']);
    const containers = asArray(task.ContainerDefinitions).map(asRecord);
    expect(containers).toHaveLength(1);
    const container = containers[0];
    if (container === undefined)
      throw new Error('Missing access-sync container.');
    expect(container.Name).toBe('access-membership-sync');
    expect(container.Command).toEqual([
      'bun',
      'packages/server/scripts/operations/sync-access-membership.ts',
    ]);
    expect(container.ReadonlyRootFilesystem).toBe(true);
    expect(container).not.toHaveProperty('Privileged');
    expect(JSON.stringify(container.Image)).toContain('BootstrapImageDigest');
    expect(JSON.stringify(container.Image)).not.toContain('AppImageDigest');

    const environment = new Map(
      asArray(container.Environment).map((item) => {
        const pair = asRecord(item);
        return [String(pair.Name), pair.Value];
      }),
    );
    expect([...environment.keys()].sort()).toEqual(
      [
        'AWS_ACCOUNT_ID',
        'AWS_REGION',
        'DATABASE_CONNECT_TIMEOUT_SECONDS',
        'DATABASE_DRIVER',
        'DATABASE_HOST',
        'DATABASE_IDLE_TIMEOUT_SECONDS',
        'DATABASE_MAX_CONNECTIONS',
        'DATABASE_NAME',
        'DATABASE_PORT',
        'DATABASE_SSL_ROOT_CERT',
        'GOOGLE_OIDC_HOSTED_DOMAIN',
        'SOURCE_SHA',
        'TMPDIR',
      ].sort(),
    );
    expect(environment.get('SOURCE_SHA')).toEqual({
      Ref: 'BootstrapSourceSha',
    });
    // Without this the task cannot resolve a member address against the
    // district's staff domain, and every run fails closed with
    // `GOOGLE_OIDC_HOSTED_DOMAIN must be configured.` — which is exactly what
    // happened from the deploy that made the auth values configuration.
    expect(environment.get('GOOGLE_OIDC_HOSTED_DOMAIN')).toBe(
      'example.invalid',
    );
    expect(JSON.stringify(environment)).not.toContain('DATABASE_ADMIN');
    expect(JSON.stringify(environment)).not.toContain('APPROVED_');

    const secrets = new Map(
      asArray(container.Secrets).map((item) => {
        const pair = asRecord(item);
        return [String(pair.Name), pair.ValueFrom];
      }),
    );
    expect([...secrets.keys()].sort()).toEqual([
      'DATABASE_PASSWORD',
      'DATABASE_USERNAME',
      'GOOGLE_ROSTER_CONFIG',
      'PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256',
    ]);
    expect(JSON.stringify(secrets.get('DATABASE_PASSWORD'))).toContain(
      ':password::',
    );
    expect(JSON.stringify(secrets.get('DATABASE_USERNAME'))).toContain(
      ':username::',
    );
    // The reference must be the complete-ARN parameter, never the bare secret
    // name. A suffix-less ARN whose name ends in a hyphen plus six characters
    // ("-groups") is parsed by Secrets Manager as name "/psd-eoc/google" with
    // suffix "groups", which resolves to nothing and surfaces as AccessDenied.
    expect(JSON.stringify(secrets.get('GOOGLE_ROSTER_CONFIG'))).toContain(
      'GoogleGroupsSecretArn',
    );
    expect(JSON.stringify(secrets.get('GOOGLE_ROSTER_CONFIG'))).not.toContain(
      "secret:/psd-eoc/google-groups'",
    );
    expect(
      JSON.stringify(
        secrets.get('PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256'),
      ),
    ).toContain(':initialMobileTransitionEmailSha256::');
    const serializedSecretReferences = JSON.stringify([...secrets.values()]);
    expect(serializedSecretReferences).not.toContain('DatabaseAdminSecret');
    expect(serializedSecretReferences).toContain('BootstrapIdentitySecret');

    const logging = asRecord(container.LogConfiguration);
    expect(logging.LogDriver).toBe('awslogs');
    expect(asRecord(logging.Options)['awslogs-stream-prefix']).toBe(
      'access-membership-sync',
    );
  });

  it('keeps provider reads on the execution role and gives the task no AWS authority', () => {
    const executionRole = roleLogicalIdForDescription(
      'Pulls the reviewed access-sync image',
    );
    const statements = inlineStatementsForRole(executionRole);
    expect([...new Set(allAllowedActions(statements))].sort()).toEqual(
      [
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage',
        'ecr:GetAuthorizationToken',
        'ecr:GetDownloadUrlForLayer',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
      ].sort(),
    );
    const secretResources = JSON.stringify(
      statements
        .filter((statement) =>
          asStringArray(statement.Action).includes(
            'secretsmanager:GetSecretValue',
          ),
        )
        .map((statement) => statement.Resource),
    );
    expect(secretResources).toContain('DatabaseApplicationSecret');
    // Granted on the complete-ARN parameter so the grant matches the exact
    // ARN the task definition requests. A `<arn>-??????` wildcard grant can
    // never match a suffix-less request.
    expect(secretResources).toContain('GoogleGroupsSecretArn');
    expect(secretResources).not.toContain('google-groups-??????');
    expect(secretResources).toContain('BootstrapIdentitySecret');
    expect(secretResources).not.toContain('DatabaseAdminSecret');
    expect(secretResources).not.toContain('GoogleOauthSecretArn');

    const taskRole = roleLogicalIdForDescription(
      'No-authority task role for protected access-membership',
    );
    expect(inlineStatementsForRole(taskRole)).toEqual([]);
    expect(
      resourceEntries('AWS::IAM::Policy').some(([, policy]) =>
        JSON.stringify(properties(policy).Roles).includes(taskRole),
      ),
    ).toBe(false);
  });
});

describe('alarm topic delivery', () => {
  it('leaves the alarm topics unencrypted so a confirmation can be sent', () => {
    // Encrypted with a customer-managed key, neither topic could deliver an
    // email subscription confirmation: it was created with the right address
    // and stayed PendingConfirmation indefinitely, no error recorded anywhere,
    // no KMS call ever made, and granting sns.amazonaws.com the key did not
    // change it. The topics in this account that do reach the same mailbox are
    // unencrypted. Re-encrypting these would silently stop every page.
    const alarmTopics = resourceEntries('AWS::SNS::Topic').filter(
      ([, resource]) =>
        String(properties(resource).TopicName).endsWith('-alarms'),
    );
    expect(
      alarmTopics.map(([, resource]) => properties(resource).TopicName).sort(),
    ).toEqual(['psd-eoc-critical-alarms', 'psd-eoc-operations-alarms']);
    for (const [, resource] of alarmTopics) {
      expect(properties(resource)).not.toHaveProperty('KmsMasterKeyId');
    }

    // Adding any statement to a topic policy replaces the implicit default that
    // grants the owning account Subscribe and Receive. Without it an endpoint
    // may not receive, so the subscription confirmation is never delivered and
    // the subscription sits in PendingConfirmation with no error anywhere.
    for (const [, resource] of resourceEntries('AWS::SNS::TopicPolicy').filter(
      ([logicalId]) => logicalId.includes('Alarm'),
    )) {
      const statements = asArray(
        asRecord(properties(resource).PolicyDocument).Statement,
      ).map(asRecord);
      const owner = statements.find(
        (statement) => statement.Sid === '__default_statement_ID',
      );
      expect(owner).toBeDefined();
      expect(owner?.Action).toContain('SNS:Receive');
      expect(owner?.Action).toContain('SNS:Subscribe');
      expect(owner?.Condition).toEqual({
        StringEquals: { 'AWS:SourceOwner': AWS_ACCOUNT },
      });
    }

    // An alarm still has to be able to publish, which is a topic policy and
    // never depended on encryption.
    const publishSids = resourceEntries('AWS::SNS::TopicPolicy').flatMap(
      ([, resource]) =>
        asArray(asRecord(properties(resource).PolicyDocument).Statement)
          .map(asRecord)
          // Some statements use a bare "*" principal, so this cannot assume
          // every Principal is an object.
          .filter((statement) =>
            JSON.stringify(statement.Principal).includes(
              'cloudwatch.amazonaws.com',
            ),
          )
          .map((statement) => statement.Sid),
    );
    expect(publishSids).toEqual([
      'AllowScopedCloudWatchAlarmPublish',
      'AllowScopedCloudWatchAlarmPublish',
    ]);

    // The operations key survives for the monitoring log groups, which do want
    // encryption and are not on the paging path.
    const operationsKey = asRecord(
      resourceEntries('AWS::KMS::Key').find(([, resource]) =>
        String(properties(resource).Description).startsWith(
          'Encrypts PSD EOC operational alarm notifications',
        ),
      )?.[1],
    );
    const sids = asArray(
      asRecord(properties(operationsKey).KeyPolicy).Statement,
    )
      .map(asRecord)
      .map((statement) => statement.Sid)
      .filter((sid) => sid !== undefined);
    expect(sids).toEqual(['AllowMonitoringLogGroupEncryption']);
  });
});

describe('delivery router boundary', () => {
  it('moves batches between queues and can do nothing else', () => {
    const router = resourceEntries('AWS::Lambda::Function').find(
      ([, resource]) =>
        properties(resource).FunctionName === 'psd-eoc-delivery-router',
    );
    const routerProperties = properties(asRecord(router?.[1]));

    // Outside the VPC on purpose: it speaks only to SQS, so it needs neither a
    // database route nor the NAT path, and it cannot reach Aurora.
    expect(routerProperties).not.toHaveProperty('VpcConfig');
    expect(routerProperties.Runtime).toBe('nodejs22.x');
    expect(routerProperties.ReservedConcurrentExecutions).toBe(5);

    const environment = asRecord(
      asRecord(routerProperties.Environment).Variables,
    );
    expect(Object.keys(environment).sort()).toEqual([
      'EMAIL_QUEUE_URL',
      'PUSH_QUEUE_URL',
      'SMS_QUEUE_URL',
    ]);

    const roleReference = JSON.stringify(routerProperties.Role);
    const routerRole = resourceEntries('AWS::IAM::Role').find(([logicalId]) =>
      roleReference.includes(logicalId),
    );
    const statements = inlineStatementsForRole(String(routerRole?.[0]));
    const actions = [...new Set(allAllowedActions(statements))].sort();

    // Reading its source queue and writing the channel queues. No provider
    // action, no database, no secret, and nothing that could start or change an
    // event.
    for (const action of actions) {
      expect(action.startsWith('sqs:')).toBe(true);
    }
    expect(actions).toContain('sqs:ReceiveMessage');
    expect(actions).toContain('sqs:SendMessage');
    for (const forbidden of ['ses:', 'sns:', 'rds', 'secretsmanager:', 's3:']) {
      expect(actions.some((action) => action.startsWith(forbidden))).toBe(
        false,
      );
    }

    // It may write the three channel queues, and must not be able to write its
    // own source queue back onto itself.
    const targets = JSON.stringify(
      statements.map((statement) => statement.Resource),
    );
    for (const reachable of ['EmailQueue', 'SmsQueue', 'PushQueue']) {
      expect(targets).toContain(reachable);
    }
    const sendTargets = JSON.stringify(
      statements
        .filter((statement) =>
          asStringArray(statement.Action).includes('sqs:SendMessage'),
        )
        .map((statement) => statement.Resource),
    );
    expect(sendTargets).not.toContain('DeliveryQueue');
  });
});

describe('configured-unverified provider readiness boundary', () => {
  it('creates no provider identity, DNS, media, channel worker, or custom resource', () => {
    for (const forbiddenType of [
      'AWS::Route53::HostedZone',
      'AWS::Route53::RecordSet',
      'AWS::S3::Bucket',
      'AWS::Scheduler::Schedule',
      'AWS::SES::EmailIdentity',
    ]) {
      template.resourceCountIs(forbiddenType, 0);
    }
    // Monitoring introduces compute and schedules, so the boundary is stated
    // by name rather than by count: the only function is the Aurora failover
    // bridge, and the only rules drive it, a targetless human reminder, and the
    // access-membership refresh that keeps sign-in from aging out.
    expect(
      resourceEntries('AWS::Lambda::Function')
        .map(([, resource]) => String(properties(resource).FunctionName))
        .sort(),
    ).toEqual([
      'psd-eoc-alarm-mailer',
      'psd-eoc-aurora-failover-metric',
      'psd-eoc-delivery-router',
    ]);
    expect(
      resourceEntries('AWS::Events::Rule')
        .map(([, resource]) => String(properties(resource).Name))
        .sort(),
    ).toEqual([
      'psd-eoc-access-membership-sync-every-two-hours',
      'psd-eoc-aurora-failover-events',
      'psd-eoc-monthly-live-delivery-test-due-reminder',
    ]);
    // Exactly one consumer exists, and it is the router: it moves a batch from
    // the delivery queue to a channel queue. No channel worker is deployed, so
    // nothing yet drains a channel queue and nothing reaches a provider.
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.resourceCountIs('AWS::ECS::Service', 0);
    const mapping = properties(onlyResource('AWS::Lambda::EventSourceMapping'));
    expect(JSON.stringify(mapping.EventSourceArn)).toContain('DeliveryQueue');
    expect(mapping.FunctionResponseTypes).toEqual(['ReportBatchItemFailures']);
    // Alarm email goes through the mailer rather than an SNS email
    // subscription, so there is no unsubscribe link and no confirmation step in
    // the paging path. SMS stays a direct subscription; it auto-confirms and
    // carries no such link.
    expect(
      resourceEntries('AWS::SNS::Subscription')
        .map(([, resource]) => String(properties(resource).Protocol))
        .sort(),
    ).toEqual(['lambda', 'lambda', 'sms', 'sms']);
    expect(
      Object.values(resources).some((resource) =>
        String(asRecord(resource).Type).startsWith('Custom::'),
      ),
    ).toBe(false);
    const serializedTemplate = JSON.stringify(synthesized);
    expect(serializedTemplate).not.toContain('rds-data:');
    expect(serializedTemplate).not.toContain('aws-data-api');
    expect(serializedTemplate).not.toContain('DATABASE_RESOURCE_ARN');
    expect(serializedTemplate).not.toContain('DATABASE_SECRET_ARN');
    // ses:SendEmail exists exactly once, on the alarm mailer, and is confined by
    // condition to the operational alarm sender. That is not the staff
    // notification path: the mailer has no roster, no database, no recipient
    // from a snapshot, and cannot send as the notification address. Nothing
    // else in the stack may send mail at all, and SendRawEmail exists nowhere.
    expect(serializedTemplate).not.toContain('ses:SendRawEmail');
    const sesSenders = resourceEntries('AWS::IAM::Policy').filter(
      ([, resource]) =>
        JSON.stringify(properties(resource).PolicyDocument).includes(
          'ses:SendEmail',
        ),
    );
    expect(sesSenders).toHaveLength(1);
    const sesStatement = asArray(
      asRecord(properties(asRecord(sesSenders[0]?.[1])).PolicyDocument)
        .Statement,
    )
      .map(asRecord)
      .find((statement) =>
        asStringArray(statement.Action).includes('ses:SendEmail'),
      );
    expect(sesStatement?.Condition).toEqual({
      StringEquals: {
        'ses:FromAddress': `eoc-alarms@${SES_IDENTITY_DOMAIN}`,
      },
    });
    expect(JSON.stringify(sesSenders[0]?.[1])).toContain('AlarmMailer');
    expect(serializedTemplate).not.toContain('controlled-recipient');
  });

  it('configures the importable SES evidence path dark and records the external destination boundary', () => {
    const configurationSetResource = onlyResource('AWS::SES::ConfigurationSet');
    const configurationSet = properties(configurationSetResource);
    expect(configurationSet.Name).toBe(SES_CONFIGURATION_SET_NAME);
    expect(configurationSet.SendingOptions).toEqual({
      SendingEnabled: false,
    });
    expect(configurationSet.ReputationOptions).toEqual({
      ReputationMetricsEnabled: true,
    });
    expect(configurationSetResource.DeletionPolicy).toBe('Retain');
    expect(configurationSetResource.UpdateReplacePolicy).toBe('Retain');

    template.resourceCountIs('AWS::SES::ConfigurationSetEventDestination', 0);

    const topicResource = asRecord(
      resourceEntries('AWS::SNS::Topic').find(
        ([, resource]) =>
          properties(resource).TopicName === SES_EVENT_TOPIC_NAME,
      )?.[1],
    );
    const topic = properties(topicResource);
    expect(topic.TopicName).toBe(SES_EVENT_TOPIC_NAME);
    expect(topic.KmsMasterKeyId).toEqual({
      'Fn::GetAtt': [expect.stringContaining('EmailEventsKey'), 'Arn'],
    });
    expect(topicResource.DeletionPolicy).toBe('Retain');
    expect(topicResource.UpdateReplacePolicy).toBe('Retain');

    const topicPolicy = properties(
      asRecord(
        resourceEntries('AWS::SNS::TopicPolicy').find(([, resource]) =>
          JSON.stringify(properties(resource).Topics).includes(
            'EmailEventsTopic',
          ),
        )?.[1],
      ),
    );
    const topicStatements = asArray(
      asRecord(topicPolicy.PolicyDocument).Statement,
    ).map(asRecord);
    const sesPublish = topicStatements.find(
      (statement) =>
        statement.Effect === 'Allow' &&
        asStringArray(statement.Action).includes('sns:Publish'),
    );
    expect(sesPublish).toBeDefined();
    expect(sesPublish?.Principal).toEqual({ Service: 'ses.amazonaws.com' });
    expect(sesPublish?.Condition).toEqual({
      StringEquals: {
        'AWS:SourceAccount': AWS_ACCOUNT,
        'AWS:SourceArn': `arn:aws:ses:${AWS_REGION}:${AWS_ACCOUNT}:configuration-set/${SES_CONFIGURATION_SET_NAME}`,
      },
    });

    // Two keys exist; this assertion is about the SES event-evidence one.
    const keyResource = asRecord(
      resourceEntries('AWS::KMS::Key').find(([, resource]) =>
        String(properties(resource).Description).startsWith(
          'Encrypts configured-unverified SES event evidence',
        ),
      )?.[1],
    );
    const key = properties(keyResource);
    expect(key.EnableKeyRotation).toBe(true);
    expect(keyResource.DeletionPolicy).toBe('Retain');
    expect(keyResource.UpdateReplacePolicy).toBe('Retain');
    const keyStatements = asArray(asRecord(key.KeyPolicy).Statement).map(
      asRecord,
    );
    const sesKeyUse = keyStatements.find(
      (statement) => statement.Sid === 'AllowSesEmailEventEncryption',
    );
    expect(sesKeyUse?.Action).toEqual(['kms:Decrypt', 'kms:GenerateDataKey*']);
    expect(sesKeyUse?.Principal).toEqual({ Service: 'ses.amazonaws.com' });
    expect(sesKeyUse?.Condition).toEqual({
      StringEquals: {
        'AWS:SourceAccount': AWS_ACCOUNT,
        'AWS:SourceArn': `arn:aws:ses:${AWS_REGION}:${AWS_ACCOUNT}:configuration-set/${SES_CONFIGURATION_SET_NAME}`,
      },
    });
  });

  it('exposes readiness state without credentials or recipient identifiers', () => {
    const outputs = asRecord(synthesized.Outputs);
    expect(Object.keys(outputs).sort()).toEqual(
      [
        'AccessSyncTaskDefinitionArn',
        'AccessSyncTaskExecutionRoleArn',
        'AccessSyncTaskRoleArn',
        'ApprovedIdentitySecretArn',
        'AppRunnerHealthCheckUrl',
        'AppRunnerImageAccessRoleArn',
        'AppRunnerServiceArn',
        'AppRunnerServiceUrl',
        'AppRunnerVpcConnectorArn',
        'BootstrapCandidateImageDigest',
        'BootstrapCandidateSourceSha',
        'BootstrapEcsClusterArn',
        'BootstrapLogGroupName',
        'BootstrapPrivateSubnetIds',
        'BootstrapSecurityGroupId',
        'BootstrapTaskDefinitionArn',
        'BootstrapTaskExecutionRoleArn',
        'BootstrapTaskRoleArn',
        'DataClassification',
        'DatabaseAdminSecretArn',
        'DatabaseApplicationSecretArn',
        'DatabaseClusterArn',
        'DatabaseName',
        'DeploymentAccount',
        'DeploymentRegion',
        'DeployedAppImageDigest',
        'DeployedAppSourceSha',
        'EmailChannelState',
        'EmailDeadLetterQueueArn',
        'EmailQueueArn',
        'EmailQueueUrl',
        'EmailWorkerLogGroupName',
        'EmailWorkerRoleArn',
        'EnvironmentName',
        'ExpectedAwsAccountAlias',
        'HealthQueueArn',
        'HealthQueueUrl',
        'ImageRepositoryArn',
        'ImageRepositoryUri',
        'MonitoringDashboardName',
        'MonitoringDashboardUrl',
        'RuntimeRoleArn',
        'SesConfigurationSetName',
        'SesEmailEventDestinationManagement',
        'SesEmailEventDestinationName',
        'SesEmailEventsKeyArn',
        'SesEmailEventsTopicArn',
        'SesFromAddress',
        'SesIdentityArn',
        'SesIdentityDomain',
        'SesIntegrationTruth',
      ].sort(),
    );
    const serializedOutputs = JSON.stringify(outputs);
    expect(serializedOutputs).not.toContain('GoogleOauthSecretArn');
    expect(serializedOutputs).not.toContain('GoogleOidcCookieSecret');
    expect(serializedOutputs).not.toContain('ApiSaltSecret');
    expect(serializedOutputs).not.toContain('eoc.psd401.net');
    expect(serializedOutputs).not.toContain('controlled-recipient');
    expect(asRecord(outputs.SesIdentityDomain).Value).toBe(SES_IDENTITY_DOMAIN);
    expect(asRecord(outputs.SesFromAddress).Value).toBe(SES_FROM_ADDRESS);
    expect(asRecord(outputs.SesEmailEventDestinationName).Value).toBe(
      SES_EVENT_DESTINATION_NAME,
    );
    expect(asRecord(outputs.SesEmailEventDestinationManagement).Value).toBe(
      'external-readback',
    );
    expect(asRecord(outputs.SesIntegrationTruth).Value).toBe(
      'configured-unverified',
    );
    expect(asRecord(outputs.EmailChannelState).Value).toBe('disabled');
    expect(asRecord(outputs.BootstrapCandidateImageDigest).Value).toEqual({
      Ref: 'BootstrapImageDigest',
    });
    expect(asRecord(outputs.DeployedAppImageDigest).Value).toEqual({
      Ref: 'AppImageDigest',
    });
    expect(asRecord(outputs.BootstrapCandidateSourceSha).Value).toEqual({
      Ref: 'BootstrapSourceSha',
    });
    expect(asRecord(outputs.DeployedAppSourceSha).Value).toEqual({
      Ref: 'SourceSha',
    });
    for (const outputName of [
      'AppRunnerHealthCheckUrl',
      'AppRunnerServiceArn',
      'AppRunnerServiceUrl',
    ]) {
      expect(asRecord(outputs[outputName]).Condition).toBe(
        'ShouldProvisionApplication',
      );
    }
  });
});
