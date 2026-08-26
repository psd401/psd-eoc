/**
 * CloudWatch alarms, dashboards, and alarm routing for PSD EOC.
 *
 * There are two entry points, because the alarms here do not all have something
 * publishing their metrics yet.
 *
 * `configureInfrastructureMonitoring` is what the live stack calls. It deploys
 * the alarms whose metrics AWS publishes on its own — App Runner, Aurora, and
 * every notification queue and dead-letter queue — and needs no credential
 * beyond the stack's own.
 *
 * `configureMonitoring` additionally deploys the one-minute canary and the
 * metrics collector, and the alarms that read what they publish. It is not
 * called yet: the canary needs a narrowly scoped agent credential that has
 * never been issued, and the collector needs the `psd_eoc_monitoring` database
 * login that `monitoringParameters` still describes as BLOCKED.
 *
 * The split matters because several application-tier alarms treat missing data
 * as breaching. Deployed without a publisher they would page the operations
 * team every minute forever, which is worse than having no alarm.
 */
import { fileURLToPath } from 'node:url';

import {
  ArnFormat,
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_events as events,
  aws_events_targets as eventTargets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_sns_subscriptions as subscriptions,
} from 'aws-cdk-lib';
import type {
  CfnCondition,
  aws_apprunner as apprunner,
  aws_kms as kms,
  aws_rds as rds,
  aws_sns as sns,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { RegionInfo } from 'aws-cdk-lib/region-info';

import { APP_RUNNER_HEALTH_CHECK_PATH, NOTIFICATION_CHANNELS } from './config';
export const MONITORING_METRIC_NAMESPACE = 'PSD/EOC';
export const MONITORING_DASHBOARD_NAME = 'psd-eoc-operations';

const ONE_MINUTE = Duration.minutes(1);
/** Every log group this module creates lives under one prefix. */
const MONITORING_LOG_GROUP_PREFIX = '/psd-eoc/monitoring/';

interface QueueWithDeadLetterQueue {
  readonly deadLetterQueue: sqs.IQueue;
  readonly queue: sqs.IQueue;
}

export interface MonitoringProps {
  readonly appRunnerService: apprunner.CfnService;
  readonly criticalAlarmTopic: sns.ITopic;
  readonly database: rds.DatabaseCluster;
  readonly displayTimeZone: string;
  readonly delivery: QueueWithDeadLetterQueue;
  readonly channelQueues: Readonly<
    Record<(typeof NOTIFICATION_CHANNELS)[number], QueueWithDeadLetterQueue>
  >;
  readonly operationsAlarmTopic: sns.ITopic;
  readonly operationsKey: kms.IKey;
  readonly monitoringRunbookBaseUrl: string;
  readonly sesIdentityDomain: string;
  /** The condition guarding App Runner, applied to anything that reads it. */
  readonly applicationCondition?: CfnCondition;
}

export interface MonitoringRuntimeParameters {
  readonly canaryEventTypeVersionId: string;
  readonly canaryFacilityId: string;
}

export interface FailureDrillMonitoringProps {
  readonly applicationCondition: CfnCondition;
  readonly appRunnerService: apprunner.CfnService;
  readonly database: rds.DatabaseCluster;
  readonly deadLetterQueues: readonly sqs.IQueue[];
  readonly namePrefix: string;
}

type AlarmTier = 'infrastructure' | 'application';

interface AlarmDefinition {
  /** Which publisher this alarm's metric depends on. */
  readonly tier: AlarmTier;
  /** True when the metric is dimensioned on the conditional App Runner service. */
  readonly dependsOnApplication?: boolean;
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly runbookAnchor: string;
  readonly metric: cloudwatch.IMetric;
  readonly threshold: number;
  readonly comparisonOperator?: cloudwatch.ComparisonOperator;
  readonly datapointsToAlarm?: number;
  readonly evaluationPeriods: number;
  readonly treatMissingData: cloudwatch.TreatMissingData;
  readonly topic: sns.ITopic;
}

interface MonitoringMetrics {
  readonly activationAcceptLatency: ExactPercentileMetrics;
  readonly acuUtilization: cloudwatch.Metric;
  readonly appRunner5xx: cloudwatch.Metric;
  readonly appRunnerLatency: cloudwatch.Metric;
  readonly auroraFailover: cloudwatch.Metric;
  readonly failoverBridgeErrors: cloudwatch.IMetric;
  readonly canaryLatency: cloudwatch.Metric;
  readonly canarySuccess: cloudwatch.Metric;
  readonly collectorSuccess: cloudwatch.Metric;
  readonly monthlyDeliveryTestDue: cloudwatch.Metric;
  readonly monthlyDeliveryTestFailedRuns: cloudwatch.Metric;
  readonly monthlyDeliveryTestMissed: cloudwatch.Metric;
  readonly replicaLag: cloudwatch.Metric;
  readonly rosterFailureAge: cloudwatch.Metric;
  readonly rosterSuccessAge: cloudwatch.Metric;
  readonly stuckOutbox: cloudwatch.Metric;
}

interface ExactPercentileMetrics {
  readonly p50: cloudwatch.Metric;
  readonly p95: cloudwatch.Metric;
  readonly p99: cloudwatch.Metric;
}

function alarmDescription(
  summary: string,
  runbookAnchor: string,
  runbookBaseUrl: string,
): string {
  return `${summary} Runbook: ${runbookBaseUrl}#${runbookAnchor}`;
}

function createAlarm(
  scope: Construct,
  definition: AlarmDefinition,
  runbookBaseUrl: string,
  applicationCondition?: CfnCondition,
): void {
  const alarm = new cloudwatch.Alarm(scope, definition.id, {
    alarmDescription: alarmDescription(
      definition.summary,
      definition.runbookAnchor,
      runbookBaseUrl,
    ),
    alarmName: definition.name,
    comparisonOperator:
      definition.comparisonOperator ??
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    ...(definition.datapointsToAlarm === undefined
      ? {}
      : { datapointsToAlarm: definition.datapointsToAlarm }),
    evaluationPeriods: definition.evaluationPeriods,
    metric: definition.metric,
    threshold: definition.threshold,
    treatMissingData: definition.treatMissingData,
  });
  const action = new cloudwatchActions.SnsAction(definition.topic);
  alarm.addAlarmAction(action);
  alarm.addOkAction(action);
  // An alarm dimensioned on the App Runner service cannot outlive it: the
  // service is created under a provisioning condition, so an unconditional
  // alarm would reference a resource CloudFormation may not have made.
  if (definition.dependsOnApplication === true && applicationCondition) {
    (alarm.node.defaultChild as cloudwatch.CfnAlarm).cfnOptions.condition =
      applicationCondition;
  }
}

function customMetric(
  metricName: string,
  options: Readonly<{
    dimensionsMap?: Record<string, string>;
    statistic?: string;
    unit?: cloudwatch.Unit;
  }> = {},
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    ...(options.dimensionsMap === undefined
      ? {}
      : { dimensionsMap: options.dimensionsMap }),
    metricName,
    namespace: MONITORING_METRIC_NAMESPACE,
    period: ONE_MINUTE,
    statistic: options.statistic ?? 'Average',
    unit: options.unit ?? cloudwatch.Unit.COUNT,
  });
}

