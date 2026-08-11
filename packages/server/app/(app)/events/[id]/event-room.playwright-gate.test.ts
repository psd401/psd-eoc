import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';

import { createDatabaseClient } from '../../../../db/client';
import {
  cleanupEventRoomPlaywrightRunAfterChildExit,
  inspectEventRoomPlaywrightPortLease,
  requireSyntheticEventRoomTestDatabaseUrl,
  resolveEventRoomPlaywrightRunContext,
  type EventRoomPlaywrightRunContext,
} from './test-database';

const playwrightConfig = fileURLToPath(
  new URL('./playwright.config.ts', import.meta.url),
);
const workspaceRoot = fileURLToPath(
  new URL('../../../../../../', import.meta.url),
);
const testWithDatabase =
  process.env.TEST_DATABASE_URL === undefined ? test.skip : test;

async function cleanExactGateRun(
  context: EventRoomPlaywrightRunContext,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    const admin = createDatabaseClient({
      driver: 'postgres',
      url: context.baseDatabaseUrl,
      maxConnections: 1,
    });
    if (admin.driver !== 'postgres') {
      throw new Error('Event-room Playwright cleanup requires PostgreSQL.');
    }
    try {
      await admin.db.execute(
        sql.raw(
          `drop database if exists "${context.databaseName}" with (force)`,
        ),
      );
    } finally {
      await admin.close();
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await cleanupEventRoomPlaywrightRunAfterChildExit(context);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Event-room Playwright gate cleanup failed.',
    );
  }
}

describe('event-room Playwright gate', () => {
  test('pins a licensed repository-local axe asset with no network loader', async () => {
    const [storedBytes, license, suite] = await Promise.all([
      readFile(new URL('./axe-core-4.10.3.min.js.txt', import.meta.url)),
      readFile(new URL('./axe-core-4.10.3.LICENSE', import.meta.url), 'utf8'),
      readFile(new URL('./event-room.playwright.ts', import.meta.url), 'utf8'),
    ]);
    const bytes =
      storedBytes.at(-1) === 0x0a
        ? storedBytes.subarray(0, storedBytes.length - 1)
        : storedBytes;
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '880970c081707360e64f34cea25ff91892f5bc95675b0776925b9709dd8a68bb',
    );
    expect(license).toContain('Mozilla Public License, version 2.0');
    expect(suite).not.toContain('cdn.jsdelivr.net');
    expect(suite).not.toContain('unpkg.com');
  });

  test('CI cannot silently skip event-room browser accessibility and safety coverage', () => {
    if (process.env.CI === 'true') {
      expect(process.env.TEST_DATABASE_URL).toBeTruthy();
    }
  });

  testWithDatabase(
    'runs the owned browser suite when the synthetic database is configured',
    async () => {
      const baseDatabaseUrl = requireSyntheticEventRoomTestDatabaseUrl(
        process.env.TEST_DATABASE_URL,
      );
      const childEnvironment = { ...process.env };
      const context = resolveEventRoomPlaywrightRunContext(
        baseDatabaseUrl,
        childEnvironment,
      );
      try {
        const child = Bun.spawn(
          [
            process.execPath,
            'x',
            'playwright',
            'test',
            '--config',
            playwrightConfig,
          ],
          {
            cwd: workspaceRoot,
            env: childEnvironment,
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        const failures: string[] = [];
        if (existsSync(context.runDirectory)) {
          failures.push(
            `validated run directory remained after child exit: ${context.runDirectory}`,
          );
        }
        if (inspectEventRoomPlaywrightPortLease(context) === 'owned') {
          failures.push(
            `validated port lease remained after child exit: ${context.portLeasePath}`,
          );
        }
        if (exitCode !== 0) {
          failures.push(
            `browser suite exited ${exitCode}.\n${stdout}\n${stderr}`,
          );
        }
        if (failures.length > 0) {
          throw new Error(
            `Event-room Playwright gate failed.\n${failures.join('\n')}`,
          );
        }
        expect(exitCode).toBe(0);
      } finally {
        await cleanExactGateRun(context);
      }
    },
    420_000,
  );
});
