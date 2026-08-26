import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { requireSyntheticTestDatabaseUrl } from '../../../packages/server/lib/testing/database';
import {
  runTestDatabaseCommand,
  validatedGeneratedEnvironment,
} from '../../test-database';
import {
  parseFocusedFailureDrillResult,
  type FailureDrillScenarioId,
} from './contract';

const REPOSITORY_ROOT = new URL('../../../', import.meta.url).pathname;
const ROOT_ENVIRONMENT_PATH = new URL('../../../.env.local', import.meta.url);
const SERVER_ENVIRONMENT_PATH = new URL(
  '../../../packages/server/.env.local',
  import.meta.url,
);
const DATABASE_NAME_PATTERN = /^psd_eoc_issue31_[a-f0-9]{32}_test$/u;

const NON_DATABASE_TEST_FILES = Object.freeze([
  'scripts/ops/failure-drills/contract.test.ts',
  'scripts/ops/failure-drills/drill-callback-route.test.ts',
  'scripts/ops/failure-drills/drill-session-boundary.test.ts',
  'scripts/ops/failure-drills/finalize-evidence.test.ts',
  'scripts/ops/failure-drills/artifact-boundary.test.ts',
  'scripts/ops/failure-drills/local-test-runner.test.ts',
  'infra/test/bin/failure-drill.test.ts',
  'infra/test/stack/psd-eoc-stack.test.ts',
  'workers/shared/processor.test.ts',
  'workers/shared/reconcile.test.ts',
  'workers/email/ses-route.test.ts',
  'packages/server/lib/testing/database.test.ts',
  'packages/server/lib/roster/groups-sync.test.ts',
  'packages/server/lib/capabilities/events.test.ts',
  'packages/server/drizzle/migration-chain.test.ts',
  'packages/server/db/schema-enums.test.ts',
]);

const FOCUSED_NON_DATABASE_CAPTURE_TESTS = Object.freeze([
  Object.freeze({
    path: 'workers/shared/processor.test.ts',
    pattern:
      'crash after provider side effect relies on attempt-ID provider idempotency',
    scenarioId: 'worker-termination-mid-fanout',
  }),
  Object.freeze({
    path: 'workers/email/ses-route.test.ts',
    pattern:
      'acknowledges an exact completed replay without a second capability write',
    scenarioId: 'duplicate-provider-callback',
  }),
]);

const FOCUSED_DATABASE_TESTS = Object.freeze([
  Object.freeze({
    path: 'scripts/ops/failure-drills/drill-session-route.integration.test.ts',
    pattern: 'issues a session and starts an event from seeded mocked channels',
    scenarioId: undefined,
  }),
  Object.freeze({
    path: 'packages/server/lib/roster/groups-sync.integration.test.ts',
    pattern:
      'records a partial provider failure then activates from the retained last-good snapshot',
    scenarioId: 'roster-sync-failure-during-activation',
  }),
  Object.freeze({
    path: 'packages/server/app/(app)/events/[id]/journal.database.test.ts',
    pattern:
      'records synthetic all-clear, delayed callback recovery, and close as append-only facts',
    scenarioId: 'delayed-callback-after-all-clear',
  }),
  Object.freeze({
    path: 'packages/server/app/(admin)/devices/session-auth.test.ts',
    pattern:
      'refreshes from recently read trusted-group membership with Google offline, then revokes across instances',
    scenarioId: undefined,
  }),
]);

interface TestProcessResult {
  readonly exitCode: number;
  readonly output: string;
}

export function assertIssue31TestResult(
  result: TestProcessResult,
  expectedPassCount?: number,
): void {
  if (result.exitCode !== 0) {
    throw new Error('An issue-31 failure-drill test process failed.');
  }
  if (/^\s*[1-9]\d* (?:skip|todo)\s*$/gmu.test(result.output)) {
    throw new Error(
      'The issue-31 failure-drill gate refuses skipped or todo tests.',
    );
  }
  const passCounts = [...result.output.matchAll(/^\s*(\d+) pass\s*$/gmu)].map(
    (match) => Number(match[1]),
  );
  if (passCounts.length !== 1 || passCounts[0] === 0) {
    throw new Error(
      'The issue-31 failure-drill gate did not observe one test summary with a passing assertion.',
    );
  }
  if (expectedPassCount !== undefined && passCounts[0] !== expectedPassCount) {
    throw new Error(
      `The focused issue-31 failure-drill test must run exactly ${String(expectedPassCount)} passing assertion(s).`,
    );
  }
}

function readGeneratedDatabaseUrl(): string | undefined {
  const rootExists = existsSync(ROOT_ENVIRONMENT_PATH);
  const serverExists = existsSync(SERVER_ENVIRONMENT_PATH);
  if (!rootExists && !serverExists) return undefined;
  if (!rootExists || !serverExists) {
    throw new Error(
      'The generated synthetic database configuration is incomplete. Run `bun run test:db:stop` before retrying.',
    );
  }
  const generated = validatedGeneratedEnvironment(
    readFileSync(ROOT_ENVIRONMENT_PATH, 'utf8'),
    readFileSync(SERVER_ENVIRONMENT_PATH, 'utf8'),
  );
  return requireSyntheticTestDatabaseUrl(generated.TEST_DATABASE_URL);
}

