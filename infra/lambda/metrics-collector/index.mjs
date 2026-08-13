import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  BeginTransactionCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
} from '@aws-sdk/client-rds-data';

export const READ_ONLY_TRANSACTION_SQL = 'SET TRANSACTION READ ONLY';
export const DELIVERY_STATES = Object.freeze([
  'attempted',
  'provider-accepted',
  'delivered',
  'failed',
  'expired',
  'unknown',
]);

export const MONITORING_QUERIES = Object.freeze({
  commitTimestampReady: `
    SELECT
      CASE
        WHEN current_setting('track_commit_timestamp') = 'on' THEN 1::double precision
        ELSE 0::double precision
      END AS ready,
      count(*) FILTER (
        WHERE transition.transition = 'activate'
          AND transition.roster_population = 'staff'
          AND transition.kind IN ('incident', 'drill')
          AND transition.occurred_at >= CAST(:bucket_start AS timestamptz)
          AND transition.occurred_at < CAST(:bucket_end AS timestamptz)
          AND pg_xact_commit_timestamp(transition.xmin::text::xid) IS NULL
      )::double precision AS missing_count
    FROM event_transitions AS transition
  `,
  activationAccept: `
    WITH candidates AS MATERIALIZED (
      SELECT pg_xact_commit_timestamp(transition.xmin::text::xid) AS committed_at,
        confirmation.consumed_at
      FROM event_transitions AS transition
      INNER JOIN human_confirmation_records AS confirmation
        ON confirmation.id = transition.confirmation_id
      WHERE transition.transition = 'activate'
        AND transition.roster_population = 'staff'
        AND transition.kind IN ('incident', 'drill')
        AND transition.occurred_at >= CAST(:bucket_start AS timestamptz)
        AND transition.occurred_at < CAST(:bucket_end AS timestamptz)
    ), cohort AS (
      SELECT committed_at,
        (extract(epoch FROM (committed_at - consumed_at)) * 1000)::double precision AS latency_ms
      FROM candidates
    )
    SELECT
      percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)
        FILTER (WHERE latency_ms >= 0 AND latency_ms NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision))::double precision AS p50_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
        FILTER (WHERE latency_ms >= 0 AND latency_ms NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision))::double precision AS p95_ms,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)
        FILTER (WHERE latency_ms >= 0 AND latency_ms NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision))::double precision AS p99_ms,
      count(*) FILTER (WHERE committed_at >= CAST(:bucket_start AS timestamptz) AND committed_at < CAST(:bucket_end AS timestamptz) + interval '1 minute' AND latency_ms >= 0 AND latency_ms NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision))::double precision AS sample_count,
      count(*) FILTER (WHERE committed_at IS NULL OR committed_at < CAST(:bucket_start AS timestamptz) OR committed_at >= CAST(:bucket_end AS timestamptz) + interval '1 minute' OR latency_ms IS NULL OR latency_ms < 0 OR latency_ms IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision))::double precision AS invalid_count
    FROM cohort
    HAVING count(*) > 0
  `,
  deliveryStates: `
    WITH recent_intents AS MATERIALIZED (
      SELECT id
      FROM notification_intents
      WHERE created_at >= CAST(:bucket_end AS timestamptz) - interval '24 hours'
        AND created_at < CAST(:bucket_end AS timestamptz)
        AND roster_population = 'staff'
        AND event_kind IN ('incident', 'drill')
        AND event_kind <> 'test'
    ), latest_attempts AS MATERIALIZED (
      SELECT DISTINCT ON (attempt.batch_id, attempt.endpoint_id)
        attempt.id
      FROM recent_intents AS intent
      INNER JOIN channel_attempts AS attempt ON attempt.intent_id = intent.id
      WHERE attempt.attempted_at < CAST(:bucket_end AS timestamptz)
      ORDER BY attempt.batch_id, attempt.endpoint_id,
        attempt.attempt_number DESC, attempt.attempted_at DESC, attempt.id DESC
    ), latest_evidence AS (
      SELECT DISTINCT ON (attempt.id)
        attempt.id AS attempt_id,
        evidence.state
      FROM latest_attempts AS attempt
      LEFT JOIN delivery_evidence AS evidence
        ON evidence.subject_kind = 'attempt'
        AND evidence.attempt_id = attempt.id
        AND evidence.recorded_at < CAST(:bucket_end AS timestamptz)
      ORDER BY attempt.id, evidence.sequence DESC NULLS LAST
    ), classified AS (
      SELECT state::text AS state,
        (state IS NULL) AS evidence_gap
      FROM latest_evidence
    )
    SELECT state,
      count(*)::double precision AS state_count,
      0::double precision AS evidence_gap_count
    FROM classified
    WHERE NOT evidence_gap
    GROUP BY state
    UNION ALL
    SELECT NULL::text AS state,
      0::double precision AS state_count,
      count(*) FILTER (WHERE evidence_gap)::double precision AS evidence_gap_count
    FROM classified
    HAVING count(*) FILTER (WHERE evidence_gap) > 0
    ORDER BY state
  `,
  outboxToProvider: `
    WITH target_channels AS MATERIALIZED (
      SELECT outbox.intent_id,
        channel.channel,
        channel.endpoint_count,
        outbox.created_at
      FROM outbox
      INNER JOIN notification_intent_channels AS channel
        ON channel.intent_id = outbox.intent_id
      WHERE outbox.created_at >= CAST(:bucket_start AS timestamptz)
        AND outbox.created_at < CAST(:bucket_end AS timestamptz)
        AND outbox.purpose = 'activation'
        AND outbox.roster_population = 'staff'
        AND outbox.event_kind IN ('incident', 'drill')
        AND outbox.event_kind <> 'test'
    ), endpoint_acceptance AS MATERIALIZED (
      SELECT target.intent_id,
        target.channel,
        target.created_at,
        attempt.endpoint_id,
        min(evidence.recorded_at) FILTER (
          WHERE evidence.state = 'provider-accepted'
        ) AS accepted_at
      FROM target_channels AS target
      LEFT JOIN dispatch_batches AS batch
        ON batch.intent_id = target.intent_id
        AND batch.channel = target.channel
        AND batch.created_at < target.created_at + interval '1 minute'
      LEFT JOIN channel_attempts AS attempt
        ON attempt.batch_id = batch.id
        AND attempt.attempted_at < target.created_at + interval '1 minute'
      LEFT JOIN delivery_evidence AS evidence
        ON evidence.subject_kind = 'attempt'
        AND evidence.intent_id IS NULL
        AND evidence.attempt_id = attempt.id
        AND evidence.recorded_at < target.created_at + interval '1 minute'
      GROUP BY target.intent_id, target.channel, target.created_at, attempt.endpoint_id
    ), cohort AS (
      SELECT channel,
        endpoint_id,
        accepted_at,
        (extract(epoch FROM (accepted_at - created_at)) * 1000)::double precision AS latency_ms
      FROM endpoint_acceptance
    ), expected AS (
      SELECT channel,
        count(*)::double precision AS channel_count,
        sum(endpoint_count)::double precision AS expected_count
      FROM target_channels
      GROUP BY channel
      HAVING sum(endpoint_count) > 0
    ), observed AS (
      SELECT channel,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)
          FILTER (WHERE latency_ms >= 0 AND latency_ms NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision))::double precision AS p50_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
          FILTER (WHERE latency_ms >= 0 AND latency_ms NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision))::double precision AS p95_ms,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)
          FILTER (WHERE latency_ms >= 0 AND latency_ms NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision))::double precision AS p99_ms,
        count(*) FILTER (WHERE latency_ms >= 0 AND latency_ms NOT IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision))::double precision AS sample_count,
        count(*) FILTER (WHERE accepted_at IS NOT NULL)::double precision AS accepted_count,
        count(endpoint_id)::double precision AS attempted_endpoint_count,
        count(*) FILTER (WHERE accepted_at IS NOT NULL AND (latency_ms < 0 OR latency_ms IN ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision)))::double precision AS invalid_count
      FROM cohort
      GROUP BY channel
    )
    SELECT expected.channel,
      observed.p50_ms,
      observed.p95_ms,
      observed.p99_ms,
      coalesce(observed.sample_count, 0)::double precision AS sample_count,
      greatest(expected.expected_count - coalesce(observed.accepted_count, 0), 0)::double precision AS incomplete_count,
      expected.expected_count,
      expected.channel_count,
      (
        coalesce(observed.invalid_count, 0)
        + greatest(coalesce(observed.accepted_count, 0) - expected.expected_count, 0)
        + greatest(coalesce(observed.attempted_endpoint_count, 0) - expected.expected_count, 0)
      )::double precision AS invalid_count
    FROM expected
    LEFT JOIN observed ON observed.channel = expected.channel
    ORDER BY expected.channel
  `,
  rosterAge: `
    SELECT
      coalesce(extract(epoch FROM (
        CAST(:bucket_end AS timestamptz) - max(completed_at) FILTER (WHERE outcome = 'complete')
      )), 315360000)::double precision AS success_age_seconds,
      CASE
        WHEN (array_agg(outcome ORDER BY completed_at DESC, id DESC))[1]
          IN ('failed', 'partial-rejected')
        THEN extract(epoch FROM (
          CAST(:bucket_end AS timestamptz) - (array_agg(completed_at ORDER BY completed_at DESC, id DESC))[1]
        ))
        ELSE 0
      END::double precision AS failure_age_seconds
    FROM roster_sync_results
    WHERE population = 'staff'
      AND completed_at < CAST(:bucket_end AS timestamptz)
  `,
  stuckOutbox: `
    SELECT count(*)::double precision AS stuck_count
    FROM outbox
    WHERE roster_population = 'staff'
      AND event_kind IN ('incident', 'drill')
      AND event_kind <> 'test'
      AND created_at <= CAST(:bucket_end AS timestamptz) - interval '1 minute'
      AND (published_at IS NULL OR published_at > CAST(:bucket_end AS timestamptz))
      AND (failed_at IS NULL OR failed_at > CAST(:bucket_end AS timestamptz))
  `,
});

