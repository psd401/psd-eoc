import { describe, expect, it } from 'bun:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import {
  EXPLORATION_SMOKE_ACCOUNT,
  EXPLORATION_SMOKE_ACCOUNT_ALIAS,
  EXPLORATION_SMOKE_BOOTSTRAP_LOG_GROUP_NAME,
  EXPLORATION_SMOKE_DATABASE_IDENTIFIER,
  EXPLORATION_SMOKE_DATABASE_NAME,
  EXPLORATION_SMOKE_DATABASE_PORT,
  EXPLORATION_SMOKE_DATABASE_SSL_ROOT_CERT,
  EXPLORATION_SMOKE_DATA_CLASSIFICATION,
  EXPLORATION_SMOKE_ENVIRONMENT,
  EXPLORATION_SMOKE_HEALTH_PATH,
  EXPLORATION_SMOKE_IMAGE_DIGEST_SENTINEL,
  EXPLORATION_SMOKE_QUEUE_NAME,
  EXPLORATION_SMOKE_REGION,
  EXPLORATION_SMOKE_REPOSITORY_NAME,
  EXPLORATION_SMOKE_STACK_NAME,
} from '../../src/exploration-smoke/config';
import { ExplorationSmokeStack } from '../../src/exploration-smoke/exploration-smoke-stack';

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

const app = new App();
const stack = new ExplorationSmokeStack(app, EXPLORATION_SMOKE_STACK_NAME, {
  env: {
    account: EXPLORATION_SMOKE_ACCOUNT,
    region: EXPLORATION_SMOKE_REGION,
  },
  stackName: EXPLORATION_SMOKE_STACK_NAME,
});
const template = Template.fromStack(stack);
const synthesized = asRecord(template.toJSON());
const resources = asRecord(synthesized.Resources);

