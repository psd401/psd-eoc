import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';

const {
  checkBootstrap,
  startBootstrap,
  validateRollbackImage,
  validateRollbackQuiescence,
} = await import('../lambda/bootstrap-deployment/index.mjs');

const PROPERTIES = Object.freeze({
  ClusterArn: 'arn:aws:ecs:us-west-2:123456789012:cluster/example-bootstrap',
  ContainerName: 'native-bootstrap',
  DeploymentRevision: 'a'.repeat(40),
  SecurityGroupId: 'sg-0123456789abcdef0',
  SubnetIds: ['subnet-0123456789abcdef0', 'subnet-0fedcba9876543210'],
  TaskDefinitionArn:
    'arn:aws:ecs:us-west-2:123456789012:task-definition/example-bootstrap:7',
});
const SHORT_TASK_ARN =
  'arn:aws:ecs:us-west-2:123456789012:task/00000000-0000-4000-8000-000000000277';

function event(requestType: 'Create' | 'Delete' | 'Update') {
  return {
    PhysicalResourceId: 'psd-eoc-bootstrap-deployment',
    RequestId: '00000000-0000-4000-8000-000000000277',
    RequestType: requestType,
    ResourceProperties: PROPERTIES,
    StackId:
      'arn:aws:cloudformation:us-west-2:123456789012:stack/example/00000000-0000-4000-8000-000000000277',
  };
}

