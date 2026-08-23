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
