import { readFile } from 'node:fs/promises';

import { assertSuccessfulFailureDrillManifest } from './contract';

const input = process.argv[2];
if (!input || process.argv.length !== 3) {
  throw new Error('Usage: bun validate-evidence.ts INPUT');
}
assertSuccessfulFailureDrillManifest(JSON.parse(await readFile(input, 'utf8')));
