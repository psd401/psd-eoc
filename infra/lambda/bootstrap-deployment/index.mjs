import { createHash } from 'node:crypto';

const PHYSICAL_RESOURCE_ID = 'psd-eoc-bootstrap-deployment';
const ROLLBACK_PHYSICAL_RESOURCE_ID = 'psd-eoc-rollback-image-validation';
const ROLLBACK_QUIESCENCE_PHYSICAL_RESOURCE_ID = 'psd-eoc-rollback-quiescence';
const CURRENT_CDK_ASSET = 'CURRENT_CDK_ASSET';
const MAX_IMAGE_METADATA_BYTES = 1024 * 1024;
const BOOTSTRAP_TASK_STOP_AFTER_MS = 26 * 60 * 1000;
const SUPPORTED_IMAGE_MANIFEST_MEDIA_TYPES = Object.freeze([
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
]);

function requiredString(value, pattern) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    !pattern.test(value)
  ) {
    throw new Error('Bootstrap deployment configuration is unavailable.');
  }
  return value;
}

function configuration(event) {
  const properties = event?.ResourceProperties;
  if (properties === null || typeof properties !== 'object') {
    throw new Error('Bootstrap deployment configuration is unavailable.');
  }
  const clusterArn = requiredString(
    properties.ClusterArn,
    /^arn:aws(?:-us-gov|-cn)?:ecs:[a-z0-9-]+:\d{12}:cluster\/[A-Za-z0-9_-]+$/u,
  );
  const containerName = requiredString(
    properties.ContainerName,
    /^[A-Za-z0-9_-]{1,255}$/u,
  );
  requiredString(properties.DeploymentRevision, /^[a-f0-9]{40}$/u);
  const securityGroupId = requiredString(
    properties.SecurityGroupId,
    /^sg-[a-f0-9]{8,17}$/u,
  );
  const taskDefinitionArn = requiredString(
    properties.TaskDefinitionArn,
    /^arn:aws(?:-us-gov|-cn)?:ecs:[a-z0-9-]+:\d{12}:task-definition\/[A-Za-z0-9_-]+:\d+$/u,
  );
  if (
    !Array.isArray(properties.SubnetIds) ||
    properties.SubnetIds.length === 0 ||
    properties.SubnetIds.length > 16 ||
    properties.SubnetIds.some(
      (value) =>
        typeof value !== 'string' || !/^subnet-[a-f0-9]{8,17}$/u.test(value),
    )
  ) {
    throw new Error('Bootstrap deployment configuration is unavailable.');
  }
  return {
    clusterArn,
    containerName,
    securityGroupId,
    subnetIds: properties.SubnetIds,
    taskDefinitionArn,
  };
}

async function runTask(input) {
  const { ECSClient, RunTaskCommand } = await import('@aws-sdk/client-ecs');
  return new ECSClient({}).send(new RunTaskCommand(input));
}

async function describeTasks(input) {
  const { DescribeTasksCommand, ECSClient } = await import(
    '@aws-sdk/client-ecs'
  );
  return new ECSClient({}).send(new DescribeTasksCommand(input));
}

async function describeServices(input) {
  const { DescribeServicesCommand, ECSClient } = await import(
    '@aws-sdk/client-ecs'
  );
  return new ECSClient({}).send(new DescribeServicesCommand(input));
}

async function stopTask(input) {
  const { ECSClient, StopTaskCommand } = await import('@aws-sdk/client-ecs');
  return new ECSClient({}).send(new StopTaskCommand(input));
}

async function readStackStatus(stackId) {
  const { CloudFormationClient, DescribeStacksCommand } = await import(
    '@aws-sdk/client-cloudformation'
  );
  const response = await new CloudFormationClient({}).send(
    new DescribeStacksCommand({ StackName: stackId }),
  );
  return response?.Stacks?.[0]?.StackStatus;
}

