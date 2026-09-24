import { afterEach, describe, expect, it, mock } from 'bun:test';

mock.module('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class CloudWatchClient {},
  PutMetricDataCommand: class PutMetricDataCommand {},
}));

const { assertDatabaseArn, runFailoverMetric } =
  await import('../lambda/failover-metric/index.mjs');

const databaseArn =
  'arn:aws:rds:us-east-1:123456789012:cluster:synthetic-example-eoc';
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
    process.env.AWS_REGION = 'us-east-1';
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
    process.env.AWS_REGION = 'us-east-1';
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

  it('accepts the configured region and rejects a retained deployment region', () => {
    expect(assertDatabaseArn(databaseArn, 'us-east-1')).toBe(databaseArn);
    expect(() => assertDatabaseArn(databaseArn, 'us-west-2')).toThrow(
      'Database identity is unavailable.',
    );
  });

  it('uses the AWS partition selected by the configured region', () => {
    for (const [region, partition] of [
      ['cn-north-1', 'aws-cn'],
      ['us-gov-west-1', 'aws-us-gov'],
    ]) {
      const arn = `arn:${partition}:rds:${region}:123456789012:cluster:synthetic-example`;
      expect(assertDatabaseArn(arn, region)).toBe(arn);
      expect(() =>
        assertDatabaseArn(
          `arn:aws:rds:${region}:123456789012:cluster:synthetic-example`,
          region,
        ),
      ).toThrow('Database identity is unavailable.');
    }
  });
});
