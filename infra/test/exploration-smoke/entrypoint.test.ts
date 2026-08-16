import { describe, expect, it } from 'bun:test';

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
      'phase_runtime_idle_timeout=$current_runtime_idle_timeout',
    );
    expect(workflow).toContain('phase_source_sha=$current_source_sha');
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
      "deployment_authority_pattern='^(arn:aws:iam::338414773271:role/",
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

  it('admits a completed rollback without automating failed rollback recovery', async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain(
      'CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE)',
    );
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

  it('proves the exact live runtime role and queue have zero send authority', async () => {
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
    expect(workflow).toContain('health-queue-send-negative-simulation.json');
    expect(workflow).toContain('--action-names sqs:SendMessage');
    expect(workflow).toContain('--resource-arns "$queue_arn"');
    expect(workflow).not.toContain('forbidden-action-simulation.json');
  });
});