const METRIC_LIMIT_PER_INVOCATION = 29;
const CLOUDWATCH_BATCH_SIZE = 100;
const PERCENTILES = Object.freeze([
  ['P50', 'p50_ms'],
  ['P95', 'p95_ms'],
  ['P99', 'p99_ms'],
]);
const MAX_ACTIVATION_SAMPLES_PER_MINUTE = 1_200;
const MAX_PROVIDER_SAMPLES_PER_MINUTE = 3_600_000;

function requiredEnvironment(name, maximumLength = 2_048) {
  const value = process.env[name];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error('Monitoring configuration is unavailable.');
  }
  return value;
}

function commonDatabaseInput() {
  return Object.freeze({
    database: requiredEnvironment('DATABASE_NAME', 63),
    resourceArn: requiredEnvironment('DATABASE_ARN'),
    secretArn: requiredEnvironment('DATABASE_SECRET_ARN'),
  });
}

function assertStaticSelect(name, sql) {
  if (
    !Object.hasOwn(MONITORING_QUERIES, name) ||
    MONITORING_QUERIES[name] !== sql ||
    !/^\s*(?:WITH\b[\s\S]+?\bSELECT\b|SELECT\b)/iu.test(sql) ||
    /\b(?:ALTER|CALL|COMMIT|COPY|CREATE|DELETE|DO|DROP|EXECUTE|GRANT|INSERT|LOCK|MERGE|NOTIFY|REFRESH|REINDEX|RESET|REVOKE|SET|TRUNCATE|UPDATE|VACUUM)\b/iu.test(
      sql,
    )
  ) {
    throw new Error('Monitoring query is not a static SELECT.');
  }
}

