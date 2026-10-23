#!/usr/bin/env bun

/**
 * Credential-free verification of the AWS Terraform roots.
 *
 * `terraform fmt`, `validate`, and `test` with mocked providers prove the HCL
 * is current without a cloud credential, the same way
 * `scripts/verify-issue-278.ts` proves the isolated Firebase root. Nothing here
 * reads, creates, or plans against a real account: no backend is initialized
 * and every provider in the test files is mocked.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..');

/** Every AWS Terraform root, relative to the repository. */
const AWS_TERRAFORM_ROOTS = ['infra/terraform/stateful'] as const;

/**
 * The Terraform line the roots pin. Kept next to the `required_version`
 * constraint in `versions.tf`: a mismatch between the two is the failure this
 * script exists to report in one line instead of as an init error.
 */
const REQUIRED_TERRAFORM_MAJOR = 1;
const REQUIRED_TERRAFORM_MINOR = 16;
/** The container used when no local Terraform satisfies the constraint. */
const TERRAFORM_IMAGE = 'hashicorp/terraform:1.16.5';

async function spawn(
  command: readonly string[],
  cwd: string,
): Promise<{ code: number; output: string }> {
  let child;
  try {
    child = Bun.spawn([...command], {
      cwd,
      env: process.env,
      stderr: 'pipe',
      stdout: 'pipe',
    });
  } catch {
    // Bun.spawn throws when the executable is not on PATH at all.
    return {
      code: 127,
      output: `${command[0] ?? ''} was not found on PATH.\n`,
    };
  }
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, output: `${stdout}${stderr}` };
}

async function localTerraformSatisfiesConstraint(): Promise<boolean> {
  const { code, output } = await spawn(
    ['terraform', 'version', '-json'],
    repositoryRoot,
  );
  if (code !== 0) return false;
  let version: string;
  try {
    version = String(
      (JSON.parse(output) as { terraform_version?: unknown }).terraform_version,
    );
  } catch {
    return false;
  }
  const [major, minor] = version.split('.').map(Number);
  return (
    major === REQUIRED_TERRAFORM_MAJOR && minor === REQUIRED_TERRAFORM_MINOR
  );
}

/** Fails loudly when `versions.tf` and this script disagree on the line. */
function assertPinnedVersionMatches(root: string): void {
  const expected = `"~> ${String(REQUIRED_TERRAFORM_MAJOR)}.${String(
    REQUIRED_TERRAFORM_MINOR,
  )}.0"`;
  const versions = readFileSync(
    resolve(repositoryRoot, root, 'versions.tf'),
    'utf8',
  );
  if (!versions.includes(`required_version = ${expected}`)) {
    throw new Error(
      `${root}/versions.tf must pin required_version = ${expected}; update scripts/verify-terraform.ts together with it.`,
    );
  }
}

async function verifyRoot(root: string, useLocal: boolean): Promise<void> {
  assertPinnedVersionMatches(root);
  const cwd = resolve(repositoryRoot, root);
  const invoke = (args: readonly string[]): readonly string[] =>
    useLocal
      ? ['terraform', ...args]
      : [
          'docker',
          'run',
          '--rm',
          '--volume',
          `${repositoryRoot}:/workspace`,
          '--workdir',
          `/workspace/${root}`,
          TERRAFORM_IMAGE,
          ...args,
        ];
  for (const args of [
    ['init', '-backend=false', '-input=false', '-no-color'],
    ['fmt', '-check', '-diff', '-no-color'],
    ['validate', '-no-color'],
    ['test', '-no-color'],
  ]) {
    const { code, output } = await spawn(invoke(args), cwd);
    process.stdout.write(output);
    if (code !== 0) {
      throw new Error(`terraform ${args[0] ?? ''} failed in ${root}.`);
    }
  }
}

if (import.meta.main) {
  const useLocal = await localTerraformSatisfiesConstraint();
  if (!useLocal) {
    console.info(
      `No local Terraform ${String(REQUIRED_TERRAFORM_MAJOR)}.${String(
        REQUIRED_TERRAFORM_MINOR,
      )}; using ${TERRAFORM_IMAGE}.`,
    );
  }
  for (const root of AWS_TERRAFORM_ROOTS) {
    await verifyRoot(root, useLocal);
  }
  console.info('AWS Terraform roots are formatted, valid, and plan cleanly.');
}
