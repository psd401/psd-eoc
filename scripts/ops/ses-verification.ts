#!/usr/bin/env bun

import process from 'node:process';

import { verificationMain } from '../../infra/src/ops/ses-verification';

export async function main(args: readonly string[] = process.argv.slice(2)) {
  return verificationMain(args);
}

if (import.meta.main) {
  process.exitCode = await main();
}
