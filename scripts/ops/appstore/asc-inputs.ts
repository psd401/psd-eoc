import { Buffer } from 'node:buffer';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { isProxy } from 'node:util/types';
import {
  BETA_BUILD_LOCALIZATION_LOCALES,
  type BetaReviewInfo,
  canonicalValue,
  deepFreezeCanonical,
  FILE_READ_CHUNK_BYTES,
  isEmail,
  type JsonObject,
  MAX_APPROVED_TESTERS,
  optionalSecretString,
  optionalString,
  requireString,
  type Tester,
} from './asc-model';
export const parseCsvRows = (input: string): readonly (readonly string[])[] => {
  const text = input.startsWith('\uFEFF') ? input.slice(1) : input;
  const rows: string[][] = [[]];
  let field = '';
  let state: 'after-quote' | 'quoted' | 'unquoted' = 'unquoted';
  const finishField = (): void => {
    rows.at(-1)?.push(field);
    field = '';
    state = 'unquoted';
  };
  const finishRow = (): void => {
    finishField();
    rows.push([]);
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (state === 'quoted') {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          state = 'after-quote';
        }
      } else {
        field += character;
      }
      continue;
    }
    if (state === 'after-quote') {
      if (character === ',') {
        finishField();
        continue;
      }
      if (character === '\n' || character === '\r') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        finishRow();
        continue;
      }
      throw new Error('Tester CSV contains characters after a closing quote.');
    }
    if (character === '"') {
      if (field.length !== 0) {
        throw new Error(
          'Tester CSV contains a quote inside an unquoted field.',
        );
      }
      state = 'quoted';
    } else if (character === ',') {
      finishField();
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      finishRow();
    } else {
      field += character;
    }
  }
  if (state === 'quoted')
    throw new Error('Tester CSV contains an unterminated quote.');
  finishField();
  return rows.filter((row) => row.some((value) => value.trim().length > 0));
};
const normalizeHeader = (value: string): string =>
  value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]/gu, '');
