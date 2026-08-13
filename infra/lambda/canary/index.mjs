import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  EXPECTED_BODY,
  REQUEST_TIMEOUT_MILLISECONDS,
  assertCanaryUrl,
  parseCredential,
  readBoundedBody,
  requiredEnvironment,
  scheduledMetricTimestamp,
} from './core.mjs';

async function publish(namespace, success, latencyMilliseconds, timestamp) {
  const client = new CloudWatchClient({});
  await client.send(
    new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: [
        {
          MetricName: 'CanarySuccess',
          Unit: 'Count',
          Value: success ? 1 : 0,
          Timestamp: timestamp,
        },
        {
          MetricName: 'CanaryLifecycleLatencyMs',
          Unit: 'Milliseconds',
          Value: latencyMilliseconds,
          Timestamp: timestamp,
        },
      ],
    }),
  );
}

async function readSecret(secretArn) {
  return new SecretsManagerClient({}).send(
    new GetSecretValueCommand({
      SecretId: secretArn,
      VersionStage: 'AWSCURRENT',
    }),
  );
}

function reportFailure(stage) {
  console.error(JSON.stringify({ event: 'monitoring-canary-failure', stage }));
}

export async function runCanary(event, dependencies = {}) {
  const namespace = requiredEnvironment(process.env, 'METRIC_NAMESPACE', 255);
  const timestamp = scheduledMetricTimestamp(event);
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const publishMetrics = dependencies.publishMetrics ?? publish;
  const readCredentialSecret = dependencies.readSecret ?? readSecret;
  const report = dependencies.reportFailure ?? reportFailure;
  const startedAt = performance.now();
  let success = false;
  let failureStage = 'configuration';
  try {
    if (requiredEnvironment(process.env, 'PROVIDER_SENDS', 16) !== 'disabled') {
      throw new Error('Provider sends are not disabled.');
    }
    const secretArn = requiredEnvironment(
      process.env,
      'CANARY_CREDENTIAL_SECRET_ARN',
    );
    failureStage = 'credential-read';
    const secret = await readCredentialSecret(secretArn);
    const credential = parseCredential(secret);
    failureStage = 'endpoint-request';
    const response = await fetchImplementation(
      assertCanaryUrl(requiredEnvironment(process.env, 'CANARY_URL')),
      {
        headers: {
          Authorization: `Bearer ${credential}`,
        },
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
      },
    );
    failureStage = 'endpoint-response';
    const body = await readBoundedBody(response);
    if (response.status !== 200 || body !== EXPECTED_BODY) {
      throw new Error('Canary endpoint reported unavailable.');
    }
    success = true;
  } catch {
    report(failureStage);
  }
  const latencyMilliseconds = Math.max(0, performance.now() - startedAt);
  try {
    await publishMetrics(namespace, success, latencyMilliseconds, timestamp);
  } catch {
    report('metric-publish');
    throw new Error('Canonical rollback canary failed.');
  }
  if (!success) {
    throw new Error('Canonical rollback canary failed.');
  }
}

export async function handler(event) {
  await runCanary(event);
}
