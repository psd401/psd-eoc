import { describe, expect, it } from 'bun:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

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
  SES_CONFIGURATION_SET_NAME,
  SES_EVENT_DESTINATION_NAME,
  SES_EVENT_TOPIC_NAME,
  SES_EVENT_TYPES,
  SES_IDENTITY_DOMAIN,
  SES_MAIL_FROM_DOMAIN,
  SES_PARENT_HOSTED_ZONE_ID,
} from '../src/config';
import { PsdEocStack } from '../src/psd-eoc-stack';

type JsonRecord = Record<string, unknown>;

interface SynthesizedResource extends JsonRecord {
  readonly DeletionPolicy?: unknown;
  readonly Properties?: unknown;
  readonly UpdateReplacePolicy?: unknown;
}

function asRecord(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(
      `Expected an object, received ${JSON.stringify(value)}`,
    );
  }
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected an array, received ${JSON.stringify(value)}`);
  }
  return value;
}

function asStringArray(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  if (!values.every((item) => typeof item === 'string')) {
    throw new TypeError(
      `Expected a string or string array, received ${JSON.stringify(value)}`,
    );
  }
  return values as string[];
}

function collectAllowedActions(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectAllowedActions);
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const record = value as JsonRecord;
  const ownActions =
    record.Effect === 'Allow' &&
    (typeof record.Action === 'string' || Array.isArray(record.Action))
      ? asStringArray(record.Action)
      : [];
  return [
    ...ownActions,
    ...Object.values(record).flatMap(collectAllowedActions),
  ];
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

function resourceProperties(resource: SynthesizedResource): JsonRecord {
  return asRecord(resource.Properties);
}

const app = new App();
const stack = new PsdEocStack(app, 'PsdEocTest', {
  env: {
    account: DEPLOYMENT_ACCOUNT,
    region: DEPLOYMENT_REGION,
  },
});
const template = Template.fromStack(stack);
const synthesizedTemplate = asRecord(template.toJSON());

describe('Aurora high-availability baseline', () => {
  it('keeps Serverless v2 running with the Data API and retained encryption', () => {
    const cluster = onlyResource('AWS::RDS::DBCluster');
    const properties = resourceProperties(cluster);
    const scaling = asRecord(properties.ServerlessV2ScalingConfiguration);

    expect(properties.Engine).toBe('aurora-postgresql');
    expect(properties.EnableHttpEndpoint).toBe(true);
    expect(properties.StorageEncrypted).toBe(true);
    expect(properties.DeletionProtection).toBe(true);
    expect(properties.KmsKeyId).toBeDefined();
    expect(properties.BackupRetentionPeriod).toBe(35);
    expect(scaling.MinCapacity).toBeNumber();
    expect(scaling.MinCapacity as number).toBeGreaterThanOrEqual(0.5);
    expect(scaling.MaxCapacity as number).toBeGreaterThanOrEqual(
      scaling.MinCapacity as number,
    );
    expect(scaling).not.toHaveProperty('SecondsUntilAutoPause');
    expect(cluster.DeletionPolicy).toBe('Retain');
    expect(cluster.UpdateReplacePolicy).toBe('Retain');
  });

  it('places a non-public writer and promotion reader in separate AZs', () => {
    const instances = resourceEntries('AWS::RDS::DBInstance');
    expect(instances).toHaveLength(2);

    const properties = instances.map(([, resource]) =>
      resourceProperties(resource),
    );
    for (const instance of properties) {
      expect(instance.DBInstanceClass).toBe('db.serverless');
      expect(instance.PubliclyAccessible).toBe(false);
      expect(instance.DBClusterIdentifier).toBeDefined();
    }

    expect(
      properties.map((instance) => instance.AvailabilityZone).sort(),
    ).toEqual(['us-west-2a', 'us-west-2b']);
    expect(properties.map((instance) => instance.PromotionTier).sort()).toEqual(
      [0, 1],
    );
    for (const [, instance] of instances) {
      expect(instance.DeletionPolicy).toBe('Retain');
      expect(instance.UpdateReplacePolicy).toBe('Retain');
    }

    template.resourceCountIs('AWS::EC2::NATGateway', 0);
    template.resourceCountIs('AWS::EC2::InternetGateway', 0);
  });
});

describe('retained private media storage', () => {
  it('retains ready media while bounding quarantine object reclamation', () => {
    const bucket = onlyResource('AWS::S3::Bucket');
    const properties = resourceProperties(bucket);

    expect(properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    expect(properties.BucketEncryption).toEqual({
      ServerSideEncryptionConfiguration: [
        {
          BucketKeyEnabled: true,
          ServerSideEncryptionByDefault: {
            KMSMasterKeyID: expect.anything(),
            SSEAlgorithm: 'aws:kms',
          },
        },
      ],
    });
    expect(properties.LifecycleConfiguration).toEqual({
      Rules: [
        {
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          ExpirationInDays: 1,
          Id: 'ExpireAbandonedQuarantineMedia',
          NoncurrentVersionExpiration: { NoncurrentDays: 1 },
          Prefix: 'quarantine/',
          Status: 'Enabled',
        },
      ],
    });
    expect(JSON.stringify(properties.LifecycleConfiguration)).not.toContain(
      'ready/',
    );
    expect(properties).not.toHaveProperty('WebsiteConfiguration');
    expect(properties).not.toHaveProperty('AccessControl');
    expect(bucket.DeletionPolicy).toBe('Retain');
    expect(bucket.UpdateReplacePolicy).toBe('Retain');

    const bucketPolicies = template.findResources('AWS::S3::BucketPolicy');
    expect(JSON.stringify(bucketPolicies)).toContain('aws:SecureTransport');
    expect(JSON.stringify(bucketPolicies)).toContain('Deny');
    for (const policy of Object.values(bucketPolicies).map(asRecord)) {
      expect(policy.DeletionPolicy).toBe('Retain');
      expect(policy.UpdateReplacePolicy).toBe('Retain');
    }
  });

  it('denies unconditional writes to create-only quarantine and ready media', () => {
    const bucketPolicy = resourceProperties(
      onlyResource('AWS::S3::BucketPolicy'),
    );
    const statements = asArray(
      asRecord(bucketPolicy.PolicyDocument).Statement,
    ).map(asRecord);
    const createOnlyQuarantine = statements.find(
      (statement) => statement.Sid === 'DenyUnconditionalQuarantineMediaWrite',
    );
    if (createOnlyQuarantine === undefined) {
      throw new Error('Missing create-only quarantine-media bucket policy.');
    }
    expect(createOnlyQuarantine.Effect).toBe('Deny');
    expect(createOnlyQuarantine.Principal).toEqual({ AWS: '*' });
    expect(createOnlyQuarantine.Action).toBe('s3:PutObject');
    expect(JSON.stringify(createOnlyQuarantine.Resource)).toContain(
      '/quarantine/*',
    );
    expect(createOnlyQuarantine.Condition).toEqual({
      Bool: { 's3:ObjectCreationOperation': 'true' },
      Null: { 's3:if-none-match': 'true' },
    });

    const immutableReady = statements.find(
      (statement) => statement.Sid === 'DenyUnconditionalReadyMediaWrite',
    );
    if (immutableReady === undefined) {
      throw new Error('Missing immutable ready-media bucket policy.');
    }
    expect(immutableReady.Effect).toBe('Deny');
    expect(immutableReady.Principal).toEqual({ AWS: '*' });
    expect(immutableReady.Action).toBe('s3:PutObject');
    expect(JSON.stringify(immutableReady.Resource)).toContain('/ready/*');
    expect(immutableReady.Condition).toEqual({
      Bool: { 's3:ObjectCreationOperation': 'true' },
      Null: { 's3:if-none-match': 'true' },
    });

    const deleteBoundary = statements.find(
      (statement) => statement.Sid === 'DenyReadyMediaDeletion',
    );
    if (deleteBoundary === undefined) {
      throw new Error('Missing ready-media deletion boundary.');
    }
    expect(deleteBoundary.Effect).toBe('Deny');
    expect(deleteBoundary.Principal).toEqual({ AWS: '*' });
    expect(asStringArray(deleteBoundary.Action).sort()).toEqual(
      ['s3:DeleteObject', 's3:DeleteObjectVersion'].sort(),
    );
    expect(JSON.stringify(deleteBoundary.Resource)).toContain('/ready/*');
    expect(deleteBoundary).not.toHaveProperty('Condition');
  });

  it('allows only exact-origin browser PUTs with bounded checksum visibility', () => {
    const parameters = asRecord(synthesizedTemplate.Parameters);
    const originParameter = asRecord(parameters.MediaUploadAllowedOrigin);
    expect(originParameter.Type).toBe('String');
    expect(originParameter).not.toHaveProperty('Default');
    expect(originParameter.AllowedPattern).toBeString();
    expect(originParameter.AllowedPattern as string).toStartWith('^https://');
    expect(originParameter.AllowedPattern as string).toEndWith('$');

    const bucket = onlyResource('AWS::S3::Bucket');
    const cors = asRecord(resourceProperties(bucket).CorsConfiguration);
    const rules = asArray(cors.CorsRules).map(asRecord);
    expect(rules).toHaveLength(1);
    const rule = rules[0];
    if (rule === undefined) {
      throw new Error('Missing media upload CORS rule.');
    }
    expect(rule.AllowedMethods).toEqual(['PUT']);
    expect(rule.AllowedOrigins).toEqual([{ Ref: 'MediaUploadAllowedOrigin' }]);
    expect(rule.AllowedHeaders).toEqual(['content-type', 'if-none-match']);
    expect(rule.ExposedHeaders).toEqual(['ETag', 'x-amz-checksum-sha256']);
    expect(rule.MaxAge).toBeNumber();
    expect(rule.MaxAge as number).toBeGreaterThan(0);
    expect(rule.MaxAge as number).toBeLessThanOrEqual(300);
    expect(JSON.stringify(rule.AllowedOrigins)).not.toContain('"*"');
    expect(asStringArray(rule.AllowedHeaders)).not.toContain('*');
  });

  it('scans and tags only quarantine uploads with the official service role boundary', () => {
    const bucketEntry = resourceEntries('AWS::S3::Bucket')[0];
    if (bucketEntry === undefined) {
      throw new Error('Missing media bucket.');
    }
    const [bucketLogicalId] = bucketEntry;
    const scanRoleEntry = resourceEntries('AWS::IAM::Role').find(([, role]) =>
      JSON.stringify(
        asRecord(resourceProperties(role).AssumeRolePolicyDocument).Statement,
      ).includes('malware-protection-plan.guardduty.amazonaws.com'),
    );
    if (scanRoleEntry === undefined) {
      throw new Error('Missing GuardDuty malware scan role.');
    }
    const [scanRoleLogicalId, scanRole] = scanRoleEntry;
    const scanRoleProperties = resourceProperties(scanRole);
    expect(scanRoleProperties.AssumeRolePolicyDocument).toEqual({
      Statement: [
        {
          Action: 'sts:AssumeRole',
          Condition: {
            ArnLike: {
              'aws:SourceArn': {
                'Fn::Join': [
                  '',
                  [
                    'arn:',
                    { Ref: 'AWS::Partition' },
                    `:guardduty:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT}:malware-protection-plan/*`,
                  ],
                ],
              },
            },
            StringEquals: {
              'aws:SourceAccount': DEPLOYMENT_ACCOUNT,
            },
          },
          Effect: 'Allow',
          Principal: {
            Service: 'malware-protection-plan.guardduty.amazonaws.com',
          },
        },
      ],
      Version: '2012-10-17',
    });

    const plan = onlyResource('AWS::GuardDuty::MalwareProtectionPlan');
    const planProperties = resourceProperties(plan);
    expect(planProperties.Actions).toEqual({
      Tagging: { Status: 'ENABLED' },
    });
    expect(planProperties.ProtectedResource).toEqual({
      S3Bucket: {
        BucketName: { Ref: bucketLogicalId },
        ObjectPrefixes: ['quarantine/'],
      },
    });
    expect(planProperties.Role).toEqual({
      'Fn::GetAtt': [scanRoleLogicalId, 'Arn'],
    });
    const dependencies = Array.isArray(plan.DependsOn)
      ? plan.DependsOn
      : [plan.DependsOn];
    expect(dependencies).toContain(scanRoleLogicalId);

    const policies = asArray(scanRoleProperties.Policies).map(asRecord);
    expect(policies).toHaveLength(1);
    const policy = policies[0];
    if (policy === undefined) {
      throw new Error('Missing GuardDuty inline scan policy.');
    }
    const statements = asArray(asRecord(policy.PolicyDocument).Statement).map(
      asRecord,
    );
    expect(statements).toHaveLength(8);
    const statementsBySid = new Map(
      statements.map((statement) => [String(statement.Sid), statement]),
    );
    const statement = (sid: string): JsonRecord => {
      const value = statementsBySid.get(sid);
      if (value === undefined) {
        throw new Error(`Missing GuardDuty statement ${sid}.`);
      }
      return value;
    };
    const managedRuleArn = {
      'Fn::Join': [
        '',
        [
          'arn:',
          { Ref: 'AWS::Partition' },
          `:events:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`,
        ],
      ],
    };

    expect(
      asStringArray(
        statement('AllowManagedRuleToSendS3EventsToGuardDuty').Action,
      ).sort(),
    ).toEqual(
      [
        'events:PutRule',
        'events:DeleteRule',
        'events:PutTargets',
        'events:RemoveTargets',
      ].sort(),
    );
    expect(
      statement('AllowManagedRuleToSendS3EventsToGuardDuty').Resource,
    ).toEqual(managedRuleArn);
    expect(
      statement('AllowManagedRuleToSendS3EventsToGuardDuty').Condition,
    ).toEqual({
      StringLike: {
        'events:ManagedBy': 'malware-protection-plan.guardduty.amazonaws.com',
      },
    });
    expect(
      asStringArray(
        statement('AllowGuardDutyToMonitorEventBridgeManagedRule').Action,
      ).sort(),
    ).toEqual(['events:DescribeRule', 'events:ListTargetsByRule'].sort());
    expect(
      statement('AllowGuardDutyToMonitorEventBridgeManagedRule').Resource,
    ).toEqual(managedRuleArn);

    expect(asStringArray(statement('AllowPostScanTag').Action).sort()).toEqual(
      [
        's3:PutObjectTagging',
        's3:GetObjectTagging',
        's3:PutObjectVersionTagging',
        's3:GetObjectVersionTagging',
      ].sort(),
    );
    expect(JSON.stringify(statement('AllowPostScanTag').Resource)).toContain(
      `${bucketLogicalId}","Arn"`,
    );
    expect(JSON.stringify(statement('AllowPostScanTag').Resource)).toContain(
      '/quarantine/*',
    );

    expect(
      asStringArray(statement('AllowEnableS3EventBridgeEvents').Action).sort(),
    ).toEqual(['s3:PutBucketNotification', 's3:GetBucketNotification'].sort());
    expect(statement('AllowEnableS3EventBridgeEvents').Resource).toEqual({
      'Fn::GetAtt': [bucketLogicalId, 'Arn'],
    });
    expect(statement('AllowPutValidationObject').Action).toBe('s3:PutObject');
    expect(
      JSON.stringify(statement('AllowPutValidationObject').Resource),
    ).toContain('/malware-protection-resource-validation-object');

    expect(statement('AllowCheckBucketOwnership').Action).toBe('s3:ListBucket');
    expect(statement('AllowCheckBucketOwnership').Resource).toEqual({
      'Fn::GetAtt': [bucketLogicalId, 'Arn'],
    });
    expect(statement('AllowCheckBucketOwnership').Condition).toEqual({
      StringLike: { 's3:prefix': 'quarantine/*' },
    });
    expect(asStringArray(statement('AllowMalwareScan').Action).sort()).toEqual(
      ['s3:GetObject', 's3:GetObjectVersion'].sort(),
    );
    expect(JSON.stringify(statement('AllowMalwareScan').Resource)).toContain(
      '/quarantine/*',
    );

    const dataKeyEntry = resourceEntries('AWS::KMS::Key').find(
      ([, key]) =>
        resourceProperties(key).Description ===
        'Encrypts retained PSD EOC database and media data.',
    );
    if (dataKeyEntry === undefined) {
      throw new Error('Missing PSD EOC data key.');
    }
    expect(
      asStringArray(statement('AllowDecryptForMalwareScan').Action).sort(),
    ).toEqual(['kms:GenerateDataKey', 'kms:Decrypt'].sort());
    expect(statement('AllowDecryptForMalwareScan').Resource).toEqual({
      'Fn::GetAtt': [dataKeyEntry[0], 'Arn'],
    });
    expect(statement('AllowDecryptForMalwareScan').Condition).toEqual({
      StringLike: {
        'kms:ViaService': `s3.${DEPLOYMENT_REGION}.amazonaws.com`,
      },
    });
    expect(JSON.stringify(statements)).not.toMatch(
      /s3:DeleteObject|kms:\*|s3:\*/u,
    );

    const bucketPolicy = resourceProperties(
      onlyResource('AWS::S3::BucketPolicy'),
    );
    const bucketStatements = asArray(
      asRecord(bucketPolicy.PolicyDocument).Statement,
    ).map(asRecord);
    const bucketStatement = (sid: string): JsonRecord => {
      const value = bucketStatements.find((candidate) => candidate.Sid === sid);
      if (value === undefined) {
        throw new Error(`Missing media bucket statement ${sid}.`);
      }
      return value;
    };
    const scanRoleArn = { 'Fn::GetAtt': [scanRoleLogicalId, 'Arn'] };
    const expectedScannerRoleCondition = {
      ArnNotEquals: {
        'aws:PrincipalArn': scanRoleArn,
      },
    };
    const tagMutationBoundary = bucketStatement(
      'DenyQuarantineScanTagMutationOutsideGuardDuty',
    );
    expect(tagMutationBoundary.Effect).toBe('Deny');
    expect(tagMutationBoundary.Principal).toEqual({ AWS: '*' });
    expect(tagMutationBoundary).not.toHaveProperty('NotPrincipal');
    expect(asStringArray(tagMutationBoundary.Action).sort()).toEqual(
      [
        's3:PutObjectTagging',
        's3:PutObjectVersionTagging',
        's3:DeleteObjectTagging',
        's3:DeleteObjectVersionTagging',
      ].sort(),
    );
    expect(JSON.stringify(tagMutationBoundary.Resource)).toContain(
      '/quarantine/*',
    );
    expect(tagMutationBoundary.Condition).toEqual(expectedScannerRoleCondition);

    const cleanReadBoundary = bucketStatement(
      'DenyQuarantineReadUnlessGuardDutyMarkedClean',
    );
    expect(cleanReadBoundary.Effect).toBe('Deny');
    expect(cleanReadBoundary.Principal).toEqual({ AWS: '*' });
    expect(cleanReadBoundary).not.toHaveProperty('NotPrincipal');
    expect(asStringArray(cleanReadBoundary.Action).sort()).toEqual(
      ['s3:GetObject', 's3:GetObjectVersion'].sort(),
    );
    expect(JSON.stringify(cleanReadBoundary.Resource)).toContain(
      '/quarantine/*',
    );
    expect(cleanReadBoundary.Condition).toEqual({
      ...expectedScannerRoleCondition,
      StringNotEquals: {
        's3:ExistingObjectTag/GuardDutyMalwareScanStatus': 'NO_THREATS_FOUND',
      },
    });
  });

  it('gives App Runner exact media data access without scan-tag write authority', () => {
    const serviceProperties = resourceProperties(
      onlyResource('AWS::AppRunner::Service'),
    );
    const instanceConfiguration = asRecord(
      serviceProperties.InstanceConfiguration,
    );
    const instanceRoleArn = asRecord(instanceConfiguration.InstanceRoleArn);
    const instanceRoleLogicalId = String(
      asArray(instanceRoleArn['Fn::GetAtt'])[0],
    );
    const runtimePolicyEntries = resourceEntries('AWS::IAM::Policy').filter(
      ([, policy]) =>
        JSON.stringify(resourceProperties(policy).Roles).includes(
          instanceRoleLogicalId,
        ),
    );
    if (runtimePolicyEntries.length === 0) {
      throw new Error('Missing App Runner runtime policy.');
    }
    const statements = runtimePolicyEntries.flatMap(([, policy]) =>
      asArray(
        asRecord(resourceProperties(policy).PolicyDocument).Statement,
      ).map(asRecord),
    );
    const scanTagRead = statements.find(
      (statement) => statement.Action === 's3:GetObjectTagging',
    );
    if (scanTagRead === undefined) {
      throw new Error('Missing App Runner GuardDuty scan-tag read.');
    }
    expect(scanTagRead.Effect).toBe('Allow');
    expect(JSON.stringify(scanTagRead.Resource)).toContain('/quarantine/*');
    const actions = statements.flatMap((statement) =>
      asStringArray(statement.Action),
    );
    expect(actions.filter((action) => action.startsWith('s3:')).sort()).toEqual(
      ['s3:GetObject', 's3:GetObjectTagging', 's3:PutObject'].sort(),
    );
    expect(actions).toContain('s3:GetObject');
    expect(actions).toContain('s3:PutObject');
    expect(actions).toContain('kms:Decrypt');
    expect(actions).toContain('kms:GenerateDataKey');
    expect(actions).not.toContain('s3:PutObjectTagging');
    expect(actions).not.toContain('s3:PutObjectVersionTagging');
    expect(actions).not.toContain('s3:PutObjectRetention');
    expect(actions).not.toContain('s3:PutObjectLegalHold');
    const mediaDataAccess = statements.find(
      (statement) =>
        JSON.stringify(statement.Action) ===
        JSON.stringify(['s3:GetObject', 's3:PutObject']),
    );
    if (mediaDataAccess === undefined) {
      throw new Error('Missing exact App Runner media object access.');
    }
    const mediaResources = JSON.stringify(mediaDataAccess.Resource);
    expect(asArray(mediaDataAccess.Resource)).toHaveLength(2);
    expect(mediaResources).toContain('/quarantine/*');
    expect(mediaResources).toContain('/ready/*');
    const mediaKmsAccess = statements.find(
      (statement) =>
        JSON.stringify(asStringArray(statement.Action).sort()) ===
        JSON.stringify(['kms:Decrypt', 'kms:GenerateDataKey'].sort()),
    );
    if (mediaKmsAccess === undefined) {
      throw new Error('Missing exact App Runner media KMS access.');
    }
    expect(mediaKmsAccess.Condition).toEqual({
      StringEquals: {
        'kms:ViaService': `s3.${DEPLOYMENT_REGION}.amazonaws.com`,
      },
    });
  });
});