describe('exploration-smoke deployment boundary', () => {
  it('rejects every account and region except the approved psd401 target', () => {
    expect(EXPLORATION_SMOKE_ACCOUNT_ALIAS).toBe('psd401');
    expect(EXPLORATION_SMOKE_ACCOUNT).toBe('338414773271');
    expect(EXPLORATION_SMOKE_REGION).toBe('us-west-2');

    expect(
      () =>
        new ExplorationSmokeStack(new App(), 'WrongAccount', {
          env: { account: '000000000000', region: EXPLORATION_SMOKE_REGION },
        }),
    ).toThrow(
      `AWS account ${EXPLORATION_SMOKE_ACCOUNT} (${EXPLORATION_SMOKE_ACCOUNT_ALIAS})`,
    );
    expect(
      () =>
        new ExplorationSmokeStack(new App(), 'WrongRegion', {
          env: { account: EXPLORATION_SMOKE_ACCOUNT, region: 'us-east-1' },
        }),
    ).toThrow(`in ${EXPLORATION_SMOKE_REGION}`);
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
    const subject = asRecord(parameters.ApprovedGoogleSubject);
    const email = asRecord(parameters.ApprovedStaffEmail);
    const displayName = asRecord(parameters.ApprovedStaffDisplayName);

    expect(provision.AllowedValues).toEqual(['false', 'true']);
    expect(provision).not.toHaveProperty('Default');
    expect(appDigest.Default).toBe(EXPLORATION_SMOKE_IMAGE_DIGEST_SENTINEL);
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
      '^arn:aws:secretsmanager:us-west-2:338414773271:secret:/psd-eoc/exploration-smoke/google-oauth-[A-Za-z0-9]{6}$',
    );
    expect(subject.NoEcho).toBe(true);
    expect(subject).not.toHaveProperty('Default');
    expect(email.NoEcho).toBe(true);
    expect(email).not.toHaveProperty('Default');
    expect(displayName.NoEcho).toBe(true);
    expect(displayName).not.toHaveProperty('Default');
    expect(displayName.AllowedPattern).toBe("^[A-Za-z0-9 .,'()&-]{1,160}$");

    const rules = asRecord(synthesized.Rules);
    const digestRule = asRecord(rules.ApplicationRequiresPublishedDigest);
    expect(digestRule.RuleCondition).toEqual({
      'Fn::Equals': [{ Ref: 'ProvisionApplication' }, 'true'],
    });
    expect(JSON.stringify(digestRule.Assertions)).toContain(
      EXPLORATION_SMOKE_IMAGE_DIGEST_SENTINEL,
    );
    const bootstrapRule = asRecord(rules.BootstrapRequiresPublishedDigest);
    expect(bootstrapRule).not.toHaveProperty('RuleCondition');
    expect(JSON.stringify(bootstrapRule.Assertions)).toContain(
      EXPLORATION_SMOKE_IMAGE_DIGEST_SENTINEL,
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

  it('tags every stateful or executable resource as isolated synthetic data', () => {
    const taggableTypes = [
      'AWS::AppRunner::AutoScalingConfiguration',
      'AWS::AppRunner::Service',
      'AWS::AppRunner::VpcConnector',
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
        expect(tags.get('Environment')).toBe(EXPLORATION_SMOKE_ENVIRONMENT);
        expect(tags.get('DataClassification')).toBe(
          EXPLORATION_SMOKE_DATA_CLASSIFICATION,
        );
        expect(tags.get('ExpectedAwsAccountAlias')).toBe(
          EXPLORATION_SMOKE_ACCOUNT_ALIAS,
        );
      }
    }
  });
});

describe('minimal isolated resource shape', () => {
  it('creates one bounded native application and bootstrap topology', () => {
    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.resourceCountIs('AWS::RDS::DBCluster', 1);
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.resourceCountIs('AWS::AppRunner::Service', 1);
    template.resourceCountIs('AWS::AppRunner::AutoScalingConfiguration', 1);
    template.resourceCountIs('AWS::AppRunner::VpcConnector', 1);
    template.resourceCountIs('AWS::ECS::Cluster', 1);
    template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
    template.resourceCountIs('AWS::ECS::Service', 0);
    template.resourceCountIs('AWS::Logs::LogGroup', 1);
    template.resourceCountIs('AWS::SQS::Queue', 1);
    template.resourceCountIs('AWS::SecretsManager::Secret', 5);

    const repository = properties(onlyResource('AWS::ECR::Repository'));
    expect(repository.RepositoryName).toBe(EXPLORATION_SMOKE_REPOSITORY_NAME);
    expect(repository.ImageTagMutability).toBe('IMMUTABLE');
    expect(repository.ImageScanningConfiguration).toEqual({ ScanOnPush: true });
    expect(JSON.stringify(repository.LifecyclePolicy)).toContain(
      'imageCountMoreThan',
    );

    const queue = properties(onlyResource('AWS::SQS::Queue'));
    expect(queue.QueueName).toBe(EXPLORATION_SMOKE_QUEUE_NAME);
    expect(queue.SqsManagedSseEnabled).toBe(true);
    expect(queue.MessageRetentionPeriod).toBe(86_400);
    expect(queue).not.toHaveProperty('RedrivePolicy');
  });

  it('preserves Aurora and database subnets while enabling only native PostgreSQL', () => {
    const clusterResource = onlyResource('AWS::RDS::DBCluster');
    const cluster = properties(clusterResource);
    const scaling = asRecord(cluster.ServerlessV2ScalingConfiguration);
    const writerResource = onlyResource('AWS::RDS::DBInstance');
    const writer = properties(writerResource);

    expect(cluster.DBClusterIdentifier).toBe(
      EXPLORATION_SMOKE_DATABASE_IDENTIFIER,
    );
    expect(cluster.DatabaseName).toBe(EXPLORATION_SMOKE_DATABASE_NAME);
    expect(cluster.Engine).toBe('aurora-postgresql');
    expect(cluster.EnableHttpEndpoint).toBe(false);
    expect(cluster.StorageEncrypted).toBe(true);
    expect(cluster.DeletionProtection).toBe(false);
    expect(cluster.BackupRetentionPeriod).toBe(1);
    expect(scaling).toEqual({ MaxCapacity: 1, MinCapacity: 0.5 });
    expect(clusterResource.DeletionPolicy).toBe('Snapshot');
    expect(clusterResource.UpdateReplacePolicy).toBe('Snapshot');

    expect(writer.DBInstanceClass).toBe('db.serverless');
    expect(writer.PromotionTier).toBe(0);
    expect(writer.PubliclyAccessible).toBe(false);
    expect(writer.AvailabilityZone).toBe(`${EXPLORATION_SMOKE_REGION}a`);
    expect(writerResource.DeletionPolicy).toBe('Delete');
    expect(writerResource.UpdateReplacePolicy).toBe('Delete');

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
    template.resourceCountIs('AWS::Lambda::Function', 0);
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
        properties(resource).GroupName ===
        'psd-eoc-exploration-smoke-application',
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
    expect(ingress.FromPort).toBe(EXPLORATION_SMOKE_DATABASE_PORT);
    expect(ingress.ToPort).toBe(EXPLORATION_SMOKE_DATABASE_PORT);
    expect(ingress.IpProtocol).toBe('tcp');
    expect(JSON.stringify(ingress.GroupId)).toContain(databaseSecurityGroup[0]);
    expect(JSON.stringify(ingress.SourceSecurityGroupId)).toContain(
      applicationSecurityGroup[0],
    );
    expect(ingress).not.toHaveProperty('CidrIp');

    const databaseEgress = properties(
      onlyResource('AWS::EC2::SecurityGroupEgress'),
    );
    expect(databaseEgress.FromPort).toBe(EXPLORATION_SMOKE_DATABASE_PORT);
    expect(databaseEgress.ToPort).toBe(EXPLORATION_SMOKE_DATABASE_PORT);
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
        '/psd-eoc/exploration-smoke/api-salt',
        '/psd-eoc/exploration-smoke/bootstrap/approved-identity',
        '/psd-eoc/exploration-smoke/database/admin',
        '/psd-eoc/exploration-smoke/database/application',
        '/psd-eoc/exploration-smoke/google-oidc-cookie-secret',
      ].sort(),
    );
    for (const name of [
      '/psd-eoc/exploration-smoke/api-salt',
      '/psd-eoc/exploration-smoke/database/admin',
      '/psd-eoc/exploration-smoke/database/application',
      '/psd-eoc/exploration-smoke/google-oidc-cookie-secret',
    ]) {
      const resource = byName.get(name);
      expect(resource).toBeDefined();
      const secret = properties(resource ?? {});
      expect(secret.GenerateSecretString).toBeDefined();
      expect(secret).not.toHaveProperty('SecretString');
      expect(resource?.DeletionPolicy).toBe('Delete');
      expect(resource?.UpdateReplacePolicy).toBe('Delete');
    }

    const identity = byName.get(
      '/psd-eoc/exploration-smoke/bootstrap/approved-identity',
    );
    expect(identity).toBeDefined();
    const identitySecretString = JSON.stringify(
      properties(identity ?? {}).SecretString,
    );
    expect(identitySecretString).toContain('googleSubject');
    expect(identitySecretString).toContain('ApprovedGoogleSubject');
    expect(identitySecretString).toContain('staffDisplayName');
    expect(identitySecretString).toContain('ApprovedStaffDisplayName');
    expect(identitySecretString).toContain('staffEmail');
    expect(identitySecretString).toContain('ApprovedStaffEmail');
    expect(synthesized).not.toHaveProperty('Transform');
    expect(identity?.DeletionPolicy).toBe('Delete');
    expect(identity?.UpdateReplacePolicy).toBe('Delete');

    const admin = asRecord(
      properties(byName.get('/psd-eoc/exploration-smoke/database/admin') ?? {})
        .GenerateSecretString,
    );
    expect(admin.SecretStringTemplate).toBe(
      JSON.stringify({ username: 'psd_eoc_admin' }),
    );
    expect(admin.ExcludePunctuation).toBe(true);

    const application = asRecord(
      properties(
        byName.get('/psd-eoc/exploration-smoke/database/application') ?? {},
      ).GenerateSecretString,
    );
    expect(application.SecretStringTemplate).toBe(
      JSON.stringify({ username: 'psd_eoc_application' }),
    );
    expect(application.ExcludePunctuation).toBe(true);

    const cookie = asRecord(
      properties(
        byName.get('/psd-eoc/exploration-smoke/google-oidc-cookie-secret') ??
          {},
      ).GenerateSecretString,
    );
    expect(cookie.PasswordLength).toBe(43);
    expect(cookie.ExcludePunctuation).toBe(true);
  });
});

