export interface MetricBucket {
  readonly cohortTimestamp: Date;
  readonly parameters: ReadonlyArray<{
    readonly name: string;
    readonly value: { readonly stringValue: string };
  }>;
  readonly scheduleTimestamp: Date;
}

export const MONITORING_QUERIES: Readonly<{
  readonly commitTimestampReady: string;
  readonly activationAccept: string;
  readonly deliveryStates: string;
  readonly deliveryTestHealth: string;
  readonly outboxToProvider: string;
  readonly rosterAge: string;
  readonly stuckOutbox: string;
}>;

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
