#!/usr/bin/env bun

import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

async function run(command: readonly string[]): Promise<void> {
  const child = Bun.spawn([...command], {
    cwd: root,
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

function requireSyntheticDatabase(): void {
  const value = process.env.TEST_DATABASE_URL;
  if (value === undefined) {
    throw new Error(
      'Issue #43 requires its PostgreSQL registration and invalidation cases. Run `bun run test:db:start` first.',
    );
  }
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    !parsed.pathname.endsWith('_test')
  ) {
    throw new Error('Issue #43 refuses a non-local or non-test database.');
  }
}

requireSyntheticDatabase();
const ciWorkflow = await Bun.file(
  resolve(root, '.github/workflows/ci.yml'),
).text();
if (
  !ciWorkflow.includes(
    "contains(github.event.pull_request.labels.*.name, 'direct-push-cutover')",
  )
) {
  throw new Error(
    'Issue #43 requires the direct-push-cutover label to trigger native E2E.',
  );
}
await run([
  'bun',
  'test',
  'packages/contracts/src/contracts.test.ts',
  'packages/server/app/(admin)/integrations/capabilities.test.ts',
  'packages/server/app/(admin)/integrations/integrations-admin-view.test.tsx',
  'packages/server/app/api/devices/capabilities.test.ts',
  'packages/server/app/api/devices/persistence.integration.test.ts',
  'packages/server/lib/notify/event-audience.database.test.ts',
  'packages/server/lib/push-provider-cutover.test.ts',
  'packages/server/lib/roster/groups-sync.test.ts',
  'packages/mobile/src/lib/push/registration-controller.test.ts',
  'workers/push/apns-credentials.test.ts',
  'workers/push/apns-transport.test.ts',
  'workers/push/fcm-credentials.test.ts',
  'workers/push/fcm-transport.test.ts',
  'workers/push/provider-clients.test.ts',
  'workers/push/direct-adapter.test.ts',
  'workers/push/direct-worker.test.ts',
  'workers/push/provider-comparison.test.ts',
  'workers/push/service.test.ts',
  'infra/test/stack/psd-eoc-stack.test.ts',
]);
await run([
  'bun',
  'test',
  '--test-name-pattern',
  'direct push migration upgrade',
  'packages/server/drizzle/database.integration.test.ts',
]);
await run([
  'bun',
  'test',
  '--test-name-pattern',
  'configures a complete new site',
  'packages/server/app/(admin)/facilities/capabilities.database.test.ts',
]);
await run(['bun', 'packages/mobile/e2e/direct-push-cutover.flow.ts']);

console.info(
  'Issue #43 provider-free direct cutover, APNs/FCM contracts, PostgreSQL lifecycle, mobile registration, and infrastructure verification passed.',
);
