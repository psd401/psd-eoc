#!/usr/bin/env bun

import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

function requireSyntheticDatabase(): void {
  const value = process.env.TEST_DATABASE_URL;
  if (value === undefined) {
    throw new Error(
      'Issue #279 requires its PostgreSQL SMS policy cases. Run `bun run test:db:start` first.',
    );
  }
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    !parsed.pathname.endsWith('_test')
  ) {
    throw new Error('Issue #279 refuses a non-local or non-test database.');
  }
}

async function run(command: readonly string[]): Promise<void> {
  const child = Bun.spawn([...command], {
    cwd: root,
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command[0]} exited with status ${code}.`);
}

requireSyntheticDatabase();
await run([
  'bun',
  'test',
  'packages/contracts/src/email-live-pilot.test.ts',
  'workers/sms/aws-eum-adapter.test.ts',
  'workers/sms/aws-eum-client.test.ts',
  'workers/sms/delivery-events.test.ts',
  'workers/sms/opt-out.test.ts',
  'workers/sms/runtime.test.ts',
  'workers/sms/service.test.ts',
  'workers/sms/state-client.test.ts',
  'workers/sms/worker.test.ts',
  'workers/sms/sms-policy.integration.test.ts',
  'packages/server/lib/notify/sms-runtime-store.integration.test.ts',
  'packages/server/app/api/internal/aws-eum-sms-runtime/runtime.test.ts',
  'packages/server/app/(admin)/integrations/capabilities.test.ts',
  'packages/server/app/(app)/delivery-tests/capabilities.test.ts',
  'packages/server/app/(app)/delivery-tests/delivery-test-ui.test.tsx',
  'packages/server/container/image-contents.test.ts',
  'infra/test/stack/psd-eoc-stack.test.ts',
]);

console.info(
  'Issue #279 provider-free SMS worker, STOP policy, controlled-canary, and infrastructure verification passed.',
);
