import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

/**
 * Runs `expo install --check` and decides whether the reported drift matters.
 *
 * Expo publishes patch releases of every SDK 57 package several times a
 * month, and the raw check exits non-zero on any of them. A patch behind is
 * still the same native line, so it is reported and does not block; a major
 * or minor mismatch means the installed package may not match the SDK's
 * native code and fails the check.
 */

const mobileDirectory = fileURLToPath(new URL('../', import.meta.url));

export type DriftLevel = 'patch' | 'incompatible';

export interface Drift {
  readonly name: string;
  readonly installed: string;
  readonly expected: string;
  readonly level: DriftLevel;
}

export interface Verdict {
  readonly ok: boolean;
  readonly message: string;
}

const DRIFT_LINE =
  /^\s*(?<name>@?[^@\s]+)@(?<installed>\d+\.\d+\.\d+\S*) - expected version: (?<expected>\S+)/u;

/** The lowest version an expected range such as `~57.0.23` or `^15.0.3` admits. */
function rangeMinimum(expected: string): string {
  return expected.replace(/^[~^>=<\s]+/u, '').split(/\s/u)[0] ?? expected;
}

export function classifyDrift(installed: string, expected: string): DriftLevel {
  const [installedMajor, installedMinor] = installed.split('.');
  const [expectedMajor, expectedMinor] = rangeMinimum(expected).split('.');
  return installedMajor === expectedMajor && installedMinor === expectedMinor
    ? 'patch'
    : 'incompatible';
}

export function parseDrift(output: string): Drift[] {
  const drifts: Drift[] = [];
  for (const line of output.split('\n')) {
    const match = DRIFT_LINE.exec(line);
    const groups = match?.groups;
    if (groups?.name === undefined) continue;
    const installed = groups.installed ?? '';
    const expected = groups.expected ?? '';
    drifts.push({
      name: groups.name,
      installed,
      expected,
      level: classifyDrift(installed, expected),
    });
  }
  return drifts;
}

export function evaluateCheck(
  status: number | null,
  stdout: string,
  stderr: string,
): Verdict {
  if (status === 0) {
    return { ok: true, message: 'Expo dependencies are up to date.' };
  }
  const drifts = parseDrift(`${stdout}\n${stderr}`);
  if (drifts.length === 0) {
    return {
      ok: false,
      message: `expo install --check exited with status ${String(status)} without reporting version drift:\n${(stderr || stdout).trim()}`,
    };
  }
  const lines = drifts.map(
    (drift) =>
      `  ${drift.name}@${drift.installed} (expected ${drift.expected}) [${drift.level}]`,
  );
  const incompatible = drifts.filter((drift) => drift.level === 'incompatible');
  if (incompatible.length > 0) {
    return {
      ok: false,
      message: [
        `Expo SDK compatibility check failed: ${String(incompatible.length)} package(s) differ from the SDK's expected major or minor version.`,
        ...lines,
        'Run `bunx expo install --fix` in packages/mobile and update the pinned set in scripts/distribution-config.test.ts.',
      ].join('\n'),
    };
  }
  return {
    ok: true,
    message: [
      `Expo published newer patch releases for ${String(drifts.length)} package(s); they stay on the installed SDK line and do not block.`,
      ...lines,
      'Bump them with `bunx expo install --fix` when convenient.',
    ].join('\n'),
  };
}

if (import.meta.main) {
  const result = spawnSync('expo', ['install', '--check'], {
    cwd: mobileDirectory,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
  if (result.error !== undefined) {
    throw new Error(`expo could not start: ${result.error.message}`);
  }
  const verdict = evaluateCheck(result.status, result.stdout, result.stderr);
  console.log(verdict.message);
  if (!verdict.ok) process.exitCode = 1;
}
