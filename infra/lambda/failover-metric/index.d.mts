export function assertDatabaseArn(value: unknown, region: unknown): string;

export function runFailoverMetric(
  event: unknown,
  dependencies?: Readonly<{
    publish?: (namespace: string) => Promise<void>;
  }>,
): Promise<void>;

export function handler(event: unknown): Promise<void>;
