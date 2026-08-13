import { describe, expect, it } from 'bun:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { DEPLOYMENT_ACCOUNT, DEPLOYMENT_REGION } from '../src/config';
import { MONITORING_RUNBOOK_BASE_URL } from '../src/monitoring';
import { PsdEocStack } from '../src/psd-eoc-stack';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected record, got ${JSON.stringify(value)}`);
  }
  return value as JsonRecord;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected array, got ${JSON.stringify(value)}`);
  }
  return value;
}

function resourceEntries(
  template: Template,
  type: string,
): Array<[string, JsonRecord]> {
  return Object.entries(template.findResources(type)).map(([id, value]) => [
    id,
    record(value),
  ]);
}

function resources(template: Template, type: string): JsonRecord[] {
  return resourceEntries(template, type).map(([, value]) => value);
}

const app = new App();
const stack = new PsdEocStack(app, 'PsdEocMonitoringTest', {
  env: { account: DEPLOYMENT_ACCOUNT, region: DEPLOYMENT_REGION },
});
const template = Template.fromStack(stack);
const synthesized = record(template.toJSON());

describe('synthesized monitoring stack', () => {
  it('routes parameterized alarm recipients without repository endpoint data', () => {
    const parameters = record(synthesized.Parameters);
    for (const name of [
      'OperationsTeamAlarmEmail',
      'OperationsTeamAlarmSmsNumber',
      'MonitoringCanaryCredentialSecretArn',
      'MonitoringCanaryFacilityId',
      'MonitoringCanaryEventTypeVersionId',
    ]) {
      const parameter = record(parameters[name]);
      expect(parameter).not.toHaveProperty('Default');
    }
    expect(record(parameters.OperationsTeamAlarmEmail).NoEcho).toBe(true);
    expect(record(parameters.OperationsTeamAlarmSmsNumber).NoEcho).toBe(true);
    const subscriptions = resources(template, 'AWS::SNS::Subscription');
    expect(subscriptions).toHaveLength(4);
    expect(
      subscriptions
        .map((resource) => record(resource.Properties).Protocol)
        .sort(),
    ).toEqual(['email', 'email', 'sms', 'sms']);
  });

  it('synthesizes every alarm with actions and a real runbook URL', () => {
    const alarms = resources(template, 'AWS::CloudWatch::Alarm');
    expect(alarms.length).toBeGreaterThanOrEqual(20);
    for (const alarm of alarms) {
      const properties = record(alarm.Properties);
      expect(typeof properties.AlarmDescription).toBe('string');
      expect(String(properties.AlarmDescription)).toContain(
        `${MONITORING_RUNBOOK_BASE_URL}#runbook-`,
      );
      expect(array(properties.AlarmActions)).toHaveLength(1);
      expect(array(properties.OKActions)).toHaveLength(1);
      if (typeof properties.Period === 'number') {
        expect(properties.Period).toBeGreaterThanOrEqual(60);
      } else {
        expect(JSON.stringify(properties.Metrics)).toContain('"Period":60');
      }
    }
    const canary = alarms
      .map((resource) => record(resource.Properties))
      .find((properties) =>
        String(properties.AlarmName).includes('one-minute-canary-failure'),
      );
    expect(canary).toBeDefined();
    const canaryMetricQueries = array(canary?.Metrics).map(record);
    expect(JSON.stringify(canaryMetricQueries)).toContain(
      'FILL(canarySuccess, 0)',
    );
    const canaryMetricPeriods = canaryMetricQueries
      .map((query) => query.MetricStat)
      .filter((metricStat) => metricStat !== undefined)
      .map((metricStat) => Number(record(metricStat).Period));
    expect(canaryMetricPeriods).toEqual([60]);
    expect(canary?.EvaluationPeriods).toBe(2);
    expect(canary?.DatapointsToAlarm).toBe(2);
    expect(canary?.TreatMissingData).toBe('breaching');
    const canaryFunction = resources(template, 'AWS::Lambda::Function')
      .map((resource) => record(resource.Properties))
      .find(
        (properties) => properties.FunctionName === 'psd-eoc-one-minute-canary',
      );
    expect(canaryFunction?.Timeout).toBe(30);
    const conservativeDetectionBudgetSeconds =
      Number(canaryMetricPeriods[0]) * Number(canary?.EvaluationPeriods) +
      60 +
      Number(canaryFunction?.Timeout);
    expect(conservativeDetectionBudgetSeconds).toBe(210);
    expect(conservativeDetectionBudgetSeconds).toBeLessThan(300);
  });

  it('keeps canary, collector, and failover IAM roles disjoint and fail closed', () => {
    const policies = resources(template, 'AWS::IAM::Policy');
    const roleByDescription = (pattern: RegExp) => {
      const entry = resourceEntries(template, 'AWS::IAM::Role').find(
        ([, candidate]) =>
          pattern.test(String(record(candidate.Properties).Description)),
      );
      if (entry === undefined) throw new Error(`Missing role ${pattern}`);
      return entry;
    };
    roleByDescription(/rollback-only canonical TEST/u);
    roleByDescription(/SELECT-only production metric collector/u);
    roleByDescription(/matched Aurora failover event/u);

    const actionsForDescription = (pattern: RegExp) => {
      const [logicalId] = roleByDescription(pattern);
      return policies
        .filter((policy) =>
          JSON.stringify(record(policy.Properties).Roles).includes(logicalId),
        )
        .flatMap((policy) =>
          array(
            record(record(policy.Properties).PolicyDocument).Statement,
          ).flatMap((statement) => {
            const action = record(statement).Action;
            return Array.isArray(action)
              ? action.map(String)
              : [String(action)];
          }),
        );
    };
    const canaryActions = actionsForDescription(
      /rollback-only canonical TEST/u,
    );
    expect(canaryActions).toContain('secretsmanager:GetSecretValue');
    expect(canaryActions).toContain('cloudwatch:PutMetricData');
    expect(canaryActions.join('\n')).not.toMatch(
      /rds-data|sqs:|ses:Send|sms-voice:Send|mobiletargeting:Send|sns:Publish/iu,
    );
    const collectorActions = actionsForDescription(
      /SELECT-only production metric collector/u,
    );
    expect(collectorActions).toContain('rds-data:BeginTransaction');
    expect(collectorActions).toContain('rds-data:ExecuteStatement');
    expect(collectorActions).toContain('rds-data:RollbackTransaction');
    expect(collectorActions).not.toContain('rds-data:CommitTransaction');
    expect(collectorActions.join('\n')).not.toMatch(
      /sqs:|ses:Send|sms-voice:Send|mobiletargeting:Send|sns:Publish/iu,
    );
  });

  it('uses one-minute schedules and injects only server-owned TEST target IDs', () => {
    const rules = resources(template, 'AWS::Events::Rule').map((resource) =>
      record(resource.Properties),
    );
    expect(
      rules.filter(
        (properties) => properties.ScheduleExpression === 'rate(1 minute)',
      ),
    ).toHaveLength(2);
    const service = resources(template, 'AWS::AppRunner::Service')[0];
    if (service === undefined) throw new Error('Missing App Runner service.');
    const environment = array(
      record(
        record(
          record(record(service.Properties).SourceConfiguration)
            .ImageRepository,
        ).ImageConfiguration,
      ).RuntimeEnvironmentVariables,
    ).map(record);
    expect(environment).toContainEqual({
      Name: 'CANARY_FACILITY_ID',
      Value: { Ref: 'MonitoringCanaryFacilityId' },
    });
    expect(environment).toContainEqual({
      Name: 'CANARY_EVENT_TYPE_VERSION_ID',
      Value: { Ref: 'MonitoringCanaryEventTypeVersionId' },
    });
  });

  it('scopes CloudWatch topic publishing and alarms failover bridge errors', () => {
    const policies = resources(template, 'AWS::SNS::TopicPolicy');
    const cloudWatchStatements = policies.flatMap((policy) =>
      array(record(record(policy.Properties).PolicyDocument).Statement)
        .map(record)
        .filter((statement) =>
          JSON.stringify(statement.Principal).includes(
            'cloudwatch.amazonaws.com',
          ),
        ),
    );
    expect(cloudWatchStatements).toHaveLength(2);
    for (const statement of cloudWatchStatements) {
      const condition = record(statement.Condition);
      expect(record(condition.StringEquals)['aws:SourceAccount']).toBe(
        DEPLOYMENT_ACCOUNT,
      );
      expect(
        JSON.stringify(record(condition.ArnLike)['aws:SourceArn']),
      ).toContain(':cloudwatch:');
      expect(
        JSON.stringify(record(condition.ArnLike)['aws:SourceArn']),
      ).toContain(':alarm:');
    }
    const bridgeAlarm = resources(template, 'AWS::CloudWatch::Alarm')
      .map((resource) => record(resource.Properties))
      .find((properties) =>
        String(properties.AlarmName).includes('failover-bridge-errors'),
      );
    expect(bridgeAlarm).toBeDefined();
    expect(JSON.stringify(bridgeAlarm?.Metrics)).toContain(
      'FILL(eventbridge, 0) + FILL(lambdaErrors, 0) + FILL(lambdaThrottles, 0)',
    );
  });

  it('renders p50/p95/p99 latency and delivery/DLQ dashboard widgets', () => {
    const dashboard = resources(template, 'AWS::CloudWatch::Dashboard')[0];
    if (dashboard === undefined) throw new Error('Missing dashboard.');
    const body = JSON.stringify(record(dashboard.Properties).DashboardBody);
    for (const value of [
      'ActivationAcceptLatencyP50Ms',
      'ActivationAcceptLatencyP95Ms',
      'ActivationAcceptLatencyP99Ms',
      'OutboxToProviderLatencyP50Ms',
      'OutboxToProviderLatencyP95Ms',
      'OutboxToProviderLatencyP99Ms',
      'OutboxToProviderIncompleteCount',
      'DeliveryStateCount',
      'DeliveryEvidenceGapCount',
      'MetricsCollectorSuccess',
      'ApproximateNumberOfMessagesVisible',
      'p50',
      'p95',
      'p99',
      'TEST excluded',
    ]) {
      expect(body).toContain(value);
    }
  });
});
