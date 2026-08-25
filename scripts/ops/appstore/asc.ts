import { exit as exitProcess } from 'node:process';

import { runAscCli } from './asc-cli';

if (import.meta.main) {
  try {
    await runAscCli(Bun.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'App Store operation failed.',
    );
    exitProcess(1);
  }
}
