import { describe, expect, test } from 'bun:test';

const workflowUrl = new URL(
  '../../../.github/workflows/sync-access-membership.yml',
  import.meta.url,
);
const stackUrl = new URL(
  '../../src/exploration-smoke/exploration-smoke-stack.ts',
  import.meta.url,
);
const scriptUrl = new URL(
  '../../../packages/server/scripts/exploration-smoke/sync-access-membership.ts',
  import.meta.url,
);
const providerUrl = new URL(
  '../../../packages/server/lib/auth/google-access-membership.ts',
  import.meta.url,
);

describe('exact access-membership protected entrypoint', () => {
  test('has no schedule and requires protected main-only publication approval', async () => {
    const workflow = await Bun.file(workflowUrl).text();
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('schedule:');
    expect(workflow).toContain('environment: exploration-smoke');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain('PUBLISH EXACT ACCESS MEMBERSHIP');
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
      'packages/server/scripts/exploration-smoke/sync-access-membership.ts',
    );
    expect(workflow).toContain('ACCESS_SYNC_REQUEST_ID');
    expect(workflow).toContain('ACCESS_SYNC_IDEMPOTENCY_KEY');
    expect(workflow).not.toContain('APPROVED_GOOGLE_SUBJECT:');
    expect(workflow).not.toContain('APPROVED_STAFF_EMAIL:');
    expect(workflow).not.toContain('GOOGLE_ROSTER_CONFIG", value:');
    expect(workflow).not.toContain('command: ["bun"');
  });

  test('proves app-only database and readonly Groups credential boundaries before running', async () => {
    const [workflow, stack, provider] = await Promise.all([
      Bun.file(workflowUrl).text(),
      Bun.file(stackUrl).text(),
      Bun.file(providerUrl).text(),
    ]);
    expect(stack).toContain("'AccessSyncTaskExecutionRole'");
    expect(stack).toContain("'AccessSyncTaskRole'");
    expect(stack).toContain("'/psd-eoc/google-groups'");
    expect(stack).toContain('databaseApplicationSecret.grantRead(');
    expect(workflow).toContain('DatabaseAdminSecretArn');
    expect(workflow).toContain(
      '.EvalResourceName == $admin and .EvalResourceDecision != "allowed"',
    );
    expect(workflow).toContain(
      'groups_secret_simulation_arn="$groups_secret_reference-ABCDEF"',
    );
    expect(workflow).not.toContain('aws secretsmanager describe-secret');
    expect(workflow).not.toContain('aws secretsmanager get-secret-value');
    expect(workflow).toContain(
      '--action-names secretsmanager:GetSecretValue sqs:SendMessage ses:SendEmail',
    );
    expect(provider).toContain(
      'https://www.googleapis.com/auth/cloud-identity.groups.readonly',
    );
    expect(provider).not.toContain('.setSubject(');
  });

  test('publishes only bounded aggregate proof and never uploads raw provider logs', async () => {
    const [workflow, script] = await Promise.all([
      Bun.file(workflowUrl).text(),
      Bun.file(scriptUrl).text(),
    ]);
    expect(workflow).toContain(
      'initialTransitionCandidateDirectMember == true',
    );
    expect(workflow).toContain('.activeAccessGroupCount == 2');
    expect(workflow).toContain('access-membership-publication.json');
    expect(workflow).toContain("if grep -Eq '@|users/|groups/");
    expect(workflow).not.toContain('path: $RUNNER_TEMP');
    expect(workflow).not.toContain(
      'access-sync-logs.json\n          retention',
    );
    expect(script).toContain(
      "event: z.literal('access-membership-sync-complete')",
    );
    expect(script).toContain(
      'initialTransitionCandidateDirectMember: z.literal(true)',
    );
    expect(script).not.toContain('memberEmails: result');
    expect(script).not.toContain('googleGroupId: result');
  });
});
