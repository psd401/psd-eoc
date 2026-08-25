import { exit as exitProcess } from 'node:process';

import { runAscCli } from './asc-cli';

export * from './asc-auth';
export * from './asc-cli';
export * from './asc-commands';
export * from './asc-inputs';
export * from './asc-model';
export * from './asc-resources';
export * from './asc-transport';

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
