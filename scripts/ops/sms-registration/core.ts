import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

export const TARGET_ACCOUNT = '338414773271';
export const TARGET_REGION = 'us-west-2';

export const REGISTRATION_TYPES = {
  brand: 'US_TEN_DLC_BRAND_REGISTRATION',
  campaign: 'US_TEN_DLC_CAMPAIGN_REGISTRATION',
  tollFree: 'US_TOLL_FREE_REGISTRATION',
} as const;

export type RegistrationKind = keyof typeof REGISTRATION_TYPES;

export interface FieldDefinition {
  readonly fieldPath: string;
  readonly fieldRequirement: 'CONDITIONAL' | 'OPTIONAL' | 'REQUIRED' | string;
  readonly fieldType: 'ATTACHMENT' | 'SELECT' | 'TEXT' | string;
  readonly selectValidation?: {
    readonly maxChoices?: number;
    readonly minChoices?: number;
    readonly options?: readonly string[];
  };
  readonly textValidation?: {
    readonly maxLength?: number;
    readonly minLength?: number;
    readonly pattern?: string;
  };
  readonly title?: string;
}

export type FieldValue =
  | {
      readonly attachmentFile: string;
      readonly fieldPath: string;
      readonly select?: never;
      readonly text?: never;
    }
  | {
      readonly attachmentFile?: never;
      readonly fieldPath: string;
      readonly select: readonly string[];
      readonly text?: never;
    }
  | {
      readonly attachmentFile?: never;
      readonly fieldPath: string;
      readonly select?: never;
      readonly text: string;
    };

export interface RegistrationData {
  readonly brand: { readonly fields: readonly FieldValue[] };
  readonly campaign: { readonly fields: readonly FieldValue[] };
  readonly dataDirectory: string;
  readonly registrationNamePrefix: string;
  readonly schemaVersion: 1;
  readonly tollFree: {
    readonly fields: readonly FieldValue[];
    readonly optOutListName: string;
  };
}

export interface RegistrationRecord {
  readonly currentVersionNumber?: number;
  readonly registrationId: string;
  readonly registrationStatus: string;
  readonly registrationType: string;
}

export interface PhoneNumberRecord {
  readonly numberType?: string;
  readonly phoneNumberId: string;
  readonly registrationId?: string;
  readonly status: string;
}

export interface RegistrationAssociationRecord {
  readonly resourceId: string;
  readonly resourceType: string;
}

export interface RegistrationVersionRecord {
  readonly deniedReasons: readonly string[];
  readonly feedback?: string;
  readonly status: string;
  readonly versionNumber: number;
}

export interface RegistrationFieldFeedback {
  readonly deniedReason?: string;
  readonly feedback?: string;
  readonly fieldPath: string;
}

export interface RegistrationAttachmentRecord {
  readonly attachmentId: string;
  readonly status: string;
}

export interface SmsRegistrationApi {
  createAttachment(input: {
    readonly attachmentBody: Uint8Array;
    readonly clientToken: string;
    readonly name: string;
  }): Promise<{
    readonly attachmentId: string;
    readonly attachmentStatus: string;
  }>;
  createRegistration(input: {
    readonly clientToken: string;
    readonly name: string;
    readonly registrationType: string;
  }): Promise<{ readonly registrationId: string }>;
  describeFieldDefinitions(
    registrationType: string,
  ): Promise<readonly FieldDefinition[]>;
  describeAttachments(
    attachmentIds: readonly string[],
  ): Promise<readonly RegistrationAttachmentRecord[]>;
  describePhoneNumbers(
    phoneNumberIds: readonly string[],
  ): Promise<readonly PhoneNumberRecord[]>;
  describeRegistrationFieldFeedback(input: {
    readonly registrationId: string;
    readonly versionNumber?: number;
  }): Promise<readonly RegistrationFieldFeedback[]>;
  describeRegistrationVersions(
    registrationId: string,
  ): Promise<readonly RegistrationVersionRecord[]>;
  describeRegistrations(
    registrationIds: readonly string[],
  ): Promise<readonly RegistrationRecord[]>;
  getCallerIdentity(): Promise<{
    readonly accountId?: string;
    readonly arn?: string;
  }>;
  associateRegistration(input: {
    readonly registrationId: string;
    readonly resourceId: string;
  }): Promise<void>;
  listRegistrationAssociations(
    registrationId: string,
  ): Promise<readonly RegistrationAssociationRecord[]>;
  putFieldValue(input: {
    readonly attachmentId?: string;
    readonly fieldPath: string;
    readonly registrationId: string;
    readonly select?: readonly string[];
    readonly text?: string;
  }): Promise<void>;
  requestTollFreeNumber(input: {
    readonly clientToken: string;
    readonly name: string;
    readonly optOutListName: string;
    readonly registrationId: string;
  }): Promise<{
    readonly monthlyLeasingPrice?: string;
    readonly phoneNumberId: string;
    readonly registrationId?: string;
    readonly status: string;
  }>;
  submitRegistration(registrationId: string): Promise<{
    readonly versionStatus: string;
  }>;
}

interface PersistedRegistration {
  associationAttempted?: boolean;
  associatedBrand?: boolean;
  attachments: Record<
    string,
    {
      attachmentId?: string;
      attachmentStatus?: string;
      clientToken: string;
      contentFingerprint: string;
    }
  >;
  clientToken: string;
  inputFingerprint: string;
  kind: RegistrationKind;
  registrationId?: string;
  submissionAttempted?: boolean;
  submitted?: boolean;
}

type PersistedTollFreeRegistration = PersistedRegistration & {
  phoneClientToken: string;
  phoneNumberId?: string;
};

export interface RegistrationState {
  brand?: PersistedRegistration;
  campaign?: PersistedRegistration;
  schemaVersion: 2;
  targetAccount: string;
  targetRegion: string;
  tollFree?: PersistedTollFreeRegistration;
}

export interface SubmitOptions {
  readonly confirmation?: string;
  readonly confirmedAccount?: string;
  readonly confirmedRegion?: string;
  readonly dataPath: string;
  readonly statePath: string;
  readonly submit: boolean;
}

export interface StatusOptions {
  readonly check: boolean;
  readonly confirmedAccount?: string;
  readonly confirmedRegion?: string;
  readonly dataPath: string;
  readonly definitions?: RegistrationKind;
  readonly statePath: string;
  readonly validateData?: RegistrationKind;
}

export interface Runtime {
  readonly createApi: () => Promise<SmsRegistrationApi>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isInteractive: boolean;
  readonly randomToken: (label: string) => string;
  readonly stderr: (message: string) => void;
  readonly stdout: (message: string) => void;
}

const CONFIRMATIONS: Readonly<Record<RegistrationKind, string>> = {
  brand: 'SUBMIT_10DLC_BRAND',
  campaign: 'SUBMIT_10DLC_CAMPAIGN',
  tollFree: 'LEASE_TOLL_FREE_AND_SUBMIT',
};

const MAX_ATTACHMENT_BYTES = 500 * 1024;
const MAX_TOLL_FREE_OPT_IN_BYTES = 400 * 1024;
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set(['.jpeg', '.jpg', '.png']);
const MAX_PROVIDER_TEXT_LENGTH = 512;

function stripAnsiSequences(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x1b) {
      output += value[index] ?? '';
      continue;
    }
    const introducer = value[index + 1];
    if (introducer === '[') {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) break;
        index += 1;
      }
      continue;
    }
    if (introducer === ']') {
      index += 2;
      while (index < value.length) {
        if (value.charCodeAt(index) === 0x07) break;
        if (value.charCodeAt(index) === 0x1b && value[index + 1] === '\\') {
          index += 1;
          break;
        }
        index += 1;
      }
    }
  }
  return output;
}

export function terminalSafeText(value: string | number): string {
  const escaped = [...stripAnsiSequences(String(value)).normalize('NFKC')]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (character === '\n' || character === '\r' || character === '\t') {
        return ' ';
      }
      if (
        codePoint < 0x20 ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0x200b && codePoint <= 0x200f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2060 && codePoint <= 0x206f) ||
        codePoint === 0xfeff
      ) {
        return `<U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}>`;
      }
      return character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  const bounded = [...escaped].slice(0, MAX_PROVIDER_TEXT_LENGTH).join('');
  return bounded.length === 0 ? '<empty>' : bounded;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}

