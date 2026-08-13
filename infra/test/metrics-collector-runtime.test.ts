import { describe, expect, it, mock } from 'bun:test';
import {
  BeginTransactionCommand,
  ExecuteStatementCommand,
  RollbackTransactionCommand,
} from '@aws-sdk/client-rds-data';

mock.module('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class CloudWatchClient {},
  PutMetricDataCommand: class PutMetricDataCommand {},
}));

const { buildMetrics, collectOperationalMetrics, metricBucket } = await import(
  '../lambda/metrics-collector/index.mjs'
);

const schedule = Object.freeze({
  'detail-type': 'Scheduled Event',
  id: '00000000-0000-4000-8000-000000000029',
  source: 'aws.events',
  time: '2026-08-12T19:20:37Z',
});

function completeResults() {
  const percentile = {
    invalid_count: 0,
    p50_ms: 100,
    p95_ms: 200,
    p99_ms: 300,
    sample_count: 10,
  };
  return {
    activationAccept: [percentile],
    deliveryStates: [
      {
        evidence_gap_count: 0,
        state: 'attempted',
        state_count: 1,
      },
      {
        evidence_gap_count: 1,
        state: null,
        state_count: 0,
      },
    ],
    outboxToProvider: ['push', 'email', 'sms'].map((channel) => ({
      ...percentile,
      channel,
      channel_count: 1,
      expected_count: 10,
      incomplete_count: 0,
    })),
    rosterAge: [{ failure_age_seconds: 0, success_age_seconds: 30 }],
    stuckOutbox: [{ stuck_count: 0 }],
  };
}

describe('operational collector runtime boundaries', () => {
  it('derives one deterministic closed-minute cohort and rejects non-schedules', () => {
    const bucket = metricBucket(schedule);
    expect(bucket.cohortTimestamp.toISOString()).toBe(
      '2026-08-12T19:18:00.000Z',
    );
    expect(bucket.parameters).toEqual([
      {
        name: 'bucket_start',
        value: { stringValue: '2026-08-12T19:18:00.000Z' },
      },
      {
        name: 'bucket_end',
        value: { stringValue: '2026-08-12T19:19:00.000Z' },
      },
    ]);
    expect(() => metricBucket({ ...schedule, source: 'caller' })).toThrow(
      'Monitoring schedule boundary is unavailable.',
    );
  });

  it('builds the exact 29-datum maximum and rejects invalid latency truth', () => {
    const metrics = buildMetrics(completeResults());
    expect(metrics).toHaveLength(29);
    const attempted = metrics.find(
      ({ MetricName }) => MetricName === 'DeliveryStateCount',
    );
    const attemptedDimensions = attempted?.Dimensions as
      | ReadonlyArray<Readonly<{ Name: string; Value: string }>>
      | undefined;
    expect(
      attemptedDimensions?.[0]?.Value === 'attempted' ? attempted?.Value : null,
    ).toBe(1);
    expect(
      metrics.find(
        ({ MetricName }) => MetricName === 'DeliveryEvidenceGapCount',
      )?.Value,
    ).toBe(1);
    const invalid = completeResults();
    invalid.activationAccept[0]!.invalid_count = 1;
    expect(() => buildMetrics(invalid)).toThrow(
      'Activation latency cohort is invalid.',
    );
    const fractional = completeResults();
    fractional.outboxToProvider[0]!.sample_count = 9.5;
    expect(() => buildMetrics(fractional)).toThrow(
      'OutboxToProviderSampleCount is unavailable.',
    );
  });

  it('rolls back after a SELECT failure and publishes no metric', async () => {
    const priorEnvironment = { ...process.env };
    process.env.DATABASE_ARN =
      'arn:aws:rds:us-west-2:123456789012:cluster:synthetic';
    process.env.DATABASE_NAME = 'psd_eoc';
    process.env.DATABASE_SECRET_ARN =
      'arn:aws:secretsmanager:us-west-2:123456789012:secret:synthetic';
    process.env.TRANSACTION_MODE = 'read-only-always-rollback';
    const commands: unknown[] = [];
    let publications = 0;
    const databaseClient = {
      async send(command: unknown) {
        commands.push(command);
        if (commands.length === 1) return { transactionId: 'transaction-1' };
        if (
          command instanceof ExecuteStatementCommand &&
          command.input.sql !== 'SET TRANSACTION READ ONLY'
        ) {
          throw new Error('synthetic SELECT failure');
        }
        return {};
      },
    };
    try {
      await expect(
        collectOperationalMetrics(schedule, {
          databaseClient,
          publishMetrics: async () => {
            publications += 1;
          },
        }),
      ).rejects.toThrow('Monitoring SELECT collection failed.');
      expect(
        commands.some(
          (command) => command instanceof RollbackTransactionCommand,
        ),
      ).toBe(true);
      expect(publications).toBe(0);
    } finally {
      process.env = priorEnvironment;
    }
  });

  it('rolls back before operational publication and emits success only last', async () => {
    const priorEnvironment = { ...process.env };
    process.env.DATABASE_ARN =
      'arn:aws:rds:us-west-2:123456789012:cluster:synthetic';
    process.env.DATABASE_NAME = 'psd_eoc';
    process.env.DATABASE_SECRET_ARN =
      'arn:aws:secretsmanager:us-west-2:123456789012:secret:synthetic';
    process.env.TRANSACTION_MODE = 'read-only-always-rollback';
    const timeline: string[] = [];
    const publications: Array<ReadonlyArray<Record<string, unknown>>> = [];
    const selectResults = [
      [],
      [{ missing_count: 0, ready: 1 }],
      [],
      [],
      [{ failure_age_seconds: 0, success_age_seconds: 30 }],
      [{ stuck_count: 0 }],
    ];
    let selectIndex = 0;
    const databaseClient = {
      async send(command: unknown) {
        if (command instanceof BeginTransactionCommand) {
          timeline.push('begin');
          return { transactionId: 'transaction-1' };
        }
        if (command instanceof RollbackTransactionCommand) {
          timeline.push('rollback');
          return {};
        }
        if (command instanceof ExecuteStatementCommand) {
          if (command.input.sql === 'SET TRANSACTION READ ONLY') {
            timeline.push('read-only');
            return {};
          }
          timeline.push(`select-${selectIndex}`);
          return {
            formattedRecords: JSON.stringify(selectResults[selectIndex++]),
          };
        }
        throw new Error('Unexpected monitoring database command.');
      },
    };
    try {
      await collectOperationalMetrics(schedule, {
        databaseClient,
        publishMetrics: async (metricData) => {
          publications.push(metricData as Array<Record<string, unknown>>);
          timeline.push(`publish-${publications.length}`);
        },
      });

      expect(selectIndex).toBe(6);
      expect(timeline.at(-3)).toBe('rollback');
      expect(timeline.at(-2)).toBe('publish-1');
      expect(timeline.at(-1)).toBe('publish-2');
      expect(publications).toHaveLength(2);
      expect(
        publications[0]?.every(
          (datum) =>
            (datum.Timestamp as Date).toISOString() ===
            '2026-08-12T19:18:00.000Z',
        ),
      ).toBe(true);
      expect(publications[1]).toEqual([
        {
          MetricName: 'MetricsCollectorSuccess',
          Unit: 'Count',
          Value: 1,
        },
      ]);
    } finally {
      process.env = priorEnvironment;
    }
  });
});
