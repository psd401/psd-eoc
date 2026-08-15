import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireSyntheticTestDatabaseUrl } from '../app/(admin)/event-types/test-database';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const playwrightCommand = [process.execPath, 'x', 'playwright'] as const;
const COMMAND_TIMEOUT_MS = 12 * 60_000;
const EVENT_ROOM_GATE_TIMEOUT_MS = 35 * 60_000;
const TERMINATION_GRACE_MS = 15_000;

interface BrowserCommand {
  readonly label: string;
  readonly arguments: readonly string[];
  readonly timeoutMs?: number;
}

const commands: readonly BrowserCommand[] = [
  {
    label: 'critical keyboard, forced-colors, and 200% activation journeys',
    arguments: [
      ...playwrightCommand,
      'test',
      '--config',
      'packages/server/e2e/playwright.config.ts',
    ],
  },
  {
    label: 'real, drill, join, and activation axe journeys',
    arguments: [
      ...playwrightCommand,
      'test',
      '--config',
      'packages/server/app/(app)/start/playwright.config.ts',
      '--grep',
      'dashboard exposes|real incident path|schema-valid intercepted (real|drill) activation|join-existing shows',
    ],
  },
  {
    label: 'late join, text, location, photo, and lifecycle journeys',
    arguments: [
      process.execPath,
      'test',
      'packages/server/app/(app)/events/[id]/event-room.playwright-gate.test.ts',
      '--test-name-pattern',
      'runs the owned browser suite when the synthetic database is configured',
    ],
    timeoutMs: EVENT_ROOM_GATE_TIMEOUT_MS,
  },
  {
    label: 'event-type configuration happy path and axe proof',
    arguments: [
      ...playwrightCommand,
      'test',
      '--config',
      'packages/server/e2e/admin.playwright.config.ts',
    ],
  },
  {
    label: 'facilities, access, and integration administration axe proof',
    arguments: [
      process.execPath,
      'test',
      'packages/server/app/(admin)/facilities/admin.playwright-gate.test.ts',
    ],
  },
];

if (process.env.PSD_EOC_E2E_SYNTHETIC_ONLY !== 'true') {
  throw new Error(
    'PSD_EOC_E2E_SYNTHETIC_ONLY=true is required; the E2E runner refuses any unlabeled environment.',
  );
}
// This gate is intentionally stricter than suites that support an explicitly
// approved remote test database: issue #32 must remain loopback-only because
// it performs full synthetic lifecycle mutations.
requireSyntheticTestDatabaseUrl(process.env.TEST_DATABASE_URL, false);

async function runBrowserCommand(command: BrowserCommand): Promise<void> {
  console.log(`\n[issue #32] ${command.label}`);
  const child = Bun.spawn([...command.arguments], {
    cwd: repositoryRoot,
    env: process.env,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ kind: 'exit' as const, exitCode })),
    new Promise<Readonly<{ kind: 'timeout' }>>((resolveTimeout) => {
      timeout = setTimeout(
        () => resolveTimeout({ kind: 'timeout' }),
        command.timeoutMs ?? COMMAND_TIMEOUT_MS,
      );
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);

  if (outcome.kind === 'timeout') {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), TERMINATION_GRACE_MS);
    try {
      await child.exited;
    } finally {
      clearTimeout(force);
    }
    throw new Error(`Issue #32 browser command timed out (${command.label}).`);
  }
  if (outcome.exitCode !== 0) {
    throw new Error(
      `Issue #32 browser command failed (${command.label}) with exit code ${outcome.exitCode}.`,
    );
  }
}

async function removeRunnerArtifacts(): Promise<void> {
  const results = await Promise.allSettled([
    rm('/tmp/psd-eoc-issue10-storage-state.json', { force: true }),
    rm('/tmp/psd-eoc-issue10-playwright', { force: true, recursive: true }),
    rm('/tmp/psd-eoc-issue32-admin-playwright', {
      force: true,
      recursive: true,
    }),
  ]);
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Issue #32 runner artifact cleanup failed.',
    );
  }
}

try {
  for (const command of commands) {
    await runBrowserCommand(command);
  }
} finally {
  await removeRunnerArtifacts();
}