function parseFieldValue(value: unknown, path: string): FieldValue {
  const record = asRecord(value, path);
  const fieldPath = requiredString(record.fieldPath, `${path}.fieldPath`);
  const variants = [
    record.text === undefined ? undefined : 'text',
    record.select === undefined ? undefined : 'select',
    record.attachmentFile === undefined ? undefined : 'attachmentFile',
  ].filter((variant) => variant !== undefined);

  if (variants.length !== 1) {
    throw new TypeError(
      `${path} must define exactly one of text, select, or attachmentFile. S3 attachment URIs are intentionally unsupported because their content cannot be inspected and sanitized locally.`,
    );
  }

  if (record.text !== undefined) {
    return { fieldPath, text: requiredString(record.text, `${path}.text`) };
  }
  if (record.select !== undefined) {
    if (
      !Array.isArray(record.select) ||
      record.select.length === 0 ||
      !record.select.every(
        (choice) => typeof choice === 'string' && choice.length > 0,
      )
    ) {
      throw new TypeError(`${path}.select must contain non-empty strings.`);
    }
    return { fieldPath, select: record.select as string[] };
  }
  if (record.attachmentFile !== undefined) {
    return {
      attachmentFile: requiredString(
        record.attachmentFile,
        `${path}.attachmentFile`,
      ),
      fieldPath,
    };
  }
  throw new TypeError(`${path} does not contain a supported field value.`);
}

function parseFields(value: unknown, path: string): readonly FieldValue[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty array.`);
  }
  const fields = value.map((field, index) =>
    parseFieldValue(field, `${path}[${index}]`),
  );
  const paths = new Set<string>();
  for (const field of fields) {
    if (paths.has(field.fieldPath)) {
      throw new TypeError(`${path} repeats field ${field.fieldPath}.`);
    }
    paths.add(field.fieldPath);
  }
  return fields;
}

export async function loadRegistrationData(
  path: string,
): Promise<RegistrationData> {
  const absolutePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to read registration data at ${absolutePath}.`, {
      cause: error,
    });
  }
  const root = asRecord(parsed, 'registration data');
  if (root.schemaVersion !== 1) {
    throw new TypeError('registration data schemaVersion must be 1.');
  }
  const brand = asRecord(root.brand, 'brand');
  const campaign = asRecord(root.campaign, 'campaign');
  const tollFree = asRecord(root.tollFree, 'tollFree');

  return {
    brand: { fields: parseFields(brand.fields, 'brand.fields') },
    campaign: { fields: parseFields(campaign.fields, 'campaign.fields') },
    dataDirectory: dirname(absolutePath),
    registrationNamePrefix: requiredString(
      root.registrationNamePrefix,
      'registrationNamePrefix',
    ),
    schemaVersion: 1,
    tollFree: {
      fields: parseFields(tollFree.fields, 'tollFree.fields'),
      optOutListName: requiredString(
        tollFree.optOutListName,
        'tollFree.optOutListName',
      ),
    },
  };
}

function flagValue(
  args: readonly string[],
  index: number,
  name: string,
): { readonly consumed: number; readonly value: string } {
  const argument = args[index];
  if (argument === undefined) {
    throw new TypeError(`Missing ${name} argument.`);
  }
  const equalsPrefix = `${name}=`;
  if (argument.startsWith(equalsPrefix)) {
    return {
      consumed: 1,
      value: requiredString(argument.slice(equalsPrefix.length), name),
    };
  }
  const value = args[index + 1];
  return { consumed: 2, value: requiredString(value, name) };
}

function defaultPaths(baseDirectory: string): {
  readonly dataPath: string;
  readonly statePath: string;
} {
  return {
    dataPath: join(baseDirectory, 'registration-data.json'),
    statePath: join(baseDirectory, 'registration-state.json'),
  };
}

export function parseSubmitOptions(
  args: readonly string[],
  baseDirectory: string,
): SubmitOptions {
  let { dataPath, statePath } = defaultPaths(baseDirectory);
  let submit = false;
  let confirmedAccount: string | undefined;
  let confirmedRegion: string | undefined;
  let confirmation: string | undefined;

  for (let index = 0; index < args.length; ) {
    const argument = args[index];
    if (argument === '--submit') {
      submit = true;
      index += 1;
      continue;
    }
    const supported = [
      '--confirm-account',
      '--confirm-action',
      '--confirm-region',
      '--data',
      '--state',
    ].find(
      (name) => argument === name || argument?.startsWith(`${name}=`) === true,
    );
    if (supported === undefined) {
      throw new TypeError(`Unknown argument: ${argument ?? '<missing>'}`);
    }
    const parsed = flagValue(args, index, supported);
    index += parsed.consumed;
    if (supported === '--confirm-account') confirmedAccount = parsed.value;
    if (supported === '--confirm-action') confirmation = parsed.value;
    if (supported === '--confirm-region') confirmedRegion = parsed.value;
    if (supported === '--data') dataPath = parsed.value;
    if (supported === '--state') statePath = parsed.value;
  }

  return {
    ...(confirmation === undefined ? {} : { confirmation }),
    ...(confirmedAccount === undefined ? {} : { confirmedAccount }),
    ...(confirmedRegion === undefined ? {} : { confirmedRegion }),
    dataPath,
    statePath,
    submit,
  };
}

export function parseStatusOptions(
  args: readonly string[],
  baseDirectory: string,
): StatusOptions {
  let { dataPath, statePath } = defaultPaths(baseDirectory);
  let check = false;
  let confirmedAccount: string | undefined;
  let confirmedRegion: string | undefined;
  let definitions: RegistrationKind | undefined;
  let validateData: RegistrationKind | undefined;

  for (let index = 0; index < args.length; ) {
    const argument = args[index];
    if (argument === '--check') {
      check = true;
      index += 1;
      continue;
    }
    const supported = [
      '--confirm-account',
      '--confirm-region',
      '--data',
      '--definitions',
      '--state',
      '--validate-data',
    ].find(
      (name) => argument === name || argument?.startsWith(`${name}=`) === true,
    );
    if (supported === undefined) {
      throw new TypeError(`Unknown argument: ${argument ?? '<missing>'}`);
    }
    const parsed = flagValue(args, index, supported);
    index += parsed.consumed;
    if (supported === '--confirm-account') confirmedAccount = parsed.value;
    if (supported === '--confirm-region') confirmedRegion = parsed.value;
    if (supported === '--data') dataPath = parsed.value;
    if (supported === '--state') statePath = parsed.value;
    if (supported === '--definitions' || supported === '--validate-data') {
      const normalized =
        parsed.value === 'toll-free' ? 'tollFree' : parsed.value;
      if (!['brand', 'campaign', 'tollFree'].includes(normalized)) {
        throw new TypeError(
          `${supported} must be brand, campaign, or toll-free.`,
        );
      }
      if (supported === '--definitions') {
        definitions = normalized as RegistrationKind;
      } else {
        validateData = normalized as RegistrationKind;
      }
    }
  }
  if (definitions !== undefined && validateData !== undefined) {
    throw new TypeError(
      'Use only one of --definitions or --validate-data per invocation.',
    );
  }
  if (definitions !== undefined || validateData !== undefined) check = true;
  return {
    check,
    ...(confirmedAccount === undefined ? {} : { confirmedAccount }),
    ...(confirmedRegion === undefined ? {} : { confirmedRegion }),
    dataPath,
    ...(definitions === undefined ? {} : { definitions }),
    statePath,
    ...(validateData === undefined ? {} : { validateData }),
  };
}

function assertTargetConfirmation(options: {
  readonly confirmedAccount?: string;
  readonly confirmedRegion?: string;
}): void {
  if (options.confirmedAccount !== TARGET_ACCOUNT) {
    throw new Error(
      `Refusing AWS access without --confirm-account ${TARGET_ACCOUNT}.`,
    );
  }
  if (options.confirmedRegion !== TARGET_REGION) {
    throw new Error(
      `Refusing AWS access without --confirm-region ${TARGET_REGION}.`,
    );
  }
}

