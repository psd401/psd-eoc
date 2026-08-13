import { afterEach, describe, expect, it, mock } from 'bun:test';

mock.module('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class CloudWatchClient {},
  PutMetricDataCommand: class PutMetricDataCommand {},
}));

const { runFailoverMetric } = await import(
  '../lambda/failover-metric/index.mjs'
);

const databaseArn =
  'arn:aws:rds:us-west-2:123456789012:cluster:synthetic-psd-eoc';
const priorEnvironment = { ...process.env };
const failoverEvent = Object.freeze({
  'detail-type': 'RDS DB Cluster Event',
  detail: { EventCategories: ['failover'] },
  resources: [databaseArn],
  source: 'aws.rds',
});

afterEach(() => {
  process.env = { ...priorEnvironment };
});

describe('Aurora failover metric bridge', () => {
  it('publishes one sanitized metric only for the configured cluster', async () => {
    process.env.DATABASE_ARN = databaseArn;
    process.env.METRIC_NAMESPACE = 'PSD/EOC';
    const namespaces: string[] = [];

    await runFailoverMetric(failoverEvent, {
      publish: async (namespace) => {
        namespaces.push(namespace);
      },
    });

    expect(namespaces).toEqual(['PSD/EOC']);
  });

  it('fails closed for another cluster or event category', async () => {
    process.env.DATABASE_ARN = databaseArn;
    process.env.METRIC_NAMESPACE = 'PSD/EOC';
    let publications = 0;
    for (const event of [
      { ...failoverEvent, resources: [`${databaseArn}-other`] },
      { ...failoverEvent, detail: { EventCategories: ['availability'] } },
    ]) {
      await expect(
        runFailoverMetric(event, {
          publish: async () => {
            publications += 1;
          },
        }),
      ).rejects.toThrow('Failover event is unavailable.');
    }
    expect(publications).toBe(0);
  });
});