describe('CloudFormation bootstrap deployment', () => {
  it('starts one private Fargate task with an idempotent request token', async () => {
    const requests: Record<string, unknown>[] = [];
    const startedAtEpochMs = 1_700_000_000_000;
    const result = await startBootstrap(event('Create'), {
      now: () => startedAtEpochMs,
      runTask: async (input) => {
        requests.push(input);
        return {
          failures: [],
          tasks: [
            {
              taskArn:
                'arn:aws:ecs:us-west-2:123456789012:task/example-bootstrap/00000000000000000000000000000277',
            },
          ],
        };
      },
    });

    expect(requests).toEqual([
      {
        clientToken: '00000000-0000-4000-8000-000000000277',
        cluster: PROPERTIES.ClusterArn,
        count: 1,
        enableECSManagedTags: true,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            assignPublicIp: 'DISABLED',
            securityGroups: [PROPERTIES.SecurityGroupId],
            subnets: PROPERTIES.SubnetIds,
          },
        },
        taskDefinition: PROPERTIES.TaskDefinitionArn,
      },
    ]);
    expect(result).toEqual({
      Data: {
        StartedAtEpochMs: startedAtEpochMs,
        TaskArn:
          'arn:aws:ecs:us-west-2:123456789012:task/example-bootstrap/00000000000000000000000000000277',
      },
      PhysicalResourceId: 'psd-eoc-bootstrap-deployment',
    });
  });

  it('does nothing during stack deletion', async () => {
    let calls = 0;
    const result = await startBootstrap(event('Delete'), {
      runTask: async () => {
        calls += 1;
        return {};
      },
    });

    expect(calls).toBe(0);
    expect(result).toEqual({
      Data: { Deleted: true },
      PhysicalResourceId: 'psd-eoc-bootstrap-deployment',
    });
  });

  it('does not launch an older bootstrap task while CloudFormation rolls back', async () => {
    let calls = 0;
    const result = await startBootstrap(event('Update'), {
      readStackStatus: async () => 'UPDATE_ROLLBACK_IN_PROGRESS',
      runTask: async () => {
        calls += 1;
        return {};
      },
    });

    expect(calls).toBe(0);
    expect(result).toEqual({
      Data: { Skipped: true },
      PhysicalResourceId: 'psd-eoc-bootstrap-deployment',
    });
    expect(
      await checkBootstrap({ ...event('Update'), Data: { Skipped: true } }),
    ).toEqual({ IsComplete: true });
  });

  it('waits while the task runs and completes only after exit code zero', async () => {
    const running = await checkBootstrap(
      {
        ...event('Update'),
        Data: {
          StartedAtEpochMs: 1_700_000_000_000,
          TaskArn:
            'arn:aws:ecs:us-west-2:123456789012:task/example-bootstrap/00000000000000000000000000000277',
        },
      },
      {
        describeTasks: async () => ({
          failures: [],
          tasks: [
            {
              lastStatus: 'RUNNING',
              taskDefinitionArn: PROPERTIES.TaskDefinitionArn,
            },
          ],
        }),
        now: () => 1_700_000_010_000,
      },
    );
    expect(running).toEqual({ IsComplete: false });

    const stopped = await checkBootstrap(
      {
        ...event('Update'),
        Data: {
          StartedAtEpochMs: 1_700_000_000_000,
          TaskArn:
            'arn:aws:ecs:us-west-2:123456789012:task/example-bootstrap/00000000000000000000000000000277',
        },
      },
      {
        describeTasks: async () => ({
          failures: [],
          tasks: [
            {
              containers: [{ exitCode: 0, name: PROPERTIES.ContainerName }],
              lastStatus: 'STOPPED',
              taskDefinitionArn: PROPERTIES.TaskDefinitionArn,
            },
          ],
        }),
        now: () => 1_700_000_010_000,
      },
    );
    expect(stopped).toEqual({ IsComplete: true });
  });

  it('fails the deployment for ECS placement errors or a nonzero bootstrap exit', async () => {
    await expect(
      startBootstrap(event('Create'), {
        runTask: async () => ({
          failures: [{ arn: PROPERTIES.TaskDefinitionArn, reason: 'RESOURCE' }],
          tasks: [],
        }),
      }),
    ).rejects.toThrow('Bootstrap task could not be started.');

    await expect(
      checkBootstrap(
        {
          ...event('Update'),
          Data: {
            StartedAtEpochMs: 1_700_000_000_000,
            TaskArn:
              'arn:aws:ecs:us-west-2:123456789012:task/example-bootstrap/00000000000000000000000000000277',
          },
        },
        {
          describeTasks: async () => ({
            failures: [],
            tasks: [
              {
                containers: [{ exitCode: 1, name: PROPERTIES.ContainerName }],
                lastStatus: 'STOPPED',
                taskDefinitionArn: PROPERTIES.TaskDefinitionArn,
              },
            ],
          }),
          now: () => 1_700_000_010_000,
        },
      ),
    ).rejects.toThrow('Bootstrap task failed.');
  });

  it('stops the exact task before the CloudFormation provider deadline', async () => {
    const startedAtEpochMs = 1_700_000_000_000;
    const stops: Record<string, unknown>[] = [];
    const timedOutEvent = {
      ...event('Update'),
      Data: {
        StartedAtEpochMs: startedAtEpochMs,
        TaskArn:
          'arn:aws:ecs:us-west-2:123456789012:task/example-bootstrap/00000000000000000000000000000277',
      },
    };
    expect(
      await checkBootstrap(timedOutEvent, {
        describeTasks: async () => ({
          failures: [],
          tasks: [
            {
              lastStatus: 'RUNNING',
              taskDefinitionArn: PROPERTIES.TaskDefinitionArn,
            },
          ],
        }),
        now: () => startedAtEpochMs + 26 * 60 * 1000,
        stopTask: async (input) => {
          stops.push(input);
          return {};
        },
      }),
    ).toEqual({ IsComplete: false });
    expect(stops).toEqual([
      {
        cluster: PROPERTIES.ClusterArn,
        reason: 'Deployment bootstrap exceeded its bounded runtime.',
        task: 'arn:aws:ecs:us-west-2:123456789012:task/example-bootstrap/00000000000000000000000000000277',
      },
    ]);
    await expect(
      checkBootstrap(timedOutEvent, {
        describeTasks: async () => ({
          failures: [],
          tasks: [
            {
              containers: [{ exitCode: 137, name: PROPERTIES.ContainerName }],
              lastStatus: 'STOPPED',
              taskDefinitionArn: PROPERTIES.TaskDefinitionArn,
            },
          ],
        }),
        now: () => startedAtEpochMs + 26 * 60 * 1000 + 10_000,
      }),
    ).rejects.toThrow('Bootstrap task failed.');
  });

  it('accepts a successful terminal task even when the next poll is after the deadline', async () => {
    const startedAtEpochMs = 1_700_000_000_000;
    expect(
      await checkBootstrap(
        {
          ...event('Update'),
          Data: {
            StartedAtEpochMs: startedAtEpochMs,
            TaskArn:
              'arn:aws:ecs:us-west-2:123456789012:task/example-bootstrap/00000000000000000000000000000277',
          },
        },
        {
          describeTasks: async () => ({
            failures: [],
            tasks: [
              {
                containers: [{ exitCode: 0, name: PROPERTIES.ContainerName }],
                lastStatus: 'STOPPED',
                taskDefinitionArn: PROPERTIES.TaskDefinitionArn,
              },
            ],
          }),
          now: () => startedAtEpochMs + 27 * 60 * 1000,
        },
      ),
    ).toEqual({ IsComplete: true });
  });

  it('keeps waiting through transient or untrusted ECS status responses', async () => {
    const pollingEvent = {
      ...event('Update'),
      Data: {
        StartedAtEpochMs: 1_700_000_000_000,
        TaskArn:
          'arn:aws:ecs:us-west-2:123456789012:task/example-bootstrap/00000000000000000000000000000277',
      },
    };
    for (const describeTasks of [
      async () => {
        throw new Error('synthetic transient ECS error');
      },
      async () => ({ failures: [{ reason: 'MISSING' }], tasks: [] }),
      async () => ({
        failures: [],
        tasks: [
          {
            lastStatus: 'RUNNING',
            taskDefinitionArn:
              'arn:aws:ecs:us-west-2:123456789012:task-definition/other-bootstrap:1',
          },
        ],
      }),
    ]) {
      expect(
        await checkBootstrap(pollingEvent, {
          describeTasks,
          now: () => 1_700_000_010_000,
        }),
      ).toEqual({ IsComplete: false });
    }
  });

  it('accepts the legacy short task ARN while retaining cluster binding', async () => {
    expect(
      await checkBootstrap(
        {
          ...event('Update'),
          Data: {
            StartedAtEpochMs: 1_700_000_000_000,
            TaskArn: SHORT_TASK_ARN,
          },
        },
        {
          describeTasks: async () => ({
            failures: [],
            tasks: [
              {
                lastStatus: 'RUNNING',
                taskDefinitionArn: PROPERTIES.TaskDefinitionArn,
              },
            ],
          }),
          now: () => 1_700_000_010_000,
        },
      ),
    ).toEqual({ IsComplete: false });
  });
});

