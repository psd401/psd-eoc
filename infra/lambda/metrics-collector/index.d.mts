export interface MetricBucket {
  readonly cohortTimestamp: Date;
  readonly parameters: ReadonlyArray<{
    readonly name: string;
    readonly value: { readonly stringValue: string };
  }>;
  readonly scheduleTimestamp: Date;
}

export function metricBucket(event: unknown): MetricBucket;

export function buildMetrics(
  results: unknown,
): ReadonlyArray<Readonly<Record<string, unknown>>>;

export function collectOperationalMetrics(
  event: unknown,
  dependencies?: Readonly<{
    databaseClient?: {
      send(command: unknown): Promise<unknown>;
    };
    publishMetrics?: (
      metricData: ReadonlyArray<Readonly<Record<string, unknown>>>,
    ) => Promise<void>;
  }>,
): Promise<void>;

export function handler(event: unknown): Promise<void>;