function appRunnerMetric(
  service: apprunner.CfnService,
  metricName: string,
  statistic: string,
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    dimensionsMap: {
      ServiceID: service.attrServiceId,
      ServiceName: 'psd-eoc',
    },
    metricName,
    namespace: 'AWS/AppRunner',
    period: ONE_MINUTE,
    statistic,
  });
}

function databaseMetric(
  database: rds.IDatabaseCluster,
  metricName: string,
  statistic: string,
  unit: cloudwatch.Unit,
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    dimensionsMap: {
      DBClusterIdentifier: database.clusterIdentifier,
    },
    metricName,
    namespace: 'AWS/RDS',
    period: ONE_MINUTE,
    statistic,
    unit,
  });
}

function exactPercentiles(
  metrics: ExactPercentileMetrics,
  labelPrefix: string,
): cloudwatch.IMetric[] {
  return [
    metrics.p50.with({ label: `${labelPrefix} p50` }),
    metrics.p95.with({ label: `${labelPrefix} p95` }),
    metrics.p99.with({ label: `${labelPrefix} p99` }),
  ];
}

function exactPercentileMetrics(
  metricPrefix: string,
  dimensionsMap?: Record<string, string>,
): ExactPercentileMetrics {
  const metric = (percentile: 'P50' | 'P95' | 'P99') =>
    customMetric(`${metricPrefix}${percentile}Ms`, {
      ...(dimensionsMap === undefined ? {} : { dimensionsMap }),
      statistic: 'Maximum',
      unit: cloudwatch.Unit.MILLISECONDS,
    });
  return {
    p50: metric('P50'),
    p95: metric('P95'),
    p99: metric('P99'),
  };
}

function configureAlarmRecipients(
  scope: Construct,
  topics: readonly sns.ITopic[],
  sesIdentityDomain: string,
): void {
  const email = new CfnParameter(scope, 'OperationsTeamAlarmEmail', {
    allowedPattern:
      "^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$",
    constraintDescription:
      'Provide the approved district operations-team mailbox; never commit it to the repository.',
    description:
      'Approved district operations-team mailbox for PSD EOC CloudWatch alarms.',
    noEcho: true,
    type: 'String',
  });
  const sms = new CfnParameter(scope, 'OperationsTeamAlarmSmsNumber', {
    allowedPattern: '^\\+[1-9][0-9]{7,14}$',
    constraintDescription:
      'Provide the approved operations-team E.164 number; never commit it to the repository.',
    description:
      'Approved district operations-team E.164 number for PSD EOC CloudWatch alarms.',
    noEcho: true,
    type: 'String',
  });

  // Email goes through a Lambda that sends with SES, not through an SNS email
  // subscription. See `infra/lambda/alarm-mailer` for why. SMS stays a direct
  // subscription: it auto-confirms and carries no unsubscribe link.
  const mailer = new lambda.Function(scope, 'AlarmMailer', {
    code: lambda.Code.fromAsset(
      fileURLToPath(new URL('../lambda/alarm-mailer', import.meta.url)),
    ),
    description:
      'Sends CloudWatch alarm notifications to the operations team with SES.',
    environment: {
      ALARM_FROM_ADDRESS: `eoc-alarms@${sesIdentityDomain}`,
      ALARM_TO_ADDRESSES: email.valueAsString,
    },
    functionName: 'psd-eoc-alarm-mailer',
    handler: 'index.handler',
    logGroup: new logs.LogGroup(scope, 'AlarmMailerLogGroup', {
      logGroupName: '/psd-eoc/monitoring/alarm-mailer',
      removalPolicy: RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.TWO_WEEKS,
    }),
    memorySize: 256,
    reservedConcurrentExecutions: 5,
    runtime: lambda.Runtime.NODEJS_22_X,
    timeout: Duration.seconds(20),
  });
  // Only from the one address, and only through SES. It has no roster, no
  // database, and no part in the staff notification path.
  mailer.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      conditions: {
        StringEquals: {
          'ses:FromAddress': `eoc-alarms@${sesIdentityDomain}`,
        },
      },
      // Both the identity and a configuration set, because the district's
      // `psd401.net` identity has a default configuration set attached that SES
      // applies to every send through it. Without the second resource the send
      // is refused with AccessDenied naming a configuration set this stack does
      // not own and did not ask for.
      //
      // The configuration set is wildcarded rather than named: it belongs to
      // another team, and this breaking because they renamed theirs would be a
      // silent loss of alarm mail. Nothing is given away by it — the condition
      // above still allows exactly one From address, so this role can send as
      // the alarm sender and as nothing else.
      resources: [
        Stack.of(scope).formatArn({
          resource: 'identity',
          resourceName: sesIdentityDomain,
          service: 'ses',
        }),
        Stack.of(scope).formatArn({
          resource: 'configuration-set',
          resourceName: '*',
          service: 'ses',
        }),
      ],
      sid: 'SendOperationalAlarmMailOnly',
    }),
  );

  for (const topic of topics) {
    topic.addSubscription(new subscriptions.LambdaSubscription(mailer));
    topic.addSubscription(new subscriptions.SmsSubscription(sms.valueAsString));
  }
}

function allowScopedCloudWatchAlarmPublish(
  scope: Construct,
  topics: readonly sns.ITopic[],
): void {
  const stack = Stack.of(scope);
  const cloudWatch = new iam.ServicePrincipal('cloudwatch.amazonaws.com');
  const alarmArn = stack.formatArn({
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    resource: 'alarm',
    resourceName: '*',
    service: 'cloudwatch',
  });
  const conditions = {
    ArnLike: { 'aws:SourceArn': alarmArn },
    StringEquals: { 'aws:SourceAccount': stack.account },
  };
  // No key grant for the topics: they are not encrypted. See the note where
  // they are created. The operations key still encrypts the monitoring log
  // groups, which is granted separately.
  for (const topic of topics) {
    // Restore the owner statement SNS creates by default.
    //
    // A topic with no explicit policy carries an implicit default granting the
    // owning account the ordinary SNS actions, including Subscribe and Receive.
    // Adding any statement replaces that default wholesale, so a topic that had
    // only the CloudWatch grant below authorised publishing and nothing else —
    // and an endpoint that may not receive never gets its subscription
    // confirmation. The subscription is created, sits in PendingConfirmation
    // forever, and no error is reported anywhere.
    //
    // `Principal: *` is what the real default uses; the SourceOwner condition
    // is what confines it to this account.
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: [
          'SNS:AddPermission',
          'SNS:DeleteTopic',
          'SNS:GetTopicAttributes',
          'SNS:ListSubscriptionsByTopic',
          'SNS:Publish',
          'SNS:Receive',
          'SNS:RemovePermission',
          'SNS:SetTopicAttributes',
          'SNS:Subscribe',
        ],
        conditions: {
          StringEquals: { 'AWS:SourceOwner': stack.account },
        },
        principals: [new iam.AnyPrincipal()],
        resources: [topic.topicArn],
        sid: '__default_statement_ID',
      }),
    );
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        conditions,
        principals: [cloudWatch],
        resources: [topic.topicArn],
        sid: 'AllowScopedCloudWatchAlarmPublish',
      }),
    );
  }
}