const ROLLBACK_DIGEST = `sha256:${'b'.repeat(64)}`;
const SOURCE_SHA = 'c'.repeat(40);

function rollbackEvent(
  imageDigest: string,
  repositoryKind:
    | 'CDK_ASSET_REPOSITORY'
    | 'CURRENT_CDK_ASSET'
    | 'LEGACY_APPLICATION_REPOSITORY',
) {
  return {
    PhysicalResourceId: 'psd-eoc-rollback-image-validation',
    RequestId: '00000000-0000-4000-8000-000000000278',
    RequestType: 'Update' as const,
    ResourceProperties: {
      CurrentSourceSha: SOURCE_SHA,
      ExpectedSourceRepositoryUrl: 'https://code.example.test/example/eoc',
      ImageDigest: imageDigest,
      Operation: 'ROLLBACK_IMAGE_VALIDATION',
      RepositoryKind: repositoryKind,
      RepositoryName: 'example/application-images',
    },
  };
}

function assetDependencies(
  options: {
    readonly configBody?: string;
    readonly declaredConfigLength?: number;
    readonly layerDigest?: string;
    readonly mediaType?: string;
    readonly omitContentLength?: boolean;
    readonly reportedImageDigest?: string;
    readonly returnedConfigBody?: string;
    readonly sourceRepositoryUrl?: string;
  } = {},
) {
  const configBody =
    options.configBody ??
    JSON.stringify({
      config: {
        Labels: {
          'org.opencontainers.image.revision': SOURCE_SHA,
          'org.opencontainers.image.source':
            options.sourceRepositoryUrl ??
            'https://code.example.test/example/eoc',
          'org.opencontainers.image.title': 'PSD EOC live pilot',
          'org.psd-eoc.data-classification': 'staff-minimized',
          'org.psd-eoc.environment': 'live-pilot',
        },
      },
    });
  const configDigest = `sha256:${createHash('sha256')
    .update(configBody)
    .digest('hex')}`;
  const mediaType = options.mediaType;
  const imageManifest = JSON.stringify({
    config: { digest: configDigest },
    mediaType,
    schemaVersion: 2,
  });
  const imageDigest =
    options.reportedImageDigest ??
    `sha256:${createHash('sha256').update(imageManifest).digest('hex')}`;
  return {
    dependencies: {
      batchGetImage: async () => ({
        failures: [],
        images: [
          {
            imageId: { imageDigest },
            imageManifest,
            imageManifestMediaType: mediaType,
          },
        ],
      }),
      fetchLayer: async () => {
        const body = options.returnedConfigBody ?? configBody;
        return new Response(body, {
          ...(options.omitContentLength
            ? {}
            : {
                headers: {
                  'content-length': String(
                    options.declaredConfigLength ??
                      new TextEncoder().encode(body).byteLength,
                  ),
                },
              }),
          status: 200,
        });
      },
      getDownloadUrlForLayer: async () => ({
        downloadUrl:
          'https://example-layer.s3.us-west-2.amazonaws.com/config.json',
        layerDigest: options.layerDigest ?? configDigest,
      }),
    },
    imageDigest,
  };
}

