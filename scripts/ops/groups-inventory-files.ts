import { randomUUID } from 'node:crypto';

import { constants } from 'node:fs';

import {
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises';

import { userInfo } from 'node:os';

import { basename, dirname, join, resolve } from 'node:path';

import {
  MAX_DRAFT_FILE_BYTES,
  FILE_READ_CHUNK_BYTES,
  type MappingDraft,
} from './groups-inventory-model';
const isNodeErrorWithCode = (
  error: unknown,
): error is Error & { readonly code: string } =>
  error instanceof Error &&
  'code' in error &&
  typeof (error as { readonly code?: unknown }).code === 'string';

export const statIfPresent = async (
  path: string,
): Promise<Awaited<ReturnType<typeof stat>> | null> => {
  try {
    return await stat(path);
  } catch (error) {
    if (
      isNodeErrorWithCode(error) &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return null;
    }
    throw error;
  }
};

const isInsideGitRepository = async (path: string): Promise<boolean> => {
  const metadata = await stat(path);
  let current = metadata.isDirectory() ? path : dirname(path);
  while (true) {
    if ((await statIfPresent(join(current, '.git'))) !== null) return true;
    const [head, objects, refs] = await Promise.all([
      statIfPresent(join(current, 'HEAD')),
      statIfPresent(join(current, 'objects')),
      statIfPresent(join(current, 'refs')),
    ]);
    if (head?.isFile() && objects?.isDirectory() && refs?.isDirectory()) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
};

export const requirePathOutsideGitRepository = async (
  path: string,
  label: string,
): Promise<string> => {
  const actualPath = await realpath(resolve(path));
  if (await isInsideGitRepository(actualPath)) {
    throw new Error(`${label} must be stored outside every Git repository.`);
  }
  return actualPath;
};

const validateSafeTemporaryRoot = async (
  path: string,
  label: string,
): Promise<string> => {
  const safeRoot = await requirePathOutsideGitRepository(path, label);
  const metadata = await stat(safeRoot);
  const currentUid = userInfo().uid;
  const writableByAnotherPrincipal = (metadata.mode & 0o022) !== 0;
  if (
    !metadata.isDirectory() ||
    (metadata.uid !== 0 && metadata.uid !== currentUid) ||
    (writableByAnotherPrincipal && (metadata.mode & 0o1000) === 0)
  ) {
    throw new Error(
      `${label} must be an owned private directory or a root-owned sticky temporary directory.`,
    );
  }
  return safeRoot;
};

const resolveOperatingSystemTemporaryRoot = async (): Promise<string> => {
  for (const candidate of ['/private/tmp', '/tmp'] as const) {
    if ((await statIfPresent(candidate)) === null) continue;
    return validateSafeTemporaryRoot(
      candidate,
      'Operating-system temporary directory',
    );
  }
  throw new Error('No fixed safe operating-system temporary directory exists.');
};

const createPrivateTemporaryDirectory = async (
  prefix: string,
  temporaryRoot?: string,
): Promise<string> => {
  const safeRoot = await validateSafeTemporaryRoot(
    temporaryRoot ?? (await resolveOperatingSystemTemporaryRoot()),
    'Temporary directory',
  );
  const isolatedPath = await mkdtemp(join(safeRoot, prefix));
  await chmod(isolatedPath, 0o700);
  const actualPath = await requirePathOutsideGitRepository(
    isolatedPath,
    'Private temporary directory',
  );
  const metadata = await stat(actualPath);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== userInfo().uid ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error('Private temporary directory was not safely created.');
  }
  return actualPath;
};

export const createIsolatedGcloudConfigPath = async (
  temporaryRoot?: string,
): Promise<string> =>
  createPrivateTemporaryDirectory('psd-eoc-gcloud-config-', temporaryRoot);

export const readPrivateJson = async (
  path: string,
  label: string,
  maximumBytes: number,
): Promise<unknown> => {
  const requestedPath = resolve(path);
  const initialMetadata = await lstat(requestedPath);
  if (!initialMetadata.isFile() || initialMetadata.size > maximumBytes) {
    throw new Error(`${label} must be a regular file within its size limit.`);
  }
  if ((initialMetadata.mode & 0o077) !== 0) {
    throw new Error(
      `${label} permissions must not allow group or other access.`,
    );
  }
  if (await isInsideGitRepository(requestedPath)) {
    throw new Error(`${label} must be stored outside every Git repository.`);
  }
  const actualParent = await realpath(dirname(requestedPath));
  if (await isInsideGitRepository(actualParent)) {
    throw new Error(`${label} must be stored outside every Git repository.`);
  }
  const safePath = join(actualParent, basename(requestedPath));
  const resolvedMetadata = await lstat(safePath);
  if (
    !resolvedMetadata.isFile() ||
    resolvedMetadata.dev !== initialMetadata.dev ||
    resolvedMetadata.ino !== initialMetadata.ino
  ) {
    throw new Error(`${label} changed while being opened.`);
  }
  const handle = await open(
    safePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let text: string;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size > maximumBytes ||
      metadata.dev !== resolvedMetadata.dev ||
      metadata.ino !== resolvedMetadata.ino
    ) {
      throw new Error(`${label} must be a regular file within its size limit.`);
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(
        `${label} permissions must not allow group or other access.`,
      );
    }
    const chunks: Buffer[] = [];
    let totalBytesRead = 0;
    while (totalBytesRead <= maximumBytes) {
      const bytes = Buffer.allocUnsafe(
        Math.min(FILE_READ_CHUNK_BYTES, maximumBytes + 1 - totalBytesRead),
      );
      const result = await handle.read(bytes, 0, bytes.length, totalBytesRead);
      if (result.bytesRead === 0) break;
      chunks.push(bytes.subarray(0, result.bytesRead));
      totalBytesRead += result.bytesRead;
    }
    if (totalBytesRead > maximumBytes) {
      throw new Error(`${label} exceeded its size limit while being read.`);
    }
    text = Buffer.concat(chunks, totalBytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
};

const resolveOutputPath = async (path: string): Promise<string> => {
  const actualParent = await requirePathOutsideGitRepository(
    dirname(resolve(path)),
    'Draft output directory',
  );
  const filename = basename(path);
  if (filename === '' || filename === '.' || filename === '..') {
    throw new Error('Draft output needs a filename.');
  }
  const parentMetadata = await stat(actualParent);
  if (!parentMetadata.isDirectory() || (parentMetadata.mode & 0o077) !== 0) {
    throw new Error(
      'Draft output directory must be private and inaccessible to group or other users.',
    );
  }
  return join(actualParent, filename);
};

export const createDefaultOutputPath = async (): Promise<string> => {
  const directory = await createPrivateTemporaryDirectory('psd-eoc-groups-');
  return join(directory, 'groups-mapping.draft.json');
};

export const serializeDraft = (
  draft: MappingDraft,
  maximumBytes = MAX_DRAFT_FILE_BYTES,
): string => {
  const serialized = `${JSON.stringify(draft, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new Error('Draft output exceeds its bounded file-size limit.');
  }
  return serialized;
};

export const writePrivateDraft = async (
  path: string,
  draft: MappingDraft,
): Promise<void> => {
  const serialized = serializeDraft(draft);
  const destination = await resolveOutputPath(path);
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, 'wx', 0o600);
  let temporaryExists = true;
  let published = false;
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    await link(temporary, destination);
    published = true;
    await unlink(temporary);
    temporaryExists = false;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (published) await unlink(destination).catch(() => undefined);
    if (temporaryExists) await unlink(temporary).catch(() => undefined);
    if (isNodeErrorWithCode(error) && error.code === 'EEXIST') {
      throw new Error('Draft output already exists; refusing to overwrite it.');
    }
    throw error;
  }
};
