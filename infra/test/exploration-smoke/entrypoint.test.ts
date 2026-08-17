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
      'https://sqs.us-west-2.amazonaws.com/<aws-account-id>/psd-eoc-email-dlq',
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
];

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
  readonly events: readonly RecoveryResource[];
  readonly stackStatus: string;
}): Promise<{
  readonly exitCode: number;
  readonly importArguments: string | undefined;
  readonly mapping: unknown;
  readonly result: unknown;
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
    const importMarker = join(directory, 'imported');
    const importArguments = join(directory, 'import-arguments.txt');
    await Promise.all([
      Bun.write(
        beforeFile,
        JSON.stringify({ StackResourceSummaries: options.before }),
      ),
      Bun.write(
        managedFile,
        JSON.stringify({
          StackResourceSummaries: retainedRecoveryResources.map((resource) => ({
            ...resource,
            ResourceStatus: 'IMPORT_COMPLETE',
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
              Outputs: [
                {
                  OutputKey: 'AppRunnerVpcConnectorArn',
                  OutputValue:
                    'arn:aws:apprunner:us-west-2:<aws-account-id>:vpcconnector/psd-eoc-exploration-smoke-native/1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                },
              ],
              StackStatus: options.stackStatus,
            },
          ],
        }),
      ),
      Bun.write(
        join(cdkOut, 'PsdEocExplorationSmoke.template.json'),
        JSON.stringify({
          Resources: {
            EmailConfigurationSet: {
              DeletionPolicy: 'Retain',
              Properties: {
                Name: 'psd-eoc-transactional',
                SendingOptions: { SendingEnabled: false },
              },
              Type: 'AWS::SES::ConfigurationSet',
            },
            EmailDeadLetterQueue5E91C06C: {
              DeletionPolicy: 'Retain',
              Properties: {
                QueueName: 'psd-eoc-email-dlq',
                SqsManagedSseEnabled: true,
              },
              Type: 'AWS::SQS::Queue',
            },
            EmailEventsKey619540BF: {
              DeletionPolicy: 'Retain',
              Properties: { EnableKeyRotation: true },
              Type: 'AWS::KMS::Key',
            },
            EmailWorkerLogGroup0611E5C2: {
              DeletionPolicy: 'Retain',
              Properties: {
                LogGroupName: '/psd-eoc/workers/email',
                RetentionInDays: 14,
              },
              Type: 'AWS::Logs::LogGroup',
            },
          },
        }),
      ),
    ]);

    const awsPath = join(fakeBin, 'aws');
    const bunxPath = join(fakeBin, 'bunx');
    await Promise.all([
      Bun.write(
        awsPath,
        `#!/usr/bin/env bash
set -euo pipefail
case "$1:$2" in
  cloudformation:describe-stacks) cat "$STACK_FIXTURE" ;;
  cloudformation:list-stack-resources)
    if [[ -e "$IMPORT_MARKER" ]]; then cat "$MANAGED_FIXTURE"; else cat "$BEFORE_FIXTURE"; fi
    ;;
  cloudformation:describe-stack-events) cat "$EVENTS_FIXTURE" ;;
  sts:assume-role)
    printf '%s\\n' '{"AccessKeyId":"test","SecretAccessKey":"test","SessionToken":"test"}'
    ;;
  *) exit 91 ;;
esac
`,
      ),
      Bun.write(
        bunxPath,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$IMPORT_ARGUMENTS"
touch "$IMPORT_MARKER"
`,
      ),
    ]);
    await Promise.all([chmod(awsPath, 0o755), chmod(bunxPath, 0o755)]);

    const child = Bun.spawnSync({
      cmd: ['bash', '-c', recoveryScript(await readWorkflow())],
      cwd: infra,
      env: {
        ...process.env,
        AWS_ACCOUNT_ID: '<aws-account-id>',
        AWS_REGION: 'us-west-2',
        BEFORE_FIXTURE: beforeFile,
        CDK_DEPLOY_ROLE_ARN:
          'arn:aws:iam::<aws-account-id>:role/cdk-hnb659fds-deploy-role-<aws-account-id>-us-west-2',
        EVENTS_FIXTURE: eventsFile,
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_RUN_ID: '1',
        IMPORT_ARGUMENTS: importArguments,
        IMPORT_MARKER: importMarker,
        MANAGED_FIXTURE: managedFile,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        STACK_FIXTURE: stackFile,
        STACK_NAME: 'PsdEocExplorationSmoke',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });

    const mappingPath = join(readback, 'email-recovery-resource-mapping.json');
    const resultPath = join(readback, 'email-recovery-result.json');
    return {
      exitCode: child.exitCode,
      importArguments: (await Bun.file(importArguments).exists())
        ? await Bun.file(importArguments).text()
        : undefined,
      mapping: (await Bun.file(mappingPath).exists())
        ? await Bun.file(mappingPath).json()
        : undefined,
      result: (await Bun.file(resultPath).exists())
        ? await Bun.file(resultPath).json()
        : undefined,
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
    expect(bootstrapStep).toBeGreaterThan(publishStep);
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
    expect(workflow).toContain('$database_application_secret_arn:username::');
    expect(workflow).toContain('$approved_identity_secret_arn:googleSubject::');
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
      "deployment_authority_pattern='^(arn:aws:iam::<aws-account-id>:role/",
    );
    expect(workflow).toContain(
      '[[ "$APPROVED_IDENTITY_SHA256" =~ ^[0-9a-f]{64},[0-9a-f]{64},[0-9a-f]{64}$ ]]',
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
    expect(workflow).toContain('import "$STACK_NAME" \\');
    expect(workflow).toContain('--resource-mapping "$mapping"');
    expect(workflow).toContain(
      'Retained dark-email resources are partial or ambiguous; refusing recovery.',
    );
    expect(workflow).toContain(
      "jq -n --arg state already-managed '{state: $state}'",
    );
    expect(workflow).toContain("jq -n --arg state imported '{state: $state}'");
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
    expect(workflow).not.toContain('aws kms schedule-key-deletion');
  });

  it('imports the exact four-resource rollback inventory from the prior live stack', async () => {
    const recovery = await runRecoveryScenario({
      before: retainedRecoveryResources,
      events: retainedRecoveryResources,
      stackStatus: 'UPDATE_ROLLBACK_COMPLETE',
    });

    expect(recovery.exitCode).toBe(0);
    expect(recovery.result).toEqual({ state: 'imported' });
    expect(recovery.mapping).toEqual({
      EmailConfigurationSet: { Name: 'psd-eoc-transactional' },
      EmailDeadLetterQueue5E91C06C: {
        QueueUrl:
          'https://sqs.us-west-2.amazonaws.com/<aws-account-id>/psd-eoc-email-dlq',
      },
      EmailEventsKey619540BF: {
        KeyId: '01234567-89ab-cdef-0123-456789abcdef',
      },
      EmailWorkerLogGroup0611E5C2: {
        LogGroupName: '/psd-eoc/workers/email',
      },
    });
    expect(recovery.importArguments).toContain(
      'import\nPsdEocExplorationSmoke',
    );
    expect(recovery.importArguments).toContain('--force');
    expect(recovery.importArguments).toContain('--resource-mapping');
  });

  it('retries idempotently without another import once all four resources are managed', async () => {
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
    expect(recovery.importArguments).toBeUndefined();
    expect(recovery.mapping).toBeUndefined();
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
    expect(recovery.importArguments).toBeUndefined();
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
      'select(.Type == "AWS::SES::ConfigurationSetEventDestination")] | length\' "$template")" -eq 1',
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
      '"AWS:SourceArn": "arn:aws:ses:us-west-2:<aws-account-id>:configuration-set/psd-eoc-transactional"',
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
    expect(workflow).not.toContain('aws sqs send-message');
    expect(workflow).not.toContain('aws ses send-email');
    expect(workflow).not.toContain('aws sesv2 send-email');
    expect(workflow).not.toContain('aws sns subscribe');
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