describe('rollback image provenance validation', () => {
  it('uses the current source without reading ECR for a normal deployment', async () => {
    let calls = 0;
    const result = await validateRollbackImage(
      rollbackEvent('CURRENT_CDK_ASSET', 'CURRENT_CDK_ASSET'),
      {
        batchGetImage: async () => {
          calls += 1;
          return {};
        },
      },
    );

    expect(calls).toBe(0);
    expect(result).toEqual({
      Data: { SourceSha: SOURCE_SHA },
      PhysicalResourceId: 'psd-eoc-rollback-image-validation',
    });
  });

  it('derives the reviewed config revision from a legacy repository digest', async () => {
    const asset = assetDependencies({
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    });
    const result = await validateRollbackImage(
      rollbackEvent(asset.imageDigest, 'LEGACY_APPLICATION_REPOSITORY'),
      asset.dependencies,
    );

    expect(result.Data).toEqual({ SourceSha: SOURCE_SHA });
  });

  it('derives the reviewed revision label from a CDK asset image config', async () => {
    const asset = assetDependencies({
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
    });
    const result = await validateRollbackImage(
      rollbackEvent(asset.imageDigest, 'CDK_ASSET_REPOSITORY'),
      asset.dependencies,
    );

    expect(result.Data).toEqual({ SourceSha: SOURCE_SHA });
  });

  it('fails closed for an invalid embedded image label', async () => {
    const asset = assetDependencies({
      configBody: JSON.stringify({
        config: {
          Labels: { 'org.opencontainers.image.revision': 'main' },
        },
      }),
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
    });
    await expect(
      validateRollbackImage(
        rollbackEvent(asset.imageDigest, 'CDK_ASSET_REPOSITORY'),
        asset.dependencies,
      ),
    ).rejects.toThrow('Rollback image provenance could not be verified.');
  });

  it('rejects untyped manifests, mismatched config layers, wrong projects, and oversized metadata', async () => {
    for (const asset of [
      assetDependencies(),
      assetDependencies({
        layerDigest: `sha256:${'0'.repeat(64)}`,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
      }),
      assetDependencies({
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        sourceRepositoryUrl: 'https://code.example.test/other/application',
      }),
      assetDependencies({
        configBody: 'x'.repeat(1024 * 1024 + 1),
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
      }),
      assetDependencies({
        mediaType: 'application/vnd.oci.image.index.v1+json',
      }),
    ]) {
      await expect(
        validateRollbackImage(
          rollbackEvent(asset.imageDigest, 'CDK_ASSET_REPOSITORY'),
          asset.dependencies,
        ),
      ).rejects.toThrow('Rollback image provenance could not be verified.');
    }
  });

  it('rejects manifest or config bytes that do not match their digest', async () => {
    for (const asset of [
      assetDependencies({
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        reportedImageDigest: ROLLBACK_DIGEST,
      }),
      assetDependencies({
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        returnedConfigBody: JSON.stringify({ config: { Labels: {} } }),
      }),
    ]) {
      await expect(
        validateRollbackImage(
          rollbackEvent(asset.imageDigest, 'CDK_ASSET_REPOSITORY'),
          asset.dependencies,
        ),
      ).rejects.toThrow('Rollback image provenance could not be verified.');
    }
  });

  it('rejects missing lengths and stops reading over-limit config streams', async () => {
    for (const asset of [
      assetDependencies({
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        omitContentLength: true,
      }),
      assetDependencies({
        declaredConfigLength: 1024 * 1024,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        returnedConfigBody: 'x'.repeat(1024 * 1024 + 1),
      }),
    ]) {
      await expect(
        validateRollbackImage(
          rollbackEvent(asset.imageDigest, 'CDK_ASSET_REPOSITORY'),
          asset.dependencies,
        ),
      ).rejects.toThrow('Rollback image provenance could not be verified.');
    }
  });
});

