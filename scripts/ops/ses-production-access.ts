#!/usr/bin/env bun

import process from 'node:process';

import { productionAccessMain } from '../../infra/src/ops/ses-production-access';

export async function main(args: readonly string[] = process.argv.slice(2)) {
  return productionAccessMain(args);
}

if (import.meta.main) {
  process.exitCode = await main();
}
