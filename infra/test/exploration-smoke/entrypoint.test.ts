import { describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXPLORATION_SMOKE_REPOSITORY_NAME } from '../../src/exploration-smoke/config';

interface ExplorationCdkConfiguration {
  readonly app: string;
  readonly context: Readonly<Record<string, unknown>>;
}

const workflowUrl = new URL(
  '../../../.github/workflows/deploy-exploration-smoke.yml',
  import.meta.url,
);
const ciWorkflowUrl = new URL(
  '../../../.github/workflows/ci.yml',
  import.meta.url,
);

async function readWorkflow(): Promise<string> {
  return Bun.file(workflowUrl).text();
}

async function readCiWorkflow(): Promise<string> {
  return Bun.file(ciWorkflowUrl).text();
}

function markedShellBlock(workflow: string, marker: string): string {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const block = workflow.match(
    new RegExp(
      ` {10}# BEGIN ${escapedMarker}\\n([\\s\\S]*?)\\n {10}# END ${escapedMarker}`,
      'u',
    ),
  )?.[1];
  if (block === undefined) {
    throw new Error(`Workflow shell block is missing: ${marker}`);
  }
  return block.replace(/^ {10}/gmu, '');
}

function directDarkResourceReadbackScript(workflow: string): string {
  return [
    markedShellBlock(workflow, 'direct dark-resource configuration readback'),
    markedShellBlock(workflow, 'direct external SES configuration readback'),
  ].join('\n');
}

async function runAccessSyncOuterRoleExecutionSimulation(options?: {
  readonly allowNeighborCluster?: boolean;
  readonly allowWrongService?: boolean;
  readonly denyRunTask?: boolean;
}): Promise<{
  readonly awsCalls: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'psd-eoc-access-dark-proof-'));
  try {
    const fakeBin = join(directory, 'bin');
    const readback = join(directory, 'artifacts', 'readback');
    const awsCalls = join(directory, 'aws-calls.txt');
    await Promise.all([
      mkdir(fakeBin, { recursive: true }),
      mkdir(readback, { recursive: true }),
    ]);
    const awsPath = join(fakeBin, 'aws');
    await Bun.write(
      awsPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1:$2" >> "$AWS_CALLS"
test "$1:$2" = "iam:simulate-principal-policy"
shift 2
action_name=
context_entries=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --action-names)
      action_name=$2
      shift 2
      ;;
    --context-entries)
      context_entries=$2
      shift 2
      ;;
    *) shift ;;
  esac
done
case "$action_name" in
  ecs:RunTask)
    if [[ "$DENY_RUN_TASK" == "true" ]]; then
      decision=implicitDeny
    elif [[ "$context_entries" == "ContextKeyName=ecs:cluster,ContextKeyValues=$EXACT_CLUSTER_ARN,ContextKeyType=string" ]]; then
      decision=allowed
    elif [[ "$ALLOW_NEIGHBOR_CLUSTER" == "true" ]]; then
      decision=allowed
    else
      decision=implicitDeny
    fi
    if [[ "$decision" == "allowed" ]]; then
      jq -n '{EvaluationResults: [{EvalDecision: "allowed"}]}'
    else
      jq -n '{EvaluationResults: [{EvalDecision: "implicitDeny"}]}'
    fi
    ;;
  iam:PassRole)
    if [[ "$context_entries" == "ContextKeyName=iam:PassedToService,ContextKeyValues=ecs-tasks.amazonaws.com,ContextKeyType=string" ]]; then
      decision=allowed
    elif [[ "$ALLOW_WRONG_SERVICE" == "true" ]]; then
      decision=allowed
    else
      decision=implicitDeny
    fi
    jq -n \
      --arg decision "$decision" \
      --arg execution "$ACCESS_EXECUTION_ROLE_ARN" \
      --arg task "$ACCESS_TASK_ROLE_ARN" '{
        EvaluationResults: [{
          EvalDecision: $decision,
          ResourceSpecificResults: [
            {EvalResourceDecision: $decision, EvalResourceName: $execution},
            {EvalResourceDecision: $decision, EvalResourceName: $task}
          ]
        }]
      }'
    ;;
  *) exit 97 ;;
