import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const stackSource = readFileSync(
  new URL('../src/psd-eoc-stack.ts', import.meta.url),
  'utf8',
);
const monitoringSource = readFileSync(
  new URL('../src/monitoring.ts', import.meta.url),
  'utf8',
);
const collectorSource = readFileSync(
  new URL('../lambda/metrics-collector/index.mjs', import.meta.url),
  'utf8',
);
const canarySource = readFileSync(
  new URL('../lambda/canary/index.mjs', import.meta.url),
  'utf8',
);
const failoverSource = readFileSync(
  new URL('../lambda/failover-metric/index.mjs', import.meta.url),
  'utf8',
);
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

describe('monitoring infrastructure source invariants', () => {
  it('uses one-minute canonical rollback canary with no request DTO or provider path', () => {
    expect(monitoringSource).toContain('events.Schedule.rate(ONE_MINUTE)');
    expect(stackSource).toContain("name: 'CANARY_FACILITY_ID'");
    expect(stackSource).toContain("name: 'CANARY_EVENT_TYPE_VERSION_ID'");
    expect(monitoringSource).not.toContain("CANARY_EVENT_KIND: 'test'");
    expect(canarySource).toContain("method: 'POST'");
    expect(canarySource).toContain('Authorization: `Bearer ${credential}`');
    expect(canarySource).not.toMatch(/\bbody\s*:/u);
    expect(canarySource).not.toContain("'Content-Type'");
    expect(canarySource).toContain("'PROVIDER_SENDS', 16");
    expect(canarySource).toContain("!== 'disabled'");
    expect(canarySource).not.toMatch(
      /start-event|all-clear-event|close-event/u,
    );
  });

  it('uses a separate SELECT-only always-rollback collector and failover emitter', () => {
    expect(monitoringSource).toContain('MetricsCollectorFunctionRole');
    expect(monitoringSource).toContain('FailoverMetricFunctionRole');
    expect(monitoringSource).toContain('CanaryFunctionRole');
    expect(collectorSource).toContain("'SET TRANSACTION READ ONLY'");
    expect(collectorSource).toContain('new BeginTransactionCommand');
    expect(collectorSource).toContain('new RollbackTransactionCommand');
    expect(collectorSource).not.toContain('CommitTransactionCommand');
    expect(collectorSource).toContain('assertStaticSelect');
    expect(collectorSource).toMatch(
      /ALTER\|CALL\|COMMIT\|COPY\|CREATE\|DELETE\|DO\|DROP\|EXECUTE\|GRANT\|INSERT\|LOCK\|MERGE\|NOTIFY\|REFRESH\|REINDEX\|RESET\|REVOKE\|SET\|TRUNCATE\|UPDATE\|VACUUM/u,
    );
    expect(failoverSource).not.toMatch(/rds-data|ExecuteStatement|queue|Send/u);
  });

  it('produces exact closed-minute staff latency and bounded evidence truth with TEST excluded', () => {
    expect(stackSource).toContain("track_commit_timestamp: '1'");
    expect(collectorSource).toContain('pg_xact_commit_timestamp');
    expect(collectorSource).toContain("transition.transition = 'activate'");
    expect(collectorSource).toContain("transition.roster_population = 'staff'");
    expect(collectorSource).toContain(
      "transition.kind IN ('incident', 'drill')",
    );
    expect(collectorSource).toContain("evidence.state = 'provider-accepted'");
    expect(collectorSource).toContain("outbox.roster_population = 'staff'");
    expect(collectorSource).toContain("outbox.event_kind <> 'test'");
    expect(collectorSource).toContain("event_kind <> 'test'");
    expect(collectorSource).toContain("population = 'staff'");
    expect(collectorSource).toContain('percentile_cont(0.50)');
    expect(collectorSource).toContain('percentile_cont(0.95)');
    expect(collectorSource).toContain('percentile_cont(0.99)');
    expect(collectorSource).toContain('CAST(:bucket_start AS timestamptz)');
    expect(collectorSource).toContain('CAST(:bucket_end AS timestamptz)');
    expect(collectorSource).toContain("interval '24 hours'");
    expect(collectorSource).toContain('latest_attempts AS MATERIALIZED');
    expect(collectorSource).toContain(
      'attempt.attempted_at < CAST(:bucket_end AS timestamptz)',
    );
    expect(collectorSource).toContain(
      'evidence.recorded_at < CAST(:bucket_end AS timestamptz)',
    );
    expect(collectorSource).not.toContain("coalesce(state::text, 'attempted')");
    expect(collectorSource).toContain('evidence_gap_count');
    expect(collectorSource).toContain('state IS NULL');
    expect(collectorSource).toContain('METRIC_LIMIT_PER_INVOCATION = 29');
    expect(collectorSource).toContain('ActivationAcceptLatency${percentile}Ms');
    expect(collectorSource).toContain('OutboxToProviderLatency${percentile}Ms');
    expect(collectorSource).toContain('DeliveryStateCount');
    expect(collectorSource).toContain('DeliveryEvidenceGapCount');
    expect(collectorSource).toContain('OutboxToProviderIncompleteCount');
    expect(collectorSource).toContain('StuckOutboxCount');
    expect(collectorSource).toContain('MetricsCollectorSuccess');
  });

  it('defines all required alarms, percentile widgets, and real runbook anchors', () => {
    for (const name of [
      '5xxStatusResponses',
      'RequestLatency',
      'ACUUtilization',
      'AuroraReplicaLagMaximum',
      'ApproximateAgeOfOldestMessage',
      'ApproximateNumberOfMessagesVisible',
      'StuckOutboxCount',
      'RosterSyncFailureAgeSeconds',
      'AuroraFailoverEvent',
      'CanarySuccess',
      'MetricsCollectorSuccess',
    ]) {
      expect(monitoringSource).toContain(name);
    }
    expect(monitoringSource).toContain("p50: metric('P50')");
    expect(monitoringSource).toContain(
      'Activation accepted — exact closed-minute p50 / p95 / p99',
    );
    expect(monitoringSource).toContain(
      'completed outbox-to-provider — exact source-cohort p50 / p95 / p99',
    );
    expect(monitoringSource).toContain('All retained dead-letter queue depths');
    expect(monitoringSource).toContain(
      'Latest delivery truth for prior-24h intent-created cohort',
    );
    const runbooks = {
      'runbook-activation-accept-latency':
        '### Runbook: Activation accept latency',
      'runbook-app-runner-errors-and-latency':
        '### Runbook: App Runner errors and latency',
      'runbook-aurora-failover-readiness-and-capacity':
        '### Runbook: Aurora failover readiness and capacity',
      'runbook-outbox-to-provider-latency':
        '### Runbook: Outbox to provider latency',
      'runbook-metrics-collector': '### Runbook: Metrics collector',
      'runbook-queue-age-and-dead-letter-queues':
        '### Runbook: Queue age and dead-letter queues',
      'runbook-roster-sync-failure-age': '### Runbook: Roster sync failure age',
      'runbook-shallow-canary': '### Runbook: Shallow canary',
      'runbook-stuck-outbox': '### Runbook: Stuck outbox',
    } as const;
    for (const [anchor, heading] of Object.entries(runbooks)) {
      expect(monitoringSource).toContain(`runbookAnchor: '${anchor}'`);
      expect(readme).toContain(heading);
    }
    expect(monitoringSource).toContain('datapointsToAlarm: 2');
    expect(monitoringSource).toContain('evaluationPeriods: 2');
    expect(monitoringSource).toContain("'FILL(canarySuccess, 0)'");
    expect(monitoringSource).toContain(
      'treatMissingData: cloudwatch.TreatMissingData.BREACHING',
    );
    expect(canarySource.match(/Timestamp: timestamp/gu)).toHaveLength(2);
    expect(monitoringSource).toContain(
      "'FILL(eventbridge, 0) + FILL(lambdaErrors, 0) + FILL(lambdaThrottles, 0)'",
    );
  });
});
