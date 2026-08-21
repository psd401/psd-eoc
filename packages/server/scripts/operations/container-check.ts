import { randomUUID } from 'node:crypto';

const STARTUP_DEADLINE_MILLISECONDS = 45_000;
const POLL_INTERVAL_MILLISECONDS = 250;

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function runCommand(
  arguments_: readonly string[],
): Promise<CommandResult> {
  const process = Bun.spawn([...arguments_], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return Object.freeze({ exitCode, stdout, stderr });
}

function readImageReference(arguments_: readonly string[]): string {
  const value = arguments_[0];
  if (
    arguments_.length !== 1 ||
    value === undefined ||
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith('-') ||
    /[\0\r\n\s]/u.test(value)
  ) {
    throw new Error(
      'Provide exactly one safe local container image reference.',
    );
  }
  return value;
}

function parseLoopbackPort(value: string): number {
  const match = /^127\.0\.0\.1:(\d{1,5})$/u.exec(value.trim());
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Docker did not publish the server on a loopback port.');
  }
  return port;
}

async function waitForStartup(origin: string): Promise<void> {
  const deadline = Date.now() + STARTUP_DEADLINE_MILLISECONDS;
  let lastStatus: number | null = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/login`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2_000),
      });
      lastStatus = response.status;
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch {
      // The process is still starting. Only the final bounded result is used.
    }
    await Bun.sleep(POLL_INTERVAL_MILLISECONDS);
  }
  throw new Error(
    `The container did not serve the login page before the deadline (last status: ${String(lastStatus)}).`,
  );
}

/**
 * Proves the reviewed image starts without credentials and that deep health
 * fails closed when AWS/database/provider dependencies are intentionally absent.
 */
export async function smokeLocalContainer(
  imageReference: string,
): Promise<void> {
  const containerName = `psd-eoc-container-check-${randomUUID()}`;
  let started = false;
  let result:
    | Readonly<{
        imageReference: string;
        loginStartup: 'ok';
        dependencyFreeDeepHealth: 'fail-closed';
      }>
    | undefined;
  let failure: unknown;
  let cleanupFailed = false;
  try {
    const run = await runCommand([
      'docker',
      'run',
      '--detach',
      '--name',
      containerName,
      '--publish',
      '127.0.0.1::3000',
      '--env',
      'AWS_EC2_METADATA_DISABLED=true',
      imageReference,
    ]);
    if (run.exitCode !== 0) {
      throw new Error('Docker could not start the reviewed server image.');
    }
    started = true;

    const portResult = await runCommand([
      'docker',
      'port',
      containerName,
      '3000/tcp',
    ]);
    if (portResult.exitCode !== 0) {
      throw new Error('Docker did not expose the reviewed server image.');
    }
    const origin = `http://127.0.0.1:${parseLoopbackPort(portResult.stdout)}`;
    await waitForStartup(origin);

    const health = await fetch(`${origin}/api/health`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    const body = await health.text();
    if (
      health.status !== 503 ||
      body !== JSON.stringify({ status: 'unavailable' }) ||
      health.headers.get('cache-control') !== 'no-store, max-age=0'
    ) {
      throw new Error(
        'Deep health did not fail closed without deployment dependencies.',
      );
    }
    result = Object.freeze({
      imageReference,
      loginStartup: 'ok' as const,
      dependencyFreeDeepHealth: 'fail-closed' as const,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (started) {
      const cleanup = await runCommand([
        'docker',
        'rm',
        '--force',
        containerName,
      ]);
      if (cleanup.exitCode !== 0) {
        cleanupFailed = true;
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailed) {
    throw new Error('The temporary smoke container could not be removed.');
  }
  if (result === undefined) {
    throw new Error('The local container-check result was unavailable.');
  }
  console.info(JSON.stringify(result));
}

if (import.meta.main) {
  try {
    await smokeLocalContainer(readImageReference(process.argv.slice(2)));
  } catch {
    console.error('The local container check failed.');
    process.exitCode = 1;
  }
}
