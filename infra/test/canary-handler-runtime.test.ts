import { afterEach, describe, expect, it, mock } from 'bun:test';

mock.module('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class CloudWatchClient {},
  PutMetricDataCommand: class PutMetricDataCommand {},
}));
mock.module('@aws-sdk/client-secrets-manager', () => ({
  GetSecretValueCommand: class GetSecretValueCommand {},
  SecretsManagerClient: class SecretsManagerClient {},
}));

const { runCanary } = await import('../lambda/canary/index.mjs');

const credential = `psd_eoc_agent_v1_ABCDEFGHIJKL.${'a'.repeat(43)}`;
const schedule = Object.freeze({
  'detail-type': 'Scheduled Event',
  id: '00000000-0000-4000-8000-000000000029',
  source: 'aws.events',
  time: '2026-08-12T19:20:37Z',
});
const priorEnvironment = { ...process.env };

function configureEnvironment(): void {
  process.env.CANARY_CREDENTIAL_SECRET_ARN =
    'arn:aws:secretsmanager:us-west-2:123456789012:secret:synthetic-canary';
  process.env.CANARY_URL =
    'https://service.us-west-2.awsapprunner.com/api/health';
  process.env.METRIC_NAMESPACE = 'PSD/EOC';
  process.env.PROVIDER_SENDS = 'disabled';
}

afterEach(() => {
  process.env = { ...priorEnvironment };
});

describe('canary Lambda handler truth', () => {
  it('publishes success into the validated schedule minute', async () => {
    configureEnvironment();
    const publications: unknown[][] = [];
    const requests: Request[] = [];

    await runCanary(schedule, {
      fetch: async (input, init) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        requests.push(request);
        return new Response('{"status":"ok"}', { status: 200 });
      },
      publishMetrics: async (...input) => {
        publications.push(input);
      },
      readSecret: async () => ({ SecretString: credential }),
      reportFailure: () => {
        throw new Error('Success must not report a failure stage.');
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers.get('authorization')).toBe(
      `Bearer ${credential}`,
    );
    expect(await requests[0]?.text()).toBe('');
    expect(publications).toHaveLength(1);
    expect(publications[0]?.[0]).toBe('PSD/EOC');
    expect(publications[0]?.[1]).toBe(true);
    expect(publications[0]?.[2]).toBeNumber();
    expect((publications[0]?.[3] as Date).toISOString()).toBe(
      '2026-08-12T19:20:00.000Z',
    );
  });

  it('publishes zero, reports only a closed stage, and rethrows generically', async () => {
    configureEnvironment();
    const failures: string[] = [];
    const publications: unknown[][] = [];

    await expect(
      runCanary(schedule, {
        fetch: async () => {
          throw new Error('private credential-like diagnostic');
        },
        publishMetrics: async (...input) => {
          publications.push(input);
        },
        readSecret: async () => ({ SecretString: credential }),
        reportFailure: (stage) => failures.push(stage),
      }),
    ).rejects.toThrow('Canonical rollback canary failed.');

    expect(failures).toEqual(['endpoint-request']);
    expect(JSON.stringify(failures)).not.toContain('private');
    expect(publications).toHaveLength(1);
    expect(publications[0]?.[1]).toBe(false);
    expect((publications[0]?.[3] as Date).toISOString()).toBe(
      '2026-08-12T19:20:00.000Z',
    );
  });
});
