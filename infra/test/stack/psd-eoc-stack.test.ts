import { describe, expect, it } from 'bun:test';
import { App, IgnoreStrategy } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import productionConfiguration from '../../cdk.json';
import {
  BOOTSTRAP_LOG_GROUP_NAME,
  DATABASE_IDENTIFIER,
  DATABASE_NAME,
  DATABASE_PORT,
  DATABASE_SSL_ROOT_CERT,
  DATA_CLASSIFICATION,
  EMAIL_DEAD_LETTER_QUEUE_NAME,
  EMAIL_CALLBACK_QUEUE_NAME,
  EMAIL_CALLBACK_DEAD_LETTER_QUEUE_NAME,
  EMAIL_CALLBACK_WORKER_LOG_GROUP_NAME,
  EMAIL_QUEUE_NAME,
  EMAIL_WORKER_LOG_GROUP_NAME,
  DEPLOYMENT_ENVIRONMENT,
  HEALTH_PATH,
  HEALTH_QUEUE_NAME,
  SERVER_REPOSITORY_NAME,
  SMS_RECEIPT_DEAD_LETTER_QUEUE_NAME,
  SMS_RECEIPT_QUEUE_NAME,
  STACK_NAME,
  assertProtectedDeploymentTarget,
  readDeploymentIdentity,
  readDeploymentTarget,
} from '../../src/stack/config';
import {
  APPLICATION_IMAGE_EXCLUDES,
  PsdEocStack,
} from '../../src/stack/psd-eoc-stack';
import {
  SES_CONFIGURATION_SET_NAME,
  SES_EVENT_DESTINATION_NAME,
  SES_EVENT_TOPIC_NAME,
} from '../../src/config';
import { AURORA_MAX_CAPACITY_ACU } from '../../src/monitoring';

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

