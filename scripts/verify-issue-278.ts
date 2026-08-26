#!/usr/bin/env bun

import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const firebaseRoot = resolve(root, 'infra/gcp/firebase');
const terraformImage = 'hashicorp/terraform:1.9.8';

async function run(command: readonly string[], cwd = root): Promise<void> {
  const child = Bun.spawn([...command], {
    cwd,
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`${command[0]} exited with status ${code}.`);
  }
}

async function terraformSupportsMockProviders(): Promise<boolean> {
  try {
    const child = Bun.spawn(['terraform', 'version', '-json'], {
      cwd: firebaseRoot,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) return false;
    const version = String(
      (JSON.parse(output) as { terraform_version?: unknown }).terraform_version,
    );
    const [major, minor] = version.split('.').map(Number);
    return major === 1 && Number.isInteger(minor) && (minor ?? 0) >= 7;
  } catch {
    return false;
  }
}

function requireSyntheticDatabase(): void {
  const value = process.env.TEST_DATABASE_URL;
  if (value === undefined) {
    throw new Error(
      'Issue #278 requires its PostgreSQL lifecycle cases. Run `bun run test:db:start` first.',
    );
  }
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    !parsed.pathname.endsWith('_test')
  ) {
    throw new Error('Issue #278 refuses a non-local or non-test database.');
  }
}

async function verifyTerraformPlan(): Promise<void> {
  if (await terraformSupportsMockProviders()) {
    await run(
      ['terraform', 'init', '-backend=false', '-input=false'],
      firebaseRoot,
    );
    await run(['terraform', 'test', '-no-color'], firebaseRoot);
    return;
  }

  const mount = `${firebaseRoot}:/workspace`;
  const prefix = [
    'docker',
    'run',
    '--rm',
    '--volume',
    mount,
    '--workdir',
    '/workspace',
    terraformImage,
  ] as const;
  await run([...prefix, 'init', '-backend=false', '-input=false']);
  await run([...prefix, 'test', '-no-color']);
}

requireSyntheticDatabase();
await verifyTerraformPlan();
await run([
  'bun',
  'test',
  'packages/contracts/src/email-live-pilot.test.ts',
  'workers/shared/processor.test.ts',
  'workers/shared/attempt-execution-client.test.ts',
  'workers/push/adapter.test.ts',
  'workers/push/receipt-lifecycle.test.ts',
  'workers/push/runtime.test.ts',
  'workers/push/service.test.ts',
  'workers/push/state-client.test.ts',
  'workers/push/transport.test.ts',
  'workers/push/worker.test.ts',
  'packages/server/app/api/internal/expo-push-runtime/runtime.test.ts',
  'packages/server/app/api/devices/persistence.integration.test.ts',
  'packages/mobile/src/lib/push/app-state-readiness.test.ts',
  'packages/mobile/src/lib/push/notification-content.test.ts',
  'packages/mobile/src/lib/push/registration-controller.test.ts',
  'packages/mobile/src/lib/push/response-controller.test.ts',
  'packages/mobile/e2e/harness.test.ts',
  'infra/test/gcp/firebase-isolation.test.ts',
]);
await run(['bun', 'packages/mobile/e2e/mobile-push-deep-link.flow.ts']);

console.info(
  'Issue #278 provider-free worker, PostgreSQL, Firebase-plan, and mobile lifecycle verification passed.',
);