function assertSubmitAuthorized(
  kind: RegistrationKind,
  options: SubmitOptions,
  runtime: Runtime,
): void {
  assertTargetConfirmation(options);
  if (!runtime.isInteractive) {
    throw new Error(
      'Real registration submission requires an interactive TTY.',
    );
  }
  const ci = runtime.env.CI;
  if (ci !== undefined && ci !== '' && ci.toLowerCase() !== 'false') {
    throw new Error('Real registration submission is disabled in CI.');
  }
  const requiredConfirmation = CONFIRMATIONS[kind];
  if (options.confirmation !== requiredConfirmation) {
    throw new Error(
      `Refusing mutation without --confirm-action ${requiredConfirmation}.`,
    );
  }
}

async function assertCallerAccount(api: SmsRegistrationApi): Promise<void> {
  const identity = await api.getCallerIdentity();
  if (identity.accountId !== TARGET_ACCOUNT) {
    throw new Error(
      `AWS credential account is ${identity.accountId === undefined ? 'unknown' : terminalSafeText(identity.accountId)}, expected ${TARGET_ACCOUNT}. No registration mutation was attempted.`,
    );
  }
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new TypeError(
      `${path} contains unexpected keys: ${unexpected.join(', ')}.`,
    );
  }
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean')
    throw new TypeError(`${path} must be boolean.`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, path);
}

function parsePersistedRegistration(
  value: unknown,
  path: string,
  expectedKind: 'tollFree',
): PersistedTollFreeRegistration;
function parsePersistedRegistration(
  value: unknown,
  path: string,
  expectedKind: 'brand' | 'campaign',
): PersistedRegistration;
function parsePersistedRegistration(
  value: unknown,
  path: string,
  expectedKind: RegistrationKind,
): PersistedRegistration | PersistedTollFreeRegistration {
  const record = asRecord(value, path);
  const isTollFree = expectedKind === 'tollFree';
  assertOnlyKeys(
    record,
    [
      'associatedBrand',
      'associationAttempted',
      'attachments',
      'clientToken',
      'inputFingerprint',
      'kind',
      'phoneClientToken',
      'phoneNumberId',
      'registrationId',
      'submissionAttempted',
      'submitted',
    ],
    path,
  );
  if (record.kind !== expectedKind) {
    throw new TypeError(`${path}.kind must be ${expectedKind}.`);
  }
  const attachmentsRecord = asRecord(record.attachments, `${path}.attachments`);
  const attachments: PersistedRegistration['attachments'] = {};
  for (const [fieldPath, rawAttachment] of Object.entries(attachmentsRecord)) {
    const attachment = asRecord(
      rawAttachment,
      `${path}.attachments.${fieldPath}`,
    );
    assertOnlyKeys(
      attachment,
      ['attachmentId', 'attachmentStatus', 'clientToken', 'contentFingerprint'],
      `${path}.attachments.${fieldPath}`,
    );
    const contentFingerprint = requiredString(
      attachment.contentFingerprint,
      `${path}.attachments.${fieldPath}.contentFingerprint`,
    );
    if (!/^[a-f0-9]{64}$/u.test(contentFingerprint)) {
      throw new TypeError(
        `${path}.attachments.${fieldPath}.contentFingerprint must be a SHA-256 hex digest.`,
      );
    }
    attachments[fieldPath] = {
      ...(attachment.attachmentId === undefined
        ? {}
        : {
            attachmentId: requiredString(
              attachment.attachmentId,
              `${path}.attachments.${fieldPath}.attachmentId`,
            ),
          }),
      ...(attachment.attachmentStatus === undefined
        ? {}
        : {
            attachmentStatus: requiredString(
              attachment.attachmentStatus,
              `${path}.attachments.${fieldPath}.attachmentStatus`,
            ),
          }),
      clientToken: requiredString(
        attachment.clientToken,
        `${path}.attachments.${fieldPath}.clientToken`,
      ),
      contentFingerprint,
    };
  }
  const registrationId = optionalString(
    record.registrationId,
    `${path}.registrationId`,
  );
  const base: PersistedRegistration = {
    ...(optionalBoolean(
      record.associationAttempted,
      `${path}.associationAttempted`,
    ) === undefined
      ? {}
      : { associationAttempted: record.associationAttempted as boolean }),
    ...(optionalBoolean(record.associatedBrand, `${path}.associatedBrand`) ===
    undefined
      ? {}
      : { associatedBrand: record.associatedBrand as boolean }),
    attachments,
    clientToken: requiredString(record.clientToken, `${path}.clientToken`),
    inputFingerprint: requiredString(
      record.inputFingerprint,
      `${path}.inputFingerprint`,
    ),
    kind: expectedKind,
    ...(registrationId === undefined ? {} : { registrationId }),
    ...(optionalBoolean(
      record.submissionAttempted,
      `${path}.submissionAttempted`,
    ) === undefined
      ? {}
      : { submissionAttempted: record.submissionAttempted as boolean }),
    ...(optionalBoolean(record.submitted, `${path}.submitted`) === undefined
      ? {}
      : { submitted: record.submitted as boolean }),
  };
  if (!/^[a-f0-9]{64}$/u.test(base.inputFingerprint)) {
    throw new TypeError(
      `${path}.inputFingerprint must be a SHA-256 hex digest.`,
    );
  }
  if (
    expectedKind !== 'campaign' &&
    (base.associationAttempted !== undefined ||
      base.associatedBrand !== undefined)
  ) {
    throw new TypeError(`${path} contains campaign-only association state.`);
  }
  if (!isTollFree) {
    if (
      record.phoneClientToken !== undefined ||
      record.phoneNumberId !== undefined
    ) {
      throw new TypeError(`${path} contains toll-free-only phone state.`);
    }
    return base;
  }
  const phoneNumberId = optionalString(
    record.phoneNumberId,
    `${path}.phoneNumberId`,
  );
  if (phoneNumberId !== undefined && registrationId === undefined) {
    throw new TypeError(`${path}.phoneNumberId requires registrationId.`);
  }
  return {
    ...base,
    phoneClientToken: requiredString(
      record.phoneClientToken,
      `${path}.phoneClientToken`,
    ),
    ...(phoneNumberId === undefined ? {} : { phoneNumberId }),
  };
}

function blankRegistration(
  kind: RegistrationKind,
  clientToken: string,
  inputFingerprint: string,
): PersistedRegistration {
  return { attachments: {}, clientToken, inputFingerprint, kind };
}

function emptyState(): RegistrationState {
  return {
    schemaVersion: 2,
    targetAccount: TARGET_ACCOUNT,
    targetRegion: TARGET_REGION,
  };
}

export async function loadState(path: string): Promise<RegistrationState> {
  try {
    const parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
    const state = asRecord(parsed, 'registration state');
    if (state.schemaVersion !== 2) {
      throw new TypeError(
        'registration state schemaVersion must be 2. Do not migrate external resource IDs implicitly; recover and verify them with AWS first.',
      );
    }
    assertOnlyKeys(
      state,
      [
        'brand',
        'campaign',
        'schemaVersion',
        'targetAccount',
        'targetRegion',
        'tollFree',
      ],
      'registration state',
    );
    if (state.targetAccount !== TARGET_ACCOUNT) {
      throw new TypeError(
        `registration state targetAccount must be ${TARGET_ACCOUNT}.`,
      );
    }
    if (state.targetRegion !== TARGET_REGION) {
      throw new TypeError(
        `registration state targetRegion must be ${TARGET_REGION}.`,
      );
    }
    return {
      ...(state.brand === undefined
        ? {}
        : {
            brand: parsePersistedRegistration(
              state.brand,
              'state.brand',
              'brand',
            ),
          }),
      ...(state.campaign === undefined
        ? {}
        : {
            campaign: parsePersistedRegistration(
              state.campaign,
              'state.campaign',
              'campaign',
            ),
          }),
      schemaVersion: 2,
      targetAccount: TARGET_ACCOUNT,
      targetRegion: TARGET_REGION,
      ...(state.tollFree === undefined
        ? {}
        : {
            tollFree: parsePersistedRegistration(
              state.tollFree,
              'state.tollFree',
              'tollFree',
            ),
          }),
    };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return emptyState();
    }
    throw new Error(`Unable to read registration state at ${resolve(path)}.`, {
      cause: error,
    });
  }
}