function parseRows(response) {
  const json = response.formattedRecords;
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > 1_000_000) {
    throw new Error('Monitoring result is unavailable.');
  }
  const value = JSON.parse(json);
  if (!Array.isArray(value) || value.length > 500) {
    throw new Error('Monitoring result is unavailable.');
  }
  return value;
}

function finiteNonnegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} is unavailable.`);
  }
  return value;
}

function nonnegativeInteger(value, name) {
  const parsed = finiteNonnegative(value, name);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} is unavailable.`);
  }
  return parsed;
}

function metric(metricName, value, unit, dimensions, timestamp) {
  return {
    ...(dimensions === undefined ? {} : { Dimensions: dimensions }),
    MetricName: metricName,
    ...(timestamp === undefined ? {} : { Timestamp: timestamp }),
    Unit: unit,
    Value: finiteNonnegative(value, metricName),
  };
}

async function executeStaticSelect(client, transactionId, name, parameters) {
  const sql = MONITORING_QUERIES[name];
  assertStaticSelect(name, sql);
  const usesMetricBucket = sql.includes(':bucket_');
  return parseRows(
    await client.send(
      new ExecuteStatementCommand({
        ...commonDatabaseInput(),
        continueAfterTimeout: false,
        formatRecordsAs: 'JSON',
        includeResultMetadata: false,
        ...(usesMetricBucket ? { parameters } : {}),
        sql,
        transactionId,
      }),
    ),
  );
}