/**
 * Lets CloudWatch Logs encrypt the monitoring log groups with the operations
 * key.
 *
 * `allowScopedCloudWatchAlarmPublish` grants `cloudwatch.amazonaws.com`, which
 * is the alarm service. Logs is a different, regional principal, and without
 * this the log group is refused at creation with "The specified KMS key does
 * not exist or is not allowed to be used with Arn ...", which reads like a
 * missing key rather than a missing grant.
 *
 * Scoped by encryption context to this account's monitoring log groups, so the
 * key cannot be used to read an unrelated log group.
 */
function allowMonitoringLogEncryption(
  scope: Construct,
  operationsKey: kms.IKey,
): void {
  const stack = Stack.of(scope);
  operationsKey.addToResourcePolicy(
    new iam.PolicyStatement({
      actions: [
        'kms:Decrypt',
        'kms:Describe*',
        'kms:Encrypt*',
        'kms:GenerateDataKey*',
        'kms:ReEncrypt*',
      ],
      conditions: {
        ArnLike: {
          'kms:EncryptionContext:aws:logs:arn': stack.formatArn({
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            resource: 'log-group',
            resourceName: `${MONITORING_LOG_GROUP_PREFIX}*`,
            service: 'logs',
          }),
        },
      },
      principals: [
        new iam.ServicePrincipal(`logs.${stack.region}.amazonaws.com`),
      ],
      resources: ['*'],
      sid: 'AllowMonitoringLogGroupEncryption',
    }),
  );
}

function monitoringParameters(scope: Construct): Readonly<{
  credentialSecretArn: string;
  eventTypeVersionId: string;
  facilityId: string;
  metricsDatabaseSecret: secretsmanager.Secret;
}> {
  const stack = Stack.of(scope);
  const partition = RegionInfo.get(stack.region).partition;
  if (partition === undefined) {
    throw new Error(
      `Monitoring requires an AWS region with a known ARN partition; received ${stack.region}.`,
    );
  }
  const credentialSecretArn = new CfnParameter(
    scope,
    'MonitoringCanaryCredentialSecretArn',
    {
      allowedPattern: `^arn:${partition}:secretsmanager:${stack.region}:${stack.account}:secret:[A-Za-z0-9/_+=.@-]+$`,
      constraintDescription:
        'Use the ARN of the separately issued, narrowly scoped rollback-canary agent credential encrypted with the AWS managed aws/secretsmanager key.',
      description:
        'Existing Secrets Manager secret containing only the rollback-canary agent bearer credential. It MUST use the AWS managed aws/secretsmanager key; this role receives no KMS decrypt grant.',
      noEcho: true,
      type: 'String',
    },
  );
  const facilityId = new CfnParameter(scope, 'MonitoringCanaryFacilityId', {
    allowedPattern:
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    constraintDescription:
      'Use the reviewed synthetic TEST facility UUID only.',
    description:
      'Reviewed synthetic-only facility UUID used by the rollback canary.',
    type: 'String',
  });
  const eventTypeVersionId = new CfnParameter(
    scope,
    'MonitoringCanaryEventTypeVersionId',
    {
      allowedPattern:
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      constraintDescription:
        'Use a reviewed synthetic TEST event-type-version UUID whose template mode is drill.',
      description:
        'Reviewed drill-template event-type-version UUID used by the rollback canary.',
      type: 'String',
    },
  );
  const metricsDatabaseSecret = new secretsmanager.Secret(
    scope,
    'MonitoringDatabaseSecret',
    {
      description:
        'BLOCKED until this NOINHERIT LOGIN receives only exact monitoring-table SELECT and required function EXECUTE.',
      generateSecretString: {
        excludePunctuation: true,
        generateStringKey: 'password',
        passwordLength: 64,
        secretStringTemplate: JSON.stringify({
          username: 'psd_eoc_monitoring',
        }),
      },
      removalPolicy: RemovalPolicy.RETAIN,
      secretName: '/psd-eoc/database/monitoring',
    },
  );
  return {
    credentialSecretArn: credentialSecretArn.valueAsString,
    eventTypeVersionId: eventTypeVersionId.valueAsString,
    facilityId: facilityId.valueAsString,
    metricsDatabaseSecret,
  };
}

function monitoringLogGroup(
  scope: Construct,
  id: string,
  name: string,
  operationsKey: kms.IKey,
): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    encryptionKey: operationsKey,
    logGroupName: name,
    removalPolicy: RemovalPolicy.RETAIN,
    retention: logs.RetentionDays.INFINITE,
  });
}

function createCanaryFunction(
  scope: Construct,
  props: MonitoringProps,
  credentialSecretArn: string,
): lambda.Function {
  const logGroup = monitoringLogGroup(
    scope,
    'CanaryLogGroup',
    '/psd-eoc/monitoring/canary',
    props.operationsKey,
  );
  const role = new iam.Role(scope, 'CanaryFunctionRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description:
      'Calls only the rollback-only canonical TEST canary and emits its sanitized health metrics.',
  });
  logGroup.grantWrite(role);
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [credentialSecretArn],
      sid: 'ReadOnlyRollbackCanaryCredential',
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': MONITORING_METRIC_NAMESPACE,
        },
      },
      resources: ['*'],
      sid: 'PublishOnlyPsdEocMonitoringMetrics',
    }),
  );

  return new lambda.Function(scope, 'CanaryFunction', {
    architecture: lambda.Architecture.ARM_64,
    code: lambda.Code.fromAsset(
      fileURLToPath(new URL('../lambda/canary', import.meta.url)),
      {
        exclude: ['package.json'],
      },
    ),
    description:
      'One-minute canonical TEST/drill/synthetic rollback canary; never persists or sends.',
    environment: {
      CANARY_CREDENTIAL_SECRET_ARN: credentialSecretArn,
      CANARY_URL: `https://${props.appRunnerService.attrServiceUrl}${APP_RUNNER_HEALTH_CHECK_PATH}`,
      METRIC_NAMESPACE: MONITORING_METRIC_NAMESPACE,
      PROVIDER_SENDS: 'disabled',
    },
    functionName: 'psd-eoc-one-minute-canary',
    handler: 'index.handler',
    logGroup,
    memorySize: 256,
    reservedConcurrentExecutions: 1,
    role,
    runtime: lambda.Runtime.NODEJS_22_X,
    timeout: Duration.seconds(30),
  });
}