describe('App Runner runtime safety boundary', () => {
  it('pins the service to a digest and exactly one provisioned instance', () => {
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
    expect(asRecord(serviceProperties.HealthCheckConfiguration).Path).toBe(
      EXPLORATION_SMOKE_HEALTH_PATH,
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
  });

  it('injects only the required synthetic runtime and Google OIDC contract', () => {
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
        'DATABASE_IDLE_TIMEOUT_SECONDS',
        'DATABASE_MAX_CONNECTIONS',
        'DATABASE_NAME',
        'DATABASE_PORT',
        'DATABASE_SSL_ROOT_CERT',
        'FANOUT_QUEUE_URL',
        'NODE_ENV',
        'RUNTIME_SECRET_ARN',
        'SOURCE_SHA',
      ].sort(),
    );
    expect(variables.get('AWS_REGION')).toBe(EXPLORATION_SMOKE_REGION);
    expect(variables.get('DATABASE_DRIVER')).toBe('postgres');
    expect(variables.get('DATABASE_HOST')).toEqual({
      'Fn::GetAtt': ['DatabaseB269D8BB', 'Endpoint.Address'],
    });
    expect(variables.get('DATABASE_PORT')).toBe(
      String(EXPLORATION_SMOKE_DATABASE_PORT),
    );
    expect(variables.get('DATABASE_NAME')).toBe(
      EXPLORATION_SMOKE_DATABASE_NAME,
    );
    expect(variables.get('DATABASE_SSL_ROOT_CERT')).toBe(
      EXPLORATION_SMOKE_DATABASE_SSL_ROOT_CERT,
    );
    expect(variables.get('DATABASE_MAX_CONNECTIONS')).toBe('1');
    expect(variables.get('DATABASE_CONNECT_TIMEOUT_SECONDS')).toBe('10');
    expect(variables.get('DATABASE_IDLE_TIMEOUT_SECONDS')).toEqual({
      Ref: 'RuntimeDatabaseIdleTimeoutSeconds',
    });
    expect(variables.get('SOURCE_SHA')).toEqual({ Ref: 'SourceSha' });
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
        'PSD_EOC_BOOTSTRAP_ADMIN_SUBJECTS',
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
      JSON.stringify(secrets.get('PSD_EOC_BOOTSTRAP_ADMIN_SUBJECTS')),
    ).toContain(':googleSubject::');

    const serialized = JSON.stringify(configuration);
    expect(serialized).not.toContain('aws-data-api');
    expect(serialized).not.toContain('DATABASE_RESOURCE_ARN');
    expect(serialized).not.toContain('DATABASE_SECRET_ARN');
    expect(serialized).not.toContain('BootstrapSourceSha');
    expect(serialized).not.toContain('ApprovedGoogleSubject');
    expect(serialized).not.toContain('GOOGLE_ROSTER_CONFIG');
    expect(serialized).not.toContain('EXPO');
    expect(serialized).not.toContain('SES');
    expect(serialized).not.toContain('SMS');
    expect(serialized).not.toContain('MEDIA_BUCKET');
    expect(serialized).not.toContain('DELIVERY_STATE_WORKER');
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
      ].sort(),
    );
    expect(actions).not.toContain('sqs:SendMessage');
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

    const queueStatement = statements.find((statement) =>
      asStringArray(statement.Action).includes('sqs:GetQueueAttributes'),
    );
    expect(queueStatement?.Resource).toEqual({
      'Fn::GetAtt': [expect.stringContaining('HealthQueue'), 'Arn'],
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
    const task = properties(onlyResource('AWS::ECS::TaskDefinition'));
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
      'packages/server/scripts/exploration-smoke/bootstrap.ts',
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
    expect(environment.get('DATABASE_NAME')).toBe(
      EXPLORATION_SMOKE_DATABASE_NAME,
    );
    expect(environment.get('DATABASE_SSL_ROOT_CERT')).toBe(
      EXPLORATION_SMOKE_DATABASE_SSL_ROOT_CERT,
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
        'APPROVED_GOOGLE_SUBJECT',
        'APPROVED_STAFF_DISPLAY_NAME',
        'APPROVED_STAFF_EMAIL',
        'DATABASE_ADMIN_PASSWORD',
        'DATABASE_ADMIN_USERNAME',
        'DATABASE_APPLICATION_PASSWORD',
        'DATABASE_APPLICATION_USERNAME',
      ].sort(),
    );
    for (const [name, key] of [
      ['APPROVED_GOOGLE_SUBJECT', 'googleSubject'],
      ['APPROVED_STAFF_DISPLAY_NAME', 'staffDisplayName'],
      ['APPROVED_STAFF_EMAIL', 'staffEmail'],
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
    const logGroup = properties(onlyResource('AWS::Logs::LogGroup'));
    expect(logGroup.LogGroupName).toBe(
      EXPLORATION_SMOKE_BOOTSTRAP_LOG_GROUP_NAME,
    );
    expect(logGroup.RetentionInDays).toBe(7);
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
});

describe('explicit absence of production and provider authority', () => {
  it('creates no messaging, DNS, media, scheduler, worker, or custom-resource service', () => {
    for (const forbiddenType of [
      'AWS::Events::Rule',
      'AWS::Lambda::Function',
      'AWS::Route53::HostedZone',
      'AWS::Route53::RecordSet',
      'AWS::S3::Bucket',
      'AWS::Scheduler::Schedule',
      'AWS::SES::ConfigurationSet',
      'AWS::SES::EmailIdentity',
      'AWS::SNS::Topic',
    ]) {
      template.resourceCountIs(forbiddenType, 0);
    }
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
  });

  it('does not expose secrets or production integration identifiers in outputs', () => {
    const outputs = asRecord(synthesized.Outputs);
    expect(Object.keys(outputs).sort()).toEqual(
      [
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
        'EnvironmentName',
        'ExpectedAwsAccountAlias',
        'HealthQueueArn',
        'HealthQueueUrl',
        'ImageRepositoryArn',
        'ImageRepositoryUri',
        'RuntimeRoleArn',
      ].sort(),
    );
    const serializedOutputs = JSON.stringify(outputs);
    expect(serializedOutputs).not.toContain('GoogleOauthSecretArn');
    expect(serializedOutputs).not.toContain('GoogleOidcCookieSecret');
    expect(serializedOutputs).not.toContain('ApiSaltSecret');
    expect(serializedOutputs).not.toContain('alerts.psd401.net');
    expect(serializedOutputs).not.toContain('eoc.psd401.net');
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
