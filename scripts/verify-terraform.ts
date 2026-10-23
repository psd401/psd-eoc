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

/** A root's pinned Terraform line, e.g. `1.16` for `~> 1.16.0`. */
interface TerraformLine {
  readonly major: number;
  readonly minor: number;
}

/**
 * Reads the line from the root's own `required_version`, so `versions.tf` is
 * the one place the version lives.
 */
function readPinnedLine(root: string): TerraformLine {
  const versions = readFileSync(
    resolve(repositoryRoot, root, 'versions.tf'),
    'utf8',
  );
  const match = /required_version\s*=\s*"~>\s*(\d+)\.(\d+)\.\d+"/.exec(
    versions,
  );
  if (match === null) {
    throw new Error(
      `${root}/versions.tf must pin required_version = "~> MAJOR.MINOR.PATCH".`,
    );
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

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

async function localTerraformMatches(line: TerraformLine): Promise<boolean> {
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
  return major === line.major && minor === line.minor;
}

async function verifyRoot(root: string): Promise<void> {
  const line = readPinnedLine(root);
  const useLocal = await localTerraformMatches(line);
  // The minor-line tag always satisfies `~> MAJOR.MINOR.0`.
  const image = `hashicorp/terraform:${String(line.major)}.${String(line.minor)}`;
  if (!useLocal) {
    console.info(
      `No local Terraform ${String(line.major)}.${String(line.minor)}; using ${image}.`,
    );
  }
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
          image,
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
  for (const root of AWS_TERRAFORM_ROOTS) {
    await verifyRoot(root);
  }
  console.info('AWS Terraform roots are formatted, valid, and plan cleanly.');
}