esac
`,
    );
    await chmod(awsPath, 0o755);
    const accessExecutionRoleArn =
      'arn:aws:iam::338414773271:role/PsdEocExplorationSmoke-AccessSyncTaskExecutionRole-test';
    const accessTaskRoleArn =
      'arn:aws:iam::338414773271:role/PsdEocExplorationSmoke-AccessSyncTaskRole-test';
    const child = Bun.spawnSync({
      cmd: [
        'bash',
        '-c',
        `set -euo pipefail\n${markedShellBlock(
          await readWorkflow(),
          'access-sync outer-role exact execution simulation',
        )}`,
      ],
      cwd: directory,
      env: {
        ...process.env,
        ACCESS_EXECUTION_ROLE_ARN: accessExecutionRoleArn,
        ACCESS_TASK_ROLE_ARN: accessTaskRoleArn,
        ALLOW_NEIGHBOR_CLUSTER: String(options?.allowNeighborCluster ?? false),
        ALLOW_WRONG_SERVICE: String(options?.allowWrongService ?? false),
        AWS_ACCOUNT_ID: '338414773271',
        AWS_CALLS: awsCalls,
        AWS_REGION: 'us-west-2',
        DENY_RUN_TASK: String(options?.denyRunTask ?? false),
        DEPLOY_ROLE_ARN:
          'arn:aws:iam::338414773271:role/psd-eoc-exploration-smoke-github-deploy',
        EXACT_CLUSTER_ARN:
          'arn:aws:ecs:us-west-2:338414773271:cluster/psd-eoc-exploration-smoke-native-bootstrap',
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        access_execution_role_arn: accessExecutionRoleArn,
        access_task_definition_arn:
          'arn:aws:ecs:us-west-2:338414773271:task-definition/psd-eoc-exploration-smoke-access-sync:1',
        access_task_role_arn: accessTaskRoleArn,
        cluster_arn:
          'arn:aws:ecs:us-west-2:338414773271:cluster/psd-eoc-exploration-smoke-native-bootstrap',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    return {
      awsCalls: (await Bun.file(awsCalls).exists())
        ? (await Bun.file(awsCalls).text()).trim().split('\n')
        : [],
      exitCode: child.exitCode,
      stderr: child.stderr.toString(),
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function runDirectDarkResourceReadback(): Promise<{
  readonly awsCalls: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'psd-eoc-email-readback-'));
  try {
    const fakeBin = join(directory, 'bin');
    const readback = join(directory, 'artifacts', 'readback');
    const awsCalls = join(directory, 'aws-calls.txt');
    await Promise.all([
      mkdir(fakeBin, { recursive: true }),
      mkdir(readback, { recursive: true }),
    ]);
    const awsPath = join(fakeBin, 'aws');
    await Bun.write(
      awsPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$1:$2" >> "$AWS_CALLS"

arg_value() {
  local wanted=$1
  shift
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "$wanted" ]]; then
      printf '%s\\n' "$2"
      return 0
    fi
    shift
  done
  return 1
}

case "$1:$2" in
  logs:describe-log-groups)
    jq -n --arg name "$email_worker_log_group_name" '{
      logGroups: [{
        arn: "arn:aws:logs:us-west-2:338414773271:log-group:/psd-eoc/workers/email:*",
        logGroupName: $name,
        retentionInDays: 14
      }]
    }'
    ;;
  sqs:get-queue-attributes)
    queue_url=$(arg_value --queue-url "$@")
    if [[ "$queue_url" == "$email_queue_url" ]]; then
      jq -n --arg arn "$email_queue_arn" --arg dlq "$email_dlq_arn" '{
        Attributes: {
          QueueArn: $arn,
          SqsManagedSseEnabled: "true",
          MessageRetentionPeriod: "345600",
          VisibilityTimeout: "60",
          RedrivePolicy: ({deadLetterTargetArn: $dlq, maxReceiveCount: "5"} | tojson)
        }
      }'
    elif [[ "$queue_url" == "$email_dlq_url" ]]; then
      jq -n --arg arn "$email_dlq_arn" --arg source "$email_queue_arn" '{
        Attributes: {
          QueueArn: $arn,
          SqsManagedSseEnabled: "true",
          MessageRetentionPeriod: "1209600",
          RedriveAllowPolicy: ({redrivePermission: "byQueue", sourceQueueArns: [$source]} | tojson)
        }
      }'
    else
      exit 94
    fi
    ;;
  sesv2:get-configuration-set)
    printf '%s\\n' '{"ConfigurationSetName":"psd-eoc-transactional","SendingOptions":{"SendingEnabled":false}}'
    ;;
  sesv2:get-configuration-set-event-destinations)
    jq -n --arg topic "$ses_events_topic_arn" '{
      EventDestinations: [{
        Enabled: true,
        MatchingEventTypes: ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "RENDERING_FAILURE", "DELIVERY_DELAY"],
        Name: "psd-eoc-email-events",
        SnsDestination: {TopicArn: $topic}
      }]
    }'
    ;;
  *) exit 96 ;;
esac
`,
    );
    await chmod(awsPath, 0o755);
    const child = Bun.spawnSync({
      cmd: [
        'bash',
        '-c',
        directDarkResourceReadbackScript(await readWorkflow()),
      ],
      cwd: directory,
      env: {
        ...process.env,
        AWS_CALLS: awsCalls,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        email_dlq_arn: 'arn:aws:sqs:us-west-2:338414773271:psd-eoc-email-dlq',
        email_dlq_url:
          'https://sqs.us-west-2.amazonaws.com/338414773271/psd-eoc-email-dlq',
        email_queue_arn: 'arn:aws:sqs:us-west-2:338414773271:psd-eoc-email',
        email_queue_url:
          'https://sqs.us-west-2.amazonaws.com/338414773271/psd-eoc-email',
        email_worker_log_group_name: '/psd-eoc/workers/email',
        ses_configuration_set_name: 'psd-eoc-transactional',
        ses_event_destination_name: 'psd-eoc-email-events',
        ses_events_topic_arn:
          'arn:aws:sns:us-west-2:338414773271:psd-eoc-email-events',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    return {
      awsCalls: (await Bun.file(awsCalls).exists())
        ? (await Bun.file(awsCalls).text()).trim().split('\n')
        : [],
      exitCode: child.exitCode,
      stderr: child.stderr.toString(),
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

interface RecoveryResource {
  readonly LogicalResourceId: string;
  readonly PhysicalResourceId: string;
  readonly ResourceStatus: string;
  readonly ResourceType: string;
}

const retainedRecoveryResources: readonly RecoveryResource[] = [
  {
    LogicalResourceId: 'EmailWorkerLogGroup0611E5C2',
    PhysicalResourceId: '/psd-eoc/workers/email',
    ResourceStatus: 'DELETE_SKIPPED',
    ResourceType: 'AWS::Logs::LogGroup',
  },
  {
    LogicalResourceId: 'EmailDeadLetterQueue5E91C06C',
    PhysicalResourceId:
      'https://sqs.us-west-2.amazonaws.com/338414773271/psd-eoc-email-dlq',
    ResourceStatus: 'DELETE_SKIPPED',
    ResourceType: 'AWS::SQS::Queue',
  },
  {
    LogicalResourceId: 'EmailConfigurationSet',
    PhysicalResourceId: 'psd-eoc-transactional',
    ResourceStatus: 'DELETE_SKIPPED',
    ResourceType: 'AWS::SES::ConfigurationSet',
  },
  {
    LogicalResourceId: 'EmailEventsKey619540BF',
    PhysicalResourceId: '01234567-89ab-cdef-0123-456789abcdef',
    ResourceStatus: 'DELETE_SKIPPED',
    ResourceType: 'AWS::KMS::Key',
  },
  {
    LogicalResourceId: 'EmailQueue9C1DA90F',
    PhysicalResourceId:
      'https://sqs.us-west-2.amazonaws.com/338414773271/psd-eoc-email',
    ResourceStatus: 'DELETE_SKIPPED',
    ResourceType: 'AWS::SQS::Queue',
  },
  {
    LogicalResourceId: 'EmailEventsTopic13C4A145',
    PhysicalResourceId:
      'arn:aws:sns:us-west-2:338414773271:psd-eoc-email-events',
    ResourceStatus: 'DELETE_SKIPPED',
    ResourceType: 'AWS::SNS::Topic',
  },
];

const previouslyManagedRecoveryResources = retainedRecoveryResources
  .slice(0, 4)
  .map((resource) => ({
    ...resource,
    ResourceStatus: 'UPDATE_COMPLETE',
  }));

const newlyRetainedRecoveryResources = retainedRecoveryResources.slice(4);

function recoveryScript(workflow: string): string {
  const script = workflow.match(
    / {6}- name: Adopt exact retained dark email resources after a rolled-back transition[\s\S]*? {8}run: \|\n([\s\S]*?)\n {6}- name: Stage the exact native bootstrap without changing the live service/,
  )?.[1];
  if (script === undefined) {
    throw new Error('retained-resource recovery step is missing');
  }
  return script.replace(/^ {10}/gm, '');
}

async function runRecoveryScenario(options: {
  readonly before: readonly RecoveryResource[];
  readonly currentTemplateManagesEventDestination?: boolean;
  readonly externalDestinationTopicArn?: string;
  readonly externalSendingEnabled?: boolean;
  readonly events: readonly RecoveryResource[];
  readonly preexistingImportObject?: boolean;
  readonly stackInventoryManagesEventDestination?: boolean;
  readonly stackStatus: string;
}): Promise<{
  readonly awsCalls: readonly string[];
  readonly changeSet: unknown;
  readonly changeSetRequest: unknown;
  readonly defaultGetTemplateExitCode: number;
  readonly exitCode: number;
  readonly importCredential: string | undefined;
  readonly importObject: unknown;
  readonly importResources: unknown;
  readonly mapping: unknown;
  readonly publicationResult: unknown;
  readonly publishedBucket: string | undefined;
  readonly publishedKey: string | undefined;
  readonly publishedTemplate: unknown;
  readonly result: unknown;
  readonly stderr: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'psd-eoc-email-recovery-'));
  try {
    const fakeBin = join(directory, 'bin');
    const infra = join(directory, 'infra');
    const readback = join(directory, 'artifacts', 'readback');
    const cdkOut = join(directory, 'artifacts', 'cdk.out');
    await Promise.all([
      mkdir(fakeBin, { recursive: true }),
      mkdir(infra, { recursive: true }),
      mkdir(readback, { recursive: true }),
      mkdir(cdkOut, { recursive: true }),
    ]);

    const beforeFile = join(directory, 'before.json');
    const managedFile = join(directory, 'managed.json');
    const eventsFile = join(directory, 'events.json');
    const stackFile = join(directory, 'stack.json');
    const currentTemplateFile = join(directory, 'current-template.json');
    const changeSetFixture = join(directory, 'change-set.json');
    const capturedChangeSetRequest = join(
      directory,
      'captured-change-set-request.json',
    );
    const awsCalls = join(directory, 'aws-calls.txt');
    const importMarker = join(directory, 'imported');
    const importCredential = join(directory, 'import-credential.txt');
    const capturedImportResources = join(
      directory,
      'captured-import-resources.json',
    );
    const publishedBucket = join(directory, 'published-bucket.txt');
    const publishedKey = join(directory, 'published-key.txt');
    const publishedTemplate = join(directory, 'published-template.json');
    const legacyAppRunnerTags = [
      { Key: 'Application', Value: 'PSD EOC Exploration Smoke' },
      { Key: 'DataClassification', Value: 'synthetic-only' },
      { Key: 'Environment', Value: 'exploration-smoke' },
      { Key: 'ExpectedAwsAccountAlias', Value: 'psd401' },
      { Key: 'ManagedBy', Value: 'AWS CDK' },
    ];
    const recoveryTemplateResources = {
      EmailConfigurationSet: {
        DeletionPolicy: 'Retain',
        Properties: {
          Name: 'psd-eoc-transactional',
          SendingOptions: { SendingEnabled: false },
        },
        Type: 'AWS::SES::ConfigurationSet',
        UpdateReplacePolicy: 'Retain',
      },
      EmailDeadLetterQueue5E91C06C: {
        DeletionPolicy: 'Retain',
        Properties: {
          QueueName: 'psd-eoc-email-dlq',
          SqsManagedSseEnabled: true,
        },
        Type: 'AWS::SQS::Queue',
        UpdateReplacePolicy: 'Retain',
      },
      EmailEventsKey619540BF: {
        DeletionPolicy: 'Retain',
        Properties: { EnableKeyRotation: true },
        Type: 'AWS::KMS::Key',
        UpdateReplacePolicy: 'Retain',
      },
      EmailEventsTopic13C4A145: {
        DeletionPolicy: 'Retain',
        Properties: {
          DisplayName: 'PSD EOC live-pilot SES event evidence',
          TopicName: 'psd-eoc-email-events',
        },
        Type: 'AWS::SNS::Topic',
        UpdateReplacePolicy: 'Retain',
      },
      EmailQueue9C1DA90F: {
        DeletionPolicy: 'Retain',
        Properties: {
          MessageRetentionPeriod: 345_600,
          QueueName: 'psd-eoc-email',
          SqsManagedSseEnabled: true,
          VisibilityTimeout: 60,
        },
        Type: 'AWS::SQS::Queue',
        UpdateReplacePolicy: 'Retain',
      },
      EmailWorkerLogGroup0611E5C2: {
        DeletionPolicy: 'Retain',
        Properties: {
          LogGroupName: '/psd-eoc/workers/email',
          RetentionInDays: 14,
        },
        Type: 'AWS::Logs::LogGroup',
        UpdateReplacePolicy: 'Retain',
      },
    } as const;
    const managedEventDestinationResource = {
      LogicalResourceId: 'EmailEventDestination',
      PhysicalResourceId: 'psd-eoc-transactional|psd-eoc-email-events',
      ResourceStatus: 'UPDATE_COMPLETE',
      ResourceType: 'AWS::SES::ConfigurationSetEventDestination',
    } as const;
    const managedLogicalIds = new Set(
      options.before
        .filter(
          (resource) =>
            resource.ResourceStatus !== 'DELETE_SKIPPED' &&
            resource.ResourceStatus !== 'DELETE_COMPLETE',
        )
        .map((resource) => resource.LogicalResourceId),
    );
    const appRunnerTemplateResources = {
      AppRunnerService: {
        Properties: {
          ServiceName: 'psd-eoc-exploration-smoke',
          SourceConfiguration: {},
          Tags: legacyAppRunnerTags,
        },
        Type: 'AWS::AppRunner::Service',
      },
      AppRunnerVpcConnector: {
        Properties: {
          SecurityGroups: [{ Ref: 'ApplicationSecurityGroup' }],
          Subnets: [
            { Ref: 'ApplicationSubnet1' },
            { Ref: 'ApplicationSubnet2' },
          ],
          Tags: legacyAppRunnerTags,
          VpcConnectorName: 'psd-eoc-exploration-smoke-native',
        },
        Type: 'AWS::AppRunner::VpcConnector',
      },
    } as const;
    const currentManagedResources = Object.fromEntries(
      Object.entries(recoveryTemplateResources).filter(([logicalId]) =>
        managedLogicalIds.has(logicalId),
      ),
    );
    const retainedLogicalIds = new Set(
      options.events.map((resource) => resource.LogicalResourceId),
    );
    const importChangeResources = retainedRecoveryResources
      .filter((resource) => retainedLogicalIds.has(resource.LogicalResourceId))
      .map((resource) => ({
        ResourceChange: {
          Action: 'Import',
          LogicalResourceId: resource.LogicalResourceId,
          ResourceType: resource.ResourceType,
        },
      }));
    await Promise.all([
      Bun.write(
        beforeFile,
        JSON.stringify({
          StackResourceSummaries: [
            ...options.before,
            ...(options.stackInventoryManagesEventDestination
              ? [managedEventDestinationResource]
              : []),
          ],
        }),
      ),
      Bun.write(
        managedFile,
        JSON.stringify({
          StackResourceSummaries: retainedRecoveryResources.map((resource) => ({
            ...resource,
            // CloudFormation normalizes successfully imported resources to
            // UPDATE_COMPLETE in the real ListStackResources response.
            ResourceStatus: 'UPDATE_COMPLETE',
          })),
        }),
      ),
      Bun.write(
        eventsFile,
        JSON.stringify({
          StackEvents: options.events.map((resource) => ({
            ...resource,
            Timestamp: '2026-08-17T02:35:19Z',
          })),
        }),
      ),
      Bun.write(
        stackFile,
        JSON.stringify({
          Stacks: [
            {
              Parameters: [
                {
                  ParameterKey: 'SourceSha',
                  ParameterValue: '0'.repeat(40),
                },
              ],
              Outputs: [
                {
                  OutputKey: 'AppRunnerVpcConnectorArn',
                  OutputValue:
                    'arn:aws:apprunner:us-west-2:338414773271:vpcconnector/psd-eoc-exploration-smoke-native/1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                },
              ],
              RoleARN:
                'arn:aws:iam::338414773271:role/cdk-hnb659fds-cfn-exec-role-338414773271-us-west-2',
              StackStatus: options.stackStatus,
            },
          ],
        }),
      ),
      Bun.write(
        currentTemplateFile,
        JSON.stringify({
          AWSTemplateFormatVersion: '2010-09-09',
          Description:
            'Isolated synthetic-only PSD EOC exploration web/mobile backend (GitHub issue #163)',
          Parameters: { SourceSha: { Type: 'String' } },
          Resources: {
            ...appRunnerTemplateResources,
            ...currentManagedResources,
            ...(options.currentTemplateManagesEventDestination
              ? {
                  EmailEventDestination: {
                    Properties: {
                      ConfigurationSetName: {
                        Ref: 'EmailConfigurationSet',
                      },
                      EventDestination: {
                        Enabled: true,
                        Name: 'psd-eoc-email-events',
                      },
                    },
                    Type: 'AWS::SES::ConfigurationSetEventDestination',
                  },
                }
              : {}),
            ExistingHealthQueue: {
              Properties: {
                QueueName: 'psd-eoc-exploration-smoke-health',
              },
              Type: 'AWS::SQS::Queue',
            },
          },
        }),
      ),
      Bun.write(
        changeSetFixture,
        JSON.stringify({
          Capabilities: ['CAPABILITY_NAMED_IAM'],
          ChangeSetId:
            'arn:aws:cloudformation:us-west-2:338414773271:changeSet/psd-eoc-retained-email-import-1-1/00000000-0000-0000-0000-000000000000',
          ChangeSetName: 'psd-eoc-retained-email-import-1-1',
          Changes: importChangeResources,
          Description: `Exact ${importChangeResources.length}-resource retained dark-email recovery for GitHub run 1`,
          ExecutionStatus: 'AVAILABLE',
          StackName: 'PsdEocExplorationSmoke',
          Status: 'CREATE_COMPLETE',
        }),
      ),
      Bun.write(
        join(cdkOut, 'PsdEocExplorationSmoke.template.json'),
        JSON.stringify({
          Resources: {
            ...appRunnerTemplateResources,
            ...recoveryTemplateResources,
          },
        }),
      ),
    ]);

    const awsPath = join(fakeBin, 'aws');
    await Bun.write(
      awsPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' "$1:$2" "\${AWS_ACCESS_KEY_ID:-missing}" >> "$AWS_CALLS"

arg_value() {
  local wanted=$1
  shift
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "$wanted" ]]; then
      printf '%s\\n' "$2"
      return 0
    fi
    shift
  done
  return 1
}

head_json() {
  local bytes checksum sha256
  bytes=$(wc -c < "$PUBLISHED_TEMPLATE" | tr -d ' ')
  checksum=$(openssl dgst -sha256 -binary "$PUBLISHED_TEMPLATE" | base64 | tr -d '\\n')
  sha256=$(shasum -a 256 "$PUBLISHED_TEMPLATE" | cut -d' ' -f1)
  printf '{"ChecksumSHA256":"%s","ContentLength":%s,"Metadata":{"sha256":"%s"},"ServerSideEncryption":"AES256"}\\n' \
    "$checksum" "$bytes" "$sha256"
}

case "$1:$2" in
  sesv2:get-configuration-set)
    test "\${AWS_ACCESS_KEY_ID:-}" = "oidc-access"
    printf '{"ConfigurationSetName":"psd-eoc-transactional","SendingOptions":{"SendingEnabled":%s}}\n' \
      "$EXTERNAL_SENDING_ENABLED"
    ;;
  sesv2:get-configuration-set-event-destinations)
    test "\${AWS_ACCESS_KEY_ID:-}" = "oidc-access"
    jq -n --arg topic "$EXTERNAL_DESTINATION_TOPIC_ARN" '{
      EventDestinations: [{
        Enabled: true,
        MatchingEventTypes: ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "RENDERING_FAILURE", "DELIVERY_DELAY"],
        Name: "psd-eoc-email-events",
        SnsDestination: {TopicArn: $topic}
      }]
    }'
    ;;
  cloudformation:describe-stacks)
    if printf '%s\\n' "$@" | grep -q 'StackStatus'; then
      if [[ -e "$IMPORT_MARKER" ]]; then
        printf '%s\\n' 'IMPORT_COMPLETE'
      else
        jq -r '.Stacks[0].StackStatus' "$STACK_FIXTURE"
      fi
    elif printf '%s\\n' "$@" | grep -q 'AppRunnerVpcConnectorArn'; then
      jq -r '.Stacks[0].Outputs[] | select(.OutputKey == "AppRunnerVpcConnectorArn") | .OutputValue' "$STACK_FIXTURE"
    elif printf '%s\\n' "$@" | grep -q 'RoleARN'; then
      jq -r '.Stacks[0].RoleARN' "$STACK_FIXTURE"
    else
      cat "$STACK_FIXTURE"
    fi
    ;;
  cloudformation:list-stack-resources)
    test "\${AWS_ACCESS_KEY_ID:-}" = "oidc-access"
    if [[ -e "$IMPORT_MARKER" ]]; then cat "$MANAGED_FIXTURE"; else cat "$BEFORE_FIXTURE"; fi
    ;;
  cloudformation:describe-stack-events)
    [[ "\${AWS_ACCESS_KEY_ID:-}" == "deploy-access" || "\${AWS_ACCESS_KEY_ID:-}" == "template-access" ]]
    cat "$EVENTS_FIXTURE"
    ;;
  cloudformation:get-template)
    case "\${AWS_ACCESS_KEY_ID:-}" in
      deploy-access | template-access) ;;
      *) exit 93 ;;
    esac
    if [[ -e "$IMPORT_MARKER" ]]; then
      jq -n --slurpfile template "$PUBLISHED_TEMPLATE" '{TemplateBody: $template[0]}'
    else
      jq -n --slurpfile template "$CURRENT_TEMPLATE_FIXTURE" '{TemplateBody: $template[0]}'
    fi
    ;;
  cloudformation:create-change-set)
    test "\${AWS_ACCESS_KEY_ID:-}" = "deploy-access"
    request=$(arg_value --cli-input-json "$@")
    cp "\${request#file://}" "$CAPTURED_CHANGE_SET_REQUEST"
    jq '.ResourcesToImport' "\${request#file://}" > "$CAPTURED_IMPORT_RESOURCES"
    printf '%s\\n' "$AWS_ACCESS_KEY_ID" > "$IMPORT_CREDENTIAL"
    printf '%s\\n' '{"Id":"arn:aws:cloudformation:us-west-2:338414773271:changeSet/psd-eoc-retained-email-import-1-1/00000000-0000-0000-0000-000000000000","StackId":"arn:aws:cloudformation:us-west-2:338414773271:stack/PsdEocExplorationSmoke/11111111-1111-1111-1111-111111111111"}'
    ;;
  cloudformation:describe-change-set)
    test "\${AWS_ACCESS_KEY_ID:-}" = "deploy-access"
    cat "$CHANGE_SET_FIXTURE"
    ;;
  cloudformation:execute-change-set)
    test "\${AWS_ACCESS_KEY_ID:-}" = "deploy-access"
    touch "$IMPORT_MARKER"
    ;;
  cloudformation:wait)
    test "\${AWS_ACCESS_KEY_ID:-}" = "deploy-access"
    ;;
  sts:get-caller-identity)
    case "\${AWS_ACCESS_KEY_ID:-}" in
      oidc-access)
        printf '%s\\n' 'arn:aws:sts::338414773271:assumed-role/psd-eoc-exploration-smoke-github-deploy/test-oidc-session'
        ;;
      deploy-access)
        printf '%s\\n' 'arn:aws:sts::338414773271:assumed-role/cdk-hnb659fds-deploy-role-338414773271-us-west-2/psd-eoc-retained-email-import-1'
        ;;
      template-access)
        printf '%s\\n' 'arn:aws:sts::338414773271:assumed-role/cdk-hnb659fds-deploy-role-338414773271-us-west-2/psd-eoc-import-template-1'
        ;;
      publisher-access)
        printf '%s\\n' 'arn:aws:sts::338414773271:assumed-role/cdk-hnb659fds-file-publishing-role-338414773271-us-west-2/psd-eoc-import-publish-1'
        ;;
      *) exit 92 ;;
    esac
    ;;
  sts:assume-role)
    test "\${AWS_ACCESS_KEY_ID:-}" = "oidc-access"
    role=$(arg_value --role-arn "$@")
    session=$(arg_value --role-session-name "$@")
    if [[ "$role" == "$CDK_FILE_PUBLISH_ROLE_ARN" ]]; then
      printf '%s\\n' '{"AccessKeyId":"publisher-access","SecretAccessKey":"publisher-secret","SessionToken":"publisher-token"}'
    elif [[ "$session" == psd-eoc-import-template-* ]]; then
      printf '%s\\n' '{"AccessKeyId":"template-access","SecretAccessKey":"template-secret","SessionToken":"template-token"}'
    else
      test "$role" = "$CDK_DEPLOY_ROLE_ARN"
      printf '%s\\n' '{"AccessKeyId":"deploy-access","SecretAccessKey":"deploy-secret","SessionToken":"deploy-token"}'
    fi
    ;;
  s3api:head-object)
    test "\${AWS_ACCESS_KEY_ID:-}" = "publisher-access"
    if [[ "\${PREEXISTING_IMPORT_OBJECT:-false}" == "true" && ! -e "$PUBLISHED_TEMPLATE" ]]; then
      cp "$EXPECTED_IMPORT_TEMPLATE" "$PUBLISHED_TEMPLATE"
    fi
    if [[ ! -e "$PUBLISHED_TEMPLATE" ]]; then
      printf '%s\\n' 'An error occurred (404) when calling the HeadObject operation: Not Found' >&2
      exit 254
    fi
    head_json
    ;;
  s3api:put-object)
    test "\${AWS_ACCESS_KEY_ID:-}" = "publisher-access"
    body=$(arg_value --body "$@")
    bucket=$(arg_value --bucket "$@")
    key=$(arg_value --key "$@")
    cp "$body" "$PUBLISHED_TEMPLATE"
    printf '%s\\n' "$bucket" > "$PUBLISHED_BUCKET"
    printf '%s\\n' "$key" > "$PUBLISHED_KEY"
    head_json
    ;;
  *) exit 91 ;;
