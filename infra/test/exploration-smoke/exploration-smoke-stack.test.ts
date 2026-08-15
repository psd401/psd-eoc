import { describe, expect, it } from 'bun:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

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
    expect(EXPLORATION_SMOKE_ACCOUNT).toBe('<aws-account-id>');
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

  it('requires an explicit two-phase choice and rejects a sentinel final image', () => {
    const parameters = asRecord(synthesized.Parameters);
    const provision = asRecord(parameters.ProvisionApplication);
    const digest = asRecord(parameters.AppImageDigest);
    const oauthArn = asRecord(parameters.GoogleOauthSecretArn);
    const subject = asRecord(parameters.ApprovedGoogleSubject);

    expect(provision.AllowedValues).toEqual(['false', 'true']);
    expect(provision).not.toHaveProperty('Default');
    expect(digest.Default).toBe(EXPLORATION_SMOKE_IMAGE_DIGEST_SENTINEL);
    expect(digest.AllowedPattern).toBe('^sha256:[0-9a-f]{64}$');
    expect(oauthArn.NoEcho).toBe(true);
    expect(oauthArn.AllowedPattern).toBe(
      '^arn:aws:secretsmanager:us-west-2:<aws-account-id>:secret:/psd-eoc/exploration-smoke/google-oauth-[A-Za-z0-9]{6}$',
    );
    expect(subject.NoEcho).toBe(true);
    expect(subject).not.toHaveProperty('Default');

    const rules = asRecord(synthesized.Rules);
    const digestRule = asRecord(rules.ApplicationRequiresPublishedDigest);
    expect(digestRule.RuleCondition).toEqual({
      'Fn::Equals': [{ Ref: 'ProvisionApplication' }, 'true'],
    });
    expect(JSON.stringify(digestRule.Assertions)).toContain(
      EXPLORATION_SMOKE_IMAGE_DIGEST_SENTINEL,
    );

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
      'AWS::ECR::Repository',
      'AWS::IAM::Role',
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
  it('creates exactly one digest repository, writer, App Runner service, and health queue', () => {
    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.resourceCountIs('AWS::RDS::DBCluster', 1);
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.resourceCountIs('AWS::AppRunner::Service', 1);
    template.resourceCountIs('AWS::AppRunner::AutoScalingConfiguration', 1);
    template.resourceCountIs('AWS::SQS::Queue', 1);
    template.resourceCountIs('AWS::SecretsManager::Secret', 4);

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

  it('keeps Aurora to one non-public Serverless v2 writer with Data API', () => {
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
    expect(cluster.EnableHttpEndpoint).toBe(true);
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

    template.resourceCountIs('AWS::EC2::NATGateway', 0);
    template.resourceCountIs('AWS::EC2::InternetGateway', 0);
    template.resourceCountIs('AWS::Lambda::Function', 0);
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 0);

    const securityGroup = properties(onlyResource('AWS::EC2::SecurityGroup'));
    expect(securityGroup.GroupDescription).toContain('Data API-only');
    expect(securityGroup.GroupName).toBe('psd-eoc-exploration-smoke-database');
    expect(securityGroup).not.toHaveProperty('SecurityGroupIngress');
    expect(JSON.stringify(securityGroup.SecurityGroupEgress)).not.toContain(
      '0.0.0.0/0',
    );
  });

  it('generates only the exact admin, application, cookie, and API secrets', () => {
    const secrets = resourceEntries('AWS::SecretsManager::Secret');
    const byName = new Map(
      secrets.map(([, resource]) => [properties(resource).Name, resource]),
    );
    expect([...byName.keys()].sort()).toEqual(
      [
        '/psd-eoc/exploration-smoke/api-salt',
        '/psd-eoc/exploration-smoke/database/admin',
        '/psd-eoc/exploration-smoke/database/application',
        '/psd-eoc/exploration-smoke/google-oidc-cookie-secret',
      ].sort(),
    );
    for (const [, resource] of secrets) {
      const secret = properties(resource);
      expect(secret.GenerateSecretString).toBeDefined();
      expect(secret).not.toHaveProperty('SecretString');
      expect(resource.DeletionPolicy).toBe('Delete');
      expect(resource.UpdateReplacePolicy).toBe('Delete');
    }

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

    const service = onlyResource('AWS::AppRunner::Service');
    const serviceProperties = properties(service);
    const source = asRecord(serviceProperties.SourceConfiguration);
    const image = asRecord(source.ImageRepository);

    expect(source.AutoDeploymentsEnabled).toBe(false);
    expect(image.ImageRepositoryType).toBe('ECR');
    expect(JSON.stringify(image.ImageIdentifier)).toContain('ImageRepository');
    expect(JSON.stringify(image.ImageIdentifier)).toContain('AppImageDigest');
    expect(JSON.stringify(image.ImageIdentifier)).toContain('"@"');
    expect(JSON.stringify(image.ImageIdentifier)).not.toContain(':latest');
    expect(asRecord(serviceProperties.HealthCheckConfiguration).Path).toBe(
      EXPLORATION_SMOKE_HEALTH_PATH,
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
        'DATABASE_DRIVER',
        'DATABASE_NAME',
        'DATABASE_RESOURCE_ARN',
        'DATABASE_SECRET_ARN',
        'FANOUT_QUEUE_URL',
        'NODE_ENV',
        'PSD_EOC_BOOTSTRAP_ADMIN_SUBJECTS',
      ].sort(),
    );
    expect(variables.get('AWS_REGION')).toBe(EXPLORATION_SMOKE_REGION);
    expect(variables.get('DATABASE_DRIVER')).toBe('aws-data-api');
    expect(variables.get('DATABASE_NAME')).toBe(
      EXPLORATION_SMOKE_DATABASE_NAME,
    );
    expect(variables.get('PSD_EOC_BOOTSTRAP_ADMIN_SUBJECTS')).toEqual({
      Ref: 'ApprovedGoogleSubject',
    });
    expect([...secrets.keys()].sort()).toEqual(
      ['API_SALT', 'GOOGLE_OAUTH_CONFIG', 'GOOGLE_OIDC_COOKIE_SECRET'].sort(),
    );
    expect(secrets.get('GOOGLE_OAUTH_CONFIG')).toEqual({
      Ref: 'GoogleOauthSecretArn',
    });

    const serialized = JSON.stringify(configuration);
    expect(serialized).not.toContain('GOOGLE_ROSTER_CONFIG');
    expect(serialized).not.toContain('EXPO');
    expect(serialized).not.toContain('SES');
    expect(serialized).not.toContain('SMS');
    expect(serialized).not.toContain('MEDIA_BUCKET');
    expect(serialized).not.toContain('DELIVERY_STATE_WORKER');
  });

  it('gives the runtime exact Data API, required-secret, and health-read permissions', () => {
    const runtimeRole = roleLogicalIdForServicePrincipal(
      'tasks.apprunner.amazonaws.com',
    );
    const statements = inlineStatementsForRole(runtimeRole);
    const actions = [...new Set(allAllowedActions(statements))].sort();

    expect(actions).toEqual(
      [
        'rds-data:BatchExecuteStatement',
        'rds-data:BeginTransaction',
        'rds-data:CommitTransaction',
        'rds-data:ExecuteStatement',
        'rds-data:RollbackTransaction',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'sqs:GetQueueAttributes',
      ].sort(),
    );
    expect(actions).not.toContain('sqs:SendMessage');
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
  });

  it('does not expose secrets or production integration identifiers in outputs', () => {
    const outputs = asRecord(synthesized.Outputs);
    expect(Object.keys(outputs).sort()).toEqual(
      [
        'AppRunnerHealthCheckUrl',
        'AppRunnerImageAccessRoleArn',
        'AppRunnerServiceArn',
        'AppRunnerServiceUrl',
        'DataClassification',
        'DatabaseAdminSecretArn',
        'DatabaseApplicationSecretArn',
        'DatabaseClusterArn',
        'DatabaseName',
        'DeploymentAccount',
        'DeploymentRegion',
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