function createMetricsCollectorFunction(
  scope: Construct,
  props: MonitoringProps,
  parameters: ReturnType<typeof monitoringParameters>,
): lambda.Function {
  const logGroup = monitoringLogGroup(
    scope,
    'MetricsCollectorLogGroup',
    '/psd-eoc/monitoring/collector',
    props.operationsKey,
  );
  const role = new iam.Role(scope, 'MetricsCollectorFunctionRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description:
      'SELECT-only production metric collector using a forced read-only transaction that is always rolled back.',
  });
  logGroup.grantWrite(role);
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [parameters.metricsDatabaseSecret.secretArn],
      sid: 'ReadOnlyDedicatedMonitoringDatabaseCredential',
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: [
        'rds-data:BeginTransaction',
        'rds-data:ExecuteStatement',
        'rds-data:RollbackTransaction',
      ],
      resources: [
        props.database.clusterArn,
        parameters.metricsDatabaseSecret.secretArn,
      ],
      sid: 'ReadOnlyRollbackOperationalMetrics',
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': MONITORING_METRIC_NAMESPACE,
        },
      },
      resources: ['*'],
      sid: 'PublishOnlyPsdEocOperationalMetrics',
    }),
  );
  return new lambda.Function(scope, 'MetricsCollectorFunction', {
    architecture: lambda.Architecture.ARM_64,
    code: lambda.Code.fromAsset(
      fileURLToPath(new URL('../lambda/metrics-collector', import.meta.url)),
      { exclude: ['package.json'] },
    ),
    description:
      'One-minute SELECT-only staff production metrics collector; excludes TEST and never commits.',
    environment: {
      DATABASE_ARN: props.database.clusterArn,
      DATABASE_NAME: 'psd_eoc',
      DATABASE_SECRET_ARN: parameters.metricsDatabaseSecret.secretArn,
      DISPLAY_TIME_ZONE: props.displayTimeZone,
      METRIC_NAMESPACE: MONITORING_METRIC_NAMESPACE,
      TRANSACTION_MODE: 'read-only-always-rollback',
    },
    functionName: 'psd-eoc-operational-metrics-collector',
    handler: 'index.handler',
    logGroup,
    memorySize: 256,
    reservedConcurrentExecutions: 1,
    role,
    runtime: lambda.Runtime.NODEJS_22_X,
    timeout: Duration.seconds(30),
  });
}

function createFailoverMetricFunction(
  scope: Construct,
  props: MonitoringProps,
): lambda.Function {
  const logGroup = monitoringLogGroup(
    scope,
    'FailoverMetricLogGroup',
    '/psd-eoc/monitoring/failover',
    props.operationsKey,
  );
  const role = new iam.Role(scope, 'FailoverMetricFunctionRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description:
      'Converts a matched Aurora failover event to one metric; no database or recovery authority.',
  });
  logGroup.grantWrite(role);
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': MONITORING_METRIC_NAMESPACE,
        },
      },
      resources: ['*'],
      sid: 'PublishOnlyAuroraFailoverMetric',
    }),
  );
  return new lambda.Function(scope, 'FailoverMetricFunction', {
    architecture: lambda.Architecture.ARM_64,
    code: lambda.Code.fromAsset(
      fileURLToPath(new URL('../lambda/failover-metric', import.meta.url)),
      { exclude: ['package.json'] },
    ),
    description:
      'Emits one sanitized Aurora failover metric from an exact EventBridge match.',
    environment: {
      DATABASE_ARN: props.database.clusterArn,
      METRIC_NAMESPACE: MONITORING_METRIC_NAMESPACE,
    },
    functionName: 'psd-eoc-aurora-failover-metric',
    handler: 'index.handler',
    logGroup,
    memorySize: 128,
    reservedConcurrentExecutions: 1,
    role,
    runtime: lambda.Runtime.NODEJS_22_X,
    timeout: Duration.seconds(10),
  });
}

function configureDashboard(
  scope: Construct,
  props: MonitoringProps,
  metrics: MonitoringMetrics,
): cloudwatch.Dashboard {
  const dashboard = new cloudwatch.Dashboard(scope, 'OperationsDashboard', {
    dashboardName: MONITORING_DASHBOARD_NAME,
    periodOverride: cloudwatch.PeriodOverride.INHERIT,
    start: '-PT6H',
  });
  const queues = [
    ['delivery', props.delivery],
    ...NOTIFICATION_CHANNELS.map(
      (channel) => [channel, props.channelQueues[channel]] as const,
    ),
  ] as const;

  dashboard.addWidgets(
    new cloudwatch.TextWidget({
      height: 4,
      markdown: [
        '# PSD EOC operational truth',
        '',
        'The one-minute canary executes canonical activation preview, start, lifecycle preview, all-clear, and close only as TEST / drill / synthetic / mocked inside a server-controlled outer transaction that is always rolled back. It has no database, queue, or provider-send permission.',
        '',
        `Production activation acceptance is measured from human confirmation consumption to the immutable activation transaction commit time. Production latency and delivery metrics require staff population and exclude TEST. Provider acceptance remains distinct from delivery and human receipt. [Monitoring runbooks](${props.monitoringRunbookBaseUrl}#alarm-response-runbooks).`,
      ].join('\n'),
      width: 24,
    }) as unknown as cloudwatch.IWidget,
  );
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({
      height: 8,
      left: exactPercentiles(
        metrics.activationAcceptLatency,
        'Activation accepted',
      ),
      leftYAxis: { label: 'Milliseconds', showUnits: false },
      right: [
        customMetric('ActivationAcceptSampleCount', {
          statistic: 'Maximum',
        }).with({ label: 'closed-minute cohort size' }),
      ],
      rightYAxis: { label: 'Samples', min: 0, showUnits: false },
      title:
        'Activation accepted — exact closed-minute p50 / p95 / p99 (1-minute period only; TEST excluded)',
      width: 12,
    }) as unknown as cloudwatch.IWidget,
    new cloudwatch.GraphWidget({
      height: 8,
      left: [
        metrics.appRunnerLatency.with({ label: 'All-route average' }),
        metrics.canaryLatency.with({ label: 'Rollback TEST lifecycle' }),
      ],
      leftYAxis: { label: 'Milliseconds', showUnits: false },
      right: [
        metrics.appRunner5xx,
        metrics.canarySuccess,
        metrics.collectorSuccess,
      ],
      rightYAxis: { label: 'Count / success', min: 0, showUnits: false },
      title:
        'Service, rollback-canary, and collector health (not activation SLO data)',
      width: 12,
    }) as unknown as cloudwatch.IWidget,
  );
  dashboard.addWidgets(
    ...NOTIFICATION_CHANNELS.map(
      (channel) =>
        new cloudwatch.GraphWidget({
          height: 7,
          left: exactPercentiles(
            exactPercentileMetrics('OutboxToProviderLatency', {
              Channel: channel,
            }),
            channel,
          ),
          leftYAxis: { label: 'Milliseconds', showUnits: false },
          right: [
            customMetric('OutboxToProviderSampleCount', {
              dimensionsMap: { Channel: channel },
              statistic: 'Maximum',
            }).with({ label: 'closed-minute cohort size' }),
            customMetric('OutboxToProviderIncompleteCount', {
              dimensionsMap: { Channel: channel },
              statistic: 'Maximum',
            }).with({ label: 'not provider-accepted by cutoff' }),
          ],
          rightYAxis: { label: 'Endpoints', min: 0, showUnits: false },
          title: `${channel} completed outbox-to-provider — exact source-cohort p50 / p95 / p99 plus incomplete endpoints (TEST excluded)`,
          width: 8,
        }) as unknown as cloudwatch.IWidget,
    ),
  );
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({
      height: 8,
      left: [
        'attempted',
        'provider-accepted',
        'delivered',
        'failed',
        'expired',
        'unknown',
      ].map((state) =>
        customMetric('DeliveryStateCount', {
          dimensionsMap: { State: state },
          statistic: 'Maximum',
        }).with({ label: state }),
      ),
      right: [
        customMetric('DeliveryEvidenceGapCount', {
          statistic: 'Maximum',
        }).with({ label: 'attempts with no evidence' }),
      ],
      leftYAxis: { label: 'Latest-state count', min: 0, showUnits: false },
      rightYAxis: { label: 'Evidence gaps', min: 0, showUnits: false },
      setPeriodToTimeRange: false,
      title:
        'Latest delivery truth for prior-24h intent-created cohort (staff only; acceptance is not receipt)',
      view: cloudwatch.GraphWidgetView.BAR,
      width: 12,
    }) as unknown as cloudwatch.IWidget,
    new cloudwatch.GraphWidget({
      height: 8,
      left: queues.map(([name, pair]) =>
        pair.deadLetterQueue
          .metricApproximateNumberOfMessagesVisible({
            period: ONE_MINUTE,
            statistic: 'Maximum',
          })
          .with({ label: `${name} DLQ` }),
      ),
      leftYAxis: { label: 'Visible messages', min: 0, showUnits: false },
      title: 'All retained dead-letter queue depths',
      width: 12,
    }) as unknown as cloudwatch.IWidget,
  );
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({
      height: 7,
      left: queues.map(([name, pair]) =>
        pair.queue
          .metricApproximateAgeOfOldestMessage({
            period: ONE_MINUTE,
            statistic: 'Maximum',
          })
          .with({ label: `${name} oldest message` }),
      ),
      leftYAxis: { label: 'Seconds', min: 0, showUnits: false },
      title: 'All notification queue ages',
      width: 12,
    }) as unknown as cloudwatch.IWidget,
    new cloudwatch.GraphWidget({
      height: 7,
      left: [metrics.stuckOutbox],
      leftYAxis: { label: 'Rows', min: 0, showUnits: false },
      right: [metrics.rosterFailureAge, metrics.rosterSuccessAge],
      rightYAxis: { label: 'Seconds', min: 0, showUnits: false },
      title: 'Stuck staff outbox and staff roster-sync age (TEST excluded)',
      width: 12,
    }) as unknown as cloudwatch.IWidget,
  );
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({
      height: 7,
      left: [metrics.acuUtilization],
      leftYAxis: { label: 'Percent', max: 100, min: 0 },
      right: [metrics.replicaLag],
      rightYAxis: { label: 'Milliseconds', min: 0, showUnits: false },
      title: 'Aurora capacity and failover readiness',
      width: 12,
    }) as unknown as cloudwatch.IWidget,
    new cloudwatch.GraphWidget({
      height: 7,
      left: [metrics.auroraFailover],
      right: [metrics.failoverBridgeErrors],
      leftYAxis: { label: 'Failover events', min: 0, showUnits: false },
      rightYAxis: { label: 'Bridge errors', min: 0, showUnits: false },
      title: 'Aurora failover events and bridge health',
      width: 12,
    }) as unknown as cloudwatch.IWidget,
  );
  if (props.applicationCondition) {
    (
      dashboard.node.defaultChild as cloudwatch.CfnDashboard
    ).cfnOptions.condition = props.applicationCondition;
  }
  return dashboard;
}