describe('bounded notification queues', () => {
  it('attaches the fan-out and channel queues to distinct retained DLQs', () => {
    const queues = resourceEntries('AWS::SQS::Queue');
    expect(queues).toHaveLength(8);

    const queuesByName = new Map(
      queues.map(([logicalId, resource]) => [
        resourceProperties(resource).QueueName,
        { logicalId, resource },
      ]),
    );

    for (const queueName of [
      'psd-eoc-fanout',
      'psd-eoc-push',
      'psd-eoc-email',
      'psd-eoc-sms',
    ]) {
      const source = queuesByName.get(queueName);
      const deadLetter = queuesByName.get(`${queueName}-dlq`);
      if (source === undefined || deadLetter === undefined) {
        throw new Error(`Missing source queue or DLQ for ${queueName}.`);
      }

      const sourceProperties = resourceProperties(source.resource);
      const deadLetterProperties = resourceProperties(deadLetter.resource);
      const redrive = asRecord(sourceProperties.RedrivePolicy);
      const deadLetterTarget = asRecord(redrive.deadLetterTargetArn);
      const redriveAllow = asRecord(deadLetterProperties.RedriveAllowPolicy);

      expect(deadLetterTarget['Fn::GetAtt']).toEqual([
        deadLetter.logicalId,
        'Arn',
      ]);
      expect(redrive.maxReceiveCount).toBe(5);
      expect(redriveAllow.redrivePermission).toBe('byQueue');
      expect(redriveAllow.sourceQueueArns).toEqual([
        {
          'Fn::Join': [
            '',
            [
              'arn:',
              { Ref: 'AWS::Partition' },
              `:sqs:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT}:${queueName}`,
            ],
          ],
        },
      ]);
      expect(sourceProperties.SqsManagedSseEnabled).toBe(true);
      expect(source.resource.DeletionPolicy).toBe('Retain');
      expect(deadLetter.resource.DeletionPolicy).toBe('Retain');
    }

    const queuePolicies = resourceEntries('AWS::SQS::QueuePolicy');
    expect(queuePolicies).toHaveLength(8);
    for (const [, policy] of queuePolicies) {
      expect(JSON.stringify(policy)).toContain('aws:SecureTransport');
      expect(policy.DeletionPolicy).toBe('Retain');
      expect(policy.UpdateReplacePolicy).toBe('Retain');
    }
  });
});