const findHeader = (
  headers: readonly string[],
  aliases: readonly string[],
  label: string,
): number => {
  const matches: number[] = [];
  for (let index = 0; index < headers.length; index += 1) {
    if (aliases.includes(headers[index] as string)) matches.push(index);
  }
  if (matches.length > 1) {
    throw new Error(`Tester CSV has duplicate ${label} headers.`);
  }
  return matches[0] ?? -1;
};
export const parseTesterCsv = (input: string): readonly Tester[] => {
  const rows = parseCsvRows(input);
  if (rows.length < 2)
    throw new Error('Tester CSV must have a header and data.');
  const headers = (rows[0] ?? []).map(normalizeHeader);
  if (headers.some((header) => header === '')) {
    throw new Error('Tester CSV contains a blank header.');
  }
  if (new Set(headers).size !== headers.length) {
    throw new Error('Tester CSV contains duplicate headers.');
  }
  const emailIndex = findHeader(
    headers,
    ['email', 'emailaddress', 'memberemail', 'memberemailaddress'],
    'email',
  );
  if (emailIndex < 0)
    throw new Error('Tester CSV has no supported email header.');
  const firstNameIndex = findHeader(
    headers,
    ['firstname', 'givenname'],
    'first-name',
  );
  const lastNameIndex = findHeader(
    headers,
    ['lastname', 'familyname', 'surname'],
    'last-name',
  );
  const memberTypeIndex = findHeader(
    headers,
    ['membertype', 'type'],
    'member-type',
  );
  const testers: Tester[] = [];
  const seen = new Set<string>();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    if (row.length !== headers.length) {
      throw new Error(
        `Tester CSV row ${rowIndex + 1} does not match the header width.`,
      );
    }
    if (
      memberTypeIndex >= 0 &&
      row[memberTypeIndex]?.trim().toLocaleUpperCase('en-US') !== 'USER'
    ) {
      throw new Error(
        `Tester CSV row ${rowIndex + 1} is not an explicit USER member.`,
      );
    }
    const rawEmail = row[emailIndex]?.trim() ?? '';
    if (rawEmail === '') {
      throw new Error(`Tester CSV row ${rowIndex + 1} has no user email.`);
    }
    const email = rawEmail.toLocaleLowerCase('en-US');
    if (!isEmail(email))
      throw new Error(`Tester CSV row ${rowIndex + 1} has an invalid email.`);
    if (seen.has(email)) {
      throw new Error(
        `Tester CSV row ${rowIndex + 1} duplicates a tester identity.`,
      );
    }
    seen.add(email);
    const firstName =
      firstNameIndex < 0 ? undefined : row[firstNameIndex]?.trim();
    const lastName = lastNameIndex < 0 ? undefined : row[lastNameIndex]?.trim();
    if ((firstName?.length ?? 0) > 255 || (lastName?.length ?? 0) > 255) {
      throw new Error(`Tester CSV row ${rowIndex + 1} has an overlong name.`);
    }
    testers.push({
      email,
      ...(firstName === undefined || firstName === '' ? {} : { firstName }),
      ...(lastName === undefined || lastName === '' ? {} : { lastName }),
    });
  }
  if (testers.length === 0)
    throw new Error('Tester CSV contains no user email rows.');
  if (testers.length > MAX_APPROVED_TESTERS) {
    throw new Error('Tester CSV exceeds the approved PSD roster limit.');
  }
  return testers;
};
const REVIEW_INFO_FIELDS = new Set([
  'betaDescription',
  'contactEmail',
  'contactFirstName',
  'contactLastName',
  'contactPhone',
  'demoAccountName',
  'demoAccountPassword',
  'demoAccountRequired',
  'feedbackEmail',
  'locale',
  'notes',
  'whatsNew',
]);
const snapshotReviewInput = (input: unknown): JsonObject => {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    isProxy(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  ) {
    throw new Error('Beta-review input must be a JSON object.');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key === 'symbol')) {
    throw new Error('Beta-review input has an unsupported field.');
  }
  const descriptors: Array<{
    descriptor: PropertyDescriptor;
    key: string;
  }> = [];
  for (const key of keys as string[]) {
    if (!REVIEW_INFO_FIELDS.has(key)) {
      throw new Error('Beta-review input has an unsupported field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      throw new Error('Beta-review input has an unsupported field.');
    }
    descriptors.push({ descriptor, key });
  }
  const snapshot = Object.create(null) as JsonObject;
  for (const { descriptor, key } of descriptors) {
    let value: unknown;
    if ('value' in descriptor) {
      value = descriptor.value;
    } else if (typeof descriptor.get === 'function') {
      value = descriptor.get.call(input) as unknown;
    } else {
      throw new Error('Beta-review input has an unreadable field.');
    }
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return snapshot;
};
export const parseReviewInfo = (input: unknown): BetaReviewInfo => {
  const snapshot = snapshotReviewInput(input);
  const contactEmail = requireString(
    snapshot.contactEmail,
    'contactEmail',
    320,
  );
  const feedbackEmail = requireString(
    snapshot.feedbackEmail,
    'feedbackEmail',
    320,
  );
  if (!isEmail(contactEmail) || !isEmail(feedbackEmail)) {
    throw new Error('Beta-review email fields must be valid email addresses.');
  }
  const demoAccountRequired = snapshot.demoAccountRequired;
  if (typeof demoAccountRequired !== 'boolean') {
    throw new Error('demoAccountRequired must be a boolean.');
  }
  const demoAccountName = optionalString(
    snapshot.demoAccountName,
    'demoAccountName',
    255,
  );
  const demoAccountPassword = optionalSecretString(
    snapshot.demoAccountPassword,
    'demoAccountPassword',
    255,
  );
  if (
    demoAccountRequired &&
    (demoAccountName === undefined || demoAccountPassword === undefined)
  ) {
    throw new Error('A required demo account needs both name and password.');
  }
  if (
    !demoAccountRequired &&
    (demoAccountName !== undefined || demoAccountPassword !== undefined)
  ) {
    throw new Error(
      'Demo account credentials are forbidden when no demo account is required.',
    );
  }
  const notes = optionalString(snapshot.notes, 'notes', 4000);
  const locale = snapshot.locale === undefined ? 'en-US' : snapshot.locale;
  if (
    typeof locale !== 'string' ||
    !BETA_BUILD_LOCALIZATION_LOCALES.has(locale)
  ) {
    throw new Error(
      'Beta-review locale is not supported by Apple BetaBuildLocalization.',
    );
  }
  return deepFreezeCanonical(
    canonicalValue({
      betaDescription: requireString(
        snapshot.betaDescription,
        'betaDescription',
        4000,
      ),
      contactEmail,
      contactFirstName: requireString(
        snapshot.contactFirstName,
        'contactFirstName',
        255,
      ),
      contactLastName: requireString(
        snapshot.contactLastName,
        'contactLastName',
        255,
      ),
      contactPhone: requireString(snapshot.contactPhone, 'contactPhone', 50),
      demoAccountRequired,
      feedbackEmail,
      locale,
      whatsNew: requireString(snapshot.whatsNew, 'whatsNew', 4000),
      ...(demoAccountName === undefined ? {} : { demoAccountName }),
      ...(demoAccountPassword === undefined ? {} : { demoAccountPassword }),
      ...(notes === undefined ? {} : { notes }),
    }),
  ) as unknown as BetaReviewInfo;
};
export const isPathInside = (candidate: string, parent: string): boolean => {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};
const isNodeErrorWithCode = (
  error: unknown,
): error is Error & {
  readonly code: string;
} =>
  error instanceof Error &&
  'code' in error &&
  typeof (
    error as {
      readonly code?: unknown;
    }
  ).code === 'string';
const statIfPresent = async (
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
const sameFileMetadata = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;
class PrivateFileValidationError extends Error {}
const privateFileValidationError = (message: string): Error =>
  new PrivateFileValidationError(message);
const readValidatedPrivateFile = async (
  path: string,
  maximumBytes: number,
  label: string,
): Promise<string> => {
  const requestedPath = resolve(path);
  const initialMetadata = await lstat(requestedPath);
  if (
    !initialMetadata.isFile() ||
    initialMetadata.nlink !== 1 ||
    initialMetadata.size > maximumBytes
  ) {
    throw privateFileValidationError(
      `${label} must be a regular file within its size limit.`,
    );
  }
  if (
    initialMetadata.uid !== userInfo().uid ||
    (initialMetadata.mode & 0o077) !== 0
  ) {
    throw privateFileValidationError(`${label} must be an owner-private file.`);
  }
  if (await isInsideGitRepository(requestedPath)) {
    throw privateFileValidationError(
      `${label} must be stored outside every Git repository.`,
    );
  }
  const actualParent = await realpath(dirname(requestedPath));
  if (await isInsideGitRepository(actualParent)) {
    throw privateFileValidationError(
      `${label} must be stored outside every Git repository.`,
    );
  }
  const parentMetadata = await stat(actualParent);
  if (
    !parentMetadata.isDirectory() ||
    parentMetadata.uid !== userInfo().uid ||
    (parentMetadata.mode & 0o077) !== 0
  ) {
    throw privateFileValidationError(
      `${label} must be stored in an owner-private directory.`,
    );
  }
  const safePath = join(actualParent, basename(requestedPath));
  const resolvedMetadata = await lstat(safePath);
  if (
    !resolvedMetadata.isFile() ||
    resolvedMetadata.nlink !== 1 ||
    resolvedMetadata.dev !== initialMetadata.dev ||
    resolvedMetadata.ino !== initialMetadata.ino
  ) {
    throw privateFileValidationError(`${label} changed while being opened.`);
  }
  const handle = await open(
    safePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let contents: string | undefined;
  let readError: unknown;
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > maximumBytes ||
      before.dev !== resolvedMetadata.dev ||
      before.ino !== resolvedMetadata.ino
    ) {
      throw privateFileValidationError(
        `${label} must be a regular file within its size limit.`,
      );
    }
    if (before.uid !== userInfo().uid || (before.mode & 0o077) !== 0) {
      throw privateFileValidationError(
        `${label} must be an owner-private file.`,
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
      throw privateFileValidationError(
        `${label} exceeded its size limit while being read.`,
      );
    }
    const after = await handle.stat();
    if (!sameFileMetadata(before, after) || totalBytesRead !== after.size) {
      throw privateFileValidationError(`${label} changed while being read.`);
    }
    try {
      contents = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks, totalBytesRead),
      );
    } catch {
      throw privateFileValidationError(
        `${label} must contain valid UTF-8 text.`,
      );
    }
  } catch (error) {
    readError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (readError === undefined) readError = error;
  }
  if (readError !== undefined) throw readError;
  if (contents === undefined) {
    throw new Error('Private file read did not complete.');
  }
  return contents;
};
export const readPrivateFile = async (
  path: string,
  maximumBytes: number,
  label: string,
): Promise<string> => {
  try {
    return await readValidatedPrivateFile(path, maximumBytes, label);
  } catch (error) {
    if (error instanceof PrivateFileValidationError) {
      throw new Error(error.message);
    }
    throw new Error(`${label} could not be read safely.`);
  }
};
export const parseReviewInfoJson = (text: string): BetaReviewInfo => {
  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Beta-review input is not valid JSON.');
  }
  return parseReviewInfo(input);
};