export function buildMetrics(results) {
  const output = [];
  if (results.activationAccept.length > 1) {
    throw new Error('Activation percentile snapshot is unavailable.');
  }
  const activation = results.activationAccept[0];
  if (activation !== undefined) {
    if (
      nonnegativeInteger(activation.invalid_count, 'ActivationInvalidCount') !==
      0
    ) {
      throw new Error('Activation latency cohort is invalid.');
    }
    const sampleCount = nonnegativeInteger(
      activation.sample_count,
      'ActivationAcceptSampleCount',
    );
    if (sampleCount === 0 || sampleCount > MAX_ACTIVATION_SAMPLES_PER_MINUTE) {
      throw new Error('Activation sample count exceeded its safe bound.');
    }
    for (const [percentile, field] of PERCENTILES) {
      output.push(
        metric(
          `ActivationAcceptLatency${percentile}Ms`,
          activation[field],
          'Milliseconds',
        ),
      );
    }
    output.push(metric('ActivationAcceptSampleCount', sampleCount, 'Count'));
  }
  const providerChannels = new Set();
  for (const row of results.outboxToProvider) {
    if (
      !['push', 'email', 'sms'].includes(row.channel) ||
      providerChannels.has(row.channel)
    ) {
      throw new Error('Provider channel is unavailable.');
    }
    providerChannels.add(row.channel);
    if (nonnegativeInteger(row.invalid_count, 'ProviderInvalidCount') !== 0) {
      throw new Error('Provider latency cohort is invalid.');
    }
    const sampleCount = nonnegativeInteger(
      row.sample_count,
      'OutboxToProviderSampleCount',
    );
    const incompleteCount = nonnegativeInteger(
      row.incomplete_count,
      'OutboxToProviderIncompleteCount',
    );
    const expectedCount = nonnegativeInteger(
      row.expected_count,
      'OutboxToProviderExpectedCount',
    );
    const channelCount = nonnegativeInteger(
      row.channel_count,
      'OutboxToProviderChannelCount',
    );
    if (
      expectedCount === 0 ||
      expectedCount > MAX_PROVIDER_SAMPLES_PER_MINUTE ||
      channelCount === 0 ||
      channelCount > MAX_ACTIVATION_SAMPLES_PER_MINUTE ||
      sampleCount + incompleteCount !== expectedCount
    ) {
      throw new Error('Provider sample count exceeded its safe bound.');
    }
    if (sampleCount > 0) {
      for (const [percentile, field] of PERCENTILES) {
        output.push(
          metric(
            `OutboxToProviderLatency${percentile}Ms`,
            row[field],
            'Milliseconds',
            [{ Name: 'Channel', Value: row.channel }],
          ),
        );
      }
    }
    output.push(
      metric('OutboxToProviderSampleCount', sampleCount, 'Count', [
        { Name: 'Channel', Value: row.channel },
      ]),
      metric('OutboxToProviderIncompleteCount', incompleteCount, 'Count', [
        { Name: 'Channel', Value: row.channel },
      ]),
    );
  }
  const deliveryCounts = new Map();
  let evidenceGapCount = 0;
  for (const row of results.deliveryStates) {
    const stateCount = nonnegativeInteger(
      row.state_count,
      'DeliveryStateCount',
    );
    const gapCount = nonnegativeInteger(
      row.evidence_gap_count,
      'DeliveryEvidenceGapCount',
    );
    if (row.state === null) {
      if (stateCount !== 0) {
        throw new Error('Delivery state snapshot is unavailable.');
      }
      evidenceGapCount += gapCount;
      continue;
    }
    if (gapCount !== 0) {
      throw new Error('Delivery state snapshot is unavailable.');
    }
    if (!DELIVERY_STATES.includes(row.state) || deliveryCounts.has(row.state)) {
      throw new Error('Delivery state snapshot is unavailable.');
    }
    deliveryCounts.set(row.state, stateCount);
  }
  for (const state of DELIVERY_STATES) {
    output.push(
      metric('DeliveryStateCount', deliveryCounts.get(state) ?? 0, 'Count', [
        { Name: 'State', Value: state },
      ]),
    );
  }
  output.push(metric('DeliveryEvidenceGapCount', evidenceGapCount, 'Count'));
  if (results.stuckOutbox.length !== 1 || results.rosterAge.length !== 1) {
    throw new Error('Operational snapshot is unavailable.');
  }
  output.push(
    metric('StuckOutboxCount', results.stuckOutbox[0].stuck_count, 'Count'),
    metric(
      'RosterSyncFailureAgeSeconds',
      results.rosterAge[0].failure_age_seconds,
      'Seconds',
    ),
    metric(
      'RosterSyncSuccessAgeSeconds',
      results.rosterAge[0].success_age_seconds,
      'Seconds',
    ),
  );
  if (output.length > METRIC_LIMIT_PER_INVOCATION) {
    throw new Error('Monitoring metric batch exceeded its safe bound.');
  }
  return output;
}