esac
`,
    );
    await chmod(awsPath, 0o755);

    const childEnvironment = {
      ...process.env,
      AWS_ACCESS_KEY_ID: 'oidc-access',
      AWS_ACCOUNT_ID: '338414773271',
      AWS_CALLS: awsCalls,
      AWS_REGION: 'us-west-2',
      AWS_SECRET_ACCESS_KEY: 'oidc-secret',
      AWS_SESSION_TOKEN: 'oidc-token',
      BEFORE_FIXTURE: beforeFile,
      CAPTURED_CHANGE_SET_REQUEST: capturedChangeSetRequest,
      CAPTURED_IMPORT_RESOURCES: capturedImportResources,
      CDK_ASSET_BUCKET: 'cdk-hnb659fds-assets-338414773271-us-west-2',
      CDK_CFN_EXEC_ROLE_ARN:
        'arn:aws:iam::338414773271:role/cdk-hnb659fds-cfn-exec-role-338414773271-us-west-2',
      CDK_DEPLOY_ROLE_ARN:
        'arn:aws:iam::338414773271:role/cdk-hnb659fds-deploy-role-338414773271-us-west-2',
      CDK_FILE_PUBLISH_ROLE_ARN:
        'arn:aws:iam::338414773271:role/cdk-hnb659fds-file-publishing-role-338414773271-us-west-2',
      CHANGE_SET_FIXTURE: changeSetFixture,
      CURRENT_TEMPLATE_FIXTURE: currentTemplateFile,
      EVENTS_FIXTURE: eventsFile,
      EXTERNAL_DESTINATION_TOPIC_ARN:
        options.externalDestinationTopicArn ??
        'arn:aws:sns:us-west-2:338414773271:psd-eoc-email-events',
      EXTERNAL_SENDING_ENABLED: String(options.externalSendingEnabled ?? false),
      EXPECTED_IMPORT_TEMPLATE: join(
        readback,
        'email-recovery-import-template.json',
      ),
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_RUN_ID: '1',
      IMPORT_CREDENTIAL: importCredential,
      IMPORT_MARKER: importMarker,
      MANAGED_FIXTURE: managedFile,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      PREEXISTING_IMPORT_OBJECT: options.preexistingImportObject
        ? 'true'
        : 'false',
      PUBLISHED_BUCKET: publishedBucket,
      PUBLISHED_KEY: publishedKey,
      PUBLISHED_TEMPLATE: publishedTemplate,
      RUNNER_TEMP: directory,
      STACK_FIXTURE: stackFile,
      STACK_NAME: 'PsdEocExplorationSmoke',
    };
    const defaultGetTemplate = Bun.spawnSync({
      cmd: [
        awsPath,
        'cloudformation',
        'get-template',
        '--stack-name',
        'PsdEocExplorationSmoke',
      ],
      env: childEnvironment,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const child = Bun.spawnSync({
      cmd: ['bash', '-c', recoveryScript(await readWorkflow())],
      cwd: infra,
      env: childEnvironment,
      stderr: 'pipe',
      stdout: 'pipe',
    });

    const mappingPath = join(readback, 'email-recovery-resource-mapping.json');
    const resultPath = join(readback, 'email-recovery-result.json');
    const changeSetPath = join(readback, 'email-recovery-change-set.json');
    const importObjectPath = join(
      readback,
      'email-recovery-import-object.json',
    );
    const importResourcesPath = join(
      readback,
      'email-recovery-import-resources.json',
    );
    const publicationResultPath = join(
      readback,
      'email-recovery-publication-result.json',
    );
    return {
      awsCalls: (await Bun.file(awsCalls).exists())
        ? (await Bun.file(awsCalls).text()).trim().split('\n')
        : [],
      changeSet: (await Bun.file(changeSetPath).exists())
        ? await Bun.file(changeSetPath).json()
        : undefined,
      changeSetRequest: (await Bun.file(capturedChangeSetRequest).exists())
        ? await Bun.file(capturedChangeSetRequest).json()
        : undefined,
      defaultGetTemplateExitCode: defaultGetTemplate.exitCode,
      exitCode: child.exitCode,
      importCredential: (await Bun.file(importCredential).exists())
        ? await Bun.file(importCredential).text()
        : undefined,
      importObject: (await Bun.file(importObjectPath).exists())
        ? await Bun.file(importObjectPath).json()
        : undefined,
      importResources: (await Bun.file(importResourcesPath).exists())
        ? await Bun.file(importResourcesPath).json()
        : undefined,
      mapping: (await Bun.file(mappingPath).exists())
        ? await Bun.file(mappingPath).json()
        : undefined,
      publicationResult: (await Bun.file(publicationResultPath).exists())
        ? await Bun.file(publicationResultPath).json()
        : undefined,
      publishedBucket: (await Bun.file(publishedBucket).exists())
        ? (await Bun.file(publishedBucket).text()).trim()
        : undefined,
      publishedKey: (await Bun.file(publishedKey).exists())
        ? (await Bun.file(publishedKey).text()).trim()
        : undefined,
      publishedTemplate: (await Bun.file(publishedTemplate).exists())
        ? await Bun.file(publishedTemplate).json()
        : undefined,
      result: (await Bun.file(resultPath).exists())
        ? await Bun.file(resultPath).json()
        : undefined,
      stderr: child.stderr.toString(),
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe('isolated CDK entrypoint configuration', () => {
  it('uses only the exploration-smoke entrypoint with safety feature flags', async () => {
    const configuration = (await Bun.file(
      new URL('../../cdk.exploration-smoke.json', import.meta.url),
    ).json()) as ExplorationCdkConfiguration;

    expect(configuration.app).toBe('bun bin/exploration-smoke.ts');
    expect(configuration.context['@aws-cdk/core:checkSecretUsage']).toBe(true);
    expect(configuration.context['@aws-cdk/aws-iam:minimizePolicies']).toBe(
      true,
    );
    expect(configuration.context['@aws-cdk/core:explicitStackTags']).toBe(true);
    expect(JSON.stringify(configuration)).not.toContain('src/app.ts');
    expect(JSON.stringify(configuration)).not.toContain('PsdEocStack');
  });

  it('runs the preview gate with the canonical synthetic PostgreSQL service', async () => {
    const workflow = await readWorkflow();
    const previewJobHeader = workflow.match(
      /\n {2}preview:\n([\s\S]*?)\n {4}steps:/,
    )?.[1];
    const deployJobHeader = workflow.match(
      /\n {2}deploy:\n([\s\S]*?)\n {4}steps:/,
    )?.[1];

    expect(previewJobHeader).toBeDefined();
    expect(previewJobHeader).toContain('image: postgres:16-alpine');
    expect(previewJobHeader).toContain('POSTGRES_DB: psd_eoc_test');
    expect(previewJobHeader).toContain('POSTGRES_USER: psd_eoc_test');
    expect(previewJobHeader).toContain(
      'DATABASE_URL: postgresql://psd_eoc_test:synthetic_test_password@localhost:5432/psd_eoc_test',
    );
    expect(previewJobHeader).toContain(
      'TEST_DATABASE_URL: postgresql://psd_eoc_test:synthetic_test_password@localhost:5432/psd_eoc_test',
    );
    expect(deployJobHeader).toBeDefined();
    expect(deployJobHeader).not.toContain('DATABASE_URL:');
    expect(deployJobHeader).not.toContain('TEST_DATABASE_URL:');
  });

  it('keeps the fast PR gate exact, focused, and full everywhere else', async () => {
    const workflow = await readCiWorkflow();

    expect(workflow).toContain(
      'if [[ "$GITHUB_EVENT_NAME" == "pull_request" ]]',
    );
    expect(workflow).toContain('.github/workflows/ci.yml | \\');
    expect(workflow).toContain(
      '.github/workflows/deploy-exploration-smoke.yml | \\',
    );
    expect(workflow).toContain(
      'infra/test/exploration-smoke/entrypoint.test.ts) ;;',
    );
    expect(workflow).toContain('mode=full');
    expect(workflow).toContain('mode=exploration-smoke-workflow');
    expect(workflow).toContain("if: steps.gate.outputs.mode == 'full'");
    expect(workflow).toContain('run: bun run check');
    expect(workflow).toContain(
      "if: steps.gate.outputs.mode == 'exploration-smoke-workflow'",
    );
    expect(workflow).toContain('bun run format:check');
    expect(workflow).toContain('bun run lint');
    expect(workflow).toContain('bun run typecheck');
    expect(workflow).toContain(
      'bun test infra/test/exploration-smoke/entrypoint.test.ts',
    );
    expect(workflow).toContain(
      'rhysd/actionlint:1.7.7@sha256:887a259a5a534f3c4f36cb02dca341673c6089431057242cdc931e9f133147e9',
    );
  });

  it('allows only the explicit synthetic deployment bypass and binds it to readback', async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain('DEPLOY SYNTHETIC EXPLORATION SMOKE');
    expect(workflow).toContain(
      'DEPLOY SYNTHETIC EXPLORATION SMOKE WITHOUT FULL CI',
    );
    expect(workflow).toContain('REPOSITORY_GATE_MODE=full');
    expect(workflow).toContain('REPOSITORY_GATE_MODE=synthetic-owner-bypass');
    expect(workflow).toContain("if: env.REPOSITORY_GATE_MODE == 'full'");
    expect(workflow).toContain(
      "if: env.REPOSITORY_GATE_MODE == 'synthetic-owner-bypass'",
    );
    expect(workflow).toContain(
      'EXPLICIT PRODUCT-OWNER BYPASS FOR SYNTHETIC EXPLORATION',
    );
    expect(workflow).toContain(
      'grep -Fx -- "- Repository gate: $REPOSITORY_GATE_RECORD" artifacts/consequence-preview.md',
    );
    expect(workflow).toContain(
      'Focused smoke tests, CDK synth, container smoke, immutable preview, protected approval, and AWS readback still run.',
    );
  });

  it('preserves the live service until the exact native bootstrap succeeds', async () => {
    const workflow = await readWorkflow();
    const stageStep = workflow.indexOf(
      '- name: Stage the exact native bootstrap without changing the live service',
    );
    const publishStep = workflow.indexOf(
      '- name: Publish and verify only the approved image digest',
    );
    const accessProofStep = workflow.indexOf(
      '- name: Prove the dedicated access sync task is least privilege and dark',
    );
    const bootstrapStep = workflow.indexOf(
      '- name: Run and prove the exact native bootstrap task',
    );
    const serviceStep = workflow.indexOf(
      '- name: Deploy the exact digest after bootstrap',
    );
    const deployJobHeader = workflow.match(
      /\n {2}deploy:\n([\s\S]*?)\n {4}steps:/,
    )?.[1];

    expect(workflow).toContain(EXPLORATION_SMOKE_REPOSITORY_NAME);
    expect(workflow).not.toContain('repository/psd-eoc-exploration-smoke');
    expect(stageStep).toBeGreaterThan(-1);
    expect(publishStep).toBeGreaterThan(stageStep);
    expect(accessProofStep).toBeGreaterThan(publishStep);
    expect(bootstrapStep).toBeGreaterThan(accessProofStep);
    expect(serviceStep).toBeGreaterThan(bootstrapStep);
    expect(workflow).toContain('phase_app_digest=$current_digest');
    expect(workflow).toContain(
      'test "$current_source_sha" = "$current_runtime_source_sha"',
    );
    expect(workflow).toContain(
      'phase_runtime_idle_timeout=$current_runtime_idle_timeout',
    );
    expect(workflow).toContain('phase_source_sha=$current_runtime_source_sha');
    expect(workflow).toContain(
      '--parameters "$STACK_NAME:BootstrapImageDigest=$IMAGE_DIGEST"',
    );
    expect(workflow).toContain(
      '--parameters "$STACK_NAME:BootstrapSourceSha=$SOURCE_SHA"',
    );
    expect(workflow).toContain(
      '--parameters "$STACK_NAME:SourceSha=$phase_source_sha"',
    );
    expect(workflow).toContain(
      '--parameters "$STACK_NAME:RuntimeDatabaseIdleTimeoutSeconds=$phase_runtime_idle_timeout"',
    );
    expect(workflow).toContain(
      '--parameters "$STACK_NAME:RuntimeDatabaseIdleTimeoutSeconds=0"',
    );
    expect(workflow).toContain(
      'select(.ParameterKey == "RuntimeDatabaseIdleTimeoutSeconds")',
    );
    expect(workflow).toContain('app-runner-repository-phase.json');
    expect(workflow).toContain(
      '.RuntimeEnvironmentVariables.DATABASE_IDLE_TIMEOUT_SECONDS',
    );
    expect(workflow).toContain(
      '--parameters "$STACK_NAME:SourceSha=$SOURCE_SHA"',
    );
    expect(workflow).not.toContain('--overrides');
    expect(workflow).not.toContain(
      'describe-service --service-arn "$service_arn" > artifacts/readback/app-runner-service.json',
    );
    expect(workflow).toContain('unset app_runner_service');
    expect(workflow).toContain(
      'unset runtime_environment_map runtime_secret_map',
    );
    expect(deployJobHeader).toBeDefined();
    expect(deployJobHeader).not.toContain(
      'secrets.EXPLORATION_SMOKE_APPROVED_GOOGLE_SUBJECT',
    );
    expect(deployJobHeader).not.toContain(
      'secrets.EXPLORATION_SMOKE_APPROVED_STAFF_EMAIL',
    );
    expect(deployJobHeader).not.toContain(
      'secrets.EXPLORATION_SMOKE_APPROVED_STAFF_DISPLAY_NAME',
    );
  });

  it('runs one provenance-bound Fargate task and requires exact native evidence', async () => {
    const workflow = await readWorkflow();

    for (const output of [
      'BootstrapEcsClusterArn',
      'BootstrapTaskDefinitionArn',
      'BootstrapPrivateSubnetIds',
      'BootstrapSecurityGroupId',
      'BootstrapLogGroupName',
      'BootstrapTaskExecutionRoleArn',
      'BootstrapTaskRoleArn',
      'AccessSyncTaskDefinitionArn',
      'AccessSyncTaskExecutionRoleArn',
      'AccessSyncTaskRoleArn',
      'AppRunnerVpcConnectorArn',
      'ApprovedIdentitySecretArn',
    ]) {
      expect(workflow).toContain(output);
    }
    expect(workflow).toContain('aws ecs run-task');
    expect(workflow).toContain('aws ecs wait tasks-stopped');
    expect(workflow).toContain('aws ecs describe-tasks');
    expect(workflow).toContain('aws ecs describe-task-definition');
    expect(workflow).toContain('--started-by "$started_by"');
    expect(workflow).toContain('--client-token "$client_token"');
    expect(workflow).toContain('assignPublicIp=DISABLED');
    expect(workflow).toContain(
      '.tasks[0].containers[0].imageDigest == $digest',
    );
    expect(workflow).toContain('.tasks[0].containers[0].exitCode == 0');
    expect(workflow).toContain('aws logs get-log-events');
    expect(workflow).toContain('ResourceNotFoundException');
    expect(workflow).toContain('.database.transport == "native-postgres"');
    expect(workflow).toContain('.database.tlsVerified == true');
    expect(workflow).toContain('.idempotence.runs == 2');
    expect(workflow).toContain('.idempotence.equivalent == true');
    expect(workflow).toContain('native-bootstrap-summary.json');
    expect(workflow).not.toContain('aws rds-data execute-statement');
    expect(workflow).not.toContain('@aws-sdk/client-rds-data');
    expect(workflow).not.toContain('DATABASE_RESOURCE_ARN');
    expect(workflow).not.toContain('DATABASE_SECRET_ARN');
    expect(workflow).not.toContain('aws-data-api');
  });

  it('stages a second named access task without executing provider or publication code', async () => {
    const workflow = await readWorkflow();
    const accessProof = workflow.match(
      / {6}- name: Prove the dedicated access sync task is least privilege and dark[\s\S]*? {6}- name: Run and prove the exact native bootstrap task/,
    )?.[0];

    expect(accessProof).toBeDefined();
    expect(workflow).toContain(
      'select(.Type == "AWS::ECS::TaskDefinition")] | length\' "$template")" -eq 2',
    );
    expect(workflow).toContain('psd-eoc-exploration-smoke-native-bootstrap');
    expect(workflow).toContain('psd-eoc-exploration-smoke-access-sync');
    expect(accessProof).toContain('AccessSyncTaskDefinitionArn');
    expect(accessProof).toContain('AccessSyncTaskExecutionRoleArn');
    expect(accessProof).toContain('AccessSyncTaskRoleArn');
    expect(accessProof).toContain(
      'test "$access_task_definition_arn" != "$bootstrap_task_definition_arn"',
    );
    expect(accessProof).toContain(
      'packages/server/scripts/exploration-smoke/sync-access-membership.ts',
    );
    expect(accessProof).toContain('readonlyRootFilesystem == true');
    expect(accessProof).toContain('networkMode == "awsvpc"');
    expect(accessProof).toContain(
      'expected_image="$repository_uri@$IMAGE_DIGEST"',
    );
    expect(accessProof).toContain('BootstrapPrivateSubnetIds');
    expect(accessProof).toContain('BootstrapSecurityGroupId');
    expect(accessProof).toContain('/psd-eoc/google-groups');
    expect(accessProof).not.toContain('aws secretsmanager describe-secret');
    expect(accessProof).not.toContain('aws secretsmanager get-secret-value');
    expect(accessProof).toContain('"DATABASE_PASSWORD"');
    expect(accessProof).toContain('"DATABASE_USERNAME"');
    expect(accessProof).toContain('"GOOGLE_ROSTER_CONFIG"');
    expect(accessProof).toContain(
      '"PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256"',
    );
    expect(accessProof).toContain(':initialMobileTransitionEmailSha256::');
    expect(accessProof).toContain('access-sync-iam-template-contract.json');
    expect(accessProof).toContain(
      '$task_roles[0].value.Properties.AssumeRolePolicyDocument == ecs_task_trust',
    );
    expect(accessProof).toContain(
      '($execution_policies[0].value.Properties.PolicyDocument.Statement | length) == 4',
    );
    expect(accessProof).toContain(
      'deployment-role-access-sync-run-task-simulation.json',
    );
    expect(accessProof).toContain(
      'deployment-role-access-sync-pass-role-simulation.json',
    );
    expect(accessProof).toContain(
      'deployment-role-access-sync-neighbor-cluster-negative-simulation.json',
    );
    expect(accessProof).toContain(
      'deployment-role-access-sync-wrong-service-negative-simulation.json',
    );
    expect(accessProof).toContain(
      'ContextKeyName=ecs:cluster,ContextKeyValues="$cluster_arn",ContextKeyType=string',
    );
    expect(accessProof).toContain('EvalDecision == "allowed"');
    expect(accessProof).toContain('EvalDecision != "allowed"');
    expect(accessProof).toContain('.EvalResourceDecision != "allowed"');
    expect(accessProof).not.toContain('aws iam get-role');
    expect(accessProof).not.toContain('aws iam get-role-policy');
    expect(accessProof).not.toContain('aws iam list-role-policies');
    expect(accessProof).not.toContain('aws iam list-attached-role-policies');
    expect(accessProof).not.toContain(
      '--policy-source-arn "$access_execution_role_arn"',
    );
    expect(accessProof).not.toContain(
      '--policy-source-arn "$access_task_role_arn"',
    );
    expect(accessProof).not.toContain('aws ecs run-task');
    expect(workflow.match(/^ {10}aws ecs run-task\b/gm)).toHaveLength(1);
    expect(workflow).not.toContain('--overrides');
  });

  it('executes the exact access authority proof and rejects missing or broader authority', async () => {
    const exact = await runAccessSyncOuterRoleExecutionSimulation();

    expect(exact.exitCode).toBe(0);
    expect(exact.stderr).toBe('');
    expect(exact.awsCalls).toEqual([
      'iam:simulate-principal-policy',
      'iam:simulate-principal-policy',
      'iam:simulate-principal-policy',
      'iam:simulate-principal-policy',
    ]);

    const missingRunTask = await runAccessSyncOuterRoleExecutionSimulation({
      denyRunTask: true,
    });
    expect(missingRunTask.exitCode).not.toBe(0);
    expect(missingRunTask.awsCalls).toEqual(['iam:simulate-principal-policy']);

    const neighboringCluster = await runAccessSyncOuterRoleExecutionSimulation({
      allowNeighborCluster: true,
    });
    expect(neighboringCluster.exitCode).not.toBe(0);
    expect(neighboringCluster.awsCalls).toEqual([
      'iam:simulate-principal-policy',
      'iam:simulate-principal-policy',
    ]);

    const wrongService = await runAccessSyncOuterRoleExecutionSimulation({
      allowWrongService: true,
    });
    expect(wrongService.exitCode).not.toBe(0);
    expect(wrongService.awsCalls).toEqual([
      'iam:simulate-principal-policy',
      'iam:simulate-principal-policy',
      'iam:simulate-principal-policy',
      'iam:simulate-principal-policy',
    ]);
  });

  it('previews and reads back private PostgreSQL with no database HTTP authority', async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain('AWS::AppRunner::VpcConnector');
    expect(workflow).toContain('AWS::EC2::NatGateway');
    expect(workflow).toContain('AWS::ECS::Cluster');
    expect(workflow).toContain('AWS::ECS::TaskDefinition');
    expect(workflow).toContain(
      '.Properties.EnableHttpEndpoint // false) == true',
    );
    expect(workflow).toContain(
      '.DBClusters[0].HttpEndpointEnabled\' artifacts/readback/database-cluster.json)" = "false"',
    );
    expect(workflow).toContain(
      '.Service.NetworkConfiguration.EgressConfiguration',
    );
    expect(workflow).toContain('EgressType: "VPC"');
    expect(workflow).toContain('"DATABASE_DRIVER"');
    expect(workflow).toContain(
      'test "$(jq -er \'.DATABASE_DRIVER\' <<< "$runtime_environment_map")" = "postgres"',
    );
    expect(workflow).toContain('"RUNTIME_SECRET_ARN"');
    expect(workflow).toContain(
      'test "$(jq -er \'.RUNTIME_SECRET_ARN\' <<< "$runtime_environment_map")" = "$api_salt_secret_arn"',
    );
    expect(workflow).toContain('"DATABASE_USERNAME"');
    expect(workflow).toContain('"DATABASE_PASSWORD"');
    expect(workflow).toContain('"PSD_EOC_BOOTSTRAP_ADMIN_SUBJECTS"');
    expect(workflow).toContain(
      '"PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256"',
    );
    expect(workflow).toContain('$database_application_secret_arn:username::');
    expect(workflow).toContain('$approved_identity_secret_arn:googleSubject::');
    expect(workflow).toContain(
      '$approved_identity_secret_arn:initialMobileTransitionEmailSha256::',
    );
    expect(workflow).toContain(
      'role/PsdEocExplorationSmoke-BootstrapTaskExecutionRole1A-[A-Za-z0-9]+$',
    );
    expect(workflow).toContain(
      'role/PsdEocExplorationSmoke-BootstrapTaskRole8B52C495-[A-Za-z0-9]+$',
    );
    expect(workflow).toContain(
      '--action-names logs:GetLogEvents             --resource-arns "$bootstrap_log_group_arn:*"',
    );
    expect(workflow).not.toContain('$bootstrap_log_stream_arn');
    expect(workflow).toContain('($statements | length) == 2');
    expect(workflow).not.toContain('"rds-data:ExecuteStatement"');
  });

  it('keeps workflow_dispatch within GitHub limits and parses combined fields', async () => {
    const workflow = await readWorkflow();
    const dispatchBlock = workflow.match(
      /workflow_dispatch:\n {4}inputs:\n([\s\S]*?)\n\npermissions:/,
    )?.[1];

    expect(dispatchBlock).toBeDefined();
    const inputNames = Array.from(
      dispatchBlock?.matchAll(/^ {6}([a-z0-9_]+):$/gm) ?? [],
      (match) => match[1],
    );
    expect(inputNames).toHaveLength(10);
    expect(inputNames).toContain('deployment_authority');
    expect(inputNames).toContain('approved_identity_sha256');
    expect(workflow).toContain(
      "deployment_authority_pattern='^(arn:aws:iam::338414773271:role/",
    );
    expect(workflow).toContain(
      '[[ "$APPROVED_IDENTITY_SHA256" =~ ^[0-9a-f]{64},[0-9a-f]{64},[0-9a-f]{64},[0-9a-f]{64}$ ]]',
    );
    expect(workflow).toContain(
      'secrets.EXPLORATION_SMOKE_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256',
    );
    expect(workflow).toContain(
      '--parameters "$STACK_NAME:InitialMobileTransitionEmailSha256=$INITIAL_MOBILE_TRANSITION_EMAIL_SHA256"',
    );
    expect(workflow).not.toContain('approved_google_subject_sha256:');
    expect(workflow).not.toContain('approved_staff_email_sha256:');
    expect(workflow).not.toContain('approved_staff_display_name_sha256:');
  });

  it('binds immutable OIDC trust and stable live policy authority before writes', async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain(
      'GITHUB_OIDC_SUBJECT: repo:psd401@1902994/psd-eoc@1326178900:environment:exploration-smoke',
    );
    expect(workflow).toContain('.ClientIDList == ["sts.amazonaws.com"]');
    expect(workflow).toContain(
      '$statements[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"',
    );
    expect(workflow).toContain(
      '$statements[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == $subject',
    );
    expect(workflow).toContain(
      'test "$REQUESTED_DEPLOY_ROLE_POLICY_SHA256" = "$EXPECTED_DEPLOY_ROLE_POLICY_SHA256"',
    );
    expect(workflow).toContain(
      'test "$REQUESTED_DEPLOY_ROLE_BOUNDARY_ARN" = "$EXPECTED_DEPLOY_ROLE_BOUNDARY_ARN"',
    );
    expect(workflow).toContain(
      'test "$actual_policy_sha256" = "$EXPECTED_DEPLOY_ROLE_POLICY_SHA256"',
    );
    expect(workflow).toContain(
      'test "$actual_boundary_arn" = "$EXPECTED_DEPLOY_ROLE_BOUNDARY_ARN"',
    );
    expect(workflow).toContain('deployment-role-policy-inventory.json');
    expect(workflow).toContain('deployment-role-permissions-boundary.txt');
    expect(workflow).toContain(
      'The zero policy hash is read-only discovery and can never authorize deployment.',
    );
  });

  it('adopts the exact retained rollback resources idempotently without deleting them', async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain(
      'Adopt exact retained dark email resources after a rolled-back transition',
    );
    expect(workflow).toContain(
      'CREATE_COMPLETE | IMPORT_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE)',
    );
    expect(workflow).toContain(
      'EmailWorkerLogGroup0611E5C2: {LogGroupName: $log_group_name}',
    );
    expect(workflow).toContain(
      'EmailDeadLetterQueue5E91C06C: {QueueUrl: $dlq_url}',
    );
    expect(workflow).toContain(
      'EmailConfigurationSet: {Name: $configuration_set_name}',
    );
    expect(workflow).toContain(
      'EmailEventsKey619540BF: {KeyId: $events_key_id}',
    );
    expect(workflow).toContain(
      'EmailQueue9C1DA90F: {QueueUrl: $email_queue_url}',
    );
    expect(workflow).toContain(
      'EmailEventsTopic13C4A145: {TopicArn: $events_topic_arn}',
    );
    expect(workflow).toContain(
      '.Resources.AppRunnerVpcConnector.Properties ==',
    );
    expect(workflow).toContain(
      '.Resources.AppRunnerService.Properties.ServiceName ==',
    );
    expect(workflow).toContain(
      '.Resources.AppRunnerService.Properties.Tags | sort_by(.Key)',
    );
    expect(workflow).toContain(
      'aws sesv2 get-configuration-set-event-destinations',
    );
    expect(workflow).toContain(
      'CDK_ASSET_BUCKET: cdk-hnb659fds-assets-338414773271-us-west-2',
    );
    expect(workflow).toContain(
      'CDK_CFN_EXEC_ROLE_ARN: arn:aws:iam::338414773271:role/cdk-hnb659fds-cfn-exec-role-338414773271-us-west-2',
    );
    expect(workflow).toContain(
      'CDK_FILE_PUBLISH_ROLE_ARN: arn:aws:iam::338414773271:role/cdk-hnb659fds-file-publishing-role-338414773271-us-west-2',
    );
    expect(workflow).toContain('aws s3api put-object \\');
    expect(workflow).toContain('--checksum-algorithm SHA256');
    expect(workflow).toContain('--server-side-encryption AES256');
    expect(workflow).toContain('aws cloudformation create-change-set \\');
    expect(workflow).toContain('--cli-input-json "file://$change_set_request"');
    expect(workflow).toContain('ChangeSetType: "IMPORT"');
    expect(workflow).toContain('ResourcesToImport: $resources[0]');
    expect(workflow).toContain('TemplateURL: $template_url');
    expect(workflow).toContain('RoleARN: $role_arn');
    expect(workflow).toContain('--output json > "$current_template_response"');
    expect(workflow).toContain(
      `jq -S '.TemplateBody' "$current_template_response" > "$current_template"`,
    );
    expect(workflow).toContain('--output json > "$imported_template_response"');
    expect(workflow).toContain(
      `jq -S '.TemplateBody' "$imported_template_response" > "$imported_template"`,
    );
    expect(workflow).toContain('(.TemplateBody.Resources | type) == "object"');
    expect(workflow).not.toContain('--query TemplateBody');
    expect(workflow).toContain(
      '--role-session-name "psd-eoc-import-template-${GITHUB_RUN_ID}"',
    );
    expect(workflow).toContain(
      '--role-session-name "psd-eoc-import-publish-${GITHUB_RUN_ID}"',
    );
    expect(workflow).toContain(
      '--role-session-name "psd-eoc-retained-email-import-${GITHUB_RUN_ID}"',
    );
    expect(workflow).toContain(
      'unset deploy_credentials deploy_access_key deploy_secret_key deploy_session_token',
    );
    expect(workflow).toContain(
      'test "$post_import_caller_arn" = "$oidc_caller_arn"',
    );
    expect(workflow).not.toContain('export AWS_ACCESS_KEY_ID');
    expect(workflow).not.toContain('export AWS_SECRET_ACCESS_KEY');
    expect(workflow).not.toContain('export AWS_SESSION_TOKEN');
    expect(workflow).toContain('template_aws() {');
    expect(workflow).toContain('publisher_aws() {');
    expect(workflow).toContain('import_aws() {');
    expect(workflow).toContain(
      'Retained dark-email resources are partial or ambiguous; refusing recovery.',
    );
    expect(workflow).toContain(
      "jq -n --arg state already-managed '{state: $state}'",
    );
    expect(workflow).toContain("jq -n --arg state imported '{state: $state}'");
    expect(workflow).toContain('.ResourceStatus == "UPDATE_COMPLETE" or');
    expect(workflow).toContain(
      'Stack state $current_status is not safe for an automated retry.',
    );
    expect(workflow).toContain(
      '> ../artifacts/readback/app-runner-before.json',
    );
    expect(workflow).toContain(
      'test "$(jq -r .Status ../artifacts/readback/app-runner-before.json)" = "RUNNING"',
    );
    expect(workflow).not.toContain(
      'aws cloudformation continue-update-rollback',
    );
    expect(workflow).not.toContain('aws cloudformation delete-stack');
    expect(workflow).not.toContain('aws cloudformation delete-change-set');
    expect(workflow).not.toContain('aws s3api delete-object');
    expect(workflow).not.toContain('aws kms schedule-key-deletion');
    expect(workflow).not.toContain('cdk import');
  });

  it('adopts the exact two newly retained resources beside the four already managed resources', async () => {
    const recovery = await runRecoveryScenario({
      before: previouslyManagedRecoveryResources,
      events: newlyRetainedRecoveryResources,
      stackStatus: 'UPDATE_ROLLBACK_COMPLETE',
    });

    expect(recovery.exitCode).toBe(0);
    expect(recovery.result).toEqual({ state: 'imported' });
    expect(recovery.mapping).toEqual({
      EmailConfigurationSet: { Name: 'psd-eoc-transactional' },
      EmailDeadLetterQueue5E91C06C: {
        QueueUrl:
          'https://sqs.us-west-2.amazonaws.com/338414773271/psd-eoc-email-dlq',
      },
      EmailEventsKey619540BF: {
        KeyId: '01234567-89ab-cdef-0123-456789abcdef',
      },
      EmailEventsTopic13C4A145: {
        TopicArn: 'arn:aws:sns:us-west-2:338414773271:psd-eoc-email-events',
      },
      EmailQueue9C1DA90F: {
        QueueUrl:
          'https://sqs.us-west-2.amazonaws.com/338414773271/psd-eoc-email',
      },
      EmailWorkerLogGroup0611E5C2: {
        LogGroupName: '/psd-eoc/workers/email',
      },
    });
    expect(recovery.defaultGetTemplateExitCode).not.toBe(0);
    expect(recovery.importCredential).toBe('deploy-access\n');
    expect(recovery.publicationResult).toEqual({ state: 'published' });
    expect(recovery.publishedBucket).toBe(
      'cdk-hnb659fds-assets-338414773271-us-west-2',
    );
    expect(recovery.publishedKey).toMatch(
      /^cdk\/PsdEocExplorationSmoke\/import-[0-9a-f]{64}[.]json$/,
    );
    const publishedKey = recovery.publishedKey as string;

    const importObject = recovery.importObject as {
      readonly bucket: string;
      readonly bytes: number;
      readonly checksumSha256: string;
      readonly key: string;
      readonly sha256: string;
      readonly url: string;
    };
    expect(importObject).toEqual({
      bucket: 'cdk-hnb659fds-assets-338414773271-us-west-2',
      bytes: expect.any(Number),
      checksumSha256: expect.stringMatching(/^[A-Za-z0-9+/]{43}=$/),
      key: publishedKey,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      url: `https://cdk-hnb659fds-assets-338414773271-us-west-2.s3.us-west-2.amazonaws.com/${publishedKey}`,
    });
    expect(importObject.bytes).toBeGreaterThan(0);
    expect(publishedKey).toBe(
      `cdk/PsdEocExplorationSmoke/import-${importObject.sha256}.json`,
    );
    const publishedTemplate = recovery.publishedTemplate as {
      readonly Resources: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(publishedTemplate.Resources).sort()).toEqual(
      [
        'AppRunnerService',
        'AppRunnerVpcConnector',
        'EmailConfigurationSet',
        'EmailDeadLetterQueue5E91C06C',
        'EmailEventsKey619540BF',
        'EmailEventsTopic13C4A145',
        'EmailQueue9C1DA90F',
        'EmailWorkerLogGroup0611E5C2',
        'ExistingHealthQueue',
      ].sort(),
    );
    expect(publishedTemplate.Resources).toMatchObject({
      AppRunnerService: {
        Properties: {
          ServiceName: 'psd-eoc-exploration-smoke',
          Tags: expect.arrayContaining([
            {
              Key: 'Application',
              Value: 'PSD EOC Exploration Smoke',
            },
          ]),
        },
      },
      EmailEventsTopic13C4A145: {
        DeletionPolicy: 'Retain',
        Properties: { TopicName: 'psd-eoc-email-events' },
        Type: 'AWS::SNS::Topic',
      },
      EmailQueue9C1DA90F: {
        DeletionPolicy: 'Retain',
        Properties: {
          QueueName: 'psd-eoc-email',
          SqsManagedSseEnabled: true,
        },
        Type: 'AWS::SQS::Queue',
      },
    });
    expect(
      Object.values(publishedTemplate.Resources).some(
        (resource) =>
          (resource as { readonly Type?: string }).Type ===
          'AWS::SES::ConfigurationSetEventDestination',
      ),
    ).toBe(false);
    expect(recovery.importResources).toEqual([
      {
        LogicalResourceId: 'EmailQueue9C1DA90F',
        ResourceIdentifier: {
          QueueUrl:
            'https://sqs.us-west-2.amazonaws.com/338414773271/psd-eoc-email',
        },
        ResourceType: 'AWS::SQS::Queue',
      },
      {
        LogicalResourceId: 'EmailEventsTopic13C4A145',
        ResourceIdentifier: {
          TopicArn: 'arn:aws:sns:us-west-2:338414773271:psd-eoc-email-events',
        },
        ResourceType: 'AWS::SNS::Topic',
      },
    ]);
    expect(recovery.changeSetRequest).toEqual({
      Capabilities: ['CAPABILITY_NAMED_IAM'],
      ChangeSetName: 'psd-eoc-retained-email-import-1-1',
      ChangeSetType: 'IMPORT',
      ClientToken: 'psd-eoc-import-1-1',
      Description:
        'Exact 2-resource retained dark-email recovery for GitHub run 1',
      Parameters: [{ ParameterKey: 'SourceSha', UsePreviousValue: true }],
      ResourcesToImport: recovery.importResources,
      RoleARN:
        'arn:aws:iam::338414773271:role/cdk-hnb659fds-cfn-exec-role-338414773271-us-west-2',
      StackName: 'PsdEocExplorationSmoke',
      TemplateURL: importObject.url,
    });
    expect(recovery.changeSet).toMatchObject({
      Description:
        'Exact 2-resource retained dark-email recovery for GitHub run 1',
      ExecutionStatus: 'AVAILABLE',
      Status: 'CREATE_COMPLETE',
    });
    expect(recovery.changeSet).not.toHaveProperty('ChangeSetType');
    expect(recovery.changeSet).not.toHaveProperty('RoleARN');

    expect(
      recovery.awsCalls.filter((call) => call.startsWith('s3api:')),
    ).toEqual([
      's3api:head-object\tpublisher-access',
      's3api:put-object\tpublisher-access',
      's3api:head-object\tpublisher-access',
    ]);
    expect(
      recovery.awsCalls.filter((call) =>
        /^(cloudformation:(create-change-set|describe-change-set|execute-change-set|wait))\t/.test(
          call,
        ),
      ),
    ).toEqual([
      'cloudformation:create-change-set\tdeploy-access',
      'cloudformation:wait\tdeploy-access',
      'cloudformation:describe-change-set\tdeploy-access',
      'cloudformation:execute-change-set\tdeploy-access',
      'cloudformation:wait\tdeploy-access',
    ]);
    expect(recovery.awsCalls).toContain(
      'cloudformation:get-template\ttemplate-access',
    );
    expect(recovery.awsCalls).toContain(
      'cloudformation:get-template\tdeploy-access',
    );
    expect(recovery.awsCalls.at(-1)).toBe(
      'cloudformation:list-stack-resources\toidc-access',
    );
    expect(
      recovery.awsCalls.filter(
        (call) => call === 'sts:get-caller-identity\toidc-access',
      ),
    ).toHaveLength(6);
  });

  it('retries idempotently without another import once all six resources are managed', async () => {
    const recovery = await runRecoveryScenario({
      before: retainedRecoveryResources.map((resource) => ({
        ...resource,
        ResourceStatus: 'IMPORT_COMPLETE',
      })),
      events: [],
      stackStatus: 'IMPORT_COMPLETE',
    });

    expect(recovery.exitCode).toBe(0);
    expect(recovery.result).toEqual({ state: 'already-managed' });
    expect(recovery.publicationResult).toBeUndefined();
    expect(recovery.importCredential).toBeUndefined();
    expect(recovery.publishedKey).toBeUndefined();
    expect(recovery.mapping).toBeUndefined();
    expect(recovery.awsCalls).not.toContain(
      'cloudformation:create-change-set\tdeploy-access',
    );
  });

  it('reuses an exact digest-matching import object after publication was interrupted', async () => {
    const recovery = await runRecoveryScenario({
      before: previouslyManagedRecoveryResources,
      events: newlyRetainedRecoveryResources,
      preexistingImportObject: true,
      stackStatus: 'UPDATE_ROLLBACK_COMPLETE',
    });

    expect(recovery.exitCode).toBe(0);
    expect(recovery.result).toEqual({ state: 'imported' });
    expect(recovery.publicationResult).toEqual({ state: 'already-published' });
    expect(
      recovery.awsCalls.filter((call) => call.startsWith('s3api:')),
    ).toEqual(['s3api:head-object\tpublisher-access']);
    expect(recovery.awsCalls).not.toContain(
      's3api:put-object\tpublisher-access',
    );
    expect(recovery.importCredential).toBe('deploy-access\n');
    expect(recovery.awsCalls.at(-1)).toBe(
      'cloudformation:list-stack-resources\toidc-access',
    );
  });

  it('fails closed on a partial retained-resource rollback inventory', async () => {
    const partial = retainedRecoveryResources.slice(0, 1);
    const recovery = await runRecoveryScenario({
      before: partial,
      events: partial,
      stackStatus: 'UPDATE_ROLLBACK_COMPLETE',
    });

    expect(recovery.exitCode).not.toBe(0);
    expect(recovery.result).toBeUndefined();
    expect(recovery.publicationResult).toBeUndefined();
    expect(recovery.importCredential).toBeUndefined();
    expect(recovery.publishedKey).toBeUndefined();
  });

  it('fails closed before recovery when the external destination drifts', async () => {
    const recovery = await runRecoveryScenario({
      before: previouslyManagedRecoveryResources,
      events: newlyRetainedRecoveryResources,
      externalDestinationTopicArn:
        'arn:aws:sns:us-west-2:338414773271:not-the-reviewed-topic',
      stackStatus: 'UPDATE_ROLLBACK_COMPLETE',
    });

    expect(recovery.exitCode).not.toBe(0);
    expect(recovery.result).toBeUndefined();
    expect(
      recovery.awsCalls.filter((call) => call.startsWith('sesv2:')),
    ).toEqual([
      'sesv2:get-configuration-set\toidc-access',
      'sesv2:get-configuration-set-event-destinations\toidc-access',
    ]);
    expect(recovery.awsCalls).not.toContain(
      'cloudformation:create-change-set\tdeploy-access',
    );
  });

  it('fails closed before recovery when SES sending is enabled', async () => {
    const recovery = await runRecoveryScenario({
      before: previouslyManagedRecoveryResources,
      events: newlyRetainedRecoveryResources,
      externalSendingEnabled: true,
      stackStatus: 'UPDATE_ROLLBACK_COMPLETE',
    });

    expect(recovery.exitCode).not.toBe(0);
    expect(recovery.result).toBeUndefined();
    expect(
      recovery.awsCalls.filter((call) => call.startsWith('sesv2:')),
    ).toEqual(['sesv2:get-configuration-set\toidc-access']);
  });

  it('fails before any change set when the Original template still manages the external destination', async () => {
    const recovery = await runRecoveryScenario({
      before: previouslyManagedRecoveryResources,
      currentTemplateManagesEventDestination: true,
      events: newlyRetainedRecoveryResources,
      stackStatus: 'UPDATE_ROLLBACK_COMPLETE',
    });

    expect(recovery.exitCode).not.toBe(0);
    expect(recovery.result).toBeUndefined();
    expect(recovery.awsCalls).not.toContain(
      'cloudformation:create-change-set\tdeploy-access',
    );
    expect(recovery.awsCalls).not.toContain(
      'cloudformation:execute-change-set\tdeploy-access',
    );
    expect(recovery.awsCalls.some((call) => call.startsWith('s3api:'))).toBe(
      false,
    );
  });

  it('fails before any change set when the live stack inventory still manages the external destination', async () => {
    const recovery = await runRecoveryScenario({
      before: previouslyManagedRecoveryResources,
      events: newlyRetainedRecoveryResources,
      stackInventoryManagesEventDestination: true,
      stackStatus: 'UPDATE_ROLLBACK_COMPLETE',
    });

    expect(recovery.exitCode).not.toBe(0);
    expect(recovery.result).toBeUndefined();
    expect(recovery.awsCalls).toContain(
      'cloudformation:list-stack-resources\toidc-access',
    );
    expect(recovery.awsCalls).not.toContain(
      'cloudformation:create-change-set\tdeploy-access',
    );
    expect(recovery.awsCalls).not.toContain(
      'cloudformation:execute-change-set\tdeploy-access',
    );
    expect(recovery.awsCalls.some((call) => call.startsWith('s3api:'))).toBe(
      false,
    );
  });

  it('scopes and verifies 14-day retention for the two exact App Runner logs', async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain("APP_RUNNER_LOG_RETENTION_DAYS: '14'");
    expect(workflow).toContain(
      'log_group_base="/aws/apprunner/$service_name/$service_id"',
    );
    expect(workflow).toContain(
      'application_log_group="$log_group_base/application"',
    );
    expect(workflow).toContain('service_log_group="$log_group_base/service"');
    expect(workflow).toContain(
      'for log_group in "$application_log_group" "$service_log_group"; do',
    );
    expect(workflow).toContain('aws logs put-retention-policy');
    expect(workflow).toContain('app-runner-log-groups.json');
    expect(workflow).toContain('.retentionInDays == ($retention | tonumber)');
    expect(workflow).toContain(
      'not-exploration-smoke/$representative_service_id/service:*',
    );
    expect(workflow).toContain(
      '$representative_log_base/not-an-app-runner-log:*',
    );
    expect(workflow).toContain('(.EvaluationResults | length) == 1');
    expect(workflow).toContain(
      '(.EvaluationResults[0].ResourceSpecificResults | length) == 2',
    );
    expect(workflow).toContain(
      '{resource: .EvalResourceName, decision: .EvalResourceDecision}',
    );
    expect(workflow).toContain('.EvalResourceDecision != "allowed"');
    expect(workflow).not.toContain(
      `test "$(jq '.EvaluationResults | length' artifacts/readback/deployment-role-log-retention-simulation.json)" -eq 2`,
    );
    expect(workflow).not.toContain(
      `test "$(jq '.EvaluationResults | length' artifacts/readback/deployment-role-log-retention-negative-simulation.json)" -eq 2`,
    );
    expect(workflow.match(/aws logs get-log-events/g)).toHaveLength(2);
    expect(workflow).toContain(
      '--log-stream-name "$bootstrap_log_stream_name"',
    );
    expect(workflow).not.toContain('aws logs filter-log-events');
  });

  it('proves the exact dark email topology without a sender, worker, subscription, or recipient', async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain(
      'select(.Type == "AWS::SQS::Queue")] | length\' "$template")" -eq 3',
    );
    expect(workflow).toContain(
      'select(.Type == "AWS::KMS::Key")] | length\' "$template")" -eq 1',
    );
    expect(workflow).toContain(
      'select(.Type == "AWS::SNS::Topic")] | length\' "$template")" -eq 1',
    );
    expect(workflow).toContain(
      'select(.Type == "AWS::SES::ConfigurationSet")] | length\' "$template")" -eq 1',
    );
    expect(workflow).toContain(
      'select(.Type == "AWS::SES::ConfigurationSetEventDestination")] | length\' "$template")" -eq 0',
    );
    expect(workflow).toContain('SesEmailEventDestinationManagement');
    expect(workflow).toContain('external-readback');
    expect(workflow).toContain(
      'aws sesv2 get-configuration-set-event-destinations',
    );
    for (const identity of [
      'psd-eoc-exploration-smoke-health',
      'psd-eoc-email',
      'psd-eoc-email-dlq',
      'psd-eoc-transactional',
      'psd-eoc-email-events',
      '/psd-eoc/workers/email',
      'arn:aws:ses:$AWS_REGION:$AWS_ACCOUNT_ID:identity/psd401.net',
    ]) {
      expect(workflow).toContain(identity);
    }
    expect(workflow).toContain(
      '$configuration_sets[0].value.Properties.SendingOptions.SendingEnabled == false',
    );
    expect(workflow).toContain(
      '$email_event_topics[0].value.Properties.KmsMasterKeyId == {"Fn::GetAtt": [$email_event_key_id, "Arn"]}',
    );
    expect(workflow).toContain('.Principal.Service? == "ses.amazonaws.com"');
    expect(workflow).toContain(
      '"AWS:SourceArn": "arn:aws:ses:us-west-2:338414773271:configuration-set/psd-eoc-transactional"',
    );
    expect(workflow).toContain(
      'Dark live-pilot email worker; consumes only its queue and has no SES send authority.',
    );
    expect(workflow).toContain('"sqs:ReceiveMessage"');
    expect(workflow).toContain(
      'sqs:(\\*|SendMessage)$|ses:(\\*|Send.*)|sns:(\\*|Publish)$',
    );
    expect(workflow).toContain('.ResourceType == "AWS::SNS::Subscription"');
    expect(workflow).toContain('.ResourceType == "AWS::SES::EmailIdentity"');
    expect(workflow).toContain('.ResourceType == "AWS::ECS::Service"');
    expect(workflow).toContain('expected-stack-resource-types.tsv');
    expect(workflow).toContain('actual-stack-resource-types.tsv');
    expect(workflow).toContain('PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE');
    expect(workflow).toContain(
      'test "$(jq -er \'.PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE\' <<< "$runtime_environment_map")" = "UNVERIFIED"',
    );
    expect(workflow).toContain(
      'test "$ses_integration_truth" = "configured-unverified"',
    );
    expect(workflow).toContain('test "$email_channel_state" = "disabled"');
    expect(workflow).toContain('notificationChannelsEnabled: 0');
    expect(workflow).toContain('matchingRosterRecipients: 0');
    expect(workflow).not.toContain('detect-stack-resource-drift');
    expect(workflow).not.toContain('StackResourceDrift');
    expect(workflow).toContain('email-worker-log-group.json');
    expect(workflow).toContain('email-queue.json');
    expect(workflow).toContain('email-dead-letter-queue.json');
    expect(workflow).toContain('aws sesv2 get-configuration-set');
    expect(workflow).toContain(
      'aws sesv2 get-configuration-set-event-destinations',
    );
    expect(workflow).toContain(
      '.Attributes.MessageRetentionPeriod == "345600"',
    );
    expect(workflow).toContain(
      '.Attributes.MessageRetentionPeriod == "1209600"',
    );
    expect(workflow).toContain('.SendingOptions.SendingEnabled == false');
    expect(workflow).not.toContain('aws sqs send-message');
    expect(workflow).not.toContain('aws ses send-email');
    expect(workflow).not.toContain('aws sesv2 send-email');
    expect(workflow).not.toContain('aws sns subscribe');
  });

  it('executes exact direct dark-resource readback without drift permission', async () => {
    const workflow = await readWorkflow();
    const readback = await runDirectDarkResourceReadback();

    expect(readback.exitCode).toBe(0);
    expect(readback.stderr).toBe('');
    expect(readback.awsCalls).toEqual([
      'logs:describe-log-groups',
      'sqs:get-queue-attributes',
      'sqs:get-queue-attributes',
      'sesv2:get-configuration-set',
      'sesv2:get-configuration-set-event-destinations',
    ]);
    expect(
      readback.awsCalls.some((call) => call.startsWith('cloudformation:')),
    ).toBe(false);
    expect(workflow).not.toContain('detect-stack-resource-drift');
    expect(workflow).not.toContain('StackResourceDrift');
    expect(retainedRecoveryResources).toHaveLength(6);
    expect(
      retainedRecoveryResources.map(({ ResourceType }) => ResourceType).sort(),
    ).toEqual(
      [
        'AWS::KMS::Key',
        'AWS::Logs::LogGroup',
        'AWS::SES::ConfigurationSet',
        'AWS::SNS::Topic',
        'AWS::SQS::Queue',
        'AWS::SQS::Queue',
      ].sort(),
    );
    expect(workflow).toContain(
      'select(.ResourceType == "AWS::SES::ConfigurationSetEventDestination")] | length) == 0',
    );
    expect(workflow).toContain(
      'test "$ses_event_destination_management" = "external-readback"',
    );
  });

  it('proves the exact live runtime role and all dark resources have zero send authority', async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain('runtime-role.json');
    expect(workflow).toContain(
      ".Service.InstanceConfiguration.InstanceRoleArn' artifacts/readback/app-runner-service.json",
    );
    expect(workflow).toContain(
      '($statements[0].Principal.Service | as_array) == ["tasks.apprunner.amazonaws.com"]',
    );
    expect(workflow).toContain('(.PermissionsBoundary // null) == null');
    expect(workflow).toContain("jq -e '.AttachedPolicies == []'");
    expect(workflow).toContain('runtime-inline-policy.json');
    expect(workflow).toContain('action_set == ["sqs:GetQueueAttributes"]');
    expect(workflow).toContain('resource_set == [$queue]');
    expect(workflow).toContain('queue-send-negative-simulation.json');
    expect(workflow).toContain('--action-names sqs:SendMessage');
    expect(workflow).toContain(
      '--resource-arns "$queue_arn" "$email_queue_arn" "$email_dlq_arn"',
    );
    expect(workflow).toContain('ses-send-negative-simulation.json');
    expect(workflow).toContain('--action-names ses:SendEmail ses:SendRawEmail');
    expect(workflow).toContain('sns-publish-negative-simulation.json');
    expect(workflow).toContain('--action-names sns:Publish');
    expect(workflow).not.toContain('forbidden-action-simulation.json');
  });
});