describe('App Runner high availability', () => {
  it('uses at least two instances and a side-effect-free HTTP health contract', () => {
    const scaling = onlyResource('AWS::AppRunner::AutoScalingConfiguration');
    const scalingProperties = resourceProperties(scaling);
    const service = onlyResource('AWS::AppRunner::Service');
    const serviceProperties = resourceProperties(service);

    expect(scalingProperties.MinSize).toBe(2);
    expect(scalingProperties.MaxSize as number).toBeGreaterThanOrEqual(2);
    expect(serviceProperties.AutoScalingConfigurationArn).toEqual({
      'Fn::GetAtt': ['AppRunnerScaling', 'AutoScalingConfigurationArn'],
    });
    expect(serviceProperties.HealthCheckConfiguration).toEqual({
      HealthyThreshold: 1,
      Interval: 5,
      Path: APP_RUNNER_HEALTH_CHECK_PATH,
      Protocol: 'HTTP',
      Timeout: 2,
      UnhealthyThreshold: 5,
    });
  });

  it('requires an immutable same-account image and disables automatic deploys', () => {
    const serviceProperties = resourceProperties(
      onlyResource('AWS::AppRunner::Service'),
    );
    const source = asRecord(serviceProperties.SourceConfiguration);
    const imageRepository = asRecord(source.ImageRepository);
    const parameters = asRecord(synthesizedTemplate.Parameters);
    const imageParameter = asRecord(parameters.AppImageIdentifier);

    expect(source.AutoDeploymentsEnabled).toBe(false);
    expect(imageRepository.ImageIdentifier).toEqual({
      Ref: 'AppImageIdentifier',
    });
    expect(imageRepository.ImageRepositoryType).toBe('ECR');
    expect(imageParameter).not.toHaveProperty('Default');
    expect(imageParameter.AllowedPattern).toContain(
      `${DEPLOYMENT_ACCOUNT}\\.dkr\\.ecr\\.${DEPLOYMENT_REGION}`,
    );
    expect(imageParameter.AllowedPattern).toContain('@sha256:');
    expect(JSON.stringify(source)).not.toContain('ExpoAccessToken');
  });

  it('matches the server database contract without exposing admin credentials', () => {
    const service = onlyResource('AWS::AppRunner::Service');
    const serviceProperties = resourceProperties(service);
    const source = asRecord(serviceProperties.SourceConfiguration);
    const imageRepository = asRecord(source.ImageRepository);
    const imageConfiguration = asRecord(imageRepository.ImageConfiguration);
    const environmentVariables = asArray(
      imageConfiguration.RuntimeEnvironmentVariables,
    ).map(asRecord);
    const environmentByName = new Map(
      environmentVariables.map((entry) => [entry.Name, entry.Value]),
    );

    const secretEntries = resourceEntries('AWS::SecretsManager::Secret');
    const secretLogicalId = (name: string): string => {
      const match = secretEntries.find(
        ([, resource]) => resourceProperties(resource).Name === name,
      );
      if (match === undefined) {
        throw new Error(`Missing secret ${name}.`);
      }
      return match[0];
    };
    const applicationSecretLogicalId = secretLogicalId(
      '/psd-eoc/database/application',
    );
    const apiSaltSecretLogicalId = secretLogicalId('/psd-eoc/api-salt');
    const googleOauthSecretLogicalId = secretLogicalId('/psd-eoc/google-oauth');

    expect([...environmentByName.keys()].sort()).toEqual(
      [
        'AWS_REGION',
        'CANARY_EVENT_TYPE_VERSION_ID',
        'CANARY_FACILITY_ID',
        'DATABASE_DRIVER',
        'DATABASE_NAME',
        'DATABASE_RESOURCE_ARN',
        'DATABASE_SECRET_ARN',
        'FANOUT_QUEUE_URL',
        'MEDIA_BUCKET_NAME',
      ].sort(),
    );
    expect(environmentByName.get('AWS_REGION')).toBe(DEPLOYMENT_REGION);
    expect(environmentByName.get('DATABASE_DRIVER')).toBe('aws-data-api');
    expect(environmentByName.get('DATABASE_NAME')).toBe('psd_eoc');
    expect(environmentByName.get('DATABASE_RESOURCE_ARN')).toBeDefined();
    expect(environmentByName.get('DATABASE_SECRET_ARN')).toEqual({
      Ref: applicationSecretLogicalId,
    });
    expect(environmentByName.has('DATABASE_CLUSTER_ARN')).toBe(false);

    const instanceConfiguration = asRecord(
      serviceProperties.InstanceConfiguration,
    );
    const instanceRoleArn = asRecord(instanceConfiguration.InstanceRoleArn);
    const instanceRoleGetAtt = asArray(instanceRoleArn['Fn::GetAtt']);
    const instanceRoleLogicalId = instanceRoleGetAtt[0];
    const runtimePolicyEntry = resourceEntries('AWS::IAM::Policy').find(
      ([, policy]) =>
        JSON.stringify(resourceProperties(policy).Roles).includes(
          String(instanceRoleLogicalId),
        ),
    );
    if (runtimePolicyEntry === undefined) {
      throw new Error('Missing App Runner runtime policy.');
    }
    const [runtimePolicyLogicalId, runtimePolicy] = runtimePolicyEntry;
    const runtimeStatements = asArray(
      asRecord(resourceProperties(runtimePolicy).PolicyDocument).Statement,
    ).map(asRecord);
    const secretReadStatements = runtimeStatements.filter((statement) =>
      JSON.stringify(statement.Action).includes(
        'secretsmanager:GetSecretValue',
      ),
    );
    if (secretReadStatements.length === 0) {
      throw new Error('Missing App Runner secret-read statement.');
    }
    const secretResourceRefs = secretReadStatements
      .flatMap((statement) =>
        Array.isArray(statement.Resource)
          ? statement.Resource
          : [statement.Resource],
      )
      .map(asRecord)
      .map((resource) => resource.Ref)
      .sort();
    expect(secretResourceRefs).toEqual(
      [
        apiSaltSecretLogicalId,
        applicationSecretLogicalId,
        googleOauthSecretLogicalId,
      ].sort(),
    );

    const dependencies = Array.isArray(service.DependsOn)
      ? service.DependsOn
      : [service.DependsOn];
    expect(dependencies).toContain(runtimePolicyLogicalId);
  });
});

