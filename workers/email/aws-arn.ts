export type SupportedAwsPartition = 'aws' | 'aws-cn' | 'aws-us-gov';

/** Rejects ARNs whose partition and region can never identify the same AWS deployment. */
export function awsPartitionSupportsRegion(
  partition: string | undefined,
  region: string | undefined,
): partition is SupportedAwsPartition {
  if (partition === 'aws-cn') {
    return region !== undefined && /^cn-[a-z]+-\d$/u.test(region);
  }
  if (partition === 'aws-us-gov') {
    return region !== undefined && /^us-gov-[a-z]+-\d$/u.test(region);
  }
  return (
    partition === 'aws' &&
    region !== undefined &&
    /^[a-z]{2}-[a-z]+-\d$/u.test(region) &&
    !region.startsWith('cn-')
  );
}

interface SqsQueueIdentity {
  readonly partition: SupportedAwsPartition;
  readonly region: string;
  readonly accountId: string;
  readonly queueName: string;
}

function parseSqsQueueArn(value: string): SqsQueueIdentity {
  const match =
    /^arn:(aws|aws-cn|aws-us-gov):sqs:([a-z0-9-]+):(\d{12}):([^:]+)$/u.exec(
      value,
    );
  const partition = match?.[1];
  const region = match?.[2];
  const accountId = match?.[3];
  const queueName = match?.[4];
  if (
    !awsPartitionSupportsRegion(partition, region) ||
    region === undefined ||
    accountId === undefined ||
    queueName === undefined ||
    queueName.length > 80 ||
    !/^[A-Za-z0-9_-]+(?:\.fifo)?$/u.test(queueName)
  ) {
    throw new Error('Invalid SQS queue ARN.');
  }
  return Object.freeze({ partition, region, accountId, queueName });
}

/**
 * Binds an SQS URL to the immutable partition, region, account, and name in
 * its ARN. Host-prefix lookalikes and cross-account queue substitution fail
 * before any worker starts polling.
 */
export function sqsQueueUrlForArn(
  queueUrlValue: string,
  queueArn: string,
): string {
  const identity = parseSqsQueueArn(queueArn);
  const dnsSuffix =
    identity.partition === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com';
  const expectedHostname = `sqs.${identity.region}.${dnsSuffix}`;
  const expectedPathname = `/${identity.accountId}/${identity.queueName}`;
  const queueUrl = new URL(queueUrlValue);
  if (
    queueUrl.protocol !== 'https:' ||
    queueUrl.hostname !== expectedHostname ||
    queueUrl.port !== '' ||
    queueUrl.username !== '' ||
    queueUrl.password !== '' ||
    queueUrl.pathname !== expectedPathname ||
    queueUrl.search !== '' ||
    queueUrl.hash !== ''
  ) {
    throw new Error('The SQS queue URL does not match its ARN.');
  }
  return queueUrl.toString();
}
