import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const productionDockerfile = new URL(
  '../../../packages/server/container/psd-eoc.Dockerfile',
  import.meta.url,
);
const drillDockerfile = new URL(
  '../../../packages/server/container/failure-drill.Dockerfile',
  import.meta.url,
);
const drillWorkflow = new URL(
  '../../../.github/workflows/failure-drill.yml',
  import.meta.url,
);
const deployWorkflow = new URL(
  '../../../.github/workflows/deploy.yml',
  import.meta.url,
);
const productionBuild = new URL(
  '../../../packages/server/.next/server',
  import.meta.url,
);

async function emittedFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? emittedFiles(path) : [path];
    }),
  );
  return files.flat();
}

test('production artifact structurally excludes every failure-drill control', async () => {
  const production = await readFile(productionDockerfile, 'utf8');
  for (const forbidden of [
    'failure-drill-runner',
    'failure-drills/session',
    'failure-drills/callback',
    'drill-session-route',
    'PSD_EOC_FAILURE_DRILL',
  ]) {
    expect(production).not.toContain(forbidden);
  }
});

if (process.env.PSD_EOC_VERIFY_BUILT_PRODUCTION === 'true') {
  test('production build structurally excludes drill routes, helpers, environment switches, and dependencies', async () => {
    const files = await emittedFiles(productionBuild.pathname);
    expect(files.length).toBeGreaterThan(0);

    const forbidden = [
      '/api/failure-drills/',
      'app/api/failure-drills',
      'failure-drill-runner',
      'deployed-mock-worker',
      'drill-session-route',
      'drill-callback-route',
      'PSD_EOC_FAILURE_DRILL',
      '@aws-sdk/client-cloudwatch',
      '@aws-sdk/client-ecs',
      '@aws-sdk/client-sqs',
      'FailoverDBClusterCommand',
      'StartMessageMoveTaskCommand',
    ] as const;
    for (const path of files) {
      const emitted = await readFile(path, 'utf8');
      for (const marker of forbidden) {
        expect(emitted).not.toContain(marker);
      }
    }
  });
}

test('the separate synthetic artifact adds the runner and operator route at build time', async () => {
  const drill = await readFile(drillDockerfile, 'utf8');
  expect(drill).toContain(
    'scripts/ops/failure-drills ./scripts/ops/failure-drills',
  );
  expect(drill).toContain(
    'packages/server/app/api/failure-drills/session/route.ts',
  );
  expect(drill).toContain(
    'packages/server/app/api/failure-drills/callback/route.ts',
  );
  expect(drill).toContain('org.psd-eoc.provider-mode="mocked"');
});

test('the drill workflow uses a fresh exact stack and receives no live secret namespace', async () => {
  const [drill, deploy] = await Promise.all([
    readFile(drillWorkflow, 'utf8'),
    readFile(deployWorkflow, 'utf8'),
  ]);
  expect(drill).toContain('environment: failure-drill');
  expect(drill).toContain('aws cloudformation describe-stacks');
  expect(drill).toContain('already exists. Choose a fresh run_id');
  expect(drill).toContain('FAILURE_DRILL_CDK_STACK_ID: FailureDrill');
  expect(drill).toContain('deploy "$FAILURE_DRILL_CDK_STACK_ID"');
  expect(drill).toContain('destroy "$FAILURE_DRILL_CDK_STACK_ID"');
  expect(drill).not.toContain('deploy "$FAILURE_DRILL_STACK_NAME"');
  expect(drill).not.toContain('destroy "$FAILURE_DRILL_STACK_NAME"');
  expect(drill).toContain('aws cloudformation list-stack-resources');
  expect(drill).toContain('checkedResources:[],remainingResources:[]');
  expect(drill).toContain('aws ecs stop-task');
  expect(drill).toContain('cleanup-observation.json');
  for (const readback of [
    'describe-db-clusters',
    'describe-db-instances',
    'apprunner describe-service',
    'ecr describe-repositories',
    'sqs get-queue-attributes',
    'logs describe-log-groups',
    'secretsmanager describe-secret',
  ]) {
    expect(drill).toContain(readback);
  }
  expect(drill).not.toContain('${{ secrets.');
  expect(deploy).not.toContain('secrets: inherit');
});
