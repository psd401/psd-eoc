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

async function readWorkflow(): Promise<string> {
  return Bun.file(workflowUrl).text();
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

  it('keeps workflow publication, bootstrap order, and readback redaction aligned', async () => {
    const workflow = await readWorkflow();
    const bootstrapStep = workflow.indexOf(
      '- name: Bootstrap synthetic data before starting App Runner',
    );
    const serviceStep = workflow.indexOf(
      '- name: Deploy the exact digest after bootstrap',
    );
    const deployJobHeader = workflow.match(
      /\n {2}deploy:\n([\s\S]*?)\n {4}steps:/,
    )?.[1];

    expect(workflow).toContain(EXPLORATION_SMOKE_REPOSITORY_NAME);
    expect(workflow).not.toContain('repository/psd-eoc-exploration-smoke');
    expect(bootstrapStep).toBeGreaterThan(-1);
    expect(serviceStep).toBeGreaterThan(bootstrapStep);
    expect(workflow).not.toContain(
      'describe-service --service-arn "$service_arn" > artifacts/readback/app-runner-service.json',
    );
    expect(workflow).toContain('unset app_runner_service');
    expect(workflow).toContain('aws apprunner list-services');
    expect(workflow).not.toContain('RuntimeEnvironmentVariables');
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
    expect(workflow).not.toContain('aws logs get-log-events');
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