function documentedContractList(contents: string, name: string): string[] {
  const start = `<!-- docs-contract:${name}:start -->`;
  const end = `<!-- docs-contract:${name}:end -->`;
  const startOffset = contents.indexOf(start);
  const endOffset = contents.indexOf(end);
  if (startOffset === -1 || endOffset <= startOffset) return [];
  return [
    ...contents
      .slice(startOffset + start.length, endOffset)
      .matchAll(/^- `([^`]+)`\s*$/gmu),
  ]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined)
    .sort();
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

const productionContext = productionConfiguration.context as Readonly<
  Record<string, unknown>
>;
const currentDeploymentTarget = readDeploymentTarget({
  tryGetContext: (key) => productionContext[key],
});
const currentDeploymentIdentity = readDeploymentIdentity({
  tryGetContext: (key) => productionContext[key],
});
const {
  account: AWS_ACCOUNT,
  accountAlias: AWS_ACCOUNT_ALIAS,
  region: AWS_REGION,
  sesFromAddress: SES_FROM_ADDRESS,
  sesIdentityDomain: SES_IDENTITY_DOMAIN,
} = currentDeploymentTarget;
const SOURCE_SHA = 'a'.repeat(40);

const app = new App({
  context: {
    'psdEoc:applicationOrigin': 'https://eoc.example.invalid',
    'psdEoc:hostedDomain': 'example.invalid',
    'psdEoc:hostedZoneId': 'Z0EXAMPLEZONEID',
    'psdEoc:iosBundleId': 'invalid.example.eoc',
    'psdEoc:organizationName': 'Example School District',
    'psdEoc:privacyContactUrl': 'https://www.example.invalid/contact',
    'psdEoc:smsSupportEmail': 'servicecentral@example.invalid',
    'psdEoc:smsSupportPhone': '+12535550123',
    'psdEoc:displayTimeZone': 'America/New_York',
  },
});
const stack = new PsdEocStack(app, STACK_NAME, {
  deploymentTarget: currentDeploymentTarget,
  env: {
    account: AWS_ACCOUNT,
    region: AWS_REGION,
  },
  stackName: STACK_NAME,
  sourceSha: SOURCE_SHA,
});
const template = Template.fromStack(stack);
const synthesized = asRecord(template.toJSON());
const resources = asRecord(synthesized.Resources);

describe('deployment boundary', () => {
  it('keeps ignored local environment files out of CDK asset staging', () => {
    const strategy = IgnoreStrategy.docker('/synthetic/psd-eoc', [
      ...APPLICATION_IMAGE_EXCLUDES,
    ]);

    expect(
      strategy.ignores('/synthetic/psd-eoc/packages/server/.env.local'),
    ).toBe(true);
    expect(strategy.ignores('/synthetic/psd-eoc/.env.production')).toBe(true);
    expect(
      strategy.ignores('/synthetic/psd-eoc/packages/server/build/output.js'),
    ).toBe(true);
    expect(
      strategy.ignores('/synthetic/psd-eoc/packages/server/runtime.log'),
    ).toBe(true);
    expect(
      strategy.ignores('/synthetic/psd-eoc/packages/server/.turbo/cache'),
    ).toBe(true);
    expect(
      strategy.ignores('/synthetic/psd-eoc/.verification/evidence.png'),
    ).toBe(true);
    expect(
      strategy.ignores('/synthetic/psd-eoc/packages/server/package.json'),
    ).toBe(false);
  });

  it('keeps the documented CloudFormation parameter index exact', async () => {
    const configuration = await Bun.file(
      new URL('../../../docs/CONFIGURATION.md', import.meta.url),
    ).text();
    expect(Object.keys(asRecord(synthesized.Parameters)).sort()).toEqual(
      documentedContractList(configuration, 'template-parameters'),
    );
  });

  it('rejects blank or padded SMS response parameters', () => {
    const parameters = asRecord(synthesized.Parameters);
    expect(asRecord(parameters.SmsHelpMessage)).toMatchObject({
      AllowedPattern: '^(UNCONFIGURED|\\S(?:[\\s\\S]{0,158}\\S)?)$',
      MaxLength: 160,
      NoEcho: true,
    });
    expect(asRecord(parameters.SmsStopMessage)).toMatchObject({
      AllowedPattern: '^(UNCONFIGURED|\\S(?:[\\s\\S]{0,158}\\S)?)$',
      MaxLength: 160,
      NoEcho: true,
    });
  });

  it('binds automatic deployment to protected account, region, and identity', () => {
    const protectedEnvironment = {
      APP_PUBLIC_ORIGIN: currentDeploymentIdentity.applicationOrigin,
      AWS_ACCOUNT_ID: currentDeploymentTarget.account,
      AWS_REGION: currentDeploymentTarget.region,
      PSD_EOC_ENFORCE_DEPLOYMENT_TARGET: 'true',
    } as const;
    expect(() =>
      assertProtectedDeploymentTarget(
        currentDeploymentTarget,
        currentDeploymentIdentity,
        protectedEnvironment,
      ),
    ).not.toThrow();
    expect(() =>
      assertProtectedDeploymentTarget(
        currentDeploymentTarget,
        currentDeploymentIdentity,
        { ...protectedEnvironment, AWS_REGION: 'us-east-1' },
      ),
    ).toThrow(/protected production environment/u);
    expect(() =>
      assertProtectedDeploymentTarget(
        { ...currentDeploymentTarget, sesIdentityDomain: 'example.invalid' },
        currentDeploymentIdentity,
        protectedEnvironment,
      ),
    ).toThrow(/protected hosted domain/u);
  });

  it('uses the canonical organization identity contract at synth time', () => {
    const identityFor = (organizationName: string) =>
      readDeploymentIdentity({
        tryGetContext(key) {
          return {
            'psdEoc:applicationOrigin': 'https://eoc.example.invalid',
            'psdEoc:hostedDomain': 'example.invalid',
            'psdEoc:hostedZoneId': 'Z0EXAMPLEZONEID',
            'psdEoc:iosBundleId': 'invalid.example.eoc',
            'psdEoc:organizationName': organizationName,
            'psdEoc:privacyContactUrl': 'https://www.example.invalid/contact',
            'psdEoc:smsSupportEmail': 'servicecentral@example.invalid',
            'psdEoc:smsSupportPhone': '+12535550123',
            'psdEoc:displayTimeZone': 'America/New_York',
          }[key];
        },
      });

    expect(identityFor('😀'.repeat(80)).organizationName).toBe('😀'.repeat(80));
    expect(identityFor('界'.repeat(106)).organizationName).toBe(
      '界'.repeat(106),
    );
    for (const invalid of [
      '😀'.repeat(81),
      '界'.repeat(107),
      'District\u202eName',
      'District\u2028Name',
    ]) {
      expect(() => identityFor(invalid)).toThrow(
        'CDK context psdEoc:organizationName',
      );
    }
  });

  it('requires a public hostname for the privacy contact at synth time', () => {
    const identityFor = (privacyContactUrl: string) =>
      readDeploymentIdentity({
        tryGetContext(key) {
          return {
            'psdEoc:applicationOrigin': 'https://eoc.example.invalid',
            'psdEoc:hostedDomain': 'example.invalid',
            'psdEoc:hostedZoneId': 'Z0EXAMPLEZONEID',
            'psdEoc:iosBundleId': 'invalid.example.eoc',
            'psdEoc:organizationName': 'Example School District',
            'psdEoc:privacyContactUrl': privacyContactUrl,
            'psdEoc:smsSupportEmail': 'servicecentral@example.invalid',
            'psdEoc:smsSupportPhone': '+12535550123',
            'psdEoc:displayTimeZone': 'America/New_York',
          }[key];
        },
      });

    for (const invalid of [
      'https://localhost/contact',
      'https://privacy.localhost/contact',
      'https://127.0.0.1/contact',
      'https://2130706433/contact',
      'https://[::1]/contact',
      'https://%/contact',
    ]) {
      expect(() => identityFor(invalid)).toThrow(
        'CDK context psdEoc:privacyContactUrl',
      );
    }
  });

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
    expect(dockerfile).toContain('org.psd-eoc.environment="live-pilot"');
    expect(dockerfile).toContain(
      'org.psd-eoc.data-classification="staff-minimized"',
    );
    expect(dockerfile).not.toMatch(/psd401|<aws-account-id>/iu);
    expect(dockerfile).not.toContain('synthetic-only');
  });

  it('rejects every account and region except the configured target', () => {
    expect(
      () =>
        new PsdEocStack(
          new App({
            context: {
              'psdEoc:applicationOrigin': 'https://eoc.example.invalid',
              'psdEoc:hostedDomain': 'example.invalid',
              'psdEoc:hostedZoneId': 'Z0EXAMPLEZONEID',
              'psdEoc:iosBundleId': 'invalid.example.eoc',
              'psdEoc:organizationName': 'Example School District',
              'psdEoc:privacyContactUrl': 'https://www.example.invalid/contact',
              'psdEoc:smsSupportEmail': 'servicecentral@example.invalid',
              'psdEoc:smsSupportPhone': '+12535550123',
              'psdEoc:displayTimeZone': 'America/New_York',
            },
          }),
          'WrongAccount',
          {
            deploymentTarget: currentDeploymentTarget,
            env: { account: '000000000000', region: AWS_REGION },
            sourceSha: SOURCE_SHA,
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
              'psdEoc:hostedZoneId': 'Z0EXAMPLEZONEID',
              'psdEoc:iosBundleId': 'invalid.example.eoc',
              'psdEoc:organizationName': 'Example School District',
              'psdEoc:privacyContactUrl': 'https://www.example.invalid/contact',
              'psdEoc:smsSupportEmail': 'servicecentral@example.invalid',
              'psdEoc:smsSupportPhone': '+12535550123',
              'psdEoc:displayTimeZone': 'America/New_York',
            },
          }),
          'WrongRegion',
          {
            deploymentTarget: currentDeploymentTarget,
            env: { account: AWS_ACCOUNT, region: 'us-east-1' },
            sourceSha: SOURCE_SHA,
          },
        ),
    ).toThrow(`in ${AWS_REGION}`);
  });

  it('uses the target AWS partition for secret and SES ARNs', () => {
    for (const [region, partition] of [
      ['cn-north-1', 'aws-cn'],
      ['us-gov-west-1', 'aws-us-gov'],
    ] as const) {
      const account = '000000000000';
      const partitionApp = new App({
        context: {
          'psdEoc:applicationOrigin': 'https://eoc.example.invalid',
          'psdEoc:hostedDomain': 'example.invalid',
          'psdEoc:hostedZoneId': 'Z0EXAMPLEZONEID',
          'psdEoc:iosBundleId': 'invalid.example.eoc',
          'psdEoc:organizationName': 'Example School District',
          'psdEoc:privacyContactUrl': 'https://www.example.invalid/contact',
          'psdEoc:smsSupportEmail': 'servicecentral@example.invalid',
          'psdEoc:smsSupportPhone': '+12535550123',
          'psdEoc:displayTimeZone': 'America/New_York',
        },
      });
      const partitionStack = new PsdEocStack(
        partitionApp,
        'PartitionVerification',
        {
          deploymentTarget: {
            account,
            accountAlias: 'example-district',
            monitoringRunbookBaseUrl:
              'https://operations.example.invalid/runbooks',
            region,
            sesFromAddress: 'eoc-alerts@example.invalid',
            sesIdentityDomain: 'example.invalid',
            sourceRepositoryUrl: 'https://code.example.invalid/example/psd-eoc',
          },
          env: { account, region },
          sourceSha: SOURCE_SHA,
        },
      );
      const partitionTemplate = asRecord(
        Template.fromStack(partitionStack).toJSON(),
      );
      const parameters = asRecord(partitionTemplate.Parameters);
      const outputs = asRecord(partitionTemplate.Outputs);
      const serialized = JSON.stringify(partitionTemplate);

      expect(asRecord(parameters.GoogleOauthSecretArn).AllowedPattern).toBe(
        `^arn:${partition}:secretsmanager:${region}:${account}:secret:/psd-eoc/google-oauth-[A-Za-z0-9]{6}$`,
      );
      expect(asRecord(parameters.GoogleGroupsSecretArn).AllowedPattern).toBe(
        `^arn:${partition}:secretsmanager:${region}:${account}:secret:/psd-eoc/google-groups-[A-Za-z0-9]{6}$`,
      );
      expect(asRecord(outputs.SesIdentityArn).Value).toBe(
        `arn:${partition}:ses:${region}:${account}:identity/example.invalid`,
      );
      expect(serialized).toContain(
        `arn:${partition}:ses:${region}:${account}:configuration-set/${SES_CONFIGURATION_SET_NAME}`,
      );
      expect(serialized).not.toContain(`arn:aws:ses:${region}`);
      expect(serialized).not.toContain(`arn:aws:secretsmanager:${region}`);
    }
  });

  it('keeps image publication and source identity inside the CDK deployment', () => {
    const parameters = asRecord(synthesized.Parameters);
    const provision = asRecord(parameters.ProvisionApplication);
    const runtimeIdleTimeout = asRecord(
      parameters.RuntimeDatabaseIdleTimeoutSeconds,
    );
    const rollbackDigest = asRecord(parameters.RollbackApplicationImageDigest);
    const rollbackRepository = asRecord(
      parameters.RollbackApplicationRepository,
    );
    const oauthArn = asRecord(parameters.GoogleOauthSecretArn);
    const initialAccessGroupId = asRecord(parameters.InitialAccessGroupId);
    const initialAccessGroupEmail = asRecord(
      parameters.InitialAccessGroupEmail,
    );
    const initialAccessGroupName = asRecord(parameters.InitialAccessGroupName);
    const transitionEmailDigest = asRecord(
      parameters.InitialMobileTransitionEmailSha256,
    );

    expect(provision.AllowedValues).toEqual(['false', 'true']);
    expect(provision).not.toHaveProperty('Default');
    expect(parameters).not.toHaveProperty('AppImageDigest');
    expect(parameters).not.toHaveProperty('BootstrapImageDigest');
    expect(parameters).not.toHaveProperty('SourceSha');
    expect(parameters).not.toHaveProperty('BootstrapSourceSha');
    expect(rollbackDigest).toMatchObject({
      AllowedPattern: '^(CURRENT_CDK_ASSET|sha256:[0-9a-f]{64})$',
      Default: 'CURRENT_CDK_ASSET',
      Type: 'String',
    });
    expect(parameters).not.toHaveProperty('RollbackApplicationSourceSha');
    expect(rollbackRepository).toMatchObject({
      AllowedValues: [
        'CURRENT_CDK_ASSET',
        'CDK_ASSET_REPOSITORY',
        'LEGACY_APPLICATION_REPOSITORY',
      ],
      Default: 'CURRENT_CDK_ASSET',
      Type: 'String',
    });
    expect(runtimeIdleTimeout).toMatchObject({
      Default: 0,
      MaxValue: 600,
      MinValue: 0,
      Type: 'Number',
    });
    expect(oauthArn.NoEcho).toBe(true);
    expect(oauthArn.AllowedPattern).toBe(
      '^arn:aws:secretsmanager:us-west-2:<aws-account-id>:secret:/psd-eoc/google-oauth-[A-Za-z0-9]{6}$',
    );
    expect(initialAccessGroupId).toMatchObject({
      Default: '',
      Type: 'String',
    });
    expect(initialAccessGroupEmail).toMatchObject({
      Default: '',
      NoEcho: true,
      Type: 'String',
    });
    expect(initialAccessGroupName).toMatchObject({
      Default: '',
      Type: 'String',
    });
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
    expect(rules).not.toHaveProperty('ApplicationRequiresPublishedDigest');
    expect(rules).not.toHaveProperty('BootstrapRequiresPublishedDigest');
    expect(rules).not.toHaveProperty('ApplicationRequiresReviewedSource');
    expect(rules).not.toHaveProperty('BootstrapRequiresReviewedSource');
    expect(
      JSON.stringify(
        asRecord(rules.RollbackApplicationSelectionIsComplete).Assertions,
      ),
    ).toContain('RollbackApplicationImageDigest');
    expect(
      JSON.stringify(
        asRecord(rules.RollbackApplicationSelectionIsComplete).Assertions,
      ),
    ).toContain('RollbackApplicationRepository');
    const rollbackDarkRule = asRecord(
      rules.RollbackRequiresPersistentlyDarkProviders,
    );
    const serializedRollbackDarkRule = JSON.stringify(rollbackDarkRule);
    for (const parameter of [
      'EnableAwsEumSmsWorker',
      'EnableDirectPush',
      'EnableEmailWorker',
      'EnableExpoPushWorker',
      'PushProviderCutover',
    ]) {
      expect(serializedRollbackDarkRule).toContain(parameter);
    }
    expect(JSON.stringify(rollbackDarkRule.RuleCondition)).toContain(
      'RollbackApplicationImageDigest',
    );
    const directCutoverRule = asRecord(rules.DirectCutoverRequiresDirectPush);
    expect(directCutoverRule.RuleCondition).toEqual({
      'Fn::Or': [
        {
          'Fn::Equals': [
            { Ref: 'PushProviderCutover' },
            '{"version":1,"ios":"direct","android":"expo"}',
          ],
        },
        {
          'Fn::Equals': [
            { Ref: 'PushProviderCutover' },
            '{"version":1,"ios":"expo","android":"direct"}',
          ],
        },
        {
          'Fn::Equals': [
            { Ref: 'PushProviderCutover' },
            '{"version":1,"ios":"direct","android":"direct"}',
          ],
        },
      ],
    });
    expect(JSON.stringify(directCutoverRule.Assertions)).toContain(
      'EnableDirectPush',
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
    expect(
      JSON.stringify(conditions.ShouldUseRollbackApplicationImage),
    ).toContain('RollbackApplicationImageDigest');
    for (const conditionName of [
      'ShouldRunExpoPushWorker',
      'ShouldRunAwsEumSmsWorker',
      'ShouldRunEmailWorker',
    ]) {
      expect(JSON.stringify(conditions[conditionName])).toContain(
        'RollbackApplicationImageDigest',
      );
    }
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
  it('creates one bounded native application, bootstrap, and conditional provider topology', () => {
    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.resourceCountIs('AWS::RDS::DBCluster', 1);
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.resourceCountIs('AWS::AppRunner::Service', 1);
    template.resourceCountIs('AWS::AppRunner::AutoScalingConfiguration', 1);
    template.resourceCountIs('AWS::AppRunner::VpcConnector', 1);
    template.resourceCountIs('AWS::ECS::Cluster', 1);
    template.resourceCountIs('AWS::ECS::TaskDefinition', 6);
    template.resourceCountIs('AWS::ECS::Service', 4);
    // Nine log groups: bootstrap/access sync, deployment bootstrap, push, SMS,
    // email send, email callback, Aurora failover, router, and alarm mailer.
    template.resourceCountIs('AWS::Logs::LogGroup', 9);
    // Thirteen queues: health, source/dead-letter pairs for delivery, email,
    // SMS work, SMS receipts, and push, plus the SES callback source/DLQ pair.
    template.resourceCountIs('AWS::SQS::Queue', 13);
    // Fifteen retained secrets include the live application and bootstrap
    // credentials, six exact internal worker-route bearers, and protected
    // Expo, APNs, and FCM credential placeholders. The push build allowlist
    // is deliberately not among them.
    template.resourceCountIs('AWS::SecretsManager::Secret', 15);
    // Two keys: SES event evidence, and operational alarm notifications.
    template.resourceCountIs('AWS::KMS::Key', 2);
    template.resourceCountIs('AWS::SES::ConfigurationSet', 1);
    template.resourceCountIs('AWS::SES::ConfigurationSetEventDestination', 1);
    // Four topics: SES event evidence, the two paging routes, and the
    // recovery route that carries every alarm's OK transition.
    template.resourceCountIs('AWS::SNS::Topic', 4);

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
    expect(emailQueue.VisibilityTimeout).toBe(120);
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

    const smsReceiptQueue = properties(
      queues.get(SMS_RECEIPT_QUEUE_NAME) ?? {},
    );
    expect(smsReceiptQueue.RedrivePolicy).toEqual({
      deadLetterTargetArn: {
        'Fn::GetAtt': [
          expect.stringContaining('SmsReceiptDeadLetterQueue'),
          'Arn',
        ],
      },
      maxReceiveCount: 5,
    });
    expect(
      properties(queues.get(SMS_RECEIPT_DEAD_LETTER_QUEUE_NAME) ?? {})
        .MessageRetentionPeriod,
    ).toBe(1_209_600);
    const redriveAllowPolicy = asRecord(
      emailDeadLetterQueue.RedriveAllowPolicy,
    );
    expect(redriveAllowPolicy.redrivePermission).toBe('byQueue');
    expect(asArray(redriveAllowPolicy.sourceQueueArns)).toHaveLength(1);
    expect(JSON.stringify(redriveAllowPolicy.sourceQueueArns)).toContain(
      `:sqs:${AWS_REGION}:${AWS_ACCOUNT}:${EMAIL_QUEUE_NAME}`,
    );

    for (const [name, queue] of queues) {
      expect(queue.DeletionPolicy).toBe(
        name === EMAIL_CALLBACK_QUEUE_NAME ||
          name === EMAIL_CALLBACK_DEAD_LETTER_QUEUE_NAME
          ? 'RetainExceptOnCreate'
          : 'Retain',
      );
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
    // Three application/monitoring functions, the image digest resolver, two
    // bootstrap handlers, and the asynchronous provider framework.
    template.resourceCountIs('AWS::Lambda::Function', 11);
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 0);

    // Six: database, shared bootstrap task, App Runner connector, and the three
    // HTTPS-only channel-worker groups. None has database ingress.
    template.resourceCountIs('AWS::EC2::SecurityGroup', 6);
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

    // Two now, not one: the shared bootstrap-task group and the App Runner
    // connector's own group each reach the writer. Both must be the database
    // port from a named group — never a CIDR.
    const ingressRules = Object.values(
      template.findResources('AWS::EC2::SecurityGroupIngress'),
    ).map(
      (resource) =>
        (resource as { Properties: Record<string, unknown> }).Properties,
    );
    expect(ingressRules).toHaveLength(2);
    for (const ingress of ingressRules) {
      expect(ingress.FromPort).toBe(DATABASE_PORT);
      expect(ingress.ToPort).toBe(DATABASE_PORT);
      expect(ingress.IpProtocol).toBe('tcp');
      expect(JSON.stringify(ingress.GroupId)).toContain(
        databaseSecurityGroup[0],
      );
      expect(ingress).not.toHaveProperty('CidrIp');
    }
    const ingressSources = JSON.stringify(
      ingressRules.map((rule) => rule.SourceSecurityGroupId),
    );
    expect(ingressSources).toContain(applicationSecurityGroup[0]);
    expect(ingressSources).toContain('AppRunnerConnectorSecurityGroup');

    // The HTTPS egress rule, which nothing asserted before. CDK inlines it into
    // each group's own SecurityGroupEgress array rather than emitting a
    // standalone resource, so it is invisible to the checks above — a widened
    // port range or a second destination here would have shipped unnoticed.
    const groupsWithEgress = Object.values(
      template.findResources('AWS::EC2::SecurityGroup'),
    )
      .map(
        (resource) =>
          (resource as { Properties: Record<string, unknown> }).Properties,
      )
      .filter((group) => Array.isArray(group.SecurityGroupEgress));
    const httpsRules = groupsWithEgress.flatMap((group) =>
      (group.SecurityGroupEgress as Record<string, unknown>[]).filter(
        (rule) => rule.CidrIp === '0.0.0.0/0',
      ),
    );
    // One for the shared task group, one for the App Runner connector group,
    // and one for each isolated channel worker.
    expect(httpsRules).toHaveLength(5);
    for (const rule of httpsRules) {
      expect(rule.FromPort).toBe(443);
      expect(rule.ToPort).toBe(443);
      expect(rule.IpProtocol).toBe('tcp');
    }

    // Also two: each group that reaches the writer has its own egress rule to
    // it. Every one must be the database port to the database group, so neither
    // path can be widened without this failing.
    const databaseEgressRules = Object.values(
      template.findResources('AWS::EC2::SecurityGroupEgress'),
    )
      .map(
        (resource) =>
          (resource as { Properties: Record<string, unknown> }).Properties,
      )
      .filter((rule) => rule.FromPort === DATABASE_PORT);
    expect(databaseEgressRules).toHaveLength(2);
    for (const databaseEgress of databaseEgressRules) {
      expect(databaseEgress.ToPort).toBe(DATABASE_PORT);
      expect(
        JSON.stringify(databaseEgress.DestinationSecurityGroupId),
      ).toContain(databaseSecurityGroup[0]);
    }
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
        '/psd-eoc/bootstrap/initial-access-group',
        '/psd-eoc/database/admin',
        '/psd-eoc/database/application',
        '/psd-eoc/google-oidc-cookie-secret',
        '/psd-eoc/providers/apns-direct',
        '/psd-eoc/providers/expo-access-token',
        '/psd-eoc/providers/fcm-direct',
        '/psd-eoc/workers/attempt-execution-token',
        '/psd-eoc/workers/delivery-state-token',
        '/psd-eoc/workers/email-runtime-token',
        '/psd-eoc/workers/expo-push-runtime-token',
        '/psd-eoc/workers/push-endpoint-token',
        '/psd-eoc/workers/sms-runtime-token',
      ].sort(),
    );
    const retainExceptOnCreate = new Set([
      '/psd-eoc/providers/apns-direct',
      '/psd-eoc/providers/fcm-direct',
      '/psd-eoc/workers/email-runtime-token',
    ]);
    for (const name of [
      '/psd-eoc/api-salt',
      '/psd-eoc/database/admin',
      '/psd-eoc/database/application',
      '/psd-eoc/google-oidc-cookie-secret',
      '/psd-eoc/providers/apns-direct',
      '/psd-eoc/providers/expo-access-token',
      '/psd-eoc/providers/fcm-direct',
      '/psd-eoc/workers/attempt-execution-token',
      '/psd-eoc/workers/delivery-state-token',
      '/psd-eoc/workers/email-runtime-token',
      '/psd-eoc/workers/expo-push-runtime-token',
      '/psd-eoc/workers/push-endpoint-token',
      '/psd-eoc/workers/sms-runtime-token',
    ]) {
      const resource = byName.get(name);
      expect(resource).toBeDefined();
      const secret = properties(resource ?? {});
      expect(secret.GenerateSecretString).toBeDefined();
      expect(secret).not.toHaveProperty('SecretString');
      expect(resource?.DeletionPolicy).toBe(
        retainExceptOnCreate.has(name) ? 'RetainExceptOnCreate' : 'Retain',
      );
      expect(resource?.UpdateReplacePolicy).toBe('Retain');
    }

    const expoProviderSecret = properties(
      byName.get('/psd-eoc/providers/expo-access-token') ?? {},
    );
    expect(asRecord(expoProviderSecret.GenerateSecretString)).toMatchObject({
      GenerateStringKey: 'accessToken',
      SecretStringTemplate: JSON.stringify({ status: 'UNCONFIGURED' }),
    });
    expect(
      asRecord(
        properties(byName.get('/psd-eoc/providers/apns-direct') ?? {})
          .GenerateSecretString,
      ),
    ).toMatchObject({
      GenerateStringKey: 'privateKey',
      SecretStringTemplate: expect.stringContaining('UNCONFIGURED'),
    });
    expect(
      asRecord(
        properties(byName.get('/psd-eoc/providers/fcm-direct') ?? {})
          .GenerateSecretString,
      ),
    ).toMatchObject({
      GenerateStringKey: 'privateKey',
      SecretStringTemplate: expect.stringContaining('UNCONFIGURED'),
    });

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

    const initialAccessGroup = byName.get(
      '/psd-eoc/bootstrap/initial-access-group',
    );
    expect(initialAccessGroup).toBeDefined();
    const initialAccessGroupSecretString = JSON.stringify(
      properties(initialAccessGroup ?? {}).SecretString,
    );
    expect(initialAccessGroupSecretString).toContain('email');
    expect(initialAccessGroupSecretString).toContain('InitialAccessGroupEmail');
    expect(initialAccessGroup?.DeletionPolicy).toBe('Retain');
    expect(initialAccessGroup?.UpdateReplacePolicy).toBe('Retain');

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
    const imageIdentifier = JSON.stringify(image.ImageIdentifier);
    expect(imageIdentifier).toContain('cdk-hnb659fds-container-assets');
    expect(imageIdentifier).toContain('ApplicationImageDigestLookup');
    expect(imageIdentifier).toContain('imageDetails.0.imageDigest');
    expect(imageIdentifier).toContain('RollbackApplicationImageDigest');
    expect(imageIdentifier).toContain('ShouldUseLegacyRollbackRepository');
    expect(imageIdentifier).toContain('@');
    expect(imageIdentifier).not.toContain(':latest');
    expect(imageIdentifier).not.toContain('AppImageDigest');
    expect(imageIdentifier).not.toContain('BootstrapImageDigest');
    expect(serviceProperties.Tags).toEqual([
      {
        Key: 'Application',
        Value: 'PSD EOC',
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
    // Asserted by value. App Runner creates a replacement connector before
    // deleting the original, so the name must differ from any live one — a typo
    // here fails the deploy at the point the service is already gone.
    expect(connector.VpcConnectorName).toBe('psd-eoc-apprunner');
    expect(asArray(connector.Subnets)).toHaveLength(2);
    expect(JSON.stringify(connector.Subnets)).toContain(
      'DatabaseNetworkApplicationSubnet1',
    );
    expect(JSON.stringify(connector.Subnets)).toContain(
      'DatabaseNetworkApplicationSubnet2',
    );
    expect(asArray(connector.SecurityGroups)).toHaveLength(1);
    // Its own group, not the one the bootstrap tasks share. App Runner refuses
    // to create a connector whose subnet and security-group combination matches
    // an existing one, so sharing made the live connector collide with its own
    // replacement and nothing about it could be edited without deleting it.
    expect(JSON.stringify(connector.SecurityGroups)).toContain(
      'AppRunnerConnectorSecurityGroup',
    );
    expect(JSON.stringify(connector.SecurityGroups)).not.toContain(
      'ApplicationSecurityGroup',
    );
    expect(connector.Tags).toEqual([
      {
        Key: 'Application',
        Value: 'PSD EOC',
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
        'MEDIA_BUCKET_NAME',
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
        'PSD_EOC_CRITICAL_ALARM_TOPIC_ARN',
        'PSD_EOC_DISPLAY_TIME_ZONE',
        'PSD_EOC_EMAIL_WORKER_ENABLED',
        'PSD_EOC_IOS_BUNDLE_ID',
        'PSD_EOC_OPERATIONS_ALARM_TOPIC_ARN',
        'PSD_EOC_ORGANIZATION_NAME',
        'PSD_EOC_PUSH_PROVIDER_CUTOVER',
        'PSD_EOC_PRIVACY_CONTACT_URL',
        'PSD_EOC_SMS_SUPPORT_EMAIL',
        'PSD_EOC_SMS_SUPPORT_PHONE',
        'PSD_EOC_SES_SNS_TOPIC_ARN',
        'PSD_EOC_SMS_DESTINATION_COUNTRY_CODE',
        'PSD_EOC_SMS_WORKER_READY',
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
    expect(variables.get('PSD_EOC_EMAIL_WORKER_ENABLED')).toEqual({
      'Fn::If': ['ShouldRunEmailWorker', 'true', 'false'],
    });
    expect(variables.get('PSD_EOC_ORGANIZATION_NAME')).toBe(
      'Example School District',
    );
    expect(variables.get('PSD_EOC_PRIVACY_CONTACT_URL')).toBe(
      'https://www.example.invalid/contact',
    );
    expect(variables.get('PSD_EOC_DISPLAY_TIME_ZONE')).toBe('America/New_York');
    expect(variables.get('PSD_EOC_PUSH_PROVIDER_CUTOVER')).toEqual({
      Ref: 'PushProviderCutover',
    });
    expect(JSON.stringify(variables.get('SOURCE_SHA'))).toContain(
      'RollbackImageValidation',
    );
    expect(variables.get('PSD_EOC_OPERATIONS_ALARM_TOPIC_ARN')).toEqual({
      Ref: expect.stringContaining('OperationsAlarmTopic'),
    });
    expect(variables.get('PSD_EOC_CRITICAL_ALARM_TOPIC_ARN')).toEqual({
      Ref: expect.stringContaining('CriticalAlarmTopic'),
    });
    expect(variables.get('PSD_EOC_SES_SNS_TOPIC_ARN')).toEqual({
      Ref: expect.stringContaining('EmailEventsTopic'),
    });
    expect(variables.get('PSD_EOC_SMS_DESTINATION_COUNTRY_CODE')).toEqual({
      Ref: 'SmsDestinationCountryCode',
    });
    expect(variables.get('PSD_EOC_SMS_WORKER_READY')).toEqual({
      'Fn::If': ['ShouldRunAwsEumSmsWorker', 'true', 'false'],
    });
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
        'GOOGLE_ROSTER_CONFIG',
        'PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN',
        'PSD_EOC_DELIVERY_STATE_WORKER_TOKEN',
        'PSD_EOC_EMAIL_RUNTIME_WORKER_TOKEN',
        'PSD_EOC_EXPO_PUSH_RUNTIME_WORKER_TOKEN',
        'PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256',
        'PSD_EOC_PUSH_ENDPOINT_WORKER_TOKEN',
        'PSD_EOC_SMS_RUNTIME_WORKER_TOKEN',
      ].sort(),
    );
    expect(secrets.get('GOOGLE_OAUTH_CONFIG')).toEqual({
      Ref: 'GoogleOauthSecretArn',
    });
    // The admin forms look a Google Group up by address with the same
    // read-only roster-reader credential the scheduled sync holds.
    expect(secrets.get('GOOGLE_ROSTER_CONFIG')).toEqual({
      Ref: 'GoogleGroupsSecretArn',
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
    // GOOGLE_ROSTER_CONFIG is deliberately present now: the admin forms
    // resolve a Google Group address to its ID with that read-only credential.
    expect(serialized).not.toContain('EXPO_ACCESS_TOKEN');
    expect(serialized).not.toContain('SES_ACCESS_KEY');
    expect(serialized).not.toContain('SES_SECRET');
    expect(serialized).not.toContain('SES_SESSION');
    expect(serialized).not.toContain('SES_SEND');
    expect(serialized).not.toContain('SMS_ORIGINATION');
    expect(serialized).not.toContain('SMS_MAX_PRICE');
    // MEDIA_BUCKET_NAME is present and is deliberately not asserted absent
    // here. This list guards provider credentials; a bucket name is not one,
    // and reaching the bucket still requires the scoped role grant asserted in
    // the runtime permission test.

    // The application holds every internal worker bearer, because verifying a
    // bearer means comparing against it. That is not a provider credential and
    // is not what this list guards: the runtime still holds nothing that can
    // reach SES, SMS, Expo, or object storage. Both arrive as resolved secret
    // references rather than plain environment values.
    for (const name of [
      'PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN',
      'PSD_EOC_DELIVERY_STATE_WORKER_TOKEN',
      'PSD_EOC_EXPO_PUSH_RUNTIME_WORKER_TOKEN',
      'PSD_EOC_PUSH_ENDPOINT_WORKER_TOKEN',
      'PSD_EOC_SMS_RUNTIME_WORKER_TOKEN',
    ]) {
      expect(secrets.has(name)).toBe(true);
      expect(variables.has(name)).toBe(false);
    }
  });

  it('keeps the dark push worker on exact queue and credential boundaries', () => {
    const securityGroups = resourceEntries('AWS::EC2::SecurityGroup').filter(
      ([, resource]) =>
        properties(resource).GroupName === 'psd-eoc-push-worker',
    );
    expect(securityGroups).toHaveLength(1);
    const pushSecurityGroup = securityGroups[0];
    if (pushSecurityGroup === undefined) {
      throw new Error('Missing push worker security group.');
    }
    expect(properties(pushSecurityGroup[1]).GroupDescription).toBe(
      'HTTPS-only egress for the isolated Expo push worker; no database route.',
    );

    const task = properties(taskDefinitionByFamily('psd-eoc-expo-push-worker'));
    const containers = asArray(task.ContainerDefinitions).map(asRecord);
    expect(containers).toHaveLength(1);
    const container = containers[0];
    if (container === undefined) throw new Error('Missing push container.');
    expect(container.Command).toEqual(['bun', 'workers/push/service.ts']);
    expect(container.ReadonlyRootFilesystem).toBe(true);

    const environment = new Map(
      asArray(container.Environment).map((item) => {
        const pair = asRecord(item);
        return [String(pair.Name), pair.Value];
      }),
    );
    expect(environment.get('PSD_EOC_EXPO_PUSH_RUNTIME_MODE')).toEqual({
      'Fn::If': ['ShouldRunExpoPushWorker', 'enabled', 'dark'],
    });
    expect(environment.get('PSD_EOC_EXPO_PUSH_PROVIDER_AUTHORIZED')).toEqual({
      'Fn::If': ['ShouldRunExpoPushWorker', 'true', 'false'],
    });
    expect(environment.get('PSD_EOC_DIRECT_PUSH_PROVIDER_AUTHORIZED')).toEqual({
      'Fn::If': ['ShouldAuthorizeDirectPush', 'true', 'false'],
    });
    expect(environment.get('PSD_EOC_PUSH_PROVIDER_CUTOVER')).toEqual({
      Ref: 'PushProviderCutover',
    });

    const injectedSecrets = new Map(
      asArray(container.Secrets).map((item) => {
        const pair = asRecord(item);
        return [String(pair.Name), pair.ValueFrom];
      }),
    );
    expect([...injectedSecrets.keys()].sort()).toEqual(
      [
        'APNS_CREDENTIAL_STATUS',
        'APNS_ENVIRONMENT',
        'APNS_KEY_ID',
        'APNS_PRIVATE_KEY',
        'APNS_TEAM_ID',
        'APNS_TOPIC',
        'EXPO_ACCESS_TOKEN',
        'FCM_CLIENT_EMAIL',
        'FCM_CREDENTIAL_STATUS',
        'FCM_ENVIRONMENT',
        'FCM_PRIVATE_KEY',
        'FCM_PROJECT_ID',
        'PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN',
        'PSD_EOC_DELIVERY_STATE_WORKER_TOKEN',
        'PSD_EOC_EXPO_CREDENTIAL_STATUS',
        'PSD_EOC_EXPO_PUSH_RUNTIME_WORKER_TOKEN',
        'PSD_EOC_PUSH_ENDPOINT_WORKER_TOKEN',
      ].sort(),
    );
    expect(JSON.stringify(container)).not.toContain('DATABASE_');
    expect(JSON.stringify(container)).not.toContain('EVENT_LIFECYCLE');
    expect(injectedSecrets.get('EXPO_ACCESS_TOKEN')).toEqual(
      expect.objectContaining({
        'Fn::Join': expect.any(Array),
      }),
    );
    expect(JSON.stringify(injectedSecrets.get('EXPO_ACCESS_TOKEN'))).toContain(
      'accessToken',
    );
    expect(
      JSON.stringify(injectedSecrets.get('PSD_EOC_EXPO_CREDENTIAL_STATUS')),
    ).toContain('status');

    const taskRole = roleLogicalIdForDescription(
      'Consumes and retries only the mobile push queue',
    );
    const taskStatements = inlineStatementsForRole(taskRole);
    expect([...new Set(allAllowedActions(taskStatements))].sort()).toEqual(
      [
        'sqs:ChangeMessageVisibility',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
        'sqs:GetQueueUrl',
        'sqs:ReceiveMessage',
        'sqs:SendMessage',
      ].sort(),
    );
    expect(JSON.stringify(taskStatements)).toContain('PushQueue');
    expect(JSON.stringify(taskStatements)).not.toContain('DeliveryQueue');
    expect(JSON.stringify(taskStatements)).not.toContain('EmailQueue');
    expect(JSON.stringify(taskStatements)).not.toContain('SmsQueue');

    const executionRole = roleLogicalIdForDescription(
      'injects only mobile push worker credentials',
    );
    const executionStatements = inlineStatementsForRole(executionRole);
    const secretStatements = executionStatements.filter((statement) =>
      asStringArray(statement.Action).includes('secretsmanager:GetSecretValue'),
    );
    const secretResources = JSON.stringify(
      secretStatements.map((statement) => statement.Resource),
    );
    expect(secretResources).toContain('ExpoAccessTokenSecret');
    expect(secretResources).toContain('ApnsDirectCredentialSecret');
    expect(secretResources).toContain('FcmDirectCredentialSecret');
    expect(secretResources).not.toContain('Database');
    expect(secretResources).not.toContain('Google');
  });

  it('keeps SMS dark until carrier resources, evidence, and live enablement agree', () => {
    const task = properties(
      taskDefinitionByFamily('psd-eoc-aws-eum-sms-worker'),
    );
    const container = asRecord(asArray(task.ContainerDefinitions)[0]);
    expect(container.Command).toEqual(['bun', 'workers/sms/service.ts']);
    expect(container.ReadonlyRootFilesystem).toBe(true);
    expect(JSON.stringify(container)).not.toContain('DATABASE_');

    const environment = new Map(
      asArray(container.Environment).map((item) => {
        const pair = asRecord(item);
        return [String(pair.Name), pair.Value];
      }),
    );
    expect(environment.get('PSD_EOC_SMS_RUNTIME_MODE')).toEqual({
      'Fn::If': ['ShouldRunAwsEumSmsWorker', 'enabled', 'dark'],
    });
    expect(environment.get('PSD_EOC_SMS_PROVIDER_AUTHORIZED')).toEqual({
      'Fn::If': ['ShouldRunAwsEumSmsWorker', 'true', 'false'],
    });
    expect(environment.get('SMS_QUEUE_ARN')).toEqual({
      'Fn::GetAtt': [expect.stringContaining('SmsQueue'), 'Arn'],
    });
    expect(environment.get('SMS_RECEIPT_QUEUE_ARN')).toEqual({
      'Fn::GetAtt': [expect.stringContaining('SmsReceiptQueue'), 'Arn'],
    });

    const injectedSecrets = asArray(container.Secrets).map((item) =>
      String(asRecord(item).Name),
    );
    expect(injectedSecrets.sort()).toEqual(
      [
        'PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN',
        'PSD_EOC_DELIVERY_STATE_WORKER_TOKEN',
        'PSD_EOC_SMS_RUNTIME_WORKER_TOKEN',
      ].sort(),
    );

    const taskRole = roleLogicalIdForDescription('Consumes the SMS queue');
    const actions = allAllowedActions(inlineStatementsForRole(taskRole));
    expect(actions).toContain('sms-voice:SendTextMessage');
    expect(actions).toContain('sms-voice:DescribeOptedOutNumbers');
    expect(actions).toContain('sqs:ReceiveMessage');
    expect(actions).toContain('sqs:SendMessage');
    const queueSendResources = JSON.stringify(
      inlineStatementsForRole(taskRole)
        .filter((statement) =>
          asStringArray(statement.Action).includes('sqs:SendMessage'),
        )
        .map((statement) => statement.Resource),
    );
    expect(queueSendResources).toContain('SmsQueue');
    expect(queueSendResources).not.toContain('SmsReceiptQueue');
    const queueReceiveResources = JSON.stringify(
      inlineStatementsForRole(taskRole)
        .filter((statement) =>
          asStringArray(statement.Action).includes('sqs:ReceiveMessage'),
        )
        .map((statement) => statement.Resource),
    );
    expect(queueReceiveResources).toContain('SmsQueue');
    expect(queueReceiveResources).toContain('SmsReceiptQueue');
    expect(JSON.stringify(inlineStatementsForRole(taskRole))).not.toContain(
      'EmailQueue',
    );
    expect(JSON.stringify(inlineStatementsForRole(taskRole))).not.toContain(
      'PushQueue',
    );

    for (const type of [
      'AWS::SMSVOICE::OptOutList',
      'AWS::SMSVOICE::Pool',
      'AWS::SMSVOICE::ProtectConfiguration',
      'AWS::SMSVOICE::ConfigurationSet',
    ]) {
      const resource = onlyResource(type);
      expect(resource.Condition).toBe('ShouldProvisionAwsEumSmsResources');
      expect(resource.DeletionPolicy).toBe('Retain');
    }
    const pool = properties(onlyResource('AWS::SMSVOICE::Pool'));
    expect(pool.SelfManagedOptOutsEnabled).toBe(false);
    expect(pool.SharedRoutesEnabled).toBe(false);
    expect(pool.DeletionProtectionEnabled).toBe(true);

    // Delivery-status telemetry: the EventBridge event destination is the only
    // way AWS publishes "Text Message Delivery Status Updated", and it exists
    // only as an API call, so it is a conditional custom resource.
    const smsEventDestination = resourceEntries('Custom::AWS').find(
      ([, resource]) =>
        JSON.stringify(properties(resource).Create).includes(
          'CreateEventDestination',
        ),
    );
    expect(smsEventDestination).toBeDefined();
    const smsEventDestinationResource = smsEventDestination?.[1] ?? {};
    expect(smsEventDestinationResource.Condition).toBe(
      'ShouldProvisionAwsEumSmsResources',
    );
    const smsEventDestinationCreate = JSON.stringify(
      properties(smsEventDestinationResource).Create,
    );
    expect(smsEventDestinationCreate).toContain('psd-eoc-sms-eventbridge');
    expect(smsEventDestinationCreate).toContain('event-bus/default');
    expect(smsEventDestinationCreate).toContain('ALL');
    expect(
      JSON.stringify(properties(smsEventDestinationResource).Update),
    ).toContain('UpdateEventDestination');
    expect(
      JSON.stringify(properties(smsEventDestinationResource).Delete),
    ).toContain('DeleteEventDestination');

    const smsService = resourceEntries('AWS::ECS::Service').find(
      ([, resource]) =>
        properties(resource).ServiceName === 'psd-eoc-aws-eum-sms-worker',
    );
    expect(smsService).toBeDefined();
    const smsWorkerDesiredCount = properties(
      smsService?.[1] ?? {},
    ).DesiredCount;
    expect(smsWorkerDesiredCount).toEqual({
      'Fn::If': ['ShouldRunAwsEumSmsWorker', 1, 0],
    });
    const appRunnerService = properties(
      onlyResource('AWS::AppRunner::Service'),
    );
    const appRunnerImage = asRecord(
      asRecord(appRunnerService.SourceConfiguration).ImageRepository,
    );
    const appRunnerConfiguration = asRecord(appRunnerImage.ImageConfiguration);
    const appRunnerEnvironment = new Map(
      asArray(appRunnerConfiguration.RuntimeEnvironmentVariables).map(
        (item) => {
          const pair = asRecord(item);
          return [String(pair.Name), pair.Value];
        },
      ),
    );
    const appRunnerSmsReadiness = appRunnerEnvironment.get(
      'PSD_EOC_SMS_WORKER_READY',
    );
    expect(appRunnerSmsReadiness).toEqual({
      'Fn::If': ['ShouldRunAwsEumSmsWorker', 'true', 'false'],
    });
    expect(asArray(asRecord(appRunnerSmsReadiness)['Fn::If'])[0]).toBe(
      asArray(asRecord(smsWorkerDesiredCount)['Fn::If'])[0],
    );

    const deliveryRule = resourceEntries('AWS::Events::Rule').find(
      ([, resource]) =>
        properties(resource).Name === 'psd-eoc-sms-delivery-events',
    );
    expect(
      JSON.stringify(properties(deliveryRule?.[1] ?? {}).Targets),
    ).toContain('SmsReceiptQueue');
    expect(
      JSON.stringify(properties(deliveryRule?.[1] ?? {}).Targets),
    ).not.toContain('SmsQueue');
    const alarmNames = resourceEntries('AWS::CloudWatch::Alarm').map(
      ([, resource]) => properties(resource).AlarmName,
    );
    expect(alarmNames).toContain('psd-eoc-sms-receipt-queue-age');
    expect(alarmNames).toContain('psd-eoc-sms-receipt-dlq-depth');
  });

  it('gives the runtime only application, health, and alarm-read permissions', () => {
    const runtimeRole = roleLogicalIdForServicePrincipal(
      'tasks.apprunner.amazonaws.com',
    );
    const statements = inlineStatementsForRole(runtimeRole);
    const actions = [...new Set(allAllowedActions(statements))].sort();

    expect(actions).toEqual(
      [
        // The three s3 actions are the private media bucket and nothing else:
        // the runtime signs upload and read grants, writes the sanitized
        // object, and reads the malware-scan tag. There is no DeleteObject --
        // a media record is append-only truth.
        's3:GetObject',
        's3:GetObjectTagging',
        's3:PutObject',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'sns:ListSubscriptionsByTopic',
        'sqs:GetQueueAttributes',
        'sqs:SendMessage',
      ].sort(),
    );
    expect(actions).not.toContain('s3:DeleteObject');
    // sqs:SendMessage is deliberate and is not a provider grant: an activation
    // hands its own notification batch to its own delivery queue after the
    // event commits. Reaching a person still requires a channel worker, and the
    // runtime has no provider write authority at all — asserted just below.
    expect(actions).not.toContain('ses:SendEmail');
    expect(actions).not.toContain('ses:SendRawEmail');
    expect(actions.some((action) => action.startsWith('rds-data:'))).toBe(
      false,
    );
    expect(actions.every((action) => !action.includes('*'))).toBe(true);
    for (const forbiddenPrefix of ['events:', 'lambda:', 'ses:']) {
      expect(actions.some((action) => action.startsWith(forbiddenPrefix))).toBe(
        false,
      );
    }
    // s3 is no longer forbidden outright, because staff attach photos to an
    // event and the runtime signs and writes those objects. It stays confined:
    // read and write of objects, no bucket-level administration, and no delete.
    expect(actions.filter((action) => action.startsWith('s3:')).sort()).toEqual(
      ['s3:GetObject', 's3:GetObjectTagging', 's3:PutObject'],
    );
    expect(actions.filter((action) => action.startsWith('sns:'))).toEqual([
      'sns:ListSubscriptionsByTopic',
    ]);
    for (const forbiddenAction of [
      'sns:Publish',
      'sns:SetTopicAttributes',
      'sns:Subscribe',
    ]) {
      expect(actions).not.toContain(forbiddenAction);
    }
    const snsStatement = statements.find((statement) =>
      asStringArray(statement.Action).includes('sns:ListSubscriptionsByTopic'),
    );
    expect(asStringArray(snsStatement?.Action)).toEqual([
      'sns:ListSubscriptionsByTopic',
    ]);
    const snsResources = asArray(snsStatement?.Resource);
    expect(snsResources).toHaveLength(2);
    expect(snsResources).toEqual(
      expect.arrayContaining([
        { Ref: expect.stringContaining('OperationsAlarmTopic') },
        { Ref: expect.stringContaining('CriticalAlarmTopic') },
      ]),
    );
    const snsTargets = JSON.stringify(snsResources);
    expect(snsTargets).toContain('OperationsAlarmTopic');
    expect(snsTargets).toContain('CriticalAlarmTopic');
    expect(snsTargets).not.toContain('EmailEventsTopic');
    expect(snsResources).not.toContain('*');

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

  it('gives the conditional email worker exact queue and SES permissions', () => {
    const task = properties(taskDefinitionByFamily('psd-eoc-email-worker'));
    const containers = asArray(task.ContainerDefinitions).map(asRecord);
    expect(containers).toHaveLength(1);
    const container = containers[0];
    if (container === undefined) throw new Error('Missing email container.');
    expect(container.Command).toEqual(['bun', 'workers/email/service.ts']);
    expect(container.ReadonlyRootFilesystem).toBe(true);
    expect(JSON.stringify(container)).not.toContain('DATABASE_');
    expect(JSON.stringify(container)).not.toContain('EVENT_LIFECYCLE');
    const environment = new Map(
      asArray(container.Environment).map((item) => {
        const pair = asRecord(item);
        return [String(pair.Name), pair.Value];
      }),
    );
    expect(environment.get('PSD_EOC_EMAIL_RUNTIME_MODE')).toEqual({
      'Fn::If': ['ShouldRunEmailWorker', 'enabled', 'dark'],
    });
    expect(environment.get('PSD_EOC_SES_PROVIDER_AUTHORIZED')).toEqual({
      'Fn::If': ['ShouldRunEmailWorker', 'true', 'false'],
    });
    expect(environment.get('PSD_EOC_SES_CREDENTIAL_STATUS')).toEqual({
      'Fn::If': ['ShouldRunEmailWorker', 'verified', 'unverified'],
    });
    const injectedSecrets = new Map(
      asArray(container.Secrets).map((item) => {
        const pair = asRecord(item);
        return [String(pair.Name), pair.ValueFrom];
      }),
    );
    expect([...injectedSecrets.keys()].sort()).toEqual(
      [
        'PSD_EOC_ATTEMPT_EXECUTION_WORKER_TOKEN',
        'PSD_EOC_DELIVERY_STATE_WORKER_TOKEN',
        'PSD_EOC_EMAIL_RUNTIME_WORKER_TOKEN',
      ].sort(),
    );

    const emailWorkerRole = roleLogicalIdForDescription(
      'Consumes and retries only the SES email queue',
    );
    const statements = inlineStatementsForRole(emailWorkerRole);
    const actions = [...new Set(allAllowedActions(statements))].sort();

    expect(actions).toEqual(
      [
        'ses:SendEmail',
        'ses:SendRawEmail',
        'sqs:ChangeMessageVisibility',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
        'sqs:GetQueueUrl',
        'sqs:ReceiveMessage',
        'sqs:SendMessage',
      ].sort(),
    );
    expect(actions.some((action) => action.startsWith('sns:'))).toBe(false);
    expect(actions.some((action) => action.startsWith('secretsmanager:'))).toBe(
      false,
    );
    const sesStatement = statements.find((statement) =>
      asStringArray(statement.Action).includes('ses:SendEmail'),
    );
    expect(asStringArray(sesStatement?.Action).sort()).toEqual([
      'ses:SendEmail',
      'ses:SendRawEmail',
    ]);
    expect(sesStatement?.Condition).toEqual({
      StringEquals: { 'ses:FromAddress': SES_FROM_ADDRESS },
    });
    const sesResources = JSON.stringify(sesStatement?.Resource);
    expect(sesResources).toContain(
      `configuration-set/${SES_CONFIGURATION_SET_NAME}`,
    );
    expect(sesResources).toContain(`identity/${SES_IDENTITY_DOMAIN}`);
    expect(sesResources).not.toContain('*');
    expect(JSON.stringify(statements)).toContain('EmailQueue');

    const service = resourceEntries('AWS::ECS::Service')
      .map(([, resource]) => properties(resource))
      .find((resource) => resource.ServiceName === 'psd-eoc-email-worker');
    expect(service?.DesiredCount).toEqual({
      'Fn::If': ['ShouldRunEmailWorker', 1, 0],
    });
  });

  it('limits the App Runner image role to the isolated ECR pull contract', () => {
    const imageRole = roleLogicalIdForServicePrincipal(
      'build.apprunner.amazonaws.com',
    );
    const statements = inlineStatementsForRole(imageRole);
    const actions = [...new Set(allAllowedActions(statements))].sort();
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
    expect(JSON.stringify(repositoryStatement?.Resource)).toContain(
      'cdk-hnb659fds-container-assets',
    );
    expect(JSON.stringify(repositoryStatement?.Resource)).not.toContain(
      'ImageRepository',
    );
    expect(JSON.stringify(statements)).toContain('ImageRepository');
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
      'timeout',
      '-s',
      'TERM',
      '-k',
      '30s',
      '25m',
      'bun',
      'packages/server/scripts/operations/bootstrap.ts',
    ]);
    expect(container.ReadonlyRootFilesystem).toBe(true);
    expect(container).not.toHaveProperty('Privileged');
    expect(JSON.stringify(container.Image)).toContain(
      'ApplicationImageDigestLookup',
    );
    expect(JSON.stringify(container.Image)).not.toContain('AppImageDigest');
    expect(JSON.stringify(container.Image)).not.toContain(
      'BootstrapImageDigest',
    );
    expect(JSON.stringify(container.Image)).toContain('@');

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
    expect(environment.get('SOURCE_SHA')).toBe(SOURCE_SHA);
    expect(environment.get('PSD_EOC_INITIAL_ACCESS_GROUP_ID')).toEqual({
      Ref: 'InitialAccessGroupId',
    });
    expect(environment.has('PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL')).toBe(false);
    expect(environment.get('PSD_EOC_INITIAL_ACCESS_GROUP_NAME')).toEqual({
      Ref: 'InitialAccessGroupName',
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
        'PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL',
      ].sort(),
    );
    for (const [name, key] of [
      ['DATABASE_ADMIN_PASSWORD', 'password'],
      ['DATABASE_ADMIN_USERNAME', 'username'],
      ['DATABASE_APPLICATION_PASSWORD', 'password'],
      ['DATABASE_APPLICATION_USERNAME', 'username'],
      ['PSD_EOC_INITIAL_ACCESS_GROUP_EMAIL', 'email'],
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

    const callbackLogGroupResource = resourceEntries(
      'AWS::Logs::LogGroup',
    ).find(
      ([, resource]) =>
        properties(resource).LogGroupName ===
        EMAIL_CALLBACK_WORKER_LOG_GROUP_NAME,
    )?.[1];
    expect(callbackLogGroupResource).toBeDefined();
    expect(callbackLogGroupResource?.DeletionPolicy).toBe(
      'RetainExceptOnCreate',
    );
    expect(callbackLogGroupResource?.UpdateReplacePolicy).toBe('Retain');
  });

  it('blocks every image consumer on one successful CloudFormation bootstrap', () => {
    const deploymentLogGroup = resourceEntries('AWS::Logs::LogGroup').find(
      ([, resource]) =>
        properties(resource).LogGroupName === '/psd-eoc/deployment/bootstrap',
    )?.[1];
    expect(deploymentLogGroup).toBeDefined();
    expect(asRecord(deploymentLogGroup).DeletionPolicy).toBe(
      'RetainExceptOnCreate',
    );
    expect(asRecord(deploymentLogGroup).UpdateReplacePolicy).toBe('Retain');

    const deployments = resourceEntries('Custom::PsdEocBootstrapDeployment');
    expect(deployments).toHaveLength(1);
    const [deploymentLogicalId, deployment] = deployments[0] ?? [];
    expect(deploymentLogicalId).toBeDefined();
    const deploymentProperties = properties(deployment ?? {});
    expect(deploymentProperties.ContainerName).toBe('native-bootstrap');
    expect(deploymentProperties.DeploymentRevision).toBe(SOURCE_SHA);
    expect(JSON.stringify(deploymentProperties.ClusterArn)).toContain(
      'BootstrapEcsCluster',
    );
    expect(JSON.stringify(deploymentProperties.TaskDefinitionArn)).toContain(
      'BootstrapTaskDefinition',
    );
    expect(asArray(deploymentProperties.SubnetIds)).toHaveLength(2);

    const rollbackValidations = resourceEntries(
      'Custom::PsdEocRollbackImageValidation',
    );
    expect(rollbackValidations).toHaveLength(1);
    const validationProperties = properties(rollbackValidations[0]?.[1] ?? {});
    expect(validationProperties.CurrentSourceSha).toBe(SOURCE_SHA);
    expect(validationProperties.ExpectedSourceRepositoryUrl).toBe(
      currentDeploymentTarget.sourceRepositoryUrl,
    );
    expect(validationProperties.ImageDigest).toEqual({
      Ref: 'RollbackApplicationImageDigest',
    });
    expect(validationProperties.Operation).toBe('ROLLBACK_IMAGE_VALIDATION');
    expect(JSON.stringify(validationProperties.RepositoryKind)).toContain(
      'RollbackApplicationRepository',
    );
    expect(JSON.stringify(validationProperties.RepositoryName)).toContain(
      'cdk-hnb659fds-container-assets',
    );
    expect(JSON.stringify(validationProperties.RepositoryName)).toContain(
      'ImageRepository',
    );
    expect(JSON.stringify(validationProperties.ServiceToken)).toContain(
      'RollbackImageValidationProvider',
    );
    expect(JSON.stringify(validationProperties.ServiceToken)).not.toContain(
      'RollbackImageValidationHandler',
    );
    const validationPolicy = resourceEntries('AWS::IAM::Policy').find(
      ([, resource]) =>
        JSON.stringify(properties(resource)).includes(
          'RollbackImageValidationHandlerServiceRole',
        ) && JSON.stringify(properties(resource)).includes('ecr:BatchGetImage'),
    )?.[1];
    expect(validationPolicy).toBeDefined();
    const serializedValidationPolicy = JSON.stringify(
      properties(validationPolicy ?? {}),
    );
    expect(serializedValidationPolicy).toContain('ecr:GetDownloadUrlForLayer');
    expect(serializedValidationPolicy).toContain(
      'cdk-hnb659fds-container-assets',
    );
    expect(serializedValidationPolicy).toContain('ImageRepository');
    expect(serializedValidationPolicy).not.toContain('ecr:DescribeImages');
    expect(serializedValidationPolicy).toContain('ecs:DescribeServices');
    expect(serializedValidationPolicy).toContain('BootstrapEcsCluster');
    expect(serializedValidationPolicy).toContain('psd-eoc-expo-push-worker');
    expect(serializedValidationPolicy).toContain('psd-eoc-aws-eum-sms-worker');
    expect(serializedValidationPolicy).toContain('psd-eoc-email-worker');

    const quiescence = resourceEntries('Custom::PsdEocRollbackQuiescence');
    expect(quiescence).toHaveLength(1);
    const [quiescenceLogicalId, quiescenceResource] = quiescence[0] ?? [];
    expect(quiescenceLogicalId).toBeDefined();
    const quiescenceProperties = properties(quiescenceResource ?? {});
    expect(quiescenceProperties.Operation).toBe('ROLLBACK_QUIESCENCE');
    expect(quiescenceProperties.RollbackSelected).toEqual({
      'Fn::If': ['ShouldUseRollbackApplicationImage', 'true', 'false'],
    });
    expect(asArray(quiescenceProperties.ServiceNames)).toHaveLength(3);
    const sendServices = resourceEntries('AWS::ECS::Service').filter(
      ([, resource]) =>
        [
          'psd-eoc-aws-eum-sms-worker',
          'psd-eoc-email-worker',
          'psd-eoc-expo-push-worker',
        ].includes(String(properties(resource).ServiceName)),
    );
    expect(sendServices).toHaveLength(3);
    for (const [, service] of sendServices) {
      expect(asArray(asRecord(service).DependsOn)).toContain(
        quiescenceLogicalId,
      );
    }
    const appRunnerResource = onlyResource('AWS::AppRunner::Service');
    expect(asArray(asRecord(appRunnerResource).DependsOn)).toContain(
      quiescenceLogicalId,
    );

    const digestLookupResource = resourceEntries('Custom::AWS').find(
      ([, resource]) =>
        JSON.stringify(properties(resource).Create).includes('describeImages'),
    );
    expect(digestLookupResource).toBeDefined();
    const digestLookup = properties(digestLookupResource?.[1] ?? {});
    expect(String(digestLookup.Create)).toContain('describeImages');
    expect(String(digestLookup.Create)).toContain(
      'cdk-hnb659fds-container-assets',
    );
    expect(String(digestLookup.Create)).not.toContain('psd-eoc/server');
    for (const [, taskDefinition] of resourceEntries(
      'AWS::ECS::TaskDefinition',
    )) {
      expect(
        JSON.stringify(properties(taskDefinition).ContainerDefinitions),
      ).not.toContain('RollbackApplicationImageDigest');
    }

    const runtimeResources = [
      onlyResource('AWS::AppRunner::Service'),
      ...resourceEntries('AWS::ECS::Service').map(([, resource]) => resource),
      resourceEntries('AWS::Events::Rule').find(
        ([, resource]) =>
          properties(resource).Name ===
          'psd-eoc-access-membership-sync-every-two-hours',
      )?.[1],
    ];
    expect(runtimeResources).toHaveLength(6);
    for (const resource of runtimeResources) {
      expect(resource).toBeDefined();
      expect(asArray(asRecord(resource).DependsOn)).toContain(
        deploymentLogicalId,
      );
    }

    const runTaskPolicies = resourceEntries('AWS::IAM::Policy').filter(
      ([, resource]) =>
        JSON.stringify(properties(resource).PolicyDocument).includes(
          'ecs:RunTask',
        ) &&
        JSON.stringify(properties(resource).PolicyDocument).includes(
          'cloudformation:DescribeStacks',
        ),
    );
    expect(runTaskPolicies).toHaveLength(1);
    const startPolicy = JSON.stringify(
      properties(runTaskPolicies[0]?.[1] ?? {}),
    );
    expect(startPolicy).toContain('BootstrapTaskDefinition');
    expect(startPolicy).toContain('iam:PassRole');
    expect(startPolicy).toContain('cloudformation:DescribeStacks');
    expect(startPolicy).not.toContain('ses:Send');
    expect(startPolicy).not.toContain('sns:Publish');

    const stopTaskPolicies = resourceEntries('AWS::IAM::Policy').filter(
      ([, resource]) =>
        JSON.stringify(properties(resource).PolicyDocument).includes(
          'ecs:StopTask',
        ),
    );
    expect(stopTaskPolicies).toHaveLength(1);
    const stopTaskPolicy = JSON.stringify(
      properties(stopTaskPolicies[0]?.[1] ?? {}),
    );
    expect(stopTaskPolicy).toContain('ecs:DescribeTasks');
    expect(stopTaskPolicy).toContain('BootstrapEcsCluster');
    expect(stopTaskPolicy).not.toContain('ses:Send');
    expect(stopTaskPolicy).not.toContain('sns:Publish');
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
    expect(secretResources).toContain('InitialAccessGroupSecret');
    expect(secretResources).not.toContain('BootstrapIdentitySecret');
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
    expect(JSON.stringify(container.Image)).toContain(
      'ApplicationImageDigestLookup',
    );
    expect(JSON.stringify(container.Image)).not.toContain('AppImageDigest');
    expect(JSON.stringify(container.Image)).not.toContain(
      'BootstrapImageDigest',
    );

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
        'PSD_EOC_PUSH_PROVIDER_CUTOVER',
        'SOURCE_SHA',
        'TMPDIR',
      ].sort(),
    );
    expect(environment.get('SOURCE_SHA')).toBe(SOURCE_SHA);
    // This task publishes a roster snapshot after refreshing membership, and
    // capturing a push endpoint requires knowing which provider this
    // deployment sends on. Without it every publication throws
    // `LOCAL_CONTACT_CAPTURE_INVALID` and the run publishes nothing, caught
    // and logged -- so the symptom is a roster that silently never advances,
    // the same shape as the hosted-domain omission below.
    expect(
      JSON.stringify(environment.get('PSD_EOC_PUSH_PROVIDER_CUTOVER')),
    ).toContain('PushProviderCutover');
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
  it('sends every recovery to the recovery topic and never to the phone', () => {
    // Alarm and recovery used to publish to the same topic, so a flapping
    // alarm both mailed and texted twice per cycle; one undeliverable email
    // message produced 79 of those in a fortnight. Recoveries still reach the
    // mailbox and no longer reach the phone.
    const alarms = resourceEntries('AWS::CloudWatch::Alarm').map(
      ([, resource]) => properties(resource),
    );
    expect(alarms.length).toBeGreaterThan(0);
    let recoveries = 0;
    for (const alarm of alarms) {
      if (alarm.OKActions === undefined) continue;
      for (const action of asArray(alarm.OKActions)) {
        expect(JSON.stringify(action)).toContain('RecoveryAlarmTopic');
        recoveries += 1;
      }
    }
    expect(recoveries).toBeGreaterThan(0);

    const smsSubscriptions = resourceEntries('AWS::SNS::Subscription')
      .map(([, resource]) => properties(resource))
      .filter((subscription) => subscription.Protocol === 'sms');
    expect(smsSubscriptions.length).toBeGreaterThan(0);
    for (const subscription of smsSubscriptions) {
      expect(JSON.stringify(subscription.TopicArn)).not.toContain(
        'RecoveryAlarmTopic',
      );
    }
    // The recovery topic still mails, or a recovery would go nowhere at all.
    const lambdaSubscriptions = resourceEntries('AWS::SNS::Subscription')
      .map(([, resource]) => properties(resource))
      .filter((subscription) => subscription.Protocol === 'lambda');
    expect(
      lambdaSubscriptions.some((subscription) =>
        JSON.stringify(subscription.TopicArn).includes('RecoveryAlarmTopic'),
      ),
    ).toBe(true);
  });

  it('needs a queue to stay backed up for three minutes before it pages', () => {
    // A message that fails and returns drives the age metric as a sawtooth. At
    // one datapoint the alarm followed every tooth.
    const queueAgeAlarms = resourceEntries('AWS::CloudWatch::Alarm')
      .map(([, resource]) => properties(resource))
      .filter((alarm) => String(alarm.AlarmName).endsWith('-queue-age'));
    expect(queueAgeAlarms.length).toBeGreaterThan(0);
    for (const alarm of queueAgeAlarms) {
      expect(alarm.DatapointsToAlarm).toBe(3);
      expect(alarm.EvaluationPeriods).toBe(3);
      expect(alarm.Threshold).toBe(60);
    }
  });

  it('does not page on a single App Runner 5xx', () => {
    // One 500 was most often a browser tab left open across a deploy, whose
    // server action the new build no longer recognises.
    const sustained = resourceEntries('AWS::CloudWatch::Alarm')
      .map(([, resource]) => properties(resource))
      .find((alarm) => alarm.AlarmName === 'psd-eoc-apprunner-5xx');
    if (sustained === undefined) {
      throw new Error('Missing the App Runner 5xx alarm.');
    }
    expect(sustained.DatapointsToAlarm).toBe(3);
    expect(sustained.EvaluationPeriods).toBe(3);

    // A genuine burst still pages immediately.
    const burst = resourceEntries('AWS::CloudWatch::Alarm')
      .map(([, resource]) => properties(resource))
      .find((alarm) => alarm.AlarmName === 'psd-eoc-apprunner-5xx-burst');
    if (burst === undefined) {
      throw new Error('Missing the App Runner 5xx burst alarm.');
    }
    expect(burst.Threshold).toBe(5);
    expect(burst.EvaluationPeriods).toBe(1);
  });

  it('measures Aurora capacity in ACU, not as a share of the ceiling', () => {
    // `ACUUtilization` is `capacity / max`. With a 0.5-to-1.0 range it has two
    // attainable values, 50 and 100, so an 80 percent threshold meant "Aurora
    // scaled up at all" -- which it does routinely with three connections and
    // no load. Alarming on it again would restore the noise.
    const alarms = resourceEntries('AWS::CloudWatch::Alarm').map(
      ([, resource]) => properties(resource),
    );
    for (const alarm of alarms) {
      expect(alarm.MetricName).not.toBe('ACUUtilization');
    }

    const capacity = alarms.find(
      (alarm) => alarm.AlarmName === 'psd-eoc-aurora-capacity-pinned',
    );
    if (capacity === undefined) {
      throw new Error('Missing the Aurora capacity alarm.');
    }
    expect(capacity.MetricName).toBe('ServerlessDatabaseCapacity');
    expect(capacity.DatapointsToAlarm).toBe(20);
    expect(capacity.EvaluationPeriods).toBe(20);
    // The threshold is the cluster's own ceiling; a lower one would fire on a
    // scale-up that never reached it.
    expect(capacity.Threshold).toBe(AURORA_MAX_CAPACITY_ACU);
  });

  it('gives the SMS heartbeat alarm room for more than one heartbeat', () => {
    // The worker heartbeats every five minutes. A twenty-minute window against
    // the previous fifteen-minute cadence held exactly one, so a single slow
    // poll emptied a period and the alarm treats missing data as breaching.
    const alarm = resourceEntries('AWS::CloudWatch::Alarm')
      .map(([, resource]) => properties(resource))
      .find((candidate) => candidate.AlarmName === 'psd-eoc-sms-worker-health');
    if (alarm === undefined) {
      throw new Error('Missing the SMS worker health alarm.');
    }
    expect(alarm.Period).toBe(900);
    expect(alarm.TreatMissingData).toBe('breaching');
  });

  it('deploys sanitized channel-worker metrics and alarms only with each worker', () => {
    const filters = resourceEntries('AWS::Logs::MetricFilter');
    // 15 channel-worker and membership filters, plus the two that count a
    // scheduled roster publication that threw or was refused.
    expect(filters).toHaveLength(17);
    expect(
      filters
        .map(([, resource]) => {
          const filter = properties(resource);
          const transformation = asRecord(
            asArray(filter.MetricTransformations)[0],
          );
          expect(transformation.MetricNamespace).toBe('PSD/EOC');
          return [
            transformation.MetricName,
            filter.FilterPattern,
            resource.Condition,
          ];
        })
        .sort(),
    ).toEqual(
      [
        [
          'AccessMembershipSyncFailureCount',
          '"Protected access-membership synchronization failed closed"',
          undefined,
        ],
        [
          'EmailCallbackFailureCount',
          '{ $.event = "email-callback-message-failed" }',
          'ShouldProvisionApplication',
        ],
        [
          'EmailCallbackWorkerHeartbeat',
          '{ $.event = "email-callback-worker-heartbeat" }',
          'ShouldProvisionApplication',
        ],
        [
          'EmailOutboxToProviderIncompleteCount',
          '{ ($.event = "email-worker-message-failed") || ($.event = "email-worker-message-incomplete") }',
          'ShouldRunEmailWorker',
        ],
        [
          'EmailOutboxToProviderLatency',
          '{ $.event = "email-worker-message-completed" }',
          'ShouldRunEmailWorker',
        ],
        [
          'EmailWorkerHeartbeat',
          '{ $.event = "email-worker-heartbeat" }',
          'ShouldRunEmailWorker',
        ],
        [
          'OutboxToProviderIncompleteCount',
          '{ ($.event = "push-worker-message-failed") || ($.event = "push-worker-message-incomplete") }',
          'ShouldRunExpoPushWorker',
        ],
        [
          'OutboxToProviderLatency',
          '{ $.event = "push-worker-message-completed" }',
          'ShouldRunExpoPushWorker',
        ],
        [
          'PushReceiptPollFailureCount',
          '{ $.event = "push-worker-receipts-failed" }',
          'ShouldRunExpoPushWorker',
        ],
        [
          'PushStuckOutboxCount',
          '{ $.event = "push-worker-stuck-outbox-sample" }',
          'ShouldRunExpoPushWorker',
        ],
        [
          'PushWorkerHeartbeat',
          '{ $.event = "push-worker-heartbeat" }',
          'ShouldRunExpoPushWorker',
        ],
        [
          'RosterMembershipSyncFailureCount',
          '{ $.event = "roster-membership-sync-failed" }',
          undefined,
        ],
        // The scheduled task's publish leg, unconditional like the membership
        // filters beside it: it writes to the bootstrap log group whether or
        // not the application tier is provisioned.
        [
          'ScheduledRosterPublishFailureCount',
          '{ $.event = "scheduled-roster-publish-complete" && $.kind = "refused" }',
          undefined,
        ],
        [
          'ScheduledRosterPublishFailureCount',
          '{ $.event = "scheduled-roster-publish-failed" }',
          undefined,
        ],
        [
          'SmsOutboxToProviderLatency',
          '{ $.event = "sms-worker-message-completed" }',
          'ShouldRunAwsEumSmsWorker',
        ],
        [
          'SmsWorkerFailureCount',
          '{ $.event = "sms-worker-message-failed" }',
          'ShouldRunAwsEumSmsWorker',
        ],
        [
          'SmsWorkerHeartbeat',
          '{ $.event = "sms-worker-heartbeat" }',
          'ShouldRunAwsEumSmsWorker',
        ],
      ].sort(),
    );
    const serializedFilters = JSON.stringify(filters).toLowerCase();
    for (const forbidden of [
      'recipient',
      'device-token',
      'pushtoken',
      'providerresponse',
      'phonenumber',
    ]) {
      expect(serializedFilters).not.toContain(forbidden);
    }

    const conditionalPushAlarms = resourceEntries('AWS::CloudWatch::Alarm')
      .filter(([, resource]) =>
        String(properties(resource).AlarmName).startsWith('psd-eoc-push-'),
      )
      .filter(([, resource]) => resource.Condition !== undefined);
    expect(
      conditionalPushAlarms
        .map(([, resource]) => {
          expect(resource.Condition).toBe('ShouldRunExpoPushWorker');
          const alarm = properties(resource);
          expect(String(alarm.AlarmDescription)).toContain('Runbook: https://');
          return alarm.AlarmName;
        })
        .sort(),
    ).toEqual(
      [
        'psd-eoc-push-outbox-to-provider-incomplete',
        'psd-eoc-push-outbox-to-provider-p95',
        'psd-eoc-push-receipt-poll-failures',
        'psd-eoc-push-stuck-production-outbox',
        'psd-eoc-push-worker-health',
      ].sort(),
    );

    const conditionalSmsAlarms = resourceEntries('AWS::CloudWatch::Alarm')
      .filter(([, resource]) =>
        String(properties(resource).AlarmName).startsWith('psd-eoc-sms-'),
      )
      .filter(([, resource]) => resource.Condition !== undefined);
    expect(
      conditionalSmsAlarms
        .map(([, resource]) => {
          expect(resource.Condition).toBe('ShouldRunAwsEumSmsWorker');
          const alarm = properties(resource);
          expect(String(alarm.AlarmDescription)).toContain('Runbook: https://');
          return alarm.AlarmName;
        })
        .sort(),
    ).toEqual(
      [
        'psd-eoc-sms-outbox-to-provider-p95',
        'psd-eoc-sms-worker-health',
        'psd-eoc-sms-worker-message-failures',
      ].sort(),
    );

    const conditionalEmailAlarms = resourceEntries('AWS::CloudWatch::Alarm')
      .filter(([, resource]) =>
        String(properties(resource).AlarmName).startsWith('psd-eoc-email-'),
      )
      .filter(([, resource]) => resource.Condition !== undefined);
    expect(
      conditionalEmailAlarms
        .map(([, resource]) => {
          expect([
            'ShouldRunEmailWorker',
            'ShouldProvisionApplication',
          ]).toContain(String(resource.Condition));
          const alarm = properties(resource);
          expect(String(alarm.AlarmDescription)).toContain('Runbook: https://');
          return alarm.AlarmName;
        })
        .sort(),
    ).toEqual(
      [
        'psd-eoc-email-callback-failures',
        'psd-eoc-email-callback-worker-health',
        'psd-eoc-email-provider-incomplete',
        'psd-eoc-email-worker-health',
      ].sort(),
    );
  });

  it('alarms when the scheduled task refreshes membership but publishes no roster', () => {
    // The publication is deliberately non-fatal: it must never take down the
    // leg that keeps sign-in working, so it logs and the task exits clean.
    // Nothing else would say the roster stopped advancing, and a roster that
    // silently stops advancing is what left staff out of an activation.
    const filters = resourceEntries('AWS::Logs::MetricFilter')
      .map(([, resource]) => properties(resource))
      .filter((filter) =>
        String(filter.FilterPattern).includes('scheduled-roster-publish'),
      );

    // Both ways it can fail to publish feed one metric: a publication that
    // threw, and one a completeness guard refused. The consequence is the
    // same either way.
    expect(
      filters
        .map((filter) =>
          asArray(filter.MetricTransformations).map(
            (t) => asRecord(t).MetricName,
          ),
        )
        .flat(),
    ).toEqual([
      'ScheduledRosterPublishFailureCount',
      'ScheduledRosterPublishFailureCount',
    ]);
    for (const filter of filters) {
      expect(JSON.stringify(filter.LogGroupName)).toContain(
        'BootstrapLogGroup',
      );
    }

    // `skipped` must not alarm: a tenant with no building source configured
    // has no roster to publish, and that is not a fault.
    const patterns = filters.map((filter) => String(filter.FilterPattern));
    expect(patterns.some((pattern) => pattern.includes('"refused"'))).toBe(
      true,
    );
    expect(patterns.some((pattern) => pattern.includes('skipped'))).toBe(false);

    const alarm = resourceEntries('AWS::CloudWatch::Alarm')
      .map(([, resource]) => resource)
      .find(
        (resource) =>
          properties(resource).AlarmName ===
          'psd-eoc-scheduled-roster-publish-failed',
      );
    if (alarm === undefined) {
      throw new Error('Missing the scheduled roster-publish alarm.');
    }
    expect(alarm.Condition).toBeUndefined();
    const properties_ = properties(alarm);
    expect(properties_.Threshold).toBe(1);
    expect(properties_.TreatMissingData).toBe('notBreaching');
    expect(String(properties_.AlarmDescription)).toContain('Runbook: https://');
    expect(JSON.stringify(asArray(properties_.AlarmActions)[0])).toContain(
      'OperationsAlarmTopic',
    );
    expect(asArray(properties_.OKActions)).toHaveLength(1);
  });

  it('alarms when the scheduled membership task fails either leg', () => {
    // The roster leg logs its failure and exits clean, so nothing else would
    // say a district list stopped refreshing; the sign-in leg failing is the
    // path to the 24-hour lockout. Both are read from the bootstrap log
    // group the task writes to, unconditionally.
    const filters = resourceEntries('AWS::Logs::MetricFilter')
      .map(([, resource]) => properties(resource))
      .filter((filter) =>
        [
          '"Protected access-membership synchronization failed closed"',
          '{ $.event = "roster-membership-sync-failed" }',
        ].includes(String(filter.FilterPattern)),
      );
    expect(
      filters
        .map((filter) =>
          asArray(filter.MetricTransformations).map(
            (t) => asRecord(t).MetricName,
          ),
        )
        .flat()
        .sort(),
    ).toEqual([
      'AccessMembershipSyncFailureCount',
      'RosterMembershipSyncFailureCount',
    ]);
    for (const filter of filters) {
      expect(JSON.stringify(filter.LogGroupName)).toContain(
        'BootstrapLogGroup',
      );
    }

    const alarms = resourceEntries('AWS::CloudWatch::Alarm').filter(
      ([, resource]) =>
        String(properties(resource).AlarmName).endsWith(
          '-membership-sync-failed',
        ),
    );
    expect(
      alarms.map(([, resource]) => properties(resource).AlarmName).sort(),
    ).toEqual([
      'psd-eoc-access-membership-sync-failed',
      'psd-eoc-roster-membership-sync-failed',
    ]);
    for (const [, resource] of alarms) {
      expect(resource.Condition).toBeUndefined();
      const alarm = properties(resource);
      expect(String(alarm.AlarmDescription)).toContain('Runbook: https://');
      expect(alarm.Threshold).toBe(1);
      expect(alarm.TreatMissingData).toBe('notBreaching');
      expect(asArray(alarm.AlarmActions)).toHaveLength(1);
      expect(asArray(alarm.OKActions)).toHaveLength(1);
      const action = JSON.stringify(asArray(alarm.AlarmActions)[0]);
      // The roster leg pages operations; the sign-in leg pages critical.
      expect(action).toContain(
        String(alarm.AlarmName).startsWith('psd-eoc-access-')
          ? 'CriticalAlarmTopic'
          : 'OperationsAlarmTopic',
      );
    }
  });

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
    // Three topics now: operations, critical, and the recovery topic that
    // every alarm's OK transition publishes to.
    expect(publishSids).toEqual([
      'AllowScopedCloudWatchAlarmPublish',
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
  it('keeps provider resources conditional, schedules disabled, and channel workers at zero', () => {
    for (const forbiddenType of [
      'AWS::Route53::HostedZone',
      'AWS::Scheduler::Schedule',
      'AWS::SES::EmailIdentity',
    ]) {
      template.resourceCountIs(forbiddenType, 0);
    }
    // The deployment owns the application's public name and the artifacts of
    // the probe that checks it. Both are pinned so an unintended record or
    // bucket still fails here.
    template.resourceCountIs('AWS::Route53::RecordSet', 1);
    // Two buckets, both pinned: the reachability probe's artifacts and the
    // private media bucket staff photos are written to. A third would fail
    // here.
    template.resourceCountIs('AWS::S3::Bucket', 2);
    template.resourceCountIs('AWS::Synthetics::Canary', 1);
    // Named application functions are bounded. CDK also synthesizes unnamed
    // image-lookup and asynchronous custom-resource framework handlers.
    expect(
      resourceEntries('AWS::Lambda::Function')
        .map(([, resource]) => properties(resource).FunctionName)
        .filter((name): name is string => typeof name === 'string')
        .sort(),
    ).toEqual([
      'psd-eoc-alarm-mailer',
      'psd-eoc-aurora-failover-metric',
      'psd-eoc-bootstrap-deployment-check',
      'psd-eoc-bootstrap-deployment-start',
      'psd-eoc-delivery-router',
      'psd-eoc-rollback-image-validation',
    ]);
    expect(
      resourceEntries('AWS::Events::Rule')
        .map(([, resource]) => String(properties(resource).Name))
        .sort(),
    ).toEqual([
      'psd-eoc-access-membership-sync-every-two-hours',
      'psd-eoc-aurora-failover-events',
      'psd-eoc-sms-delivery-events',
      'psd-eoc-sms-opt-out-reconciliation',
    ]);
    // Exactly one Lambda consumer exists, and it is the router. Provider send
    // services are conditional; the durable email callback service follows the
    // application so suppression evidence can still be ingested while sending
    // is dark.
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.resourceCountIs('AWS::ECS::Service', 4);
    const services = resourceEntries('AWS::ECS::Service').map(([, resource]) =>
      properties(resource),
    );
    const pushService = services.find(
      (service) => service.ServiceName === 'psd-eoc-expo-push-worker',
    );
    expect(pushService?.DesiredCount).toEqual({
      'Fn::If': ['ShouldRunExpoPushWorker', 1, 0],
    });
    const emailService = services.find(
      (service) => service.ServiceName === 'psd-eoc-email-worker',
    );
    expect(emailService?.DesiredCount).toEqual({
      'Fn::If': ['ShouldRunEmailWorker', 1, 0],
    });
    const callbackService = services.find(
      (service) => service.ServiceName === 'psd-eoc-email-callback-worker',
    );
    expect(callbackService?.DesiredCount).toEqual({
      'Fn::If': ['ShouldProvisionApplication', 1, 0],
    });
    const smsService = services.find(
      (service) => service.ServiceName === 'psd-eoc-aws-eum-sms-worker',
    );
    expect(smsService?.DesiredCount).toEqual({
      'Fn::If': ['ShouldRunAwsEumSmsWorker', 1, 0],
    });
    const callbackRole = roleLogicalIdForDescription(
      'Consumes only the durable SES callback queue',
    );
    expect(
      [
        ...new Set(allAllowedActions(inlineStatementsForRole(callbackRole))),
      ].sort(),
    ).toEqual(
      [
        'sqs:ChangeMessageVisibility',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
        'sqs:GetQueueUrl',
        'sqs:ReceiveMessage',
      ].sort(),
    );
    const smsRules = resourceEntries('AWS::Events::Rule')
      .map(([, resource]) => properties(resource))
      .filter((rule) => String(rule.Name).startsWith('psd-eoc-sms-'));
    expect(smsRules).toHaveLength(2);
    for (const rule of smsRules) {
      expect(rule.State).toEqual({
        'Fn::If': ['ShouldRunAwsEumSmsWorker', 'ENABLED', 'DISABLED'],
      });
    }
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
      // Three mailer subscriptions and two SMS ones: the recovery topic mails
      // but never texts, so a recovery cannot page anybody.
    ).toEqual(['lambda', 'lambda', 'lambda', 'sms', 'sms', 'sqs']);
    expect(
      Object.values(resources)
        .map((resource) => String(asRecord(resource).Type))
        .filter((type) => type.startsWith('Custom::'))
        .sort(),
    ).toEqual([
      'Custom::AWS',
      'Custom::AWS',
      'Custom::PsdEocBootstrapDeployment',
      'Custom::PsdEocRollbackImageValidation',
      'Custom::PsdEocRollbackQuiescence',
    ]);
    const serializedTemplate = JSON.stringify(synthesized);
    expect(serializedTemplate).not.toContain('rds-data:');
    expect(serializedTemplate).not.toContain('aws-data-api');
    expect(serializedTemplate).not.toContain('DATABASE_RESOURCE_ARN');
    expect(serializedTemplate).not.toContain('DATABASE_SECRET_ARN');
    // SES send authority exists only on the alarm mailer and isolated email
    // worker. App Runner remains unable to send directly.
    const sesSenders = resourceEntries('AWS::IAM::Policy').filter(
      ([, resource]) =>
        JSON.stringify(properties(resource).PolicyDocument).includes(
          'ses:SendEmail',
        ),
    );
    expect(sesSenders).toHaveLength(2);
    const senderConditions = sesSenders.map(
      ([, resource]) =>
        asArray(asRecord(properties(resource).PolicyDocument).Statement)
          .map(asRecord)
          .find((statement) =>
            asStringArray(statement.Action).includes('ses:SendEmail'),
          )?.Condition,
    );
    expect(senderConditions).toEqual(
      expect.arrayContaining([
        {
          StringEquals: {
            'ses:FromAddress': `eoc-alarms@${SES_IDENTITY_DOMAIN}`,
          },
        },
        { StringEquals: { 'ses:FromAddress': SES_FROM_ADDRESS } },
      ]),
    );
    const runtimeRole = roleLogicalIdForServicePrincipal(
      'tasks.apprunner.amazonaws.com',
    );
    expect(
      allAllowedActions(inlineStatementsForRole(runtimeRole)),
    ).not.toContain('ses:SendEmail');
    expect(serializedTemplate).not.toContain('controlled-recipient');
  });

  it('enables the SES configuration set and wires encrypted signed evidence', () => {
    const configurationSetResource = onlyResource('AWS::SES::ConfigurationSet');
    const configurationSet = properties(configurationSetResource);
    expect(configurationSet.Name).toBe(SES_CONFIGURATION_SET_NAME);
    expect(configurationSet.SendingOptions).toEqual({
      SendingEnabled: true,
    });
    expect(configurationSet.ReputationOptions).toEqual({
      ReputationMetricsEnabled: true,
    });
    expect(configurationSetResource.DeletionPolicy).toBe('Retain');
    expect(configurationSetResource.UpdateReplacePolicy).toBe('Retain');

    const eventDestination = properties(
      onlyResource('AWS::SES::ConfigurationSetEventDestination'),
    );
    expect(eventDestination.ConfigurationSetName).toEqual({
      Ref: expect.stringContaining('EmailConfigurationSet'),
    });
    expect(eventDestination.EventDestination).toEqual(
      expect.objectContaining({
        Enabled: true,
        MatchingEventTypes: [
          'SEND',
          'DELIVERY',
          'BOUNCE',
          'COMPLAINT',
          'REJECT',
        ],
        Name: SES_EVENT_DESTINATION_NAME,
        SnsDestination: {
          TopicARN: { Ref: expect.stringContaining('EmailEventsTopic') },
        },
      }),
    );

    const queueSubscriptionResource = resourceEntries(
      'AWS::SNS::Subscription',
    ).find(([, resource]) => properties(resource).Protocol === 'sqs')?.[1];
    if (queueSubscriptionResource === undefined) {
      throw new Error('Missing durable SES callback subscription.');
    }
    const queueSubscription = properties(queueSubscriptionResource);
    expect(JSON.stringify(queueSubscription.Endpoint)).toContain(
      'EmailCallbackQueue',
    );
    expect(JSON.stringify(queueSubscription.TopicArn)).toContain(
      'EmailEventsTopic',
    );
    expect(queueSubscription.RawMessageDelivery).toBe(false);

    const callbackQueueResource = resourceEntries('AWS::SQS::Queue').find(
      ([, resource]) =>
        properties(resource).QueueName === EMAIL_CALLBACK_QUEUE_NAME,
    )?.[1];
    if (callbackQueueResource === undefined) {
      throw new Error('Missing durable callback queue.');
    }
    expect(properties(callbackQueueResource).RedrivePolicy).toEqual({
      deadLetterTargetArn: {
        'Fn::GetAtt': [
          expect.stringContaining('EmailCallbackDeadLetterQueue'),
          'Arn',
        ],
      },
      maxReceiveCount: 5,
    });
    expect(callbackQueueResource.DeletionPolicy).toBe('RetainExceptOnCreate');
    expect(callbackQueueResource.UpdateReplacePolicy).toBe('Retain');

    const callbackDeadLetterQueueResource = resourceEntries(
      'AWS::SQS::Queue',
    ).find(
      ([, resource]) =>
        properties(resource).QueueName ===
        EMAIL_CALLBACK_DEAD_LETTER_QUEUE_NAME,
    )?.[1];
    if (callbackDeadLetterQueueResource === undefined) {
      throw new Error('Missing callback dead-letter queue.');
    }
    const callbackRedriveAllowPolicy = asRecord(
      properties(callbackDeadLetterQueueResource).RedriveAllowPolicy,
    );
    expect(callbackRedriveAllowPolicy.redrivePermission).toBe('byQueue');
    expect(asArray(callbackRedriveAllowPolicy.sourceQueueArns)).toHaveLength(1);
    expect(
      JSON.stringify(callbackRedriveAllowPolicy.sourceQueueArns),
    ).toContain(
      `:sqs:${AWS_REGION}:${AWS_ACCOUNT}:${EMAIL_CALLBACK_QUEUE_NAME}`,
    );
    expect(callbackDeadLetterQueueResource.DeletionPolicy).toBe(
      'RetainExceptOnCreate',
    );
    expect(callbackDeadLetterQueueResource.UpdateReplacePolicy).toBe('Retain');
    expect(
      resourceEntries('AWS::CloudWatch::Alarm').some(
        ([, resource]) =>
          properties(resource).AlarmName === 'psd-eoc-email-callback-dlq-depth',
      ),
    ).toBe(true);
    expect(
      resourceEntries('AWS::CloudWatch::Alarm').some(
        ([, resource]) =>
          properties(resource).AlarmName ===
          'psd-eoc-email-callback-worker-health',
      ),
    ).toBe(true);

    const callbackTask = properties(
      taskDefinitionByFamily('psd-eoc-email-callback-worker'),
    );
    const callbackContainer = asArray(callbackTask.ContainerDefinitions)
      .map(asRecord)
      .find((container) => container.Name === 'ses-email-callback-worker');
    if (callbackContainer === undefined) {
      throw new Error('Missing email callback worker container.');
    }
    expect(callbackContainer.Command).toEqual([
      'bun',
      'workers/email/callback-service.ts',
    ]);
    expect(JSON.stringify(callbackContainer.Image)).toContain(
      'ApplicationImageDigestLookup',
    );
    expect(JSON.stringify(callbackContainer.LogConfiguration)).toContain(
      'EmailCallbackWorkerLogGroup',
    );
    const callbackEnvironment = new Map(
      asArray(callbackContainer.Environment).map((entry) => {
        const variable = asRecord(entry);
        return [variable.Name, variable.Value];
      }),
    );
    expect(
      JSON.stringify(callbackEnvironment.get('EMAIL_CALLBACK_QUEUE_ARN')),
    ).toContain('EmailCallbackQueue');
    expect(
      JSON.stringify(callbackEnvironment.get('EMAIL_CALLBACK_QUEUE_URL')),
    ).toContain('EmailCallbackQueue');
    expect(
      resourceEntries('AWS::Logs::LogGroup').some(
        ([, resource]) =>
          properties(resource).LogGroupName ===
          EMAIL_CALLBACK_WORKER_LOG_GROUP_NAME,
      ),
    ).toBe(true);
    const callbackService = resourceEntries('AWS::ECS::Service')
      .map(([, resource]) => properties(resource))
      .find(
        (resource) => resource.ServiceName === 'psd-eoc-email-callback-worker',
      );
    expect(callbackService?.DesiredCount).toEqual({
      'Fn::If': ['ShouldProvisionApplication', 1, 0],
    });

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
        'DeployedApplicationImageDigest',
        'DeployedApplicationSourceSha',
        'DeploymentBootstrapImageDigest',
        'DeploymentAccount',
        'DeploymentRegion',
        'DeploymentSourceSha',
        'EmailChannelState',
        'EmailCallbackDeadLetterQueueArn',
        'EmailCallbackQueueArn',
        'EmailCallbackQueueUrl',
        'EmailCallbackWorkerLogGroupName',
        'EmailCallbackWorkerServiceArn',
        'EmailDeadLetterQueueArn',
        'EmailQueueArn',
        'EmailQueueUrl',
        'EmailWorkerDeploymentState',
        'EmailWorkerLogGroupName',
        'EmailWorkerRoleArn',
        'EmailWorkerServiceArn',
        'EmailWorkerTaskDefinitionArn',
        'EmailWorkerTaskExecutionRoleArn',
        'EnvironmentName',
        'ExpectedAwsAccountAlias',
        'ExpoAccessTokenSecretArn',
        'HealthQueueArn',
        'HealthQueueUrl',
        'ImageRepositoryArn',
        'ImageRepositoryUri',
        'MonitoringDashboardName',
        'MonitoringDashboardUrl',
        'PushDeadLetterQueueArn',
        'PushIntegrationTruth',
        'PushQueueArn',
        'PushQueueUrl',
        'PushWorkerDeploymentState',
        'PushWorkerLogGroupName',
        'PushWorkerServiceArn',
        'PushWorkerTaskDefinitionArn',
        'PushWorkerTaskExecutionRoleArn',
        'PushWorkerTaskRoleArn',
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
      'cloudformation',
    );
    expect(asRecord(outputs.SesIntegrationTruth).Value).toEqual({
      'Fn::If': [
        'ShouldRunEmailWorker',
        'configured-awaiting-human-verification',
        'configured-unverified',
      ],
    });
    expect(asRecord(outputs.EmailChannelState).Value).toEqual({
      'Fn::If': [
        'ShouldRunEmailWorker',
        'awaiting-human-verification',
        'disabled',
      ],
    });
    expect(
      JSON.stringify(asRecord(outputs.DeploymentBootstrapImageDigest).Value),
    ).toContain('ApplicationImageDigestLookup');
    expect(asRecord(outputs.DeploymentSourceSha).Value).toBe(SOURCE_SHA);
    expect(
      JSON.stringify(asRecord(outputs.DeployedApplicationImageDigest).Value),
    ).toContain('RollbackApplicationImageDigest');
    expect(
      JSON.stringify(asRecord(outputs.DeployedApplicationSourceSha).Value),
    ).toContain('RollbackImageValidation');
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