async function publish(metricData) {
  if (metricData.length === 0) return;
  const client = new CloudWatchClient({});
  const namespace = requiredEnvironment('METRIC_NAMESPACE', 255);
  for (
    let offset = 0;
    offset < metricData.length;
    offset += CLOUDWATCH_BATCH_SIZE
  ) {
    await client.send(
      new PutMetricDataCommand({
        MetricData: metricData.slice(offset, offset + CLOUDWATCH_BATCH_SIZE),
        Namespace: namespace,
      }),
    );
  }
}

export function metricBucket(event) {
  if (
    event?.source !== 'aws.events' ||
    event?.['detail-type'] !== 'Scheduled Event' ||
    typeof event?.id !== 'string' ||
    event.id.length === 0 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      event.id,
    )
  ) {
    throw new Error('Monitoring schedule boundary is unavailable.');
  }
  const scheduled = event?.time;
  if (
    typeof scheduled !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(scheduled)
  ) {
    throw new Error('Monitoring schedule boundary is unavailable.');
  }
  const eventTime = new Date(scheduled);
  if (!Number.isFinite(eventTime.getTime())) {
    throw new Error('Monitoring schedule boundary is unavailable.');
  }
  eventTime.setUTCSeconds(0, 0);
  const bucketEnd = new Date(eventTime.getTime() - 60_000);
  const bucketStart = new Date(bucketEnd.getTime() - 60_000);
  return {
    cohortTimestamp: bucketStart,
    parameters: [
      {
        name: 'bucket_start',
        value: { stringValue: bucketStart.toISOString() },
      },
      {
        name: 'bucket_end',
        value: { stringValue: bucketEnd.toISOString() },
      },
    ],
    scheduleTimestamp: eventTime,
  };
}

export async function collectOperationalMetrics(event, dependencies = {}) {
  if (
    requiredEnvironment('TRANSACTION_MODE', 64) !== 'read-only-always-rollback'
  ) {
    throw new Error('Monitoring transaction mode is unavailable.');
  }
  const client = dependencies.databaseClient ?? new RDSDataClient({});
  const publishMetrics = dependencies.publishMetrics ?? publish;
  const bucket = metricBucket(event);
  const { parameters } = bucket;
  const transaction = await client.send(
    new BeginTransactionCommand(commonDatabaseInput()),
  );
  const transactionId = transaction.transactionId;
  if (typeof transactionId !== 'string' || transactionId.length === 0) {
    throw new Error('Monitoring transaction is unavailable.');
  }
  let failure;
  let results;
  try {
    await client.send(
      new ExecuteStatementCommand({
        ...commonDatabaseInput(),
        continueAfterTimeout: false,
        sql: READ_ONLY_TRANSACTION_SQL,
        transactionId,
      }),
    );
    results = {
      activationAccept: await executeStaticSelect(
        client,
        transactionId,
        'activationAccept',
        parameters,
      ),
      commitTimestampReady: await executeStaticSelect(
        client,
        transactionId,
        'commitTimestampReady',
        parameters,
      ),
      deliveryStates: await executeStaticSelect(
        client,
        transactionId,
        'deliveryStates',
        parameters,
      ),
      outboxToProvider: await executeStaticSelect(
        client,
        transactionId,
        'outboxToProvider',
        parameters,
      ),
      rosterAge: await executeStaticSelect(
        client,
        transactionId,
        'rosterAge',
        parameters,
      ),
      stuckOutbox: await executeStaticSelect(
        client,
        transactionId,
        'stuckOutbox',
        parameters,
      ),
    };
  } catch (error) {
    failure = error;
  }
  try {
    await client.send(
      new RollbackTransactionCommand({
        ...commonDatabaseInput(),
        transactionId,
      }),
    );
  } catch (rollbackError) {
    throw new Error('Monitoring transaction rollback failed.', {
      cause: rollbackError,
    });
  }
  if (failure !== undefined) {
    throw new Error('Monitoring SELECT collection failed.', { cause: failure });
  }
  if (
    results.commitTimestampReady.length !== 1 ||
    results.commitTimestampReady[0].ready !== 1 ||
    nonnegativeInteger(
      results.commitTimestampReady[0].missing_count,
      'CommitTimestampMissingCount',
    ) !== 0
  ) {
    throw new Error('Commit timestamp monitoring is unavailable.');
  }
  await publishMetrics(
    buildMetrics(results).map((datum) => ({
      ...datum,
      Timestamp: bucket.cohortTimestamp,
    })),
  );
  await publishMetrics([metric('MetricsCollectorSuccess', 1, 'Count')]);
}

export async function handler(event) {
  await collectOperationalMetrics(event);
}
