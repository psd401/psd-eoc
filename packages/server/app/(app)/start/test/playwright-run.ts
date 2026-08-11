import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export const START_FLOW_PLAYWRIGHT_RUN_ID_ENV =
  'PSD_EOC_START_PLAYWRIGHT_RUN_ID';
export const START_FLOW_PLAYWRIGHT_ARTIFACTS_ACQUIRED_ENV =
  'PSD_EOC_START_PLAYWRIGHT_ARTIFACTS_ACQUIRED';

const RUN_ID_PATTERN = /^[0-9a-f]{32}$/u;
const ARTIFACT_PREFIX = 'psd-eoc-issue15-';

/** Generates an unguessable identifier shared by exactly one browser run. */
export function createStartFlowPlaywrightRunId(): string {
  return randomBytes(16).toString('hex');
}

/** Fails closed unless a caller supplies the exact run identifier shape. */
export function requireStartFlowPlaywrightRunId(
  value: string | undefined = process.env[START_FLOW_PLAYWRIGHT_RUN_ID_ENV],
): string {
  if (value === undefined || !RUN_ID_PATTERN.test(value)) {
    throw new Error(
      `${START_FLOW_PLAYWRIGHT_RUN_ID_ENV} must be exactly 32 lowercase hexadecimal characters.`,
    );
  }
  return value;
}

export interface StartFlowPlaywrightPaths {
  readonly fixture: string;
  readonly owner: string;
  readonly output: string;
  readonly root: string;
  readonly storageState: string;
}

/** Derives every temporary artifact from one validated, run-owned token. */
export function startFlowPlaywrightPaths(
  value: string | undefined = process.env[START_FLOW_PLAYWRIGHT_RUN_ID_ENV],
): StartFlowPlaywrightPaths {
  const runId = requireStartFlowPlaywrightRunId(value);
  const temporaryRoot = resolve(tmpdir());
  const expectedBasename = `${ARTIFACT_PREFIX}${runId}`;
  const root = resolve(temporaryRoot, expectedBasename);
  if (dirname(root) !== temporaryRoot || basename(root) !== expectedBasename) {
    throw new Error(
      'Refusing to address an unexpected Playwright artifact path.',
    );
  }
  return Object.freeze({
    root,
    fixture: resolve(root, 'fixture.json'),
    owner: resolve(root, '.owner'),
    output: resolve(root, 'results'),
    storageState: resolve(root, 'storage-state.json'),
  });
}

/** Claims a fresh artifact directory without adopting any pre-existing path. */
export async function acquireStartFlowPlaywrightArtifacts(
  value: string | undefined = process.env[START_FLOW_PLAYWRIGHT_RUN_ID_ENV],
): Promise<void> {
  const runId = requireStartFlowPlaywrightRunId(value);
  const paths = startFlowPlaywrightPaths(runId);
  await mkdir(paths.root, { mode: 0o700 });
  try {
    await writeFile(paths.owner, `${runId}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    await rmdir(paths.root).catch(() => undefined);
    throw error;
  }
}

/** Verifies the exact config-claimed root without changing its contents. */
export async function assertStartFlowPlaywrightArtifactsOwned(
  value: string | undefined = process.env[START_FLOW_PLAYWRIGHT_RUN_ID_ENV],
): Promise<void> {
  const runId = requireStartFlowPlaywrightRunId(value);
  const paths = startFlowPlaywrightPaths(runId);
  let rootMetadata;
  try {
    rootMetadata = await lstat(paths.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'Refusing to use Playwright artifacts without an owned root.',
      );
    }
    throw error;
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Refusing to use an unexpected Playwright artifact root.');
  }
  let owner: string;
  try {
    owner = await readFile(paths.owner, { encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'Refusing to use Playwright artifacts without an ownership marker.',
      );
    }
    throw error;
  }
  if (owner !== `${runId}\n`) {
    throw new Error(
      'Refusing to use Playwright artifacts with a mismatched ownership marker.',
    );
  }
}

/** Removes only the exact validated artifact directory owned by this run. */
export async function removeStartFlowPlaywrightArtifacts(
  value: string | undefined = process.env[START_FLOW_PLAYWRIGHT_RUN_ID_ENV],
): Promise<void> {
  const runId = requireStartFlowPlaywrightRunId(value);
  const paths = startFlowPlaywrightPaths(value);
  try {
    await lstat(paths.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  await assertStartFlowPlaywrightArtifactsOwned(runId);
  await rm(paths.root, { force: true, recursive: true });
}
