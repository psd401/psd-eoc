function requiredNamespace() {
  const value = process.env.METRIC_NAMESPACE;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error('Metric namespace is unavailable.');
  }
  return value;
}

export function assertDatabaseArn(value, region) {
  const partition =
    typeof region === 'string' && region.startsWith('cn-')
      ? 'aws-cn'
      : typeof region === 'string' && region.startsWith('us-gov-')
        ? 'aws-us-gov'
        : 'aws';
  if (
    typeof value !== 'string' ||
    typeof region !== 'string' ||
    !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u.test(region) ||
    !new RegExp(
      `^arn:${partition}:rds:${region}:\\d{12}:cluster:[A-Za-z0-9-]+$`,
      'u',
    ).test(value)
  ) {
    throw new Error('Database identity is unavailable.');
  }
  return value;
}

function requiredDatabaseArn() {
  return assertDatabaseArn(process.env.DATABASE_ARN, process.env.AWS_REGION);
}

function assertAuroraFailoverEvent(value, databaseArn) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.source !== 'aws.rds' ||
    value['detail-type'] !== 'RDS DB Cluster Event' ||
    !Array.isArray(value.resources) ||
    value.resources.length !== 1 ||
    value.resources[0] !== databaseArn ||
    !Array.isArray(value.detail?.EventCategories) ||
    !value.detail.EventCategories.includes('failover')
  ) {
    throw new Error('Failover event is unavailable.');
  }
}

async function publish(namespace) {
  const { CloudWatchClient, PutMetricDataCommand } =
    await import('@aws-sdk/client-cloudwatch');
  await new CloudWatchClient({}).send(
    new PutMetricDataCommand({
      MetricData: [
        {
          MetricName: 'AuroraFailoverEvent',
          Unit: 'Count',
          Value: 1,
        },
      ],
      Namespace: namespace,
    }),
  );
}

export async function runFailoverMetric(event, dependencies = {}) {
  const databaseArn = requiredDatabaseArn();
  assertAuroraFailoverEvent(event, databaseArn);
  await (dependencies.publish ?? publish)(requiredNamespace());
}

export async function handler(event) {
  await runFailoverMetric(event);
}