const QUIESCENCE_SERVICE_NAMES = ['push-worker', 'sms-worker', 'email-worker'];
const DARK_PROVIDER_PROPERTIES = Object.freeze({
  EnableAwsEumSmsWorker: 'false',
  EnableDirectPush: 'false',
  EnableEmailWorker: 'false',
  EnableExpoPushWorker: 'false',
  PushProviderCutover: '{"version":1,"ios":"expo","android":"expo"}',
});

function quiescenceEvent(rollbackSelected: 'false' | 'true') {
  return {
    OldResourceProperties: {
      ...DARK_PROVIDER_PROPERTIES,
      DeploymentRevision: SOURCE_SHA,
      Operation: 'ROLLBACK_QUIESCENCE',
    },
    RequestType: 'Update' as const,
    ResourceProperties: {
      ...DARK_PROVIDER_PROPERTIES,
      ClusterArn: PROPERTIES.ClusterArn,
      DeploymentRevision: SOURCE_SHA,
      Operation: 'ROLLBACK_QUIESCENCE',
      RollbackSelected: rollbackSelected,
      ServiceNames: QUIESCENCE_SERVICE_NAMES,
    },
  };
}

describe('rollback provider quiescence', () => {
  it('skips normal deployments without reading ECS', async () => {
    let calls = 0;
    const result = await validateRollbackQuiescence(quiescenceEvent('false'), {
      describeServices: async () => {
        calls += 1;
        return {};
      },
    });
    expect(calls).toBe(0);
    expect(result.Data).toEqual({ Skipped: true });
  });

  it('proves every send worker is at zero before rollback continues', async () => {
    const requests: Record<string, unknown>[] = [];
    const result = await validateRollbackQuiescence(quiescenceEvent('true'), {
      describeServices: async (input) => {
        requests.push(input);
        return {
          failures: [],
          services: QUIESCENCE_SERVICE_NAMES.map((serviceName) => ({
            desiredCount: 0,
            pendingCount: 0,
            runningCount: 0,
            serviceName,
          })),
        };
      },
    });
    expect(requests).toEqual([
      {
        cluster: PROPERTIES.ClusterArn,
        services: QUIESCENCE_SERVICE_NAMES,
      },
    ]);
    expect(result.Data).toEqual({ Quiescent: true });
  });

  it('fails before application rollback when any send worker is active', async () => {
    await expect(
      validateRollbackQuiescence(quiescenceEvent('true'), {
        describeServices: async () => ({
          failures: [],
          services: QUIESCENCE_SERVICE_NAMES.map((serviceName, index) => ({
            desiredCount: index === 0 ? 1 : 0,
            pendingCount: 0,
            runningCount: index === 0 ? 1 : 0,
            serviceName,
          })),
        }),
      }),
    ).rejects.toThrow('Provider workers are not quiescent for rollback.');
  });

  it('rejects a one-step rollback whose previously persisted state was live', async () => {
    let calls = 0;
    await expect(
      validateRollbackQuiescence(
        {
          ...quiescenceEvent('true'),
          OldResourceProperties: {
            ...DARK_PROVIDER_PROPERTIES,
            DeploymentRevision: SOURCE_SHA,
            EnableEmailWorker: 'true',
            Operation: 'ROLLBACK_QUIESCENCE',
          },
        },
        {
          describeServices: async () => {
            calls += 1;
            return {};
          },
        },
      ),
    ).rejects.toThrow('Provider workers are not quiescent for rollback.');
    expect(calls).toBe(0);
  });

  it('rejects phase two from a different infrastructure commit', async () => {
    let calls = 0;
    await expect(
      validateRollbackQuiescence(
        {
          ...quiescenceEvent('true'),
          OldResourceProperties: {
            ...DARK_PROVIDER_PROPERTIES,
            DeploymentRevision: 'd'.repeat(40),
            Operation: 'ROLLBACK_QUIESCENCE',
          },
        },
        {
          describeServices: async () => {
            calls += 1;
            return {};
          },
        },
      ),
    ).rejects.toThrow('Provider workers are not quiescent for rollback.');
    expect(calls).toBe(0);
  });
});