async function batchGetImage(input) {
  const { BatchGetImageCommand, ECRClient } = await import(
    '@aws-sdk/client-ecr'
  );
  return new ECRClient({}).send(new BatchGetImageCommand(input));
}

async function getDownloadUrlForLayer(input) {
  const { ECRClient, GetDownloadUrlForLayerCommand } = await import(
    '@aws-sdk/client-ecr'
  );
  return new ECRClient({}).send(new GetDownloadUrlForLayerCommand(input));
}

function rollbackConfiguration(event) {
  const properties = event?.ResourceProperties;
  if (properties === null || typeof properties !== 'object') {
    throw new Error('invalid properties');
  }
  const currentSourceSha = requiredString(
    properties.CurrentSourceSha,
    /^(?!0{40}$)[a-f0-9]{40}$/u,
  );
  const expectedSourceRepositoryUrl = requiredString(
    properties.ExpectedSourceRepositoryUrl,
    /^https:\/\/[^\s/]+\/[^\s]+$/u,
  );
  const imageDigest = requiredString(
    properties.ImageDigest,
    /^(?:CURRENT_CDK_ASSET|sha256:[a-f0-9]{64})$/u,
  );
  const repositoryKind = requiredString(
    properties.RepositoryKind,
    /^(?:CURRENT_CDK_ASSET|CDK_ASSET_REPOSITORY|LEGACY_APPLICATION_REPOSITORY)$/u,
  );
  const repositoryName = requiredString(
    properties.RepositoryName,
    /^(?=.{2,256}$)(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*$/u,
  );
  const isCurrent = imageDigest === CURRENT_CDK_ASSET;
  if (isCurrent !== (repositoryKind === CURRENT_CDK_ASSET)) {
    throw new Error('incomplete rollback selection');
  }
  return {
    currentSourceSha,
    expectedSourceRepositoryUrl,
    imageDigest,
    repositoryKind,
    repositoryName,
  };
}

function parseBoundedJson(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_IMAGE_METADATA_BYTES
  ) {
    throw new Error('image metadata unavailable');
  }
  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('image metadata unavailable');
  }
  return parsed;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function readBoundedResponseBody(response) {
  const declaredLength = response.headers?.get('content-length');
  if (declaredLength === null || !/^\d+$/u.test(declaredLength)) {
    throw new Error('asset config unavailable');
  }
  const expectedBytes = Number(declaredLength);
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    expectedBytes > MAX_IMAGE_METADATA_BYTES ||
    response.body === null
  ) {
    throw new Error('asset config unavailable');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > expectedBytes || totalBytes > MAX_IMAGE_METADATA_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('asset config unavailable');
    }
    chunks.push(value);
  }
  if (totalBytes !== expectedBytes) {
    throw new Error('asset config unavailable');
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function assetSourceSha(config, dependencies) {
  const response = await (dependencies.batchGetImage ?? batchGetImage)({
    acceptedMediaTypes: SUPPORTED_IMAGE_MANIFEST_MEDIA_TYPES,
    imageIds: [{ imageDigest: config.imageDigest }],
    repositoryName: config.repositoryName,
  });
  if (
    (Array.isArray(response?.failures) && response.failures.length > 0) ||
    !Array.isArray(response?.images) ||
    response.images.length !== 1
  ) {
    throw new Error('asset image unavailable');
  }
  const image = response.images[0];
  if (
    image?.imageId?.imageDigest !== config.imageDigest ||
    !SUPPORTED_IMAGE_MANIFEST_MEDIA_TYPES.includes(image.imageManifestMediaType)
  ) {
    throw new Error('asset image unavailable');
  }
  if (sha256(image.imageManifest) !== config.imageDigest) {
    throw new Error('asset image unavailable');
  }
  const manifest = parseBoundedJson(image.imageManifest);
  if (
    manifest.schemaVersion !== 2 ||
    manifest.mediaType !== image.imageManifestMediaType
  ) {
    throw new Error('asset image unavailable');
  }
  const configDigest = requiredString(
    manifest?.config?.digest,
    /^sha256:[a-f0-9]{64}$/u,
  );
  const layer = await (
    dependencies.getDownloadUrlForLayer ?? getDownloadUrlForLayer
  )({
    layerDigest: configDigest,
    repositoryName: config.repositoryName,
  });
  if (layer?.layerDigest !== configDigest) {
    throw new Error('asset config unavailable');
  }
  const downloadUrl = new URL(
    requiredString(layer?.downloadUrl, /^https:\/\/[^\s]+$/u),
  );
  if (
    downloadUrl.protocol !== 'https:' ||
    !(
      downloadUrl.hostname.endsWith('.amazonaws.com') ||
      downloadUrl.hostname.endsWith('.amazonaws.com.cn')
    )
  ) {
    throw new Error('asset config unavailable');
  }
  const download = await (dependencies.fetchLayer ?? fetch)(downloadUrl.href, {
    redirect: 'error',
  });
  if (!download.ok) {
    throw new Error('asset config unavailable');
  }
  const body = await readBoundedResponseBody(download);
  if (sha256(body) !== configDigest) {
    throw new Error('asset config unavailable');
  }
  const imageConfig = parseBoundedJson(new TextDecoder().decode(body));
  const labels = imageConfig?.config?.Labels;
  if (
    labels?.['org.opencontainers.image.source'] !==
      config.expectedSourceRepositoryUrl ||
    labels?.['org.opencontainers.image.title'] !== 'PSD EOC live pilot' ||
    labels?.['org.psd-eoc.data-classification'] !== 'staff-minimized' ||
    labels?.['org.psd-eoc.environment'] !== 'live-pilot'
  ) {
    throw new Error('asset identity unavailable');
  }
  return requiredString(
    labels?.['org.opencontainers.image.revision'],
    /^(?!0{40}$)[a-f0-9]{40}$/u,
  );
}

export async function validateRollbackImage(event, dependencies = {}) {
  const physicalResourceId =
    typeof event?.PhysicalResourceId === 'string' &&
    event.PhysicalResourceId.length > 0
      ? event.PhysicalResourceId
      : ROLLBACK_PHYSICAL_RESOURCE_ID;
  if (event?.RequestType === 'Delete') {
    return {
      Data: { Deleted: true },
      PhysicalResourceId: physicalResourceId,
    };
  }
  try {
    if (event?.RequestType !== 'Create' && event?.RequestType !== 'Update') {
      throw new Error('unsupported request');
    }
    const config = rollbackConfiguration(event);
    let sourceSha = config.currentSourceSha;
    if (config.repositoryKind !== CURRENT_CDK_ASSET) {
      sourceSha = await assetSourceSha(config, dependencies);
    }
    return {
      Data: { SourceSha: sourceSha },
      PhysicalResourceId: physicalResourceId,
    };
  } catch {
    throw new Error('Rollback image provenance could not be verified.');
  }
}

function providerConfigurationIsPersistentlyDark(properties) {
  return (
    properties !== null &&
    typeof properties === 'object' &&
    properties.EnableExpoPushWorker === 'false' &&
    properties.EnableDirectPush === 'false' &&
    properties.EnableAwsEumSmsWorker === 'false' &&
    properties.EnableEmailWorker === 'false' &&
    properties.PushProviderCutover ===
      '{"version":1,"ios":"expo","android":"expo"}'
  );
}

export async function validateRollbackQuiescence(event, dependencies = {}) {
  const physicalResourceId =
    typeof event?.PhysicalResourceId === 'string' &&
    event.PhysicalResourceId.length > 0
      ? event.PhysicalResourceId
      : ROLLBACK_QUIESCENCE_PHYSICAL_RESOURCE_ID;
  if (event?.RequestType === 'Delete') {
    return {
      Data: { Deleted: true },
      PhysicalResourceId: physicalResourceId,
    };
  }
  try {
    if (event?.RequestType !== 'Create' && event?.RequestType !== 'Update') {
      throw new Error('unsupported request');
    }
    const properties = event?.ResourceProperties;
    if (properties === null || typeof properties !== 'object') {
      throw new Error('invalid properties');
    }
    const deploymentRevision = requiredString(
      properties.DeploymentRevision,
      /^(?!0{40}$)[a-f0-9]{40}$/u,
    );
    const rollbackSelected = requiredString(
      properties.RollbackSelected,
      /^(?:true|false)$/u,
    );
    if (rollbackSelected === 'false') {
      return {
        Data: { Skipped: true },
        PhysicalResourceId: physicalResourceId,
      };
    }
    if (
      !providerConfigurationIsPersistentlyDark(properties) ||
      !providerConfigurationIsPersistentlyDark(event.OldResourceProperties) ||
      event.OldResourceProperties?.Operation !== 'ROLLBACK_QUIESCENCE' ||
      event.OldResourceProperties?.DeploymentRevision !== deploymentRevision
    ) {
      throw new Error('provider configuration was not previously dark');
    }
    const clusterArn = requiredString(
      properties.ClusterArn,
      /^arn:aws(?:-us-gov|-cn)?:ecs:[a-z0-9-]+:\d{12}:cluster\/[A-Za-z0-9_-]+$/u,
    );
    if (
      !Array.isArray(properties.ServiceNames) ||
      properties.ServiceNames.length !== 3 ||
      properties.ServiceNames.some(
        (value) =>
          typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/u.test(value),
      ) ||
      new Set(properties.ServiceNames).size !== properties.ServiceNames.length
    ) {
      throw new Error('invalid services');
    }
    const response = await (dependencies.describeServices ?? describeServices)({
      cluster: clusterArn,
      services: properties.ServiceNames,
    });
    if (
      (Array.isArray(response?.failures) && response.failures.length > 0) ||
      !Array.isArray(response?.services) ||
      response.services.length !== properties.ServiceNames.length
    ) {
      throw new Error('services unavailable');
    }
    const expectedServiceNames = new Set(properties.ServiceNames);
    for (const service of response.services) {
      if (
        !expectedServiceNames.delete(service?.serviceName) ||
        service?.desiredCount !== 0 ||
        service?.pendingCount !== 0 ||
        service?.runningCount !== 0
      ) {
        throw new Error('service is not quiescent');
      }
    }
    if (expectedServiceNames.size !== 0) {
      throw new Error('service unavailable');
    }
    return {
      Data: { Quiescent: true },
      PhysicalResourceId: physicalResourceId,
    };
  } catch {
    throw new Error('Provider workers are not quiescent for rollback.');
  }
}

export async function startBootstrap(event, dependencies = {}) {
  const physicalResourceId =
    typeof event?.PhysicalResourceId === 'string' &&
    event.PhysicalResourceId.length > 0
      ? event.PhysicalResourceId
      : PHYSICAL_RESOURCE_ID;
  if (event?.RequestType === 'Delete') {
    return {
      Data: { Deleted: true },
      PhysicalResourceId: physicalResourceId,
    };
  }
  if (event?.RequestType !== 'Create' && event?.RequestType !== 'Update') {
    throw new Error('Bootstrap deployment request is unavailable.');
  }
  if (event.RequestType === 'Update') {
    const stackId = requiredString(
      event.StackId,
      /^arn:aws(?:-us-gov|-cn)?:cloudformation:[a-z0-9-]+:\d{12}:stack\/[A-Za-z0-9-]+\/[a-f0-9-]+$/u,
    );
    const stackStatus = await (dependencies.readStackStatus ?? readStackStatus)(
      stackId,
    );
    if (typeof stackStatus !== 'string') {
      throw new Error('Deployment rollback state is unavailable.');
    }
    if (stackStatus.includes('ROLLBACK')) {
      return {
        Data: { Skipped: true },
        PhysicalResourceId: physicalResourceId,
      };
    }
  }
  const requestId = requiredString(event.RequestId, /^[A-Za-z0-9_-]{1,64}$/u);
  const config = configuration(event);
  const response = await (dependencies.runTask ?? runTask)({
    clientToken: requestId,
    cluster: config.clusterArn,
    count: 1,
    enableECSManagedTags: true,
    launchType: 'FARGATE',
    networkConfiguration: {
      awsvpcConfiguration: {
        assignPublicIp: 'DISABLED',
        securityGroups: [config.securityGroupId],
        subnets: config.subnetIds,
      },
    },
    taskDefinition: config.taskDefinitionArn,
  });
  const taskArn = response?.tasks?.[0]?.taskArn;
  if (
    (Array.isArray(response?.failures) && response.failures.length > 0) ||
    typeof taskArn !== 'string' ||
    taskArn.length === 0
  ) {
    throw new Error('Bootstrap task could not be started.');
  }
  return {
    Data: {
      StartedAtEpochMs: (dependencies.now ?? Date.now)(),
      TaskArn: taskArn,
    },
    PhysicalResourceId: physicalResourceId,
  };
}

export async function checkBootstrap(event, dependencies = {}) {
  if (event?.RequestType === 'Delete') return { IsComplete: true };
  if (event?.Data?.Skipped === true) return { IsComplete: true };
  const config = configuration(event);
  const taskArn = requiredString(
    event?.Data?.TaskArn,
    /^arn:aws(?:-us-gov|-cn)?:ecs:[a-z0-9-]+:\d{12}:task\/(?:(?:[A-Za-z0-9_-]+)\/)?(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/u,
  );
  const startedAtEpochMs = event?.Data?.StartedAtEpochMs;
  if (
    typeof startedAtEpochMs !== 'number' ||
    !Number.isSafeInteger(startedAtEpochMs) ||
    startedAtEpochMs <= 0
  ) {
    throw new Error('Bootstrap task status is unavailable.');
  }
  let response;
  try {
    response = await (dependencies.describeTasks ?? describeTasks)({
      cluster: config.clusterArn,
      tasks: [taskArn],
    });
  } catch {
    return { IsComplete: false };
  }
  if (
    (Array.isArray(response?.failures) && response.failures.length > 0) ||
    !Array.isArray(response?.tasks) ||
    response.tasks.length !== 1
  ) {
    return { IsComplete: false };
  }
  const task = response.tasks[0];
  if (task?.taskDefinitionArn !== config.taskDefinitionArn) {
    return { IsComplete: false };
  }
  if (task?.lastStatus === 'STOPPED') {
    const container = Array.isArray(task.containers)
      ? task.containers.find((entry) => entry?.name === config.containerName)
      : undefined;
    if (container?.exitCode !== 0) {
      throw new Error('Bootstrap task failed.');
    }
    return { IsComplete: true };
  }
  const deadlineExceeded =
    (dependencies.now ?? Date.now)() - startedAtEpochMs >=
    BOOTSTRAP_TASK_STOP_AFTER_MS;
  if (deadlineExceeded) {
    try {
      await (dependencies.stopTask ?? stopTask)({
        cluster: config.clusterArn,
        reason: 'Deployment bootstrap exceeded its bounded runtime.',
        task: taskArn,
      });
    } catch {
      return { IsComplete: false };
    }
    return { IsComplete: false };
  }
  return { IsComplete: false };
}

export async function onEvent(event) {
  return startBootstrap(event);
}

export async function isComplete(event) {
  return checkBootstrap(event);
}

export async function resolveRollbackImage(event) {
  if (event?.ResourceProperties?.Operation === 'ROLLBACK_QUIESCENCE') {
    return validateRollbackQuiescence(event);
  }
  return validateRollbackImage(event);
}
