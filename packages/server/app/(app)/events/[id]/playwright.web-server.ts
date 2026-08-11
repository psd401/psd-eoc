import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { dropOwnedEventRoomPlaywrightDatabase } from './playwright-database';
import {
  finalizeEventRoomPlaywrightWebServer,
  requireInheritedEventRoomPlaywrightRunContext,
  waitForEventRoomPlaywrightPortToClose,
} from './test-database';

const NEXT_SHUTDOWN_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
  const context = requireInheritedEventRoomPlaywrightRunContext();
  if (
    realpathSync(resolve(process.cwd())) !==
    realpathSync(resolve(context.serverDirectory))
  ) {
    throw new Error(
      'The event-room Playwright web server started outside its run workspace.',
    );
  }

  let nextProcess: ReturnType<typeof Bun.spawn> | undefined;
  let forcedShutdown: ReturnType<typeof setTimeout> | undefined;
  let shutdownRequested = false;
  const requestShutdown = (signal: NodeJS.Signals) => {
    shutdownRequested = true;
    if (nextProcess === undefined) return;
    nextProcess.kill(signal);
    forcedShutdown ??= setTimeout(() => {
      nextProcess?.kill('SIGKILL');
    }, NEXT_SHUTDOWN_TIMEOUT_MS);
  };
  const terminate = () => requestShutdown('SIGTERM');
  const interrupt = () => requestShutdown('SIGINT');
  process.once('SIGTERM', terminate);
  process.once('SIGINT', interrupt);
  try {
    const nextCli = join(
      context.workspaceDirectory,
      'node_modules',
      'next',
      'dist',
      'bin',
      'next',
    );
    const spawnedNext = Bun.spawn(
      [
        process.execPath,
        nextCli,
        'dev',
        '--hostname',
        'localhost',
        '--port',
        String(context.appPort),
      ],
      {
        cwd: context.serverDirectory,
        env: process.env,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    nextProcess = spawnedNext;
    if (shutdownRequested) requestShutdown('SIGTERM');
    const exitCode = await finalizeEventRoomPlaywrightWebServer(
      context,
      async () => {
        const code = await spawnedNext.exited;
        if (forcedShutdown !== undefined) clearTimeout(forcedShutdown);
        process.chdir(tmpdir());
        return code;
      },
      waitForEventRoomPlaywrightPortToClose,
      () => dropOwnedEventRoomPlaywrightDatabase(context),
    );
    process.exitCode = shutdownRequested ? 0 : exitCode;
  } finally {
    if (forcedShutdown !== undefined) clearTimeout(forcedShutdown);
    process.off('SIGTERM', terminate);
    process.off('SIGINT', interrupt);
    process.chdir(tmpdir());
  }
}

await main();