function configureAlarms(
  scope: Construct,
  props: MonitoringProps,
  metrics: MonitoringMetrics,
  includeApplicationTier: boolean,
): void {
  // An alarm is only worth deploying once something publishes its metric. The
  // application tier reads metrics emitted by the canary and the metrics
  // collector, neither of which is deployed, and several of those alarms treat
  // missing data as breaching — deploying them would page the operations team
  // continuously and teach everyone to ignore the address. See
  // `configureInfrastructureMonitoring`.
  const emit = (definition: AlarmDefinition): void => {
    if (definition.tier === 'application' && !includeApplicationTier) {
      return;
    }
    createAlarm(
      scope,
      definition,
      props.monitoringRunbookBaseUrl,
      props.applicationCondition,
    );
  };
  const canaryHeartbeat = new cloudwatch.MathExpression({
    expression: 'FILL(canarySuccess, 0)',
    label: 'Canary success (missing minute = failure)',
    period: ONE_MINUTE,
    usingMetrics: { canarySuccess: metrics.canarySuccess },
  });
  emit({
    tier: 'infrastructure',
    evaluationPeriods: 1,
    dependsOnApplication: true,
    id: 'AppRunner5xxAlarm',
    metric: metrics.appRunner5xx,
    name: 'psd-eoc-apprunner-5xx',
    runbookAnchor: 'runbook-app-runner-errors-and-latency',
    summary: 'One or more App Runner 5xx responses occurred in one minute.',
    threshold: 1,
    topic: props.criticalAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  emit({
    tier: 'infrastructure',
    datapointsToAlarm: 3,
    evaluationPeriods: 5,
    dependsOnApplication: true,
    id: 'AppRunnerLatencyAlarm',
    metric: metrics.appRunnerLatency,
    name: 'psd-eoc-apprunner-request-latency-average',
    runbookAnchor: 'runbook-app-runner-errors-and-latency',
    summary: 'App Runner all-route average request latency exceeded 500 ms.',
    threshold: 500,
    topic: props.operationsAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  emit({
    tier: 'application',
    datapointsToAlarm: 3,
    evaluationPeriods: 5,
    id: 'ActivationAcceptLatencyAlarm',
    metric: metrics.activationAcceptLatency.p95,
    name: 'psd-eoc-activation-accept-latency-p95',
    runbookAnchor: 'runbook-activation-accept-latency',
    summary:
      'Staff incident/drill closed-minute activation confirm-to-commit p95 exceeded the adopted 500 ms target in three of five minutes.',
    threshold: 500,
    topic: props.criticalAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  emit({
    tier: 'infrastructure',
    evaluationPeriods: 1,
    id: 'AuroraFailoverBridgeErrorAlarm',
    metric: metrics.failoverBridgeErrors,
    name: 'psd-eoc-aurora-failover-bridge-errors',
    runbookAnchor: 'runbook-aurora-failover-readiness-and-capacity',
    summary:
      'The Aurora failover EventBridge target or failover metric Lambda failed.',
    threshold: 1,
    topic: props.criticalAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  emit({
    tier: 'infrastructure',
    datapointsToAlarm: 3,
    evaluationPeriods: 5,
    id: 'AuroraCapacityAlarm',
    metric: metrics.acuUtilization,
    name: 'psd-eoc-aurora-acu-utilization',
    runbookAnchor: 'runbook-aurora-failover-readiness-and-capacity',
    summary: 'Aurora ACU utilization remained at or above 80 percent.',
    threshold: 80,
    topic: props.operationsAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  });
  emit({
    tier: 'application',
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    datapointsToAlarm: 2,
    evaluationPeriods: 2,
    id: 'MetricsCollectorFailureAlarm',
    metric: metrics.collectorSuccess,
    name: 'psd-eoc-metrics-collector-failure',
    runbookAnchor: 'runbook-metrics-collector',
    summary:
      'The read-only operational metrics collector failed or stopped reporting after its required rollback.',
    threshold: 1,
    topic: props.criticalAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  });
  emit({
    tier: 'application',
    evaluationPeriods: 1,
    id: 'MonthlyDeliveryTestDueReminderAlarm',
    metric: metrics.monthlyDeliveryTestDue,
    name: 'psd-eoc-monthly-live-delivery-test-due',
    runbookAnchor: 'runbook-monthly-live-delivery-test',
    summary:
      'The targetless monthly reminder is due; automation did not start a test or invoke a provider.',
    threshold: 1,
    topic: props.operationsAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  emit({
    tier: 'application',
    evaluationPeriods: 1,
    id: 'MonthlyDeliveryTestFailedRunAlarm',
    metric: metrics.monthlyDeliveryTestFailedRuns,
    name: 'psd-eoc-monthly-live-delivery-test-failed',
    runbookAnchor: 'runbook-monthly-live-delivery-test',
    summary:
      'One or more append-only monthly live delivery-test reports recorded a failed terminal run in the closed minute.',
    threshold: 1,
    topic: props.criticalAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  emit({
    tier: 'application',
    evaluationPeriods: 1,
    id: 'MonthlyDeliveryTestMissedAlarm',
    metric: metrics.monthlyDeliveryTestMissed,
    name: 'psd-eoc-monthly-live-delivery-test-missed',
    runbookAnchor: 'runbook-monthly-live-delivery-test',
    summary: `The immediately preceding ${props.displayTimeZone} calendar month has no successful terminal live delivery-test report.`,
    threshold: 1,
    topic: props.criticalAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  emit({
    tier: 'application',
    datapointsToAlarm: 3,
    evaluationPeriods: 5,
    id: 'AuroraReplicaLagAlarm',
    metric: metrics.replicaLag,
    name: 'psd-eoc-aurora-replica-lag',
    runbookAnchor: 'runbook-aurora-failover-readiness-and-capacity',
    summary:
      'Aurora maximum replica lag remained at or above one second, degrading failover readiness.',
    threshold: 1_000,
    topic: props.criticalAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  });
  emit({
    tier: 'infrastructure',
    evaluationPeriods: 1,
    id: 'AuroraFailoverAlarm',
    metric: metrics.auroraFailover,
    name: 'psd-eoc-aurora-failover-event',
    runbookAnchor: 'runbook-aurora-failover-readiness-and-capacity',
    summary: 'Aurora emitted a cluster failover event.',
    threshold: 1,
    topic: props.criticalAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
  emit({
    tier: 'application',
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    datapointsToAlarm: 2,
    evaluationPeriods: 2,
    id: 'CanaryFailureAlarm',
    metric: canaryHeartbeat,
    name: 'psd-eoc-one-minute-canary-failure',
    runbookAnchor: 'runbook-shallow-canary',
    summary:
      'The one-minute canonical TEST/drill/synthetic rollback canary failed or stopped reporting.',
    threshold: 1,
    topic: props.criticalAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  });
  emit({
    tier: 'application',
    evaluationPeriods: 1,
    id: 'StuckOutboxAlarm',
    metric: metrics.stuckOutbox,
    name: 'psd-eoc-stuck-production-outbox',
    runbookAnchor: 'runbook-stuck-outbox',
    summary:
      'At least one staff outbox row was neither published nor terminally failed within one minute.',
    threshold: 1,
    topic: props.criticalAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  });
  emit({
    tier: 'application',
    evaluationPeriods: 1,
    id: 'RosterSyncFailureAgeAlarm',
    metric: metrics.rosterFailureAge,
    name: 'psd-eoc-roster-sync-failure-age',
    runbookAnchor: 'runbook-roster-sync-failure-age',
    summary:
      'The latest staff roster-sync result remained failed or partial-rejected for at least 15 minutes.',
    threshold: 900,
    topic: props.criticalAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  });
  emit({
    tier: 'application',
    evaluationPeriods: 1,
    id: 'RosterSyncSuccessAgeAlarm',
    metric: metrics.rosterSuccessAge,
    name: 'psd-eoc-roster-sync-success-age',
    runbookAnchor: 'runbook-roster-sync-failure-age',
    summary:
      'No complete staff roster sync has been retained within the last 25 hours.',
    threshold: 90_000,
    topic: props.criticalAlarmTopic,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  });

  const queues = [
    ['Delivery', 'delivery', props.delivery],
    ...NOTIFICATION_CHANNELS.map(
      (channel) =>
        [
          `${channel.charAt(0).toUpperCase()}${channel.slice(1)}`,
          channel,
          props.channelQueues[channel],
        ] as const,
    ),
  ] as const;
  for (const [idPrefix, name, pair] of queues) {
    emit({
      tier: 'infrastructure',
      evaluationPeriods: 1,
      id: `${idPrefix}QueueAgeAlarm`,
      metric: pair.queue.metricApproximateAgeOfOldestMessage({
        period: ONE_MINUTE,
        statistic: 'Maximum',
      }),
      name: `psd-eoc-${name}-queue-age`,
      runbookAnchor: 'runbook-queue-age-and-dead-letter-queues',
      summary: `The oldest ${name} queue message reached 60 seconds.`,
      threshold: 60,
      topic: props.criticalAlarmTopic,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    emit({
      tier: 'infrastructure',
      evaluationPeriods: 1,
      id: `${idPrefix}DeadLetterQueueDepthAlarm`,
      metric: pair.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: ONE_MINUTE,
        statistic: 'Maximum',
      }),
      name: `psd-eoc-${name}-dlq-depth`,
      runbookAnchor: 'runbook-queue-age-and-dead-letter-queues',
      summary: `The retained ${name} dead-letter queue contains one or more messages.`,
      threshold: 1,
      topic: props.criticalAlarmTopic,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
  for (const channel of NOTIFICATION_CHANNELS) {
    const threshold = channel === 'push' ? 5_000 : 15_000;
    emit({
      tier: 'application',
      evaluationPeriods: 1,
      id: `${channel.charAt(0).toUpperCase()}${channel.slice(1)}ProviderLatencyAlarm`,
      metric: exactPercentileMetrics('OutboxToProviderLatency', {
        Channel: channel,
      }).p95,
      name: `psd-eoc-${channel}-outbox-to-provider-p95`,
      runbookAnchor: 'runbook-outbox-to-provider-latency',
      summary: `${channel} outbox-to-provider p95 exceeded the adopted ${threshold / 1_000}-second SLO.`,
      threshold,
      topic: props.criticalAlarmTopic,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    emit({
      tier: 'application',
      evaluationPeriods: 1,
      id: `${channel.charAt(0).toUpperCase()}${channel.slice(1)}ProviderIncompleteAlarm`,
      metric: customMetric('OutboxToProviderIncompleteCount', {
        dimensionsMap: { Channel: channel },
        statistic: 'Maximum',
      }),
      name: `psd-eoc-${channel}-outbox-to-provider-incomplete`,
      runbookAnchor: 'runbook-outbox-to-provider-latency',
      summary: `${channel} activation endpoints did not reach provider acceptance by the deterministic one-minute cutoff.`,
      threshold: 1,
      topic: props.criticalAlarmTopic,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}

/**
 * Every metric the alarms and dashboard read.
 *
 * Building a metric creates no resource — it is a reference to a name and a
 * namespace. Which of these actually have a publisher depends on the tier the
 * caller deploys.
 */
function assembleMetrics(
  props: MonitoringProps,
  failoverBridgeErrors: cloudwatch.IMetric,
  monthlyDeliveryTestDue: events.Rule,
): MonitoringMetrics {
  return {
    activationAcceptLatency: exactPercentileMetrics('ActivationAcceptLatency'),
    acuUtilization: props.database.metricACUUtilization({
      period: ONE_MINUTE,
      statistic: 'Maximum',
    }),
    appRunner5xx: appRunnerMetric(
      props.appRunnerService,
      '5xxStatusResponses',
      'Sum',
    ),
    appRunnerLatency: appRunnerMetric(
      props.appRunnerService,
      'RequestLatency',
      'Average',
    ),
    auroraFailover: customMetric('AuroraFailoverEvent', { statistic: 'Sum' }),
    failoverBridgeErrors,
    canaryLatency: customMetric('CanaryLifecycleLatencyMs', {
      unit: cloudwatch.Unit.MILLISECONDS,
    }),
    canarySuccess: customMetric('CanarySuccess', { statistic: 'Minimum' }),
    collectorSuccess: customMetric('MetricsCollectorSuccess', {
      statistic: 'Minimum',
    }),
    monthlyDeliveryTestDue: new cloudwatch.Metric({
      dimensionsMap: { RuleName: monthlyDeliveryTestDue.ruleName },
      metricName: 'TriggeredRules',
      namespace: 'AWS/Events',
      period: ONE_MINUTE,
      statistic: 'Sum',
    }),
    monthlyDeliveryTestFailedRuns: customMetric(
      'MonthlyLiveDeliveryTestFailedRunCount',
      { statistic: 'Maximum' },
    ),
    monthlyDeliveryTestMissed: customMetric('MonthlyLiveDeliveryTestMissed', {
      statistic: 'Maximum',
    }),
    replicaLag: databaseMetric(
      props.database,
      'AuroraReplicaLagMaximum',
      'Maximum',
      cloudwatch.Unit.MILLISECONDS,
    ),
    rosterFailureAge: customMetric('RosterSyncFailureAgeSeconds', {
      statistic: 'Maximum',
      unit: cloudwatch.Unit.SECONDS,
    }),
    rosterSuccessAge: customMetric('RosterSyncSuccessAgeSeconds', {
      statistic: 'Maximum',
      unit: cloudwatch.Unit.SECONDS,
    }),
    stuckOutbox: customMetric('StuckOutboxCount', { statistic: 'Maximum' }),
  };
}

/**
 * The Aurora failover bridge: an EventBridge rule turning cluster failover
 * events into a metric, plus a metric covering the bridge's own failures.
 *
 * The bridge needs no credential and no database role, so it deploys in both
 * monitoring tiers.
 */
function createFailoverBridge(
  scope: Construct,
  props: MonitoringProps,
  failoverMetricFunction: lambda.Function,
): cloudwatch.IMetric {
  const failoverEvents = new events.Rule(scope, 'AuroraFailoverEvents', {
    description:
      'Turns Aurora cluster failover events into a metric; performs no recovery mutation.',
    eventPattern: {
      detail: { EventCategories: ['failover'] },
      detailType: ['RDS DB Cluster Event'],
      resources: [props.database.clusterArn],
      source: ['aws.rds'],
    },
    ruleName: 'psd-eoc-aurora-failover-events',
  });
  failoverEvents.addTarget(
    new eventTargets.LambdaFunction(failoverMetricFunction, {
      maxEventAge: Duration.minutes(5),
      retryAttempts: 2,
    }),
  );
  return new cloudwatch.MathExpression({
    expression:
      'FILL(eventbridge, 0) + FILL(lambdaErrors, 0) + FILL(lambdaThrottles, 0)',
    label: 'Failover bridge errors',
    period: ONE_MINUTE,
    usingMetrics: {
      eventbridge: new cloudwatch.Metric({
        dimensionsMap: { RuleName: failoverEvents.ruleName },
        metricName: 'FailedInvocations',
        namespace: 'AWS/Events',
        period: ONE_MINUTE,
        statistic: 'Sum',
      }),
      lambdaErrors: failoverMetricFunction.metricErrors({
        period: ONE_MINUTE,
        statistic: 'Sum',
      }),
      lambdaThrottles: failoverMetricFunction.metricThrottles({
        period: ONE_MINUTE,
        statistic: 'Sum',
      }),
    },
  });
}

/** Targetless monthly reminder; it invokes no app, queue, or provider. */
function createMonthlyDeliveryTestReminder(scope: Construct): events.Rule {
  return new events.Rule(scope, 'MonthlyDeliveryTestDueReminder', {
    description:
      'Targetless reminder only: a human may review the monthly live delivery test; this invokes no app, queue, or provider.',
    enabled: true,
    ruleName: 'psd-eoc-monthly-live-delivery-test-due-reminder',
    schedule: events.Schedule.expression('cron(0 17 1 * ? *)'),
  });
}

/** Publishes the dashboard's name and console URL under its own condition. */
function publishDashboardOutputs(
  scope: Construct,
  dashboard: cloudwatch.Dashboard,
  applicationCondition?: CfnCondition,
): void {
  const stack = Stack.of(scope);
  const name = new CfnOutput(scope, 'MonitoringDashboardName', {
    value: dashboard.dashboardName,
  });
  const url = new CfnOutput(scope, 'MonitoringDashboardUrl', {
    value: `https://${stack.region}.console.aws.amazon.com/cloudwatch/home?region=${stack.region}#dashboards:name=${dashboard.dashboardName}`,
  });
  if (applicationCondition) {
    name.condition = applicationCondition;
    url.condition = applicationCondition;
  }
}

/**
 * The monitoring the deployed stack can actually support today.
 *
 * This is `configureMonitoring` minus everything that depends on a publisher
 * that does not exist yet. It raises alarms on App Runner, Aurora, and every
 * notification queue and dead-letter queue — all native AWS metrics, needing no
 * credential, no Lambda beyond the failover bridge, and no database role.
 *
 * Left out, deliberately, and why:
 *
 * - the one-minute canary, which needs a narrowly scoped agent credential that
 *   has never been issued;
 * - the metrics collector, which needs the `psd_eoc_monitoring` database login
 *   that `monitoringParameters` still describes as BLOCKED, and everything
 *   downstream of it: stuck-outbox depth, roster sync ages, activation accept
 *   latency, and the monthly delivery test;
 * - Aurora replica lag, because the cluster runs a single writer with no
 *   reader, so `AuroraReplicaLagMaximum` never reports;
 * - per-channel outbox-to-provider latency, which the channel workers publish
 *   and no channel worker is deployed.
 *
 * Several of those treat missing data as breaching. Deploying them against a
 * metric nobody publishes would page the operations team every minute forever,
 * which is worse than no alarm: it trains people to ignore the address.
 */
export function configureInfrastructureMonitoring(
  scope: Construct,
  props: MonitoringProps,
): void {
  configureAlarmRecipients(
    scope,
    [props.operationsAlarmTopic, props.criticalAlarmTopic],
    props.sesIdentityDomain,
  );
  allowScopedCloudWatchAlarmPublish(scope, [
    props.operationsAlarmTopic,
    props.criticalAlarmTopic,
  ]);
  allowMonitoringLogEncryption(scope, props.operationsKey);
  const failoverBridgeErrors = createFailoverBridge(
    scope,
    props,
    createFailoverMetricFunction(scope, props),
  );
  const monthlyDeliveryTestDue = createMonthlyDeliveryTestReminder(scope);
  const metrics = assembleMetrics(
    props,
    failoverBridgeErrors,
    monthlyDeliveryTestDue,
  );
  configureAlarms(scope, props, metrics, false);
  const dashboard = configureDashboard(scope, props, metrics);
  publishDashboardOutputs(scope, dashboard, props.applicationCondition);
}

/**
 * Native-metric evidence for a one-run synthetic stack.
 *
 * These alarms intentionally have no actions: the drill records their state in
 * its evidence ledger, but it cannot notify a person or gain provider send
 * authority. Names and dimensions are derived only from the disposable stack.
 */
export function configureFailureDrillMonitoring(
  scope: Construct,
  props: FailureDrillMonitoringProps,
): void {
  const addAlarm = (
    id: string,
    suffix: string,
    metric: cloudwatch.IMetric,
    threshold = 1,
  ): void => {
    const alarm = new cloudwatch.Alarm(scope, id, {
      actionsEnabled: false,
      alarmDescription:
        'Synthetic failure-drill evidence only; no notification actions are attached.',
      alarmName: `${props.namePrefix}-${suffix}`,
      evaluationPeriods: 1,
      metric,
      threshold,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    (alarm.node.defaultChild as cloudwatch.CfnAlarm).cfnOptions.condition =
      props.applicationCondition;
  };

  addAlarm(
    'FailureDrillAppRunner5xxAlarm',
    'apprunner-5xx',
    new cloudwatch.Metric({
      dimensionsMap: {
        ServiceID: props.appRunnerService.attrServiceId,
        ServiceName: props.namePrefix,
      },
      metricName: '5xxStatusResponses',
      namespace: 'AWS/AppRunner',
      period: ONE_MINUTE,
      statistic: 'Sum',
    }),
  );
  addAlarm(
    'FailureDrillAuroraCapacityAlarm',
    'aurora-acu',
    databaseMetric(
      props.database,
      'ACUUtilization',
      'Maximum',
      cloudwatch.Unit.PERCENT,
    ),
    80,
  );
  for (const [index, queue] of props.deadLetterQueues.entries()) {
    addAlarm(
      `FailureDrillDeadLetterQueue${String(index + 1)}Alarm`,
      `dlq-${String(index + 1)}`,
      queue.metricApproximateNumberOfMessagesVisible({
        period: ONE_MINUTE,
        statistic: 'Maximum',
      }),
    );
  }
  const dashboard = new cloudwatch.Dashboard(scope, 'FailureDrillDashboard', {
    dashboardName: `${props.namePrefix}-recovery`,
    periodOverride: cloudwatch.PeriodOverride.INHERIT,
    start: '-PT1H',
  });
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({
      left: [
        new cloudwatch.Metric({
          dimensionsMap: {
            ServiceID: props.appRunnerService.attrServiceId,
            ServiceName: props.namePrefix,
          },
          metricName: '5xxStatusResponses',
          namespace: 'AWS/AppRunner',
          period: ONE_MINUTE,
          statistic: 'Sum',
        }),
      ],
      title: 'Synthetic App Runner 5xx recovery signal',
      width: 12,
    }) as unknown as cloudwatch.IWidget,
    new cloudwatch.GraphWidget({
      left: [
        databaseMetric(
          props.database,
          'ACUUtilization',
          'Maximum',
          cloudwatch.Unit.PERCENT,
        ),
      ],
      title: 'Synthetic Aurora capacity through failover',
      width: 12,
    }) as unknown as cloudwatch.IWidget,
  );
  dashboard.addWidgets(
    new cloudwatch.GraphWidget({
      left: props.deadLetterQueues.map((queue, index) =>
        queue
          .metricApproximateNumberOfMessagesVisible({
            period: ONE_MINUTE,
            statistic: 'Maximum',
          })
          .with({ label: `Synthetic DLQ ${String(index + 1)}` }),
      ),
      title: 'Synthetic dead-letter queue reconciliation',
      width: 24,
    }) as unknown as cloudwatch.IWidget,
  );
  (
    dashboard.node.defaultChild as cloudwatch.CfnDashboard
  ).cfnOptions.condition = props.applicationCondition;
}

/** Adds phase-5 monitoring without any notification-provider send authority. */
export function configureMonitoring(
  scope: Construct,
  props: MonitoringProps,
): MonitoringRuntimeParameters {
  const parameters = monitoringParameters(scope);
  configureAlarmRecipients(
    scope,
    [props.operationsAlarmTopic, props.criticalAlarmTopic],
    props.sesIdentityDomain,
  );
  allowScopedCloudWatchAlarmPublish(scope, [
    props.operationsAlarmTopic,
    props.criticalAlarmTopic,
  ]);
  allowMonitoringLogEncryption(scope, props.operationsKey);

  const canaryFunction = createCanaryFunction(
    scope,
    props,
    parameters.credentialSecretArn,
  );
  const metricsCollectorFunction = createMetricsCollectorFunction(
    scope,
    props,
    parameters,
  );
  const failoverMetricFunction = createFailoverMetricFunction(scope, props);
  const canarySchedule = new events.Rule(scope, 'MonitoringCanarySchedule', {
    description:
      'Runs canonical TEST/drill/synthetic lifecycle in a forced-rollback transaction every minute; never sends.',
    enabled: true,
    ruleName: 'psd-eoc-monitoring-canary-every-minute',
    schedule: events.Schedule.rate(ONE_MINUTE),
  });
  canarySchedule.addTarget(
    new eventTargets.LambdaFunction(canaryFunction, {
      maxEventAge: Duration.minutes(2),
      retryAttempts: 1,
    }),
  );
  const metricsSchedule = new events.Rule(scope, 'MetricsCollectorSchedule', {
    description:
      'Collects staff-only production metrics with static SELECTs in an always-rolled-back read-only transaction.',
    enabled: true,
    ruleName: 'psd-eoc-operational-metrics-every-minute',
    schedule: events.Schedule.rate(ONE_MINUTE),
  });
  metricsSchedule.addTarget(
    new eventTargets.LambdaFunction(metricsCollectorFunction, {
      maxEventAge: Duration.minutes(2),
      retryAttempts: 1,
    }),
  );
  const monthlyDeliveryTestDue = createMonthlyDeliveryTestReminder(scope);
  const failoverBridgeErrors = createFailoverBridge(
    scope,
    props,
    failoverMetricFunction,
  );

  const metrics = assembleMetrics(
    props,
    failoverBridgeErrors,
    monthlyDeliveryTestDue,
  );
  configureAlarms(scope, props, metrics, true);
  const dashboard = configureDashboard(scope, props, metrics);
  publishDashboardOutputs(scope, dashboard, props.applicationCondition);
  return {
    canaryEventTypeVersionId: parameters.eventTypeVersionId,
    canaryFacilityId: parameters.facilityId,
  };
}
