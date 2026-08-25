import { resolve } from 'node:path';

const REPOSITORY_ROOT = new URL('..', import.meta.url).pathname;
const MOBILE_ROOT = resolve(REPOSITORY_ROOT, 'packages/mobile');

export function mobileNativeResultExitCode(results: {
  readonly numPendingTests: number;
  readonly success: boolean;
}): number {
  if (results.numPendingTests > 0) {
    console.error(
      `The mobile-native test gate encountered ${String(results.numPendingTests)} skipped test(s).`,
    );
  }
  return results.success && results.numPendingTests === 0 ? 0 : 1;
}

if (import.meta.main) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'run',
      '--cwd',
      MOBILE_ROOT,
      'test:native',
      '--',
      '--json',
    ],
    cwd: REPOSITORY_ROOT,
    stderr: 'inherit',
    stdout: 'pipe',
  });
  const [output, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  } else {
    const results = JSON.parse(output) as {
      readonly numPendingTests: number;
      readonly success: boolean;
    };
    process.exitCode = mobileNativeResultExitCode(results);
  }
}