describe('fail-closed integration placeholders', () => {
  it('creates generated secrets without plaintext credential properties', () => {
    const secrets = resourceEntries('AWS::SecretsManager::Secret');
    expect(secrets).toHaveLength(6);

    const expectedNames = new Set([
      '/psd-eoc/api-salt',
      '/psd-eoc/database/admin',
      '/psd-eoc/database/application',
      '/psd-eoc/database/monitoring',
      '/psd-eoc/expo-access-token',
      '/psd-eoc/google-oauth',
    ]);
    for (const [, secret] of secrets) {
      const properties = resourceProperties(secret);
      expect(expectedNames.delete(properties.Name as string)).toBe(true);
      expect(properties.GenerateSecretString).toBeDefined();
      expect(properties).not.toHaveProperty('SecretString');
      expect(secret.DeletionPolicy).toBe('Retain');
    }
    expect(expectedNames.size).toBe(0);
  });

  it('creates a retained child zone with retained same-account delegation', () => {
    const hostedZoneEntries = resourceEntries('AWS::Route53::HostedZone');
    expect(hostedZoneEntries).toHaveLength(1);
    const hostedZoneEntry = hostedZoneEntries[0];
    if (hostedZoneEntry === undefined) {
      throw new Error('Missing alerts.psd401.net hosted zone.');
    }
    const [hostedZoneLogicalId, hostedZone] = hostedZoneEntry;
    expect(resourceProperties(hostedZone).Name).toBe(`${SES_IDENTITY_DOMAIN}.`);
    expect(hostedZone.DeletionPolicy).toBe('Retain');
    expect(hostedZone.UpdateReplacePolicy).toBe('Retain');

    const delegationEntries = resourceEntries('AWS::Route53::RecordSet').filter(
      ([, record]) => resourceProperties(record).Type === 'NS',
    );
    expect(delegationEntries).toHaveLength(1);
    const delegationEntry = delegationEntries[0];
    if (delegationEntry === undefined) {
      throw new Error('Missing alerts.psd401.net delegation record.');
    }
    const delegation = delegationEntry[1];
    expect(resourceProperties(delegation)).toEqual({
      Comment: 'Delegates alerts.psd401.net to the retained PSD EOC zone.',
      HostedZoneId: SES_PARENT_HOSTED_ZONE_ID,
      Name: `${SES_IDENTITY_DOMAIN}.`,
      ResourceRecords: {
        'Fn::GetAtt': [hostedZoneLogicalId, 'NameServers'],
      },
      TTL: '300',
      Type: 'NS',
    });
    expect(delegation.DeletionPolicy).toBe('Retain');
    expect(delegation.UpdateReplacePolicy).toBe('Retain');

    const outputs = asRecord(synthesizedTemplate.Outputs);
    expect(asRecord(outputs.AlertsHostedZoneId).Value).toEqual({
      Ref: hostedZoneLogicalId,
    });
    expect(asRecord(outputs.AlertsHostedZoneNameServers).Value).toEqual({
      'Fn::Join': [',', { 'Fn::GetAtt': [hostedZoneLogicalId, 'NameServers'] }],
    });
  });

  it('publishes retained Easy DKIM and fail-closed MAIL FROM records', () => {
    const identityEntries = resourceEntries('AWS::SES::EmailIdentity');
    expect(identityEntries).toHaveLength(1);
    const identityEntry = identityEntries[0];
    if (identityEntry === undefined) {
      throw new Error('Missing SES email identity.');
    }
    const [identityLogicalId, identity] = identityEntry;
    expect(identityLogicalId).toBe('EmailIdentity');
    const identityProperties = resourceProperties(identity);
    expect(identityProperties.EmailIdentity).toBe(SES_IDENTITY_DOMAIN);
    expect(identityProperties.DkimAttributes).toEqual({ SigningEnabled: true });
    expect(identityProperties.DkimSigningAttributes).toEqual({
      NextSigningKeyLength: 'RSA_2048_BIT',
    });
    expect(identityProperties.FeedbackAttributes).toEqual({
      EmailForwardingEnabled: false,
    });
    expect(identityProperties.MailFromAttributes).toEqual({
      BehaviorOnMxFailure: 'REJECT_MESSAGE',
      MailFromDomain: SES_MAIL_FROM_DOMAIN,
    });
    expect(identityProperties.ConfigurationSetAttributes).toEqual({
      ConfigurationSetName: { Ref: 'EmailConfigurationSet' },
    });
    expect(identity.DeletionPolicy).toBe('Retain');
    expect(identity.UpdateReplacePolicy).toBe('Retain');

    const records = resourceEntries('AWS::Route53::RecordSet');
    expect(records).toHaveLength(6);
    const dkimRecords = records
      .filter(([, record]) => resourceProperties(record).Type === 'CNAME')
      .sort(([left], [right]) => left.localeCompare(right));
    expect(dkimRecords).toHaveLength(3);
    dkimRecords.forEach(([, record], index) => {
      const properties = resourceProperties(record);
      const recordNumber = index + 1;
      expect(properties.Name).toEqual({
        'Fn::GetAtt': [identityLogicalId, `DkimDNSTokenName${recordNumber}`],
      });
      expect(properties.ResourceRecords).toEqual([
        {
          'Fn::GetAtt': [identityLogicalId, `DkimDNSTokenValue${recordNumber}`],
        },
      ]);
      expect(record.DeletionPolicy).toBe('Retain');
      expect(record.UpdateReplacePolicy).toBe('Retain');
    });

    const mailFromRecords = records.filter(([, record]) => {
      const properties = resourceProperties(record);
      return properties.Name === `${SES_MAIL_FROM_DOMAIN}.`;
    });
    expect(mailFromRecords).toHaveLength(2);
    const mailFromByType = new Map(
      mailFromRecords.map(([, record]) => [
        resourceProperties(record).Type,
        record,
      ]),
    );
    const mxRecord = mailFromByType.get('MX');
    const txtRecord = mailFromByType.get('TXT');
    if (mxRecord === undefined || txtRecord === undefined) {
      throw new Error('Missing MAIL FROM MX or SPF record.');
    }
    expect(resourceProperties(mxRecord).ResourceRecords).toEqual([
      `10 feedback-smtp.${DEPLOYMENT_REGION}.amazonses.com.`,
    ]);
    expect(resourceProperties(txtRecord).ResourceRecords).toEqual([
      '"v=spf1 include:amazonses.com ~all"',
    ]);
    for (const record of [mxRecord, txtRecord]) {
      expect(record.DeletionPolicy).toBe('Retain');
      expect(record.UpdateReplacePolicy).toBe('Retain');
    }

    const outputs = asRecord(synthesizedTemplate.Outputs);
    for (const recordNumber of [1, 2, 3]) {
      const nameOutput = asRecord(outputs[`SesDkimRecordName${recordNumber}`]);
      const valueOutput = asRecord(
        outputs[`SesDkimRecordValue${recordNumber}`],
      );
      expect(nameOutput.Description).toContain('published automatically');
      expect(valueOutput.Description).toContain('published automatically');
    }
    expect(asRecord(outputs.SesMailFromDomain).Value).toBe(
      SES_MAIL_FROM_DOMAIN,
    );
  });

  it('publishes exact SES delivery events to an encrypted retained topic', () => {
    const configurationSet = onlyResource('AWS::SES::ConfigurationSet');
    expect(resourceProperties(configurationSet)).toMatchObject({
      Name: SES_CONFIGURATION_SET_NAME,
      ReputationOptions: { ReputationMetricsEnabled: true },
    });
    expect(configurationSet.DeletionPolicy).toBe('Retain');
    expect(configurationSet.UpdateReplacePolicy).toBe('Retain');

    const eventDestination = onlyResource(
      'AWS::SES::ConfigurationSetEventDestination',
    );
    const eventDestinationProperties = resourceProperties(eventDestination);
    expect(eventDestinationProperties.ConfigurationSetName).toEqual({
      Ref: 'EmailConfigurationSet',
    });
    const eventDefinition = asRecord(
      eventDestinationProperties.EventDestination,
    );
    expect(eventDefinition.Enabled).toBe(true);
    expect(eventDefinition.Name).toBe(SES_EVENT_DESTINATION_NAME);
    expect(eventDefinition.MatchingEventTypes).toEqual([...SES_EVENT_TYPES]);
    expect(eventDefinition.MatchingEventTypes).not.toContain('OPEN');
    expect(eventDefinition.MatchingEventTypes).not.toContain('CLICK');
    expect(eventDestination.DeletionPolicy).toBe('Retain');
    expect(eventDestination.UpdateReplacePolicy).toBe('Retain');

    const eventTopicEntry = resourceEntries('AWS::SNS::Topic').find(
      ([, topic]) =>
        resourceProperties(topic).TopicName === SES_EVENT_TOPIC_NAME,
    );
    if (eventTopicEntry === undefined) {
      throw new Error('Missing SES event topic.');
    }
    const [eventTopicLogicalId, eventTopic] = eventTopicEntry;
    expect(resourceProperties(eventTopic).KmsMasterKeyId).toBeDefined();
    expect(eventTopic.DeletionPolicy).toBe('Retain');
    expect(eventTopic.UpdateReplacePolicy).toBe('Retain');
    expect(asRecord(eventDefinition.SnsDestination).TopicARN).toEqual({
      Ref: eventTopicLogicalId,
    });

    const expectedSourceArn = `arn:aws:ses:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT}:configuration-set/${SES_CONFIGURATION_SET_NAME}`;
    const eventTopicPolicyEntry = resourceEntries('AWS::SNS::TopicPolicy').find(
      ([, policy]) =>
        JSON.stringify(resourceProperties(policy).Topics).includes(
          eventTopicLogicalId,
        ),
    );
    if (eventTopicPolicyEntry === undefined) {
      throw new Error('Missing SES event topic policy.');
    }
    const topicStatements = asArray(
      asRecord(resourceProperties(eventTopicPolicyEntry[1]).PolicyDocument)
        .Statement,
    ).map(asRecord);
    const sesPublishStatement = topicStatements.find(
      (statement) => statement.Sid === 'AllowSesConfigurationSetEvents',
    );
    if (sesPublishStatement === undefined) {
      throw new Error('Missing SES publish policy statement.');
    }
    expect(sesPublishStatement).toEqual({
      Action: 'sns:Publish',
      Condition: {
        StringEquals: {
          'AWS:SourceAccount': DEPLOYMENT_ACCOUNT,
          'AWS:SourceArn': expectedSourceArn,
        },
      },
      Effect: 'Allow',
      Principal: { Service: 'ses.amazonaws.com' },
      Resource: { Ref: eventTopicLogicalId },
      Sid: 'AllowSesConfigurationSetEvents',
    });

    const sesKmsStatement = resourceEntries('AWS::KMS::Key')
      .flatMap(([, key]) =>
        asArray(asRecord(resourceProperties(key).KeyPolicy).Statement).map(
          asRecord,
        ),
      )
      .find((statement) => statement.Sid === 'AllowSesEmailEventEncryption');
    expect(sesKmsStatement).toEqual({
      Action: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      Condition: {
        StringEquals: {
          'AWS:SourceAccount': DEPLOYMENT_ACCOUNT,
          'AWS:SourceArn': expectedSourceArn,
        },
      },
      Effect: 'Allow',
      Principal: { Service: 'ses.amazonaws.com' },
      Resource: '*',
      Sid: 'AllowSesEmailEventEncryption',
    });

    const outputs = asRecord(synthesizedTemplate.Outputs);
    expect(asRecord(outputs.SesConfigurationSetName).Value).toEqual({
      Ref: 'EmailConfigurationSet',
    });
    expect(asRecord(outputs.SesEmailEventsTopicArn).Value).toEqual({
      Ref: eventTopicLogicalId,
    });
    const eventTopicSubscriptions = resourceEntries(
      'AWS::SNS::Subscription',
    ).filter(([, subscription]) =>
      JSON.stringify(resourceProperties(subscription).TopicArn).includes(
        eventTopicLogicalId,
      ),
    );
    expect(eventTopicSubscriptions).toHaveLength(0);
    expect(collectAllowedActions(synthesizedTemplate).join('\n')).not.toMatch(
      /^(?:s3:DeleteObject(?:Version)?|ses:(?:\*|Send.*)|sms-voice:Send.*|mobiletargeting:Send.*)$/imu,
    );
  });
});

