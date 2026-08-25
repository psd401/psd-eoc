import { exit } from 'node:process';

import { runGroupsInventoryCli } from './groups-inventory-cli';

export * from './groups-inventory-classification';
export * from './groups-inventory-cli';
export * from './groups-inventory-files';
export * from './groups-inventory-google';
export * from './groups-inventory-input';
export * from './groups-inventory-model';
export * from './groups-inventory-report';

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