export async function saveState(
  path: string,
  state: RegistrationState,
): Promise<void> {
  const absolutePath = resolve(path);
  const temporaryPath = `${absolutePath}.tmp`;
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, absolutePath);
}

async function withExclusiveSubmitLock<T>(
  statePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const absoluteStatePath = resolve(statePath);
  const lockPath = `${absoluteStatePath}.lock`;
  await mkdir(dirname(absoluteStatePath), { recursive: true });
  let lockHandle: Awaited<ReturnType<typeof open>>;
  try {
    lockHandle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      throw new Error(
        `Another submit workflow holds ${lockPath}. If a prior process crashed, verify its AWS state before removing the stale lock.`,
        { cause: error },
      );
    }
    throw error;
  }
  const releaseLock = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      await lockHandle.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await unlink(lockPath);
    } catch (error) {
      if (
        !(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      ) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Unable to release ${lockPath}.`);
    }
  };
  try {
    await lockHandle.writeFile(
      `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid })}\n`,
      { encoding: 'utf8' },
    );
    await lockHandle.chmod(0o600);
    const result = await operation();
    await releaseLock();
    return result;
  } catch (operationError) {
    try {
      await releaseLock();
    } catch (releaseError) {
      throw new AggregateError(
        [operationError, releaseError],
        `Submit workflow failed and ${lockPath} could not be released.`,
      );
    }
    throw operationError;
  }
}

function fieldsForKind(
  data: RegistrationData,
  kind: RegistrationKind,
): readonly FieldValue[] {
  return data[kind].fields;
}

function containsPlaceholder(value: string): boolean {
  return (
    /example|\.invalid|00-0000000|000000000|replace_(?:me|with)/iu.test(
      value,
    ) || value === '+12065550100'
  );
}

function assertNoPlaceholders(
  data: RegistrationData,
  fields: readonly FieldValue[],
): void {
  const offenders: string[] = [];
  if (containsPlaceholder(data.registrationNamePrefix)) {
    offenders.push('registrationNamePrefix');
  }
  for (const field of fields) {
    const values =
      'text' in field && field.text !== undefined
        ? [field.text]
        : 'select' in field && field.select !== undefined
          ? field.select
          : 'attachmentFile' in field && field.attachmentFile !== undefined
            ? [field.attachmentFile]
            : [];
    if (values.some(containsPlaceholder)) offenders.push(field.fieldPath);
  }
  if (offenders.length > 0) {
    throw new Error(
      `Refusing submission while placeholder values remain in: ${offenders.join(', ')}.`,
    );
  }
}

function requireConfiguredFields(
  fieldsByPath: ReadonlyMap<string, FieldValue>,
  requiredPaths: readonly string[],
  reason: string,
): void {
  const missing = requiredPaths.filter((path) => !fieldsByPath.has(path));
  if (missing.length > 0) {
    throw new Error(`${reason}: ${missing.join(', ')}.`);
  }
}

function selectedValue(
  fieldsByPath: ReadonlyMap<string, FieldValue>,
  fieldPath: string,
): string | undefined {
  const field = fieldsByPath.get(fieldPath);
  return field !== undefined && 'select' in field
    ? field.select?.[0]
    : undefined;
}

function validateKnownConditionalRules(
  kind: RegistrationKind,
  fields: readonly FieldValue[],
): void {
  const fieldsByPath = new Map(fields.map((field) => [field.fieldPath, field]));
  if (
    kind === 'brand' &&
    selectedValue(fieldsByPath, 'companyInfo.legalType') === 'PUBLIC_PROFIT'
  ) {
    requireConfiguredFields(
      fieldsByPath,
      [
        'companyInfo.stockSymbol',
        'companyInfo.stockExchange',
        'companyInfo.businessContactEmail',
      ],
      'PUBLIC_PROFIT brand registrations require the conditional company fields',
    );
  }
  if (
    kind === 'tollFree' &&
    selectedValue(fieldsByPath, 'companyInfo.businessType') !==
      'SOLE_PROPRIETOR'
  ) {
    requireConfiguredFields(
      fieldsByPath,
      [
        'companyInfo.taxId',
        'companyInfo.taxIdAuthority',
        'companyInfo.taxIdCountry',
      ],
      'Non-sole-proprietor toll-free registrations require the conditional company-identification fields',
    );
  }
  if (kind === 'campaign') {
    const hasTerms =
      fieldsByPath.has('campaignInfo.termsAndConditionsLink') ||
      fieldsByPath.has('campaignInfo.termsAndConditionsFile');
    const hasPrivacy =
      fieldsByPath.has('campaignInfo.privacyPolicyLink') ||
      fieldsByPath.has('campaignInfo.privacyPolicyFile');
    if (!hasTerms || !hasPrivacy) {
      throw new Error(
        'Campaign registration requires a terms-and-conditions URL/file and a privacy-policy URL/file.',
      );
    }
    requireConfiguredFields(
      fieldsByPath,
      ['campaignInfo.optInScreenshot'],
      'PSD EOC requires opt-in evidence even when AWS marks the screenshot conditional',
    );
  }
  if (kind === 'campaign' || kind === 'tollFree') {
    const samples = fields
      .filter(
        (field): field is Extract<FieldValue, { readonly text: string }> =>
          field.fieldPath.startsWith('messageSamples.') &&
          'text' in field &&
          field.text !== undefined,
      )
      .map((field) => field.text.toUpperCase());
    const hasReal = samples.some(
      (sample) => sample.includes('REAL INCIDENT') && !sample.includes('DRILL'),
    );
    const hasDrill = samples.some(
      (sample) => sample.includes('DRILL') && !sample.includes('REAL INCIDENT'),
    );
    if (!hasReal || !hasDrill) {
      throw new Error(
        `${kind} message samples must include separate, unmistakable REAL INCIDENT and DRILL examples.`,
      );
    }
  }
}

function validateAgainstDefinitions(
  kind: RegistrationKind,
  fields: readonly FieldValue[],
  definitions: readonly FieldDefinition[],
): void {
  const definitionsByPath = new Map(
    definitions.map((definition) => [definition.fieldPath, definition]),
  );
  const configuredPaths = new Set(fields.map((field) => field.fieldPath));
  const missing = definitions
    .filter(
      (definition) =>
        definition.fieldRequirement === 'REQUIRED' &&
        !configuredPaths.has(definition.fieldPath),
    )
    .map((definition) => definition.fieldPath);
  if (missing.length > 0) {
    throw new Error(
      `registration-data.json is missing AWS-required fields: ${missing.map(terminalSafeText).join(', ')}.`,
    );
  }

  for (const field of fields) {
    const definition = definitionsByPath.get(field.fieldPath);
    if (definition === undefined) {
      throw new Error(
        `AWS does not define field ${field.fieldPath} for this registration type. Run status.ts --definitions to refresh the example.`,
      );
    }
    const configuredType =
      'text' in field && field.text !== undefined
        ? 'TEXT'
        : 'select' in field && field.select !== undefined
          ? 'SELECT'
          : 'ATTACHMENT';
    if (definition.fieldType !== configuredType) {
      throw new Error(
        `${field.fieldPath} is ${terminalSafeText(definition.fieldType)} in AWS but configured as ${configuredType}.`,
      );
    }
    if ('text' in field && field.text !== undefined) {
      const { maxLength, minLength, pattern } = definition.textValidation ?? {};
      if (minLength !== undefined && field.text.length < minLength) {
        throw new Error(`${field.fieldPath} is shorter than ${minLength}.`);
      }
      if (maxLength !== undefined && field.text.length > maxLength) {
        throw new Error(`${field.fieldPath} is longer than ${maxLength}.`);
      }
      if (pattern !== undefined) {
        let expression: RegExp;
        try {
          expression = new RegExp(pattern, 'u');
        } catch (error) {
          throw new Error(
            `AWS supplied an unsupported validation pattern for ${field.fieldPath}; refusing mutation.`,
            { cause: error },
          );
        }
        if (!expression.test(field.text)) {
          throw new Error(
            `${field.fieldPath} does not match the current AWS validation pattern.`,
          );
        }
      }
    }
    if ('select' in field && field.select !== undefined) {
      const validation = definition.selectValidation;
      if (
        validation?.minChoices !== undefined &&
        field.select.length < validation.minChoices
      ) {
        throw new Error(
          `${field.fieldPath} requires at least ${validation.minChoices} choice(s).`,
        );
      }
      if (
        validation?.maxChoices !== undefined &&
        field.select.length > validation.maxChoices
      ) {
        throw new Error(
          `${field.fieldPath} permits at most ${validation.maxChoices} choice(s).`,
        );
      }
      const allowed = validation?.options;
      if (
        allowed !== undefined &&
        field.select.some((choice) => !allowed.includes(choice))
      ) {
        throw new Error(
          `${field.fieldPath} contains an unsupported choice. Allowed values: ${allowed.map(terminalSafeText).join(', ')}.`,
        );
      }
    }
  }
  validateKnownConditionalRules(kind, fields);
}

function resolvedAttachmentPath(
  dataDirectory: string,
  attachmentPath: string,
): string {
  return isAbsolute(attachmentPath)
    ? attachmentPath
    : resolve(dataDirectory, attachmentPath);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_VISUAL_ANCILLARY_CHUNKS = new Set([
  'acTL',
  'bKGD',
  'cHRM',
  'fcTL',
  'fdAT',
  'gAMA',
  'iCCP',
  'sBIT',
  'sRGB',
  'tRNS',
]);

function sanitizePng(body: Uint8Array, path: string): Uint8Array {
  const bytes = Buffer.from(body);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`Attachment ${path} is not a structurally valid PNG.`);
  }
  const parts: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE.length)];
  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error(`Attachment ${path} contains a truncated PNG chunk.`);
    }
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) {
      throw new Error(
        `Attachment ${path} contains an invalid PNG chunk length.`,
      );
    }
    const chunkType = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    if (chunkType === 'IHDR') sawHeader = true;
    if (chunkType === 'IDAT' || chunkType === 'fdAT') sawImageData = true;
    const isCritical =
      (bytes[offset + 4] ?? 0) >= 65 && (bytes[offset + 4] ?? 0) <= 90;
    if (isCritical || PNG_VISUAL_ANCILLARY_CHUNKS.has(chunkType)) {
      parts.push(bytes.subarray(offset, chunkEnd));
    }
    offset = chunkEnd;
    if (chunkType === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawHeader || !sawImageData || !sawEnd) {
    throw new Error(`Attachment ${path} is missing required PNG image chunks.`);
  }
  return Buffer.concat(parts);
}

function sanitizeJpeg(body: Uint8Array, path: string): Uint8Array {
  const bytes = Buffer.from(body);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error(`Attachment ${path} is not a structurally valid JPEG.`);
  }
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset < bytes.length) {
    const markerStart = offset;
    if (bytes[offset] !== 0xff) {
      throw new Error(`Attachment ${path} contains invalid JPEG marker data.`);
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    if (marker === undefined || marker === 0x00) {
      throw new Error(`Attachment ${path} contains a truncated JPEG marker.`);
    }
    offset += 1;
    if (marker === 0xd9) {
      parts.push(bytes.subarray(markerStart, offset));
      return Buffer.concat(parts);
    }
    const standaloneMarker =
      marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);
    if (standaloneMarker) {
      parts.push(bytes.subarray(markerStart, offset));
      continue;
    }
    if (offset + 2 > bytes.length) {
      throw new Error(`Attachment ${path} contains a truncated JPEG segment.`);
    }
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2) {
      throw new Error(`Attachment ${path} contains an invalid JPEG segment.`);
    }
    const segmentEnd = offset + segmentLength;
    if (segmentEnd > bytes.length) {
      throw new Error(`Attachment ${path} contains a truncated JPEG segment.`);
    }
    if (marker === 0xda) {
      let imageEnd: number | undefined;
      for (let index = segmentEnd; index + 1 < bytes.length; index += 1) {
        if (bytes[index] === 0xff && bytes[index + 1] === 0xd9) {
          imageEnd = index + 2;
          break;
        }
      }
      if (imageEnd === undefined) {
        throw new Error(`Attachment ${path} is missing the JPEG end marker.`);
      }
      parts.push(bytes.subarray(markerStart, imageEnd));
      return Buffer.concat(parts);
    }
    const isMetadataSegment =
      marker === 0xfe ||
      marker === 0xe1 ||
      (marker >= 0xe3 && marker <= 0xed) ||
      marker === 0xef;
    if (!isMetadataSegment) {
      parts.push(bytes.subarray(markerStart, segmentEnd));
    }
    offset = segmentEnd;
  }
  throw new Error(`Attachment ${path} is missing complete JPEG image data.`);
}

async function attachmentBody(
  dataDirectory: string,
  attachmentPath: string,
  kind: RegistrationKind,
  fieldPath: string,
): Promise<Uint8Array> {
  const absolutePath = resolvedAttachmentPath(dataDirectory, attachmentPath);
  const extension = extname(absolutePath).toLowerCase();
  if (!ALLOWED_ATTACHMENT_EXTENSIONS.has(extension)) {
    throw new Error(
      `Attachment ${absolutePath} must be JPEG, JPG, or PNG. PDF and S3 inputs are intentionally unsupported so metadata can be stripped locally.`,
    );
  }
  const body = await readFile(absolutePath);
  const maximumBytes =
    kind === 'tollFree' && fieldPath === 'messagingUseCase.optInImage'
      ? MAX_TOLL_FREE_OPT_IN_BYTES
      : MAX_ATTACHMENT_BYTES;
  if (body.byteLength === 0 || body.byteLength > maximumBytes) {
    throw new Error(
      `Attachment ${absolutePath} must be between 1 byte and ${String(maximumBytes / 1024)} KiB.`,
    );
  }
  const sanitized =
    extension === '.png'
      ? sanitizePng(body, absolutePath)
      : sanitizeJpeg(body, absolutePath);
  if (sanitized.byteLength === 0 || sanitized.byteLength > maximumBytes) {
    throw new Error(
      `Sanitized attachment ${absolutePath} exceeds its size limit.`,
    );
  }
  return sanitized;
}

interface PreparedAttachment {
  readonly body: Uint8Array;
  readonly contentFingerprint: string;
}

async function prepareAttachments(
  data: RegistrationData,
  fields: readonly FieldValue[],
  kind: RegistrationKind,
): Promise<ReadonlyMap<string, PreparedAttachment>> {
  const prepared = new Map<string, PreparedAttachment>();
  for (const field of fields) {
    if (!('attachmentFile' in field) || field.attachmentFile === undefined) {
      continue;
    }
    const body = await attachmentBody(
      data.dataDirectory,
      field.attachmentFile,
      kind,
      field.fieldPath,
    );
    prepared.set(field.fieldPath, {
      body,
      contentFingerprint: sha256(body),
    });
  }
  return prepared;
}

function inputFingerprint(
  data: RegistrationData,
  fields: readonly FieldValue[],
  kind: RegistrationKind,
  preparedAttachments: ReadonlyMap<string, PreparedAttachment>,
): string {
  const canonicalFields = [...fields]
    .sort((left, right) => left.fieldPath.localeCompare(right.fieldPath))
    .map((field) => {
      if ('text' in field && field.text !== undefined) {
        return { fieldPath: field.fieldPath, text: field.text };
      }
      if ('select' in field && field.select !== undefined) {
        return { fieldPath: field.fieldPath, select: [...field.select].sort() };
      }
      const attachment = preparedAttachments.get(field.fieldPath);
      if (attachment === undefined) {
        throw new Error(`Missing prepared attachment for ${field.fieldPath}.`);
      }
      return {
        attachmentContentSha256: attachment.contentFingerprint,
        fieldPath: field.fieldPath,
      };
    });
  return sha256(
    JSON.stringify({
      fields: canonicalFields,
      kind,
      registrationNamePrefix: data.registrationNamePrefix,
      ...(kind === 'tollFree'
        ? { optOutListName: data.tollFree.optOutListName }
        : {}),
      registrationType: REGISTRATION_TYPES[kind],
      targetAccount: TARGET_ACCOUNT,
      targetRegion: TARGET_REGION,
    }),
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

async function requireAttachmentComplete(input: {
  readonly api: SmsRegistrationApi;
  readonly attachment: PersistedRegistration['attachments'][string];
  readonly attachmentId: string;
  readonly persist: () => Promise<void>;
}): Promise<void> {
  let status = input.attachment.attachmentStatus;
  for (
    let attempt = 0;
    attempt < 10 && status !== 'UPLOAD_COMPLETE';
    attempt += 1
  ) {
    const live = (
      await input.api.describeAttachments([input.attachmentId])
    ).find((attachment) => attachment.attachmentId === input.attachmentId);
    status = live?.status ?? 'unknown';
    input.attachment.attachmentStatus = status;
    await input.persist();
    if (status === 'UPLOAD_FAILED' || status === 'DELETED') {
      throw new Error(
        `Registration attachment ${input.attachmentId} is ${status}; submission stopped.`,
      );
    }
    if (status !== 'UPLOAD_COMPLETE') await delay(250);
  }
  if (status !== 'UPLOAD_COMPLETE') {
    throw new Error(
      `Registration attachment ${input.attachmentId} is ${status ?? 'unknown'}, not UPLOAD_COMPLETE. Re-run after AWS finishes processing it.`,
    );
  }
}

async function populateFields(input: {
  readonly api: SmsRegistrationApi;
  readonly data: RegistrationData;
  readonly fields: readonly FieldValue[];
  readonly kind: RegistrationKind;
  readonly persist: () => Promise<void>;
  readonly preparedAttachments: ReadonlyMap<string, PreparedAttachment>;
  readonly registration: PersistedRegistration;
  readonly registrationId: string;
  readonly runtime: Runtime;
}): Promise<void> {
  for (const field of input.fields) {
    if ('attachmentFile' in field && field.attachmentFile !== undefined) {
      const prepared = input.preparedAttachments.get(field.fieldPath);
      if (prepared === undefined) {
        throw new Error(`Missing prepared attachment for ${field.fieldPath}.`);
      }
      let attachment = input.registration.attachments[field.fieldPath];
      if (attachment === undefined) {
        attachment = {
          clientToken: input.runtime.randomToken(`${input.kind}-attachment`),
          contentFingerprint: prepared.contentFingerprint,
        };
        input.registration.attachments[field.fieldPath] = attachment;
        await input.persist();
      }
      if (attachment.contentFingerprint !== prepared.contentFingerprint) {
        throw new Error(
          `Attachment content for ${field.fieldPath} changed after state was bound. Stop and reconcile the existing AWS registration before continuing.`,
        );
      }
      if (attachment.attachmentId === undefined) {
        const created = await input.api.createAttachment({
          attachmentBody: prepared.body,
          clientToken: attachment.clientToken,
          name: `PSD EOC ${input.kind} ${field.fieldPath}`,
        });
        attachment.attachmentId = created.attachmentId;
        attachment.attachmentStatus = created.attachmentStatus;
        await input.persist();
      }
      const attachmentId = attachment.attachmentId;
      if (attachmentId === undefined) {
        throw new Error(`Missing attachment ID for ${field.fieldPath}.`);
      }
      await requireAttachmentComplete({
        api: input.api,
        attachment,
        attachmentId,
        persist: input.persist,
      });
      await input.api.putFieldValue({
        attachmentId,
        fieldPath: field.fieldPath,
        registrationId: input.registrationId,
      });
      continue;
    }
    if ('select' in field && field.select !== undefined) {
      await input.api.putFieldValue({
        fieldPath: field.fieldPath,
        registrationId: input.registrationId,
        select: field.select,
      });
      continue;
    }
    if ('text' in field && field.text !== undefined) {
      await input.api.putFieldValue({
        fieldPath: field.fieldPath,
        registrationId: input.registrationId,
        text: field.text,
      });
    }
  }
}

function registrationName(
  data: RegistrationData,
  kind: RegistrationKind,
): string {
  const suffix =
    kind === 'brand'
      ? '10DLC brand'
      : kind === 'campaign'
        ? '10DLC campaign'
        : 'toll-free';
  return `${data.registrationNamePrefix} — ${suffix}`;
}

function describePreview(
  kind: RegistrationKind,
  data: RegistrationData,
  options: SubmitOptions,
  runtime: Runtime,
): void {
  const fields = fieldsForKind(data, kind);
  const attachmentCount = fields.filter(
    (field) => 'attachmentFile' in field && field.attachmentFile !== undefined,
  ).length;
  runtime.stdout('PSD EOC SMS registration consequence preview');
  runtime.stdout(
    `mode: ${options.submit ? 'REAL SUBMISSION REQUESTED' : 'OFFLINE DRY-RUN'}`,
  );
  runtime.stdout(`account: ${TARGET_ACCOUNT}`);
  runtime.stdout(`region: ${TARGET_REGION}`);
  runtime.stdout(`registration type: ${REGISTRATION_TYPES[kind]}`);
  runtime.stdout(
    `configured fields: ${fields.length}; attachments: ${attachmentCount}`,
  );
  runtime.stdout(
    'Business, tax, contact, and message values are intentionally redacted.',
  );
  if (kind === 'tollFree') {
    runtime.stdout(
      'CONSEQUENCE: RequestPhoneNumber starts a recurring toll-free number lease charge before registration review.',
    );
  } else {
    runtime.stdout(
      'CONSEQUENCE: submission creates an externally reviewed carrier/TCR registration that cannot be edited while under review.',
    );
  }
  if (!options.submit) {
    runtime.stdout('No AWS client was created and no AWS request was made.');
    runtime.stdout(
      `To submit, add --submit --confirm-account ${TARGET_ACCOUNT} --confirm-region ${TARGET_REGION} --confirm-action ${CONFIRMATIONS[kind]}.`,
    );
  }
}

function stateRegistration(
  state: RegistrationState,
  kind: RegistrationKind,
  fingerprint: string,
  runtime: Runtime,
): PersistedRegistration {
  const current = state[kind];
  if (current !== undefined) {
    if (current.kind !== kind || current.inputFingerprint !== fingerprint) {
      throw new Error(
        `${kind} input no longer matches the account/region/kind-bound local state. Do not reuse or delete the state until its AWS resource IDs have been reconciled.`,
      );
    }
    return current;
  }
  const created = blankRegistration(
    kind,
    runtime.randomToken(`${kind}-registration`),
    fingerprint,
  );
  if (kind === 'brand') state.brand = created;
  if (kind === 'campaign') state.campaign = created;
  if (kind === 'tollFree') {
    state.tollFree = {
      ...created,
      phoneClientToken: runtime.randomToken('toll-free-number'),
    };
  }
  return state[kind] as PersistedRegistration;
}

async function createRegistrationIfNeeded(input: {
  readonly api: SmsRegistrationApi;
  readonly data: RegistrationData;
  readonly kind: RegistrationKind;
  readonly persist: () => Promise<void>;
  readonly registration: PersistedRegistration;
}): Promise<string> {
  if (input.registration.registrationId !== undefined) {
    return input.registration.registrationId;
  }
  const created = await input.api.createRegistration({
    clientToken: input.registration.clientToken,
    name: registrationName(input.data, input.kind),
    registrationType: REGISTRATION_TYPES[input.kind],
  });
  input.registration.registrationId = created.registrationId;
  await input.persist();
  return created.registrationId;
}

const SUBMITTED_VERSION_STATUSES = new Set([
  'APPROVED',
  'AWS_REVIEWING',
  'REQUIRES_AUTHENTICATION',
  'REQUIRES_OFFLINE_REVIEW',
  'REVIEWING',
  'SUBMITTED',
]);

function latestVersion(
  versions: readonly RegistrationVersionRecord[],
): RegistrationVersionRecord | undefined {
  return [...versions].sort(
    (left, right) => right.versionNumber - left.versionNumber,
  )[0];
}

async function reconcileRegistration(input: {
  readonly api: SmsRegistrationApi;
  readonly kind: RegistrationKind;
  readonly persist: () => Promise<void>;
  readonly registration: PersistedRegistration;
  readonly runtime: Runtime;
}): Promise<'already-submitted' | 'editable' | 'missing'> {
  const registrationId = input.registration.registrationId;
  if (registrationId === undefined) return 'missing';
  const live = (await input.api.describeRegistrations([registrationId])).find(
    (registration) => registration.registrationId === registrationId,
  );
  if (live === undefined) {
    throw new Error(
      `${input.kind} registration ${registrationId} is missing in AWS. Local state was preserved; recover before continuing.`,
    );
  }
  if (live.registrationType !== REGISTRATION_TYPES[input.kind]) {
    throw new Error(
      `${input.kind} state points to AWS registration type ${terminalSafeText(live.registrationType)}, expected ${REGISTRATION_TYPES[input.kind]}.`,
    );
  }
  if (
    ['CLOSED', 'DELETED', 'REQUIRES_UPDATES'].includes(live.registrationStatus)
  ) {
    throw new Error(
      `${input.kind} registration is ${terminalSafeText(live.registrationStatus)}. This script does not create correction versions automatically; inspect provider feedback and follow the runbook.`,
    );
  }
  const version = latestVersion(
    await input.api.describeRegistrationVersions(registrationId),
  );
  if (version === undefined) {
    throw new Error(
      `${input.kind} registration has no readable version; refusing mutation.`,
    );
  }
  if (SUBMITTED_VERSION_STATUSES.has(version.status)) {
    input.registration.submitted = true;
    delete input.registration.submissionAttempted;
    await input.persist();
    input.runtime.stdout(
      `${input.kind} registration is already ${terminalSafeText(version.status)} in AWS; no field or submission mutation was repeated.`,
    );
    return 'already-submitted';
  }
  if (version.status !== 'DRAFT' || live.registrationStatus !== 'CREATED') {
    throw new Error(
      `${input.kind} registration/version state is ${terminalSafeText(live.registrationStatus)}/${terminalSafeText(version.status)}; automatic recovery is intentionally unsupported.`,
    );
  }
  if (input.registration.submissionAttempted === true) {
    throw new Error(
      `${input.kind} submission has unresolved prior intent but AWS still reports a draft. Do not replay SubmitRegistrationVersion until live status is reconciled by a human.`,
    );
  }
  if (input.registration.submitted === true) {
    throw new Error(
      `${input.kind} local state says submitted but AWS reports a draft. Refusing to guess which state is authoritative.`,
    );
  }
  return 'editable';
}

async function ensureCampaignBrandAssociation(input: {
  readonly api: SmsRegistrationApi;
  readonly brandId: string;
  readonly campaign: PersistedRegistration;
  readonly campaignId: string;
  readonly persist: () => Promise<void>;
}): Promise<void> {
  const associations = await input.api.listRegistrationAssociations(
    input.campaignId,
  );
  const brandAssociations = associations.filter(
    (association) => association.resourceType === REGISTRATION_TYPES.brand,
  );
  if (
    brandAssociations.some(
      (association) => association.resourceId !== input.brandId,
    )
  ) {
    throw new Error(
      'Campaign is associated with a different 10DLC brand. Refusing to replace or hide the live association.',
    );
  }
  if (
    !brandAssociations.some(
      (association) => association.resourceId === input.brandId,
    )
  ) {
    if (
      input.campaign.associationAttempted === true ||
      input.campaign.associatedBrand === true
    ) {
      throw new Error(
        'Campaign has unresolved prior association intent but AWS did not return the expected live association. Do not replay CreateRegistrationAssociation until a human reconciles eventual consistency.',
      );
    }
    input.campaign.associationAttempted = true;
    await input.persist();
    await input.api.associateRegistration({
      registrationId: input.campaignId,
      resourceId: input.brandId,
    });
    const verified = await input.api.listRegistrationAssociations(
      input.campaignId,
    );
    if (
      !verified.some(
        (association) =>
          association.resourceId === input.brandId &&
          association.resourceType === REGISTRATION_TYPES.brand,
      )
    ) {
      throw new Error(
        'AWS did not report the requested campaign-to-brand association; submission stopped.',
      );
    }
  }
  input.campaign.associatedBrand = true;
  delete input.campaign.associationAttempted;
  await input.persist();
}

async function verifyTollFreeNumberAssociation(input: {
  readonly api: SmsRegistrationApi;
  readonly phoneNumberId: string;
  readonly registrationId: string;
}): Promise<PhoneNumberRecord> {
  const phone = (
    await input.api.describePhoneNumbers([input.phoneNumberId])
  ).find((item) => item.phoneNumberId === input.phoneNumberId);
  if (phone === undefined) {
    throw new Error(
      `Leased phone number ${input.phoneNumberId} is missing in AWS; local state was preserved.`,
    );
  }
  if (phone.numberType !== undefined && phone.numberType !== 'TOLL_FREE') {
    throw new Error(
      `Phone resource ${input.phoneNumberId} is ${terminalSafeText(phone.numberType)}, not TOLL_FREE.`,
    );
  }
  if (phone.registrationId !== input.registrationId) {
    throw new Error(
      `Phone resource ${input.phoneNumberId} is not associated with the expected toll-free registration.`,
    );
  }
  if (phone.status === 'DELETED') {
    throw new Error(
      `Toll-free phone resource ${input.phoneNumberId} is DELETED.`,
    );
  }
  return phone;
}

export async function runSubmit(
  kind: RegistrationKind,
  options: SubmitOptions,
  runtime: Runtime,
): Promise<void> {
  const data = await loadRegistrationData(options.dataPath);
  describePreview(kind, data, options, runtime);
  if (!options.submit) return;

  assertSubmitAuthorized(kind, options, runtime);
  const fields = fieldsForKind(data, kind);
  assertNoPlaceholders(data, fields);
  const api = await runtime.createApi();
  await assertCallerAccount(api);
  const definitions = await api.describeFieldDefinitions(
    REGISTRATION_TYPES[kind],
  );
  validateAgainstDefinitions(kind, fields, definitions);
  const preparedAttachments = await prepareAttachments(data, fields, kind);
  const fingerprint = inputFingerprint(data, fields, kind, preparedAttachments);

  await withExclusiveSubmitLock(options.statePath, async () => {
    const state = await loadState(options.statePath);
    const registration = stateRegistration(state, kind, fingerprint, runtime);
    const persist = async (): Promise<void> =>
      saveState(options.statePath, state);
    await persist();

    const reconciliation = await reconcileRegistration({
      api,
      kind,
      persist,
      registration,
      runtime,
    });
    if (reconciliation === 'already-submitted') return;

    let brandId: string | undefined;
    if (kind === 'campaign') {
      brandId = state.brand?.registrationId;
      if (brandId === undefined) {
        throw new Error(
          'A locally recorded 10DLC brand registration is required first.',
        );
      }
      const brand = (await api.describeRegistrations([brandId])).find(
        (item) => item.registrationId === brandId,
      );
      if (
        brand?.registrationType !== REGISTRATION_TYPES.brand ||
        brand.registrationStatus !== 'COMPLETE'
      ) {
        throw new Error(
          `10DLC brand type/status is ${brand?.registrationType === undefined ? 'unknown' : terminalSafeText(brand.registrationType)}/${brand?.registrationStatus === undefined ? 'unknown' : terminalSafeText(brand.registrationStatus)}, not ${REGISTRATION_TYPES.brand}/COMPLETE. Campaign submission was not attempted.`,
        );
      }
    }

    const registrationId = await createRegistrationIfNeeded({
      api,
      data,
      kind,
      persist,
      registration,
    });

    if (kind === 'campaign') {
      if (brandId === undefined)
        throw new Error('Missing brand registration ID.');
      await ensureCampaignBrandAssociation({
        api,
        brandId,
        campaign: registration,
        campaignId: registrationId,
        persist,
      });
    }

    await populateFields({
      api,
      data,
      fields,
      kind,
      persist,
      preparedAttachments,
      registration,
      registrationId,
      runtime,
    });

    if (kind === 'tollFree') {
      const tollFree = state.tollFree;
      if (tollFree === undefined) throw new Error('Missing toll-free state.');
      let responseRegistrationId: string | undefined;
      if (tollFree.phoneNumberId === undefined) {
        const number = await api.requestTollFreeNumber({
          clientToken: tollFree.phoneClientToken,
          name: registrationName(data, kind),
          optOutListName: data.tollFree.optOutListName,
          registrationId,
        });
        tollFree.phoneNumberId = number.phoneNumberId;
        responseRegistrationId = number.registrationId;
        await persist();
        runtime.stdout(
          `Toll-free number request recorded as ${terminalSafeText(number.status)}; monthly lease price: ${number.monthlyLeasingPrice === undefined ? 'unknown' : terminalSafeText(number.monthlyLeasingPrice)}.`,
        );
      }
      const phoneNumberId = tollFree.phoneNumberId;
      if (phoneNumberId === undefined) {
        throw new Error('AWS did not return a toll-free phone number ID.');
      }
      await verifyTollFreeNumberAssociation({
        api,
        phoneNumberId,
        registrationId,
      });
      if (
        responseRegistrationId !== undefined &&
        responseRegistrationId !== registrationId
      ) {
        throw new Error(
          'AWS returned an unexpected registration ID for the leased toll-free number. The phone ID was preserved; stop and reconcile before retrying.',
        );
      }
    }

    registration.submissionAttempted = true;
    await persist();
    const submitted = await api.submitRegistration(registrationId);
    if (!SUBMITTED_VERSION_STATUSES.has(submitted.versionStatus)) {
      throw new Error(
        `AWS returned unexpected post-submit version status ${terminalSafeText(submitted.versionStatus)}. Submission intent remains unresolved; reconcile live status before retrying.`,
      );
    }
    registration.submitted = true;
    delete registration.submissionAttempted;
    await persist();
    runtime.stdout(
      `Registration version submitted; AWS version status: ${terminalSafeText(submitted.versionStatus)}. This does not mean approved.`,
    );
  });
}

export async function runStatus(
  options: StatusOptions,
  runtime: Runtime,
): Promise<void> {
  const state = await loadState(options.statePath);
  const registrations = (['brand', 'campaign', 'tollFree'] as const).flatMap(
    (kind) => {
      const registrationId = state[kind]?.registrationId;
      return registrationId === undefined ? [] : [{ kind, registrationId }];
    },
  );
  runtime.stdout('PSD EOC SMS registration status');
  runtime.stdout(
    `mode: ${options.check ? 'READ-ONLY AWS CHECK' : 'OFFLINE LOCAL STATE'}`,
  );
  if (!options.check) {
    for (const item of registrations) {
      runtime.stdout(
        `${item.kind}: unknown (local ID present; AWS not queried)`,
      );
    }
    if (registrations.length === 0)
      runtime.stdout('registrations: none recorded locally');
    runtime.stdout('No AWS client was created and no AWS request was made.');
    return;
  }

  assertTargetConfirmation(options);
  const api = await runtime.createApi();
  await assertCallerAccount(api);
  if (options.definitions !== undefined) {
    const definitions = await api.describeFieldDefinitions(
      REGISTRATION_TYPES[options.definitions],
    );
    runtime.stdout(
      `field definitions: ${REGISTRATION_TYPES[options.definitions]}`,
    );
    for (const definition of definitions) {
      runtime.stdout(
        `${terminalSafeText(definition.fieldRequirement)}\t${terminalSafeText(definition.fieldType)}\t${terminalSafeText(definition.fieldPath)}\t${definition.title === undefined ? '' : terminalSafeText(definition.title)}`,
      );
    }
    return;
  }
  if (options.validateData !== undefined) {
    const data = await loadRegistrationData(options.dataPath);
    const registrationType = REGISTRATION_TYPES[options.validateData];
    const fields = fieldsForKind(data, options.validateData);
    assertNoPlaceholders(data, fields);
    const definitions = await api.describeFieldDefinitions(registrationType);
    validateAgainstDefinitions(options.validateData, fields, definitions);
    await prepareAttachments(data, fields, options.validateData);
    runtime.stdout(
      `${options.validateData} configured fields and sanitized local attachments match the current ${registrationType} schema. No registration was created or submitted.`,
    );
    return;
  }

  const failedReads: string[] = [];
  for (const item of registrations) {
    let live: RegistrationRecord | undefined;
    try {
      live = (await api.describeRegistrations([item.registrationId])).find(
        (registration) => registration.registrationId === item.registrationId,
      );
      if (live === undefined) {
        throw new Error('registration was not returned by AWS');
      }
      runtime.stdout(
        `${item.kind}: ${terminalSafeText(live.registrationStatus)} (${terminalSafeText(live.registrationType)})`,
      );
      if (live.registrationType !== REGISTRATION_TYPES[item.kind]) {
        failedReads.push(`${item.kind} registration type mismatch`);
        runtime.stderr(
          `${item.kind}: AWS registration type does not match local state.`,
        );
      }
    } catch {
      runtime.stdout(`${item.kind}: unknown (type unknown)`);
      runtime.stderr(`${item.kind}: AWS registration read failed.`);
      failedReads.push(`${item.kind} registration`);
      continue;
    }

    let version: RegistrationVersionRecord | undefined;
    try {
      version = latestVersion(
        await api.describeRegistrationVersions(item.registrationId),
      );
      if (version === undefined) {
        throw new Error('registration version was not returned by AWS');
      }
      runtime.stdout(
        `${item.kind} latest version: ${terminalSafeText(version.status)} (version ${terminalSafeText(version.versionNumber)})`,
      );
      if (version.feedback !== undefined) {
        runtime.stdout(
          `${item.kind} feedback: ${terminalSafeText(version.feedback)}`,
        );
      }
      for (const reason of version.deniedReasons) {
        runtime.stdout(
          `${item.kind} denied reason: ${terminalSafeText(reason)}`,
        );
      }
    } catch {
      runtime.stdout(`${item.kind} latest version: unknown`);
      runtime.stderr(`${item.kind}: AWS registration-version read failed.`);
      failedReads.push(`${item.kind} registration version`);
    }

    if (
      live.registrationStatus === 'REQUIRES_UPDATES' ||
      version?.status === 'DENIED'
    ) {
      try {
        const feedback = await api.describeRegistrationFieldFeedback({
          registrationId: item.registrationId,
          ...(version === undefined
            ? {}
            : { versionNumber: version.versionNumber }),
        });
        if (feedback.length === 0) {
          runtime.stdout(`${item.kind} field feedback: none returned by AWS`);
        }
        for (const field of feedback) {
          runtime.stdout(
            `${item.kind} field ${terminalSafeText(field.fieldPath)}: ${field.deniedReason !== undefined ? terminalSafeText(field.deniedReason) : field.feedback !== undefined ? terminalSafeText(field.feedback) : 'no reason returned'}`,
          );
        }
      } catch {
        runtime.stdout(`${item.kind} field feedback: unknown`);
        runtime.stderr(`${item.kind}: AWS field-feedback read failed.`);
        failedReads.push(`${item.kind} field feedback`);
      }
    }
  }
  if (registrations.length === 0) {
    runtime.stdout('registrations: none recorded locally');
  }
  const phoneNumberId = state.tollFree?.phoneNumberId;
  if (phoneNumberId !== undefined) {
    try {
      const phone = (await api.describePhoneNumbers([phoneNumberId])).find(
        (candidate) => candidate.phoneNumberId === phoneNumberId,
      );
      if (phone === undefined) {
        throw new Error('phone number was not returned by AWS');
      }
      const associationMatches =
        phone.registrationId === state.tollFree?.registrationId;
      runtime.stdout(
        `toll-free number: ${terminalSafeText(phone.status)} (${phone.numberType === undefined ? 'type unknown' : terminalSafeText(phone.numberType)}); registration association: ${associationMatches ? 'matches local state' : 'mismatched'}`,
      );
      if (!associationMatches || phone.numberType !== 'TOLL_FREE') {
        failedReads.push('toll-free number reconciliation');
        runtime.stderr(
          'toll-free number: AWS type or registration association does not match local state.',
        );
      }
    } catch {
      runtime.stdout(
        'toll-free number: unknown; registration association: unknown',
      );
      runtime.stderr('toll-free number: AWS read failed.');
      failedReads.push('toll-free number');
    }
  }
  runtime.stdout(
    'Only COMPLETE means an approved registration. Provider acceptance is not message delivery.',
  );
  if (failedReads.length > 0) {
    throw new Error(
      `Status is incomplete or inconsistent for: ${failedReads.join(', ')}. Unknown is not success.`,
    );
  }
}

export function defaultToken(label: string): string {
  return `psd-eoc-${label}-${crypto.randomUUID()}`.slice(0, 64);
}