async function resolveBaseDatabaseUrl(): Promise<{
  readonly started: boolean;
  readonly url: string;
}> {
  if (process.env.TEST_DATABASE_URL !== undefined) {
    return {
      started: false,
      url: requireSyntheticTestDatabaseUrl(process.env.TEST_DATABASE_URL),
    };
  }
  const generated = readGeneratedDatabaseUrl();
  if (generated !== undefined) {
    const sql = postgres(maintenanceUrl(generated), {
      connect_timeout: 1,
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await sql`select 1`;
      return { started: false, url: generated };
    } catch {
      // Generated configuration can outlive an interrupted Docker process. The
      // owned compose project is the only service this gate is allowed to
      // recover, and `start` rewrites the port if Docker assigns a new one.
    } finally {
      await sql.end({ timeout: 1 });
    }
  }

  const exitCode = await runTestDatabaseCommand('start');
  if (exitCode !== 0) {
    throw new Error(
      'The issue-31 failure-drill gate could not start its synthetic PostgreSQL service.',
    );
  }
  const startedUrl = readGeneratedDatabaseUrl();
  if (startedUrl === undefined) {
    throw new Error(
      'The synthetic PostgreSQL service started without generating its reserved configuration.',
    );
  }
  return { started: true, url: startedUrl };
}

function maintenanceUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

async function createIssueDatabase(
  baseUrl: string,
  databaseName: string,
): Promise<string> {
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('The issue-31 disposable database name is invalid.');
  }
  const sql = postgres(maintenanceUrl(baseUrl), {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await sql.unsafe(`create database "${databaseName}"`);
  } finally {
    await sql.end();
  }
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function dropIssueDatabase(
  baseUrl: string,
  databaseName: string,
): Promise<void> {
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error('Refusing to drop an invalid issue-31 database name.');
  }
  const sql = postgres(maintenanceUrl(baseUrl), {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await sql.unsafe(`drop database if exists "${databaseName}" (force)`);
  } finally {
    await sql.end();
  }
}

function childEnvironment(
  databaseUrl?: string,
  captureScenario?: string,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (captureScenario === undefined) {
    delete environment.PSD_EOC_FAILURE_DRILL_CAPTURE_SCENARIO;
  } else {
    environment.PSD_EOC_FAILURE_DRILL_CAPTURE_SCENARIO = captureScenario;
  }
  delete environment.PSD_EOC_ALLOW_REMOTE_TEST_DATABASE;
  if (databaseUrl === undefined) {
    delete environment.TEST_DATABASE_URL;
    delete environment.DATABASE_URL;
  } else {
    environment.TEST_DATABASE_URL = databaseUrl;
    environment.DATABASE_URL = databaseUrl;
  }
  return environment;
}

async function runTestProcess(
  arguments_: readonly string[],
  databaseUrl?: string,
  expectedPassCount?: number,
  captureScenario?: FailureDrillScenarioId,
): Promise<string> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'test', ...arguments_],
    cwd: REPOSITORY_ROOT,
    env: childEnvironment(databaseUrl, captureScenario),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  assertIssue31TestResult(
    { exitCode, output: `${stdout}\n${stderr}` },
    expectedPassCount,
  );
  if (captureScenario !== undefined) {
    parseFocusedFailureDrillResult(`${stdout}\n${stderr}`, captureScenario);
  }
  return `${stdout}\n${stderr}`;
}

export async function runIssue31TestGate(): Promise<void> {
  await runTestProcess(NON_DATABASE_TEST_FILES);
  for (const focused of FOCUSED_NON_DATABASE_CAPTURE_TESTS) {
    await runTestProcess(
      [focused.path, '--test-name-pattern', focused.pattern],
      undefined,
      1,
      focused.scenarioId,
    );
  }

  const base = await resolveBaseDatabaseUrl();
  const databaseName = `psd_eoc_issue31_${randomUUID().replaceAll('-', '')}_test`;
  let databaseCreated = false;
  const errors: unknown[] = [];
  try {
    const databaseUrl = await createIssueDatabase(base.url, databaseName);
    databaseCreated = true;
    for (const focused of FOCUSED_DATABASE_TESTS) {
      await runTestProcess(
        [focused.path, '--test-name-pattern', focused.pattern],
        databaseUrl,
        1,
        focused.scenarioId,
      );
    }
  } catch (error) {
    errors.push(error);
  } finally {
    if (databaseCreated) {
      try {
        await dropIssueDatabase(base.url, databaseName);
      } catch (error) {
        errors.push(error);
      }
    }
    if (base.started) {
      try {
        if ((await runTestDatabaseCommand('stop')) !== 0) {
          errors.push(
            new Error(
              'The issue-31 failure-drill gate could not stop its synthetic PostgreSQL service.',
            ),
          );
        }
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      'The issue-31 failure-drill gate and its cleanup both failed.',
    );
  }
}

if (import.meta.main) {
  await runIssue31TestGate();
}