describe('operational observability', () => {
  it('retains non-expiring encrypted logs and alarm topics', () => {
    const logGroups = resourceEntries('AWS::Logs::LogGroup');
    expect(logGroups).toHaveLength(8);
    for (const [, logGroup] of logGroups) {
      const properties = resourceProperties(logGroup);
      expect(properties.KmsKeyId).toBeDefined();
      expect(properties).not.toHaveProperty('RetentionInDays');
      expect(logGroup.DeletionPolicy).toBe('Retain');
    }

    const topics = resourceEntries('AWS::SNS::Topic');
    expect(topics).toHaveLength(3);
    for (const [, topic] of topics) {
      expect(resourceProperties(topic).KmsMasterKeyId).toBeDefined();
      expect(topic.DeletionPolicy).toBe('Retain');
    }
    const topicPolicies = resourceEntries('AWS::SNS::TopicPolicy');
    expect(topicPolicies).toHaveLength(3);
    for (const [, policy] of topicPolicies) {
      expect(JSON.stringify(policy)).toContain('aws:SecureTransport');
      expect(policy.DeletionPolicy).toBe('Retain');
      expect(policy.UpdateReplacePolicy).toBe('Retain');
    }
    template.resourceCountIs('AWS::SNS::Subscription', 4);
    expect(
      resourceEntries('AWS::CloudWatch::Alarm').length,
    ).toBeGreaterThanOrEqual(20);
  });

  it('scopes CloudWatch Logs service access to regional PSD EOC groups', () => {
    const operationsKeyEntry = resourceEntries('AWS::KMS::Key').find(
      ([, key]) => {
        const statements = asArray(
          asRecord(resourceProperties(key).KeyPolicy).Statement,
        ).map(asRecord);
        return statements.some(
          (statement) => statement.Sid === 'AllowCloudWatchLogsEncryption',
        );
      },
    );
    if (operationsKeyEntry === undefined) {
      throw new Error('Missing operations KMS key policy.');
    }
    const statements = asArray(
      asRecord(resourceProperties(operationsKeyEntry[1]).KeyPolicy).Statement,
    ).map(asRecord);
    const logsStatement = statements.find(
      (statement) => statement.Sid === 'AllowCloudWatchLogsEncryption',
    );
    if (logsStatement === undefined) {
      throw new Error('Missing CloudWatch Logs KMS statement.');
    }

    expect(logsStatement.Effect).toBe('Allow');
    expect(logsStatement.Principal).toEqual({
      Service: `logs.${DEPLOYMENT_REGION}.amazonaws.com`,
    });
    expect(asArray(logsStatement.Action).sort()).toEqual(
      [
        'kms:Decrypt*',
        'kms:Describe*',
        'kms:Encrypt*',
        'kms:GenerateDataKey*',
        'kms:ReEncrypt*',
      ].sort(),
    );
    expect(logsStatement.Condition).toEqual({
      ArnLike: {
        'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT}:log-group:/psd-eoc/*`,
      },
    });
  });
});

