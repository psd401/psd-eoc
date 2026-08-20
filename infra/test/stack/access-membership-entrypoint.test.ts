import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflowUrl = new URL(
  '../../../.github/workflows/sync-access-membership.yml',
  import.meta.url,
);
const stackUrl = new URL('../../src/stack/psd-eoc-stack.ts', import.meta.url);
const scriptUrl = new URL(
  '../../../packages/server/scripts/operations/sync-access-membership.ts',
  import.meta.url,
);
const providerUrl = new URL(
  '../../../packages/server/lib/auth/google-access-membership.ts',
  import.meta.url,
);

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

async function runOuterRoleExecutionProof(options?: {
  readonly allowNeighborCluster?: boolean;
  readonly allowNeighborRoles?: boolean;
  readonly allowNeighborTask?: boolean;
  readonly allowWrongService?: boolean;
  readonly denyExactRunTask?: boolean;
}): Promise<{
  readonly actions: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;
}> {
  const directory = await mkdtemp(
    join(tmpdir(), 'psd-eoc-access-stage-proof-'),
  );
  try {
    const fakeBin = join(directory, 'bin');
    const readback = join(directory, 'artifacts', 'readback');
    const actionsPath = join(directory, 'aws-actions.txt');
    await Promise.all([
      mkdir(fakeBin, { recursive: true }),
      mkdir(readback, { recursive: true }),
    ]);
    const awsPath = join(fakeBin, 'aws');
    await Bun.write(
      awsPath,
      `#!/usr/bin/env bash
set -euo pipefail
test "$1:$2" = "iam:simulate-principal-policy"
shift 2
policy_source=
action_name=
context_entries=
resources=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --policy-source-arn)
      policy_source=$2
      shift 2
      ;;
    --action-names)
      action_name=$2
      shift 2
      ;;
    --resource-arns)
      shift
      while [[ $# -gt 0 && "$1" != --* ]]; do
        resources+=("$1")
        shift
      done
      ;;
    --context-entries)
      context_entries=$2
      shift 2
      ;;
    *) exit 96 ;;
  esac
done
test "$policy_source" = "$DEPLOY_ROLE_ARN"
printf '%s\\n' "$action_name" >> "$AWS_ACTIONS"

case "$action_name" in
  ecs:RunTask)
    test "\${#resources[@]}" -eq 1
    exact_context="ContextKeyName=ecs:cluster,ContextKeyValues=$EXACT_CLUSTER_ARN,ContextKeyType=string"
    neighbor_context="ContextKeyName=ecs:cluster,ContextKeyValues=$NEIGHBOR_CLUSTER_ARN,ContextKeyType=string"
    if [[ "\${resources[0]}" == "$TASK_DEFINITION_ARN" && "$context_entries" == "$exact_context" ]]; then
      if [[ "$DENY_EXACT_RUN_TASK" == "true" ]]; then
        decision=implicitDeny
      else
        decision=allowed
      fi
    elif [[ "\${resources[0]}" == "$NEIGHBOR_TASK_DEFINITION_ARN" && "$context_entries" == "$exact_context" ]]; then
      if [[ "$ALLOW_NEIGHBOR_TASK" == "true" ]]; then
        decision=allowed
      else
        decision=implicitDeny
      fi
    elif [[ "\${resources[0]}" == "$TASK_DEFINITION_ARN" && "$context_entries" == "$neighbor_context" ]]; then
      if [[ "$ALLOW_NEIGHBOR_CLUSTER" == "true" ]]; then
        decision=allowed
      else
        decision=implicitDeny
      fi
    else
      exit 95
    fi
    jq -n --arg decision "$decision" '{
      EvaluationResults: [{EvalDecision: $decision}]
    }'
    ;;
  iam:PassRole)
    test "\${#resources[@]}" -eq 2
    exact_context="ContextKeyName=iam:PassedToService,ContextKeyValues=ecs-tasks.amazonaws.com,ContextKeyType=string"
    wrong_context="ContextKeyName=iam:PassedToService,ContextKeyValues=lambda.amazonaws.com,ContextKeyType=string"
    if [[ "\${resources[0]}" == "$EXECUTION_ROLE_ARN" && "\${resources[1]}" == "$TASK_ROLE_ARN" ]]; then
      if [[ "$context_entries" == "$exact_context" ]]; then
        decision=allowed
      elif [[ "$context_entries" == "$wrong_context" && "$ALLOW_WRONG_SERVICE" == "true" ]]; then
        decision=allowed
      elif [[ "$context_entries" == "$wrong_context" ]]; then
        decision=implicitDeny
      else
        exit 94
      fi
    elif [[ "\${resources[0]}" == "$NEIGHBOR_EXECUTION_ROLE_ARN" && "\${resources[1]}" == "$NEIGHBOR_TASK_ROLE_ARN" ]]; then
      test "$context_entries" = "$exact_context"
      if [[ "$ALLOW_NEIGHBOR_ROLES" == "true" ]]; then
        decision=allowed
      else
        decision=implicitDeny
      fi
    else
      exit 93
    fi
    jq -n \\
      --arg decision "$decision" \\
      --arg execution "\${resources[0]}" \\
      --arg task "\${resources[1]}" '{
        EvaluationResults: [{
          EvalDecision: $decision,
          ResourceSpecificResults: [
            {EvalResourceDecision: $decision, EvalResourceName: $execution},
            {EvalResourceDecision: $decision, EvalResourceName: $task}
          ]
        }]
      }'
    ;;
  *) exit 92 ;;
esac
`,
    );
    await chmod(awsPath, 0o755);
    const executionRoleArn =
      'arn:aws:iam::<aws-account-id>:role/PsdEocExplorationSmoke-AccessSyncTaskExecutionRole-test';
    const taskRoleArn =
      'arn:aws:iam::<aws-account-id>:role/PsdEocExplorationSmoke-AccessSyncTaskRole-test';
    const neighborExecutionRoleArn =
      'arn:aws:iam::<aws-account-id>:role/PsdEocExplorationSmoke-NeighborTaskExecutionRole';
    const neighborTaskRoleArn =
      'arn:aws:iam::<aws-account-id>:role/PsdEocExplorationSmoke-NeighborTaskRole';
    const exactClusterArn =
      'arn:aws:ecs:us-west-2:<aws-account-id>:cluster/psd-eoc-exploration-smoke-native-bootstrap';
    const neighborClusterArn =
      'arn:aws:ecs:us-west-2:<aws-account-id>:cluster/psd-eoc-not-exploration-smoke';
    const taskDefinitionArn =
      'arn:aws:ecs:us-west-2:<aws-account-id>:task-definition/psd-eoc-exploration-smoke-access-sync:1';
    const child = Bun.spawnSync({
      cmd: [
        'bash',
        '-c',
        `set -euo pipefail\n${markedShellBlock(
          await Bun.file(workflowUrl).text(),
          'access-sync outer-role exact execution simulation',
        )}`,
      ],
      cwd: directory,
      env: {
        ...process.env,
        ALLOW_NEIGHBOR_CLUSTER: String(options?.allowNeighborCluster ?? false),
        ALLOW_NEIGHBOR_ROLES: String(options?.allowNeighborRoles ?? false),
        ALLOW_NEIGHBOR_TASK: String(options?.allowNeighborTask ?? false),
        ALLOW_WRONG_SERVICE: String(options?.allowWrongService ?? false),
        AWS_ACCOUNT_ID: '<aws-account-id>',
        AWS_ACTIONS: actionsPath,
        AWS_REGION: 'us-west-2',
        DENY_EXACT_RUN_TASK: String(options?.denyExactRunTask ?? false),
        DEPLOY_ROLE_ARN:
          'arn:aws:iam::<aws-account-id>:role/psd-eoc-exploration-smoke-github-deploy',
        EXACT_CLUSTER_ARN: exactClusterArn,
        EXECUTION_ROLE_ARN: executionRoleArn,
        NEIGHBOR_CLUSTER_ARN: neighborClusterArn,
        NEIGHBOR_EXECUTION_ROLE_ARN: neighborExecutionRoleArn,
        NEIGHBOR_TASK_DEFINITION_ARN:
          'arn:aws:ecs:us-west-2:<aws-account-id>:task-definition/psd-eoc-not-exploration-smoke-access-sync:1',
        NEIGHBOR_TASK_ROLE_ARN: neighborTaskRoleArn,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        TASK_DEFINITION_ARN: taskDefinitionArn,
        TASK_ROLE_ARN: taskRoleArn,
        cluster_arn: exactClusterArn,
        execution_role_arn: executionRoleArn,
        task_definition_arn: taskDefinitionArn,
        task_role_arn: taskRoleArn,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    return {
      actions: (await Bun.file(actionsPath).exists())
        ? (await Bun.file(actionsPath).text()).trim().split('\n')
        : [],
      exitCode: child.exitCode,
      stderr: child.stderr.toString(),
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe('exact access-membership protected entrypoint', () => {
  test('has no schedule and requires protected main-only publication approval', async () => {
    const workflow = await Bun.file(workflowUrl).text();
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('schedule:');
    expect(workflow).toContain('environment: exploration-smoke');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain('STAGE EXACT ACCESS MEMBERSHIP');
    expect(workflow).toContain('FINALIZE PROVEN MOBILE ACCESS');
    expect(workflow).toContain('type: choice');
    expect(workflow).toContain('mobile_session_id:');
    expect(workflow).toContain('membership_snapshot_id:');
    expect(workflow).toContain('AWS_EXPLORATION_SMOKE_DEPLOY_POLICY_SHA256');
    expect(workflow).toContain(
      'AWS_EXPLORATION_SMOKE_DEPLOY_PERMISSIONS_BOUNDARY_ARN',
    );
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main',
    );
  });

  test('runs only the dedicated digest-pinned private task with nonsecret run identity overrides', async () => {
    const workflow = await Bun.file(workflowUrl).text();
    expect(workflow).toContain('AccessSyncTaskDefinitionArn');
    expect(workflow).toContain('psd-eoc-exploration-smoke-access-sync:');
    expect(workflow).toContain('assignPublicIp=DISABLED');
    expect(workflow).toContain('$repository_uri@$IMAGE_DIGEST');
    expect(workflow).toContain(
      'packages/server/scripts/operations/sync-access-membership.ts',
    );
    expect(workflow).toContain('ACCESS_SYNC_REQUEST_ID');
    expect(workflow).toContain('ACCESS_SYNC_IDEMPOTENCY_KEY');
    expect(workflow).toContain('ACCESS_SYNC_PHASE');
    expect(workflow).toContain('ACCESS_SYNC_MOBILE_SESSION_ID');
    expect(workflow).toContain('ACCESS_SYNC_MEMBERSHIP_SNAPSHOT_ID');
    expect(workflow).not.toContain('APPROVED_GOOGLE_SUBJECT:');
    expect(workflow).not.toContain('APPROVED_STAFF_EMAIL:');
    expect(workflow).not.toContain('GOOGLE_ROSTER_CONFIG", value:');
    expect(workflow).not.toContain('command: ["bun"');
  });

  test('binds the deployed app-only task without inspecting its IAM roles', async () => {
    const [workflow, stack, provider] = await Promise.all([
      Bun.file(workflowUrl).text(),
      Bun.file(stackUrl).text(),
      Bun.file(providerUrl).text(),
    ]);
    expect(stack).toContain("'AccessSyncTaskExecutionRole'");
    expect(stack).toContain("'AccessSyncTaskRole'");
    // Imported by complete ARN, not by name. The bare name must not appear as
    // a secret locator: Secrets Manager parses a suffix-less ARN ending in a
    // hyphen plus six characters ("-groups") as a different secret entirely.
    expect(stack).toContain("'GoogleGroupsSecretArn'");
    expect(stack).toContain('fromSecretCompleteArn');
    expect(stack).not.toContain("'/psd-eoc/google-groups'");
    expect(stack).toContain('databaseApplicationSecret.grantRead(');
    expect(stack).toContain("'PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256'");
    expect(workflow).not.toContain('DatabaseAdminSecretArn');
    expect(workflow).not.toContain('groups_secret_simulation_arn');
    expect(workflow).not.toContain('--policy-source-arn "$execution_role_arn"');
    expect(workflow).not.toContain('--policy-source-arn "$task_role_arn"');
    expect(
      [...workflow.matchAll(/--policy-source-arn "([^"]+)"/gu)].map(
        ([, source]) => source,
      ),
    ).toEqual(Array.from({ length: 6 }, () => '$DEPLOY_ROLE_ARN'));
    expect(workflow).not.toContain('aws secretsmanager describe-secret');
    expect(workflow).not.toContain('aws secretsmanager get-secret-value');
    expect(workflow).not.toContain(
      '--action-names secretsmanager:GetSecretValue',
    );
    expect(workflow).not.toContain('--action-names sqs:SendMessage');
    expect(workflow).not.toContain('--action-names ses:SendEmail');
    expect(provider).toContain(
      'https://www.googleapis.com/auth/cloud-identity.groups.readonly',
    );
    expect(provider).not.toContain('.setSubject(');
  });

  test('executes exact outer-role authority and fails on every broader boundary', async () => {
    const exact = await runOuterRoleExecutionProof();
    expect(exact.stderr).toBe('');
    expect(exact.exitCode).toBe(0);
    expect(exact.actions).toEqual([
      'ecs:RunTask',
      'ecs:RunTask',
      'ecs:RunTask',
      'iam:PassRole',
      'iam:PassRole',
      'iam:PassRole',
    ]);

    const deniedExactRun = await runOuterRoleExecutionProof({
      denyExactRunTask: true,
    });
    expect(deniedExactRun.exitCode).not.toBe(0);
    expect(deniedExactRun.actions).toEqual(['ecs:RunTask']);

    const broadTask = await runOuterRoleExecutionProof({
      allowNeighborTask: true,
    });
    expect(broadTask.exitCode).not.toBe(0);
    expect(broadTask.actions).toEqual(['ecs:RunTask', 'ecs:RunTask']);

    const broadCluster = await runOuterRoleExecutionProof({
      allowNeighborCluster: true,
    });
    expect(broadCluster.exitCode).not.toBe(0);
    expect(broadCluster.actions).toEqual([
      'ecs:RunTask',
      'ecs:RunTask',
      'ecs:RunTask',
    ]);

    const broadService = await runOuterRoleExecutionProof({
      allowWrongService: true,
    });
    expect(broadService.exitCode).not.toBe(0);
    expect(broadService.actions).toEqual([
      'ecs:RunTask',
      'ecs:RunTask',
      'ecs:RunTask',
      'iam:PassRole',
      'iam:PassRole',
    ]);

    const broadRoles = await runOuterRoleExecutionProof({
      allowNeighborRoles: true,
    });
    expect(broadRoles.exitCode).not.toBe(0);
    expect(broadRoles.actions).toEqual([
      'ecs:RunTask',
      'ecs:RunTask',
      'ecs:RunTask',
      'iam:PassRole',
      'iam:PassRole',
      'iam:PassRole',
    ]);
  });

  test('publishes only bounded aggregate proof and never uploads raw provider logs', async () => {
    const [workflow, script] = await Promise.all([
      Bun.file(workflowUrl).text(),
      Bun.file(scriptUrl).text(),
    ]);
    expect(workflow).toContain('.proofKind == "initial-selector-match"');
    expect(workflow).toContain('.proofKind == "durable-ios-session"');
    expect(workflow).toContain('.activeAccessGroupCount == 2');
    expect(workflow).toContain('.activeAccessGroupCount == 1');
    expect(workflow).toContain('.auditEntryHash == null');
    expect(workflow).toContain('access-membership-publication.json');
    expect(workflow).toContain("if grep -Eq '@|users/|groups/");
    expect(workflow).not.toContain('path: $RUNNER_TEMP');
    expect(workflow).not.toContain(
      'access-sync-logs.json\n          retention',
    );
    expect(script).toContain(
      "event: z.literal('access-membership-sync-complete')",
    );
    // One run identity, no phases: the sync reads the configured groups and
    // replaces their membership. The staged/finalized protocol and its
    // compiled-in mobile selector are gone.
    expect(script).toContain('ACCESS_SYNC_REQUEST_ID');
    expect(script).toContain('ACCESS_SYNC_IDEMPOTENCY_KEY');
    expect(script).not.toContain("phase: z.literal('finalize')");
    expect(script).not.toContain(
      'PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256',
    );
    // The summary stays an aggregate: no member emails, no provider group id.
    expect(script).not.toContain('memberEmails: result');
    expect(script).not.toContain('googleGroupId: result');
  });
});
