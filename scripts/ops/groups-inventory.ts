import { exit } from 'node:process';

import { runGroupsInventoryCli } from './groups-inventory-cli';

if (import.meta.main) {
  try {
    await runGroupsInventoryCli(Bun.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : 'Google Groups inventory failed safely.',
    );
    exit(1);
  }
}