describe('GitHub OIDC deployment boundary', () => {
  it('trusts only the immutable repository and approved workflow on main', () => {
    const roles = resourceEntries('AWS::IAM::Role');
    const deployRoleEntry = roles.find(
      ([, role]) =>
        resourceProperties(role).RoleName === 'PsdEocGithubActionsDeploy',
    );
    if (deployRoleEntry === undefined) {
      throw new Error('Missing GitHub Actions deploy role.');
    }

    const [, deployRole] = deployRoleEntry;
    const properties = resourceProperties(deployRole);
    const trustPolicy = asRecord(properties.AssumeRolePolicyDocument);
    const statements = asArray(trustPolicy.Statement);
    expect(statements).toHaveLength(1);
    const statement = asRecord(statements[0]);
    const condition = asRecord(asRecord(statement.Condition).StringEquals);

    expect(statement.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(statement.Effect).toBe('Allow');
    expect(statement.Principal).toEqual({
      Federated: `arn:aws:iam::${DEPLOYMENT_ACCOUNT}:oidc-provider/${GITHUB_OIDC_ISSUER}`,
    });
    expect(condition).toEqual({
      [`${GITHUB_OIDC_ISSUER}:aud`]: 'sts.amazonaws.com',
      [`${GITHUB_OIDC_ISSUER}:job_workflow_ref`]:
        GITHUB_DEPLOY_JOB_WORKFLOW_REF,
      [`${GITHUB_OIDC_ISSUER}:ref`]: GITHUB_MAIN_REF,
      [`${GITHUB_OIDC_ISSUER}:repository`]: GITHUB_REPOSITORY,
      [`${GITHUB_OIDC_ISSUER}:repository_id`]: GITHUB_REPOSITORY_ID,
      [`${GITHUB_OIDC_ISSUER}:repository_owner_id`]: GITHUB_OWNER_ID,
      [`${GITHUB_OIDC_ISSUER}:sub`]: GITHUB_OIDC_SUBJECT,
    });
    expect(JSON.stringify(condition)).not.toContain('*');
    expect(properties.MaxSessionDuration).toBe(3600);
  });

  it('uses no static IAM identity and grants only bootstrap-role assumption', () => {
    template.resourceCountIs('AWS::IAM::AccessKey', 0);
    template.resourceCountIs('AWS::IAM::User', 0);
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);

    const deployRoleEntry = resourceEntries('AWS::IAM::Role').find(
      ([, role]) =>
        resourceProperties(role).RoleName === 'PsdEocGithubActionsDeploy',
    );
    if (deployRoleEntry === undefined) {
      throw new Error('Missing GitHub Actions deploy role.');
    }
    const [deployRoleLogicalId] = deployRoleEntry;
    const deployPolicy = resourceEntries('AWS::IAM::Policy').find(
      ([, policy]) =>
        JSON.stringify(resourceProperties(policy).Roles).includes(
          deployRoleLogicalId,
        ),
    );
    if (deployPolicy === undefined) {
      throw new Error('Missing GitHub Actions deploy policy.');
    }

    const policyDocument = asRecord(
      resourceProperties(deployPolicy[1]).PolicyDocument,
    );
    const statements = asArray(policyDocument.Statement);
    expect(statements).toHaveLength(1);
    const statement = asRecord(statements[0]);
    expect(statement.Action).toBe('sts:AssumeRole');
    expect(statement.Effect).toBe('Allow');
    expect(statement.Resource).toEqual(
      ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(
        (purpose) =>
          `arn:aws:iam::${DEPLOYMENT_ACCOUNT}:role/cdk-hnb659fds-${purpose}-role-${DEPLOYMENT_ACCOUNT}-${DEPLOYMENT_REGION}`,
      ),
    );
  });
});

describe('no automated critical-action path', () => {
  it('limits automation to monitoring and has no provider sender', () => {
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
    const rules = resourceEntries('AWS::Events::Rule').map(([, resource]) =>
      resourceProperties(resource),
    );
    expect(rules).toHaveLength(3);
    expect(
      rules.filter((rule) => rule.ScheduleExpression === 'rate(1 minute)'),
    ).toHaveLength(2);
    expect(
      rules.filter((rule) =>
        JSON.stringify(rule.EventPattern ?? {}).includes(
          'RDS DB Cluster Event',
        ),
      ),
    ).toHaveLength(1);
    const subscriptions = resourceEntries('AWS::SNS::Subscription').map(
      ([, resource]) => resourceProperties(resource),
    );
    expect(subscriptions).toHaveLength(4);
    expect(
      subscriptions.map((subscription) => subscription.Protocol).sort(),
    ).toEqual(['email', 'email', 'sms', 'sms']);
    expect(JSON.stringify(synthesizedTemplate)).not.toMatch(
      /ses:(?:\*|Send)|sms-voice:Send|mobiletargeting:Send/i,
    );
  });
});
