import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { statusMain, submitMain } from './cli';

import {
  MAX_PROVIDER_ITEMS,
  MAX_PROVIDER_PAGES,
  REGISTRATION_TYPES,
  SMS_CLIENT_CONFIG,
  STS_CLIENT_CONFIG,
  TARGET_ACCOUNT,
  TARGET_REGION,
  assertProviderPageCapacity,
  loadState,
  nextProviderPageToken,
  runStatus,
  runSubmit,
  saveState,
  toRegistrationDeniedReason,
  toRegistrationFieldFeedback,
  type FieldDefinition,
  type RegistrationKind,
  type Runtime,
  type SmsRegistrationApi,
  type StatusOptions,
  type SubmitOptions,
  type RegistrationVersionRecord,
} from './core';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'psd-eoc-sms-registration-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeData(directory: string): Promise<string> {
  const dataPath = join(directory, 'registration-data.json');
  await mkdir(join(directory, 'attachments'));
  await writeFile(
    join(directory, 'attachments', 'campaign-opt-in.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  await writeFile(
    dataPath,
    JSON.stringify({
      brand: {
        fields: [{ fieldPath: 'brand.required', text: 'District legal value' }],
      },
      campaign: {
        fields: [
          { fieldPath: 'campaign.required', text: 'District campaign value' },
          {
            fieldPath: 'campaignInfo.termsAndConditionsLink',
            text: 'https://www.psd401.net/sms-terms',
          },
          {
            fieldPath: 'campaignInfo.privacyPolicyLink',
            text: 'https://www.psd401.net/privacy',
          },
          {
            attachmentFile: 'attachments/campaign-opt-in.png',
            fieldPath: 'campaignInfo.optInScreenshot',
          },
          {
            fieldPath: 'messageSamples.messageSample1',
            text: 'PSD EOC REAL INCIDENT — synthetic staff safety alert. Reply STOP to opt out.',
          },
          {
            fieldPath: 'messageSamples.messageSample2',
            text: 'PSD EOC DRILL — synthetic staff exercise alert. Reply STOP to opt out.',
          },
        ],
      },
      registrationNamePrefix: 'PSD EOC district staff alerts',
      schemaVersion: 1,
      tollFree: {
        fields: [
          { fieldPath: 'tollFree.required', text: 'District toll-free value' },
          {
            fieldPath: 'companyInfo.businessType',
            select: ['SOLE_PROPRIETOR'],
          },
          {
            fieldPath: 'messageSamples.messageSample1',
            text: 'PSD EOC REAL INCIDENT — synthetic staff safety alert. Reply STOP to opt out.',
          },
          {
            fieldPath: 'messageSamples.messageSample2',
            text: 'PSD EOC DRILL — synthetic staff exercise alert. Reply STOP to opt out.',
          },
        ],
      },
    }),
  );
  return dataPath;
}

function definitions(kind: RegistrationKind): readonly FieldDefinition[] {
  const paths =
    kind === 'brand'
      ? ([['brand.required', 'TEXT']] as const)
      : kind === 'campaign'
        ? ([
            ['campaign.required', 'TEXT'],
            ['campaignInfo.termsAndConditionsLink', 'TEXT'],
            ['campaignInfo.privacyPolicyLink', 'TEXT'],
            ['campaignInfo.optInScreenshot', 'ATTACHMENT'],
            ['messageSamples.messageSample1', 'TEXT'],
            ['messageSamples.messageSample2', 'TEXT'],
          ] as const)
        : ([
            ['tollFree.required', 'TEXT'],
            ['companyInfo.businessType', 'SELECT'],
            ['messageSamples.messageSample1', 'TEXT'],
            ['messageSamples.messageSample2', 'TEXT'],
          ] as const);
  return paths.map(([fieldPath, fieldType]) => ({
    fieldPath,
    fieldRequirement:
      fieldPath === `${kind}.required` ? 'REQUIRED' : 'OPTIONAL',
    fieldType,
    ...(fieldType === 'SELECT'
      ? {
          selectValidation: {
            maxChoices: 1,
            minChoices: 1,
            options: ['SOLE_PROPRIETOR'],
          },
        }
      : fieldType === 'TEXT'
        ? { textValidation: { maxLength: 200, minLength: 1 } }
        : {}),
    title: fieldPath,
  }));
}

class FakeApi implements SmsRegistrationApi {
  readonly attachmentBodies: Uint8Array[] = [];
  readonly calls: string[] = [];
  /** Every AWS Name tag value this run would have sent. */
  readonly tagNames: string[] = [];
  readonly associations = new Map<string, string>();
  readonly registrationStatuses = new Map<string, string>();
  readonly submittedRegistrations = new Set<string>();
  accountId = TARGET_ACCOUNT;
  attachmentCreateStatus = 'UPLOAD_COMPLETE';
  attachmentDescribeStatus = 'UPLOAD_COMPLETE';
  associationCrashAfterWrite = false;
  brandStatus = 'COMPLETE';
  createRegistrationStarted?: () => void;
  createRegistrationWait?: Promise<void>;
  definitionOverride?: readonly FieldDefinition[];
  fieldFeedbackOverride: readonly {
    readonly deniedReason?: string;
    readonly feedback?: string;
    readonly fieldPath: string;
  }[] = [];
  hideAssociations = false;
  hideSubmittedState = false;
  registrationReadError = false;
  phoneStatus = 'ACTIVE';
  submitCrashAfterWrite = false;
  versionOverride?: readonly RegistrationVersionRecord[];

  async associateRegistration(input: {
    readonly registrationId: string;
    readonly resourceId: string;
  }): Promise<void> {
    this.calls.push(`associate:${input.registrationId}:${input.resourceId}`);
    this.associations.set(input.registrationId, input.resourceId);
    if (this.associationCrashAfterWrite) {
      this.associationCrashAfterWrite = false;
      throw new Error('synthetic crash after association write');
    }
  }

  async createAttachment(input: {
    readonly attachmentBody: Uint8Array;
  }): Promise<{
    readonly attachmentId: string;
    readonly attachmentStatus: string;
  }> {
    this.calls.push('create-attachment');
    this.attachmentBodies.push(Uint8Array.from(input.attachmentBody));
    return {
      attachmentId: 'attachment-1',
      attachmentStatus: this.attachmentCreateStatus,
    };
  }

  async createRegistration(input: {
    readonly registrationType: string;
    readonly name?: string;
  }): Promise<{ readonly registrationId: string }> {
    this.calls.push(`create:${input.registrationType}`);
    if (input.name !== undefined) this.tagNames.push(input.name);
    this.createRegistrationStarted?.();
    await this.createRegistrationWait;
    const registrationId =
      input.registrationType === REGISTRATION_TYPES.brand
        ? 'registration-brand'
        : input.registrationType === REGISTRATION_TYPES.campaign
          ? 'registration-campaign'
          : 'registration-toll-free';
    this.registrationStatuses.set(registrationId, 'CREATED');
    return { registrationId };
  }

  async describeFieldDefinitions(registrationType: string) {
    this.calls.push(`definitions:${registrationType}`);
    const kind =
      registrationType === REGISTRATION_TYPES.brand
        ? 'brand'
        : registrationType === REGISTRATION_TYPES.campaign
          ? 'campaign'
          : 'tollFree';
    return this.definitionOverride ?? definitions(kind);
  }

  async describeAttachments() {
    this.calls.push('describe-attachments');
    return [
      { attachmentId: 'attachment-1', status: this.attachmentDescribeStatus },
    ];
  }

  async describePhoneNumbers() {
    this.calls.push('describe-phone');
    return [
      {
        phoneNumberId: 'phone-1',
        registrationId: 'registration-toll-free',
        numberType: 'TOLL_FREE',
        status: this.phoneStatus,
      },
    ] as const;
  }

  async describeRegistrationFieldFeedback() {
    this.calls.push('describe-field-feedback');
    return this.fieldFeedbackOverride;
  }

  async describeRegistrationVersions(registrationId: string) {
    this.calls.push(`describe-versions:${registrationId}`);
    if (this.versionOverride !== undefined) return this.versionOverride;
    return [
      {
        deniedReasons: [],
        status:
          this.submittedRegistrations.has(registrationId) &&
          !this.hideSubmittedState
            ? 'SUBMITTED'
            : 'DRAFT',
        versionNumber: 1,
      },
    ] as const;
  }

  async describeRegistrations(registrationIds: readonly string[]) {
    this.calls.push(`describe-registrations:${registrationIds.join(',')}`);
    if (this.registrationReadError) {
      throw new Error('synthetic provider read failure');
    }
    return registrationIds.map((registrationId) => ({
      registrationId,
      registrationStatus: this.submittedRegistrations.has(registrationId)
        ? this.hideSubmittedState
          ? 'CREATED'
          : 'SUBMITTED'
        : registrationId === 'registration-brand' &&
            !this.registrationStatuses.has(registrationId)
          ? this.brandStatus
          : (this.registrationStatuses.get(registrationId) ?? 'REVIEWING'),
      registrationType:
        registrationId === 'registration-brand'
          ? REGISTRATION_TYPES.brand
          : registrationId === 'registration-campaign'
            ? REGISTRATION_TYPES.campaign
            : REGISTRATION_TYPES.tollFree,
    }));
  }

  async getCallerIdentity() {
    this.calls.push('identity');
    return {
      accountId: this.accountId,
      arn: 'arn:aws:sts::synthetic:role/test',
    };
  }

  async putFieldValue(input: { readonly fieldPath: string }): Promise<void> {
    this.calls.push(`put:${input.fieldPath}`);
  }

  async listRegistrationAssociations(registrationId: string) {
    this.calls.push(`list-associations:${registrationId}`);
    if (this.hideAssociations) return [];
    const resourceId = this.associations.get(registrationId);
    return resourceId === undefined
      ? []
      : [{ resourceId, resourceType: REGISTRATION_TYPES.brand }];
  }

  async requestTollFreeNumber() {
    this.calls.push('request-toll-free');
    return {
      monthlyLeasingPrice: '2.00',
      phoneNumberId: 'phone-1',
      registrationId: 'registration-toll-free',
      status: 'PENDING',
    } as const;
  }

  async submitRegistration(registrationId: string) {
    this.calls.push(`submit:${registrationId}`);
    this.submittedRegistrations.add(registrationId);
    this.registrationStatuses.set(registrationId, 'SUBMITTED');
    if (this.submitCrashAfterWrite) {
      this.submitCrashAfterWrite = false;
      throw new Error('synthetic crash after submission write');
    }
    return { versionStatus: 'SUBMITTED' } as const;
  }
}

function testRuntime(api: FakeApi, overrides: Partial<Runtime> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let apiCreations = 0;
  let token = 0;
  const runtime: Runtime = {
    createApi: async () => {
      apiCreations += 1;
      return api;
    },
    env: {},
    isInteractive: true,
    randomToken: (label) => `${label}-${String((token += 1))}`,
    stderr: (message) => stderr.push(message),
    stdout: (message) => stdout.push(message),
    ...overrides,
  };
  return {
    apiCreations: () => apiCreations,
    runtime,
    stderr,
    stdout,
  };
}

function submitOptions(
  directory: string,
  dataPath: string,
  confirmation: string,
  submit = true,
): SubmitOptions {
  return {
    confirmation,
    confirmedAccount: TARGET_ACCOUNT,
    confirmedRegion: TARGET_REGION,
    dataPath,
    statePath: join(directory, 'registration-state.json'),
    submit,
  };
}

async function seedCompletedBrand(statePath: string): Promise<void> {
  await saveState(statePath, {
    brand: {
      attachments: {},
      clientToken: 'brand-token',
      inputFingerprint: 'a'.repeat(64),
      kind: 'brand',
      registrationId: 'registration-brand',
      submitted: true,
    },
    schemaVersion: 2,
    targetAccount: TARGET_ACCOUNT,
    targetRegion: TARGET_REGION,
  });
}

function mutationCalls(api: FakeApi): readonly string[] {
  return api.calls.filter((call) =>
    [
      'associate:',
      'create-attachment',
      'create:',
      'put:',
      'request-toll-free',
      'submit:',
    ].some((prefix) => call.startsWith(prefix)),
  );
}

async function replaceDataValue(
  dataPath: string,
  search: string,
  replacement: string,
): Promise<void> {
  const original = await readFile(dataPath, 'utf8');
  if (!original.includes(search)) {
    throw new Error(`Synthetic fixture did not contain ${search}.`);
  }
  await writeFile(dataPath, original.replace(search, replacement));
}

async function addBrandAttachment(
  dataPath: string,
  attachmentFile: string,
): Promise<void> {
  const requiredField =
    '{"fieldPath":"brand.required","text":"District legal value"}';
  await replaceDataValue(
    dataPath,
    requiredField,
    `${requiredField},${JSON.stringify({ attachmentFile, fieldPath: 'brand.evidence' })}`,
  );
}

function enableBrandAttachment(api: FakeApi): void {
  api.definitionOverride = [
    ...definitions('brand'),
    {
      fieldPath: 'brand.evidence',
      fieldRequirement: 'OPTIONAL',
      fieldType: 'ATTACHMENT',
    },
  ];
}

function pngWithTextMetadata(body: Uint8Array): Uint8Array {
  const bytes = Buffer.from(body);
  const typeOffset = bytes.indexOf(Buffer.from('IEND', 'ascii'));
  if (typeOffset < 4) throw new Error('Synthetic PNG has no IEND chunk.');
  const data = Buffer.from('Comment\0GPS:SYNTHETIC', 'utf8');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('tEXt', 4, 'ascii');
  data.copy(chunk, 8);
  return Buffer.concat([
    bytes.subarray(0, typeOffset - 4),
    chunk,
    bytes.subarray(typeOffset - 4),
  ]);
}

function jpegWithExifMetadata(): Uint8Array {
  const metadata = Buffer.from('Exif\0\0GPS:SYNTHETIC', 'utf8');
  const app1 = Buffer.alloc(4 + metadata.length);
  app1.set([0xff, 0xe1], 0);
  app1.writeUInt16BE(metadata.length + 2, 2);
  metadata.copy(app1, 4);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0x02, 0xff, 0xd9]),
  ]);
}

async function stateFailureCause(statePath: string): Promise<string> {
  try {
    await loadState(statePath);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    return cause instanceof Error ? cause.message : String(cause);
  }
  throw new Error('Expected state parsing to fail.');
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolvePromise === undefined) throw new Error('Deferred not ready.');
      resolvePromise();
    },
  };
}

describe('AWS response compatibility', () => {
  it('pins write retries and ignores ambient endpoint overrides', () => {
    expect(SMS_CLIENT_CONFIG).toEqual({
      ignoreConfiguredEndpointUrls: true,
      maxAttempts: 1,
      region: TARGET_REGION,
    });
    expect(STS_CLIENT_CONFIG).toEqual({
      ignoreConfiguredEndpointUrls: true,
      region: TARGET_REGION,
    });
  });

  it('preserves every registration denial remediation field', () => {
    expect(
      toRegistrationDeniedReason(
        'SYNTHETIC_DENIAL',
        'Short description',
        'Long remediation detail',
        'AWS guidance',
        'https://docs.aws.amazon.com/example',
      ),
    ).toEqual({
      documentationLink: 'https://docs.aws.amazon.com/example',
      documentationTitle: 'AWS guidance',
      longDescription: 'Long remediation detail',
      reason: 'SYNTHETIC_DENIAL',
      shortDescription: 'Short description',
    });
    expect(toRegistrationDeniedReason('DENIED', 'Short')).toEqual({
      reason: 'DENIED',
      shortDescription: 'Short',
    });
    expect(() => toRegistrationDeniedReason(undefined, 'Short')).toThrow(
      'omitted denied Reason',
    );
    expect(() => toRegistrationDeniedReason('DENIED', undefined)).toThrow(
      'omitted denied ShortDescription',
    );
  });

  it('bounds and de-duplicates untrusted provider pagination tokens', () => {
    const tokens = new Set<string>();
    expect(nextProviderPageToken(tokens, 'secret-a')).toBe('secret-a');
    expect(nextProviderPageToken(tokens, 'secret-b')).toBe('secret-b');
    let cycleMessage = '';
    try {
      nextProviderPageToken(tokens, 'secret-a');
    } catch (error) {
      cycleMessage = error instanceof Error ? error.message : String(error);
    }
    expect(cycleMessage).toContain('pagination');
    expect(cycleMessage).not.toContain('secret-a');
    expect(cycleMessage).not.toContain('secret-b');
    expect(() => nextProviderPageToken(new Set(), '')).toThrow('pagination');
    expect(() => nextProviderPageToken(new Set(), 42)).toThrow('pagination');

    const uniqueTokens = new Set<string>();
    for (let index = 1; index < MAX_PROVIDER_PAGES; index += 1) {
      expect(nextProviderPageToken(uniqueTokens, `synthetic-${index}`)).toBe(
        `synthetic-${index}`,
      );
    }
    expect(() =>
      nextProviderPageToken(uniqueTokens, 'secret-over-limit'),
    ).toThrow(`${MAX_PROVIDER_PAGES}-page safety limit`);
    expect(() => assertProviderPageCapacity(MAX_PROVIDER_ITEMS - 1, 2)).toThrow(
      `${MAX_PROVIDER_ITEMS}-item safety limit`,
    );
    expect(() =>
      assertProviderPageCapacity(MAX_PROVIDER_ITEMS - 1, 1),
    ).not.toThrow();
  });

  it('preserves all registration field review result variants', () => {
    expect(
      toRegistrationFieldFeedback(
        'campaignInfo.optInDescription',
        undefined,
        'Add more detail to the synthetic opt-in description.',
      ),
    ).toEqual({
      feedback: 'Add more detail to the synthetic opt-in description.',
      fieldPath: 'campaignInfo.optInDescription',
    });
    expect(
      toRegistrationFieldFeedback(
        'campaignInfo.optInDescription',
        'Missing consent disclosure.',
        undefined,
      ),
    ).toEqual({
      deniedReason: 'Missing consent disclosure.',
      fieldPath: 'campaignInfo.optInDescription',
    });
    expect(
      toRegistrationFieldFeedback(
        'campaignInfo.optInDescription',
        'Missing consent disclosure.',
        'Add Reply STOP to unsubscribe.',
      ),
    ).toEqual({
      deniedReason: 'Missing consent disclosure.',
      feedback: 'Add Reply STOP to unsubscribe.',
      fieldPath: 'campaignInfo.optInDescription',
    });
    expect(
      toRegistrationFieldFeedback(
        'campaignInfo.optInDescription',
        undefined,
        undefined,
      ),
    ).toBeUndefined();
  });
});

describe('offline safety boundary', () => {
  it('runs a dry-run without creating an AWS client or state file', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const api = new FakeApi();
    const harness = testRuntime(api);

    await runSubmit(
      'brand',
      submitOptions(directory, dataPath, '', false),
      harness.runtime,
    );

    expect(harness.apiCreations()).toBe(0);
    expect(api.calls).toEqual([]);
    expect(harness.stdout.join('\n')).toContain('OFFLINE DRY-RUN');
    expect(harness.stdout.join('\n')).toContain('No AWS client was created');
    await expect(
      readFile(join(directory, 'registration-state.json')),
    ).rejects.toThrow();
  });

  it('rejects CI and non-interactive submissions before AWS client creation', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const api = new FakeApi();
    const ci = testRuntime(api, { env: { CI: 'true' } });
    await expect(
      runSubmit(
        'brand',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
        ci.runtime,
      ),
    ).rejects.toThrow('disabled in CI');
    expect(ci.apiCreations()).toBe(0);

    const nonInteractive = testRuntime(api, { isInteractive: false });
    await expect(
      runSubmit(
        'brand',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
        nonInteractive.runtime,
      ),
    ).rejects.toThrow('interactive TTY');
    expect(nonInteractive.apiCreations()).toBe(0);
  });

  it('stops on the wrong AWS account before SMS API mutation', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const api = new FakeApi();
    api.accountId = '111122223333';
    const harness = testRuntime(api);

    await expect(
      runSubmit(
        'brand',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
        harness.runtime,
      ),
    ).rejects.toThrow('expected 338414773271');
    expect(api.calls).toEqual(['identity']);
  });

  it('rejects an explicit REPLACE_ME sentinel before AWS client creation', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    await replaceDataValue(
      dataPath,
      'District legal value',
      'REPLACE_ME_DISTRICT_LEGAL_NAME',
    );
    const api = new FakeApi();
    const harness = testRuntime(api);

    await expect(
      runSubmit(
        'brand',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
        harness.runtime,
      ),
    ).rejects.toThrow('placeholder values remain');
    expect(harness.apiCreations()).toBe(0);
  });

  it('validates the shared AWS Name tag length before client creation', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    await replaceDataValue(
      dataPath,
      'PSD EOC district staff alerts',
      'x'.repeat(240),
    );
    const api = new FakeApi();
    const harness = testRuntime(api);

    await expect(
      runSubmit(
        'brand',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
        harness.runtime,
      ),
    ).rejects.toThrow('no longer than 239 characters');
    expect(harness.apiCreations()).toBe(0);
    expect(api.calls).toEqual([]);
  });

  it('rejects a legacy custom opt-out list before client creation', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const data = JSON.parse(await readFile(dataPath, 'utf8')) as {
      tollFree: Record<string, unknown>;
    };
    data.tollFree.optOutListName = 'private-legacy-list';
    await writeFile(dataPath, JSON.stringify(data));
    const api = new FakeApi();
    const harness = testRuntime(api);

    await expect(
      runSubmit(
        'tollFree',
        submitOptions(directory, dataPath, 'LEASE_TOLL_FREE_AND_SUBMIT'),
        harness.runtime,
      ),
    ).rejects.toThrow('tollFree.optOutListName is no longer supported');

    expect(harness.apiCreations()).toBe(0);
    expect(api.calls).toEqual([]);
  });

  it('tags every registration with a name AWS will accept', async () => {
    // AWS End User Messaging rejects a tag value outside its permitted
    // character set. The separator here was an em dash, so every real
    // submission this tool attempted failed with
    // INVALID_PARAMETER Fields="tags" before the first mutating call, and no
    // registration was ever created. Length was already covered; the character
    // set was not.
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const api = new FakeApi();
    const harness = testRuntime(api);

    await runSubmit(
      'tollFree',
      submitOptions(directory, dataPath, 'LEASE_TOLL_FREE_AND_SUBMIT'),
      harness.runtime,
    );

    expect(api.tagNames.length).toBeGreaterThan(0);
    for (const name of api.tagNames) {
      expect(name).toMatch(/^[A-Za-z0-9 _.:/=+@-]+$/u);
    }
  });
});

describe('attachment trust boundary', () => {
  for (const fixture of [
    {
      extension: 'png',
      metadata: 'GPS:SYNTHETIC',
      prepare: pngWithTextMetadata,
    },
    {
      extension: 'jpg',
      metadata: 'Exif',
      prepare: () => jpegWithExifMetadata(),
    },
  ] as const) {
    it(`strips ${fixture.extension.toUpperCase()} metadata before upload`, async () => {
      const directory = await fixtureDirectory();
      const dataPath = await writeData(directory);
      const originalPng = await readFile(
        join(directory, 'attachments', 'campaign-opt-in.png'),
      );
      const attachmentName = `attachments/brand-evidence.${fixture.extension}`;
      await writeFile(
        join(directory, attachmentName),
        fixture.prepare(originalPng),
      );
      await addBrandAttachment(dataPath, attachmentName);
      const api = new FakeApi();
      enableBrandAttachment(api);
      const harness = testRuntime(api);

      await runSubmit(
        'brand',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
        harness.runtime,
      );

      expect(api.attachmentBodies).toHaveLength(1);
      const uploaded = Buffer.from(api.attachmentBodies[0] ?? []);
      expect(uploaded.includes(Buffer.from(fixture.metadata))).toBe(false);
      expect(uploaded.includes(Buffer.from('GPS:SYNTHETIC'))).toBe(false);
    });
  }

  it('rejects S3 attachment input before creating an AWS client', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    await replaceDataValue(
      dataPath,
      '"attachmentFile":"attachments/campaign-opt-in.png"',
      '"attachmentS3Uri":"s3://synthetic-bucket/opt-in.png"',
    );
    const api = new FakeApi();
    const harness = testRuntime(api);

    await expect(
      runSubmit(
        'campaign',
        submitOptions(directory, dataPath, '', false),
        harness.runtime,
      ),
    ).rejects.toThrow('S3 attachment URIs are intentionally unsupported');
    expect(harness.apiCreations()).toBe(0);
    expect(api.calls).toEqual([]);
  });

  it('rejects JPEG toll-free opt-in evidence before registration or lease mutation', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    await writeFile(
      join(directory, 'attachments', 'toll-free-opt-in.jpg'),
      jpegWithExifMetadata(),
    );
    await replaceDataValue(
      dataPath,
      '{"fieldPath":"tollFree.required","text":"District toll-free value"}',
      '{"fieldPath":"tollFree.required","text":"District toll-free value"},{"attachmentFile":"attachments/toll-free-opt-in.jpg","fieldPath":"messagingUseCase.optInImage"}',
    );
    const api = new FakeApi();
    api.definitionOverride = [
      ...definitions('tollFree'),
      {
        fieldPath: 'messagingUseCase.optInImage',
        fieldRequirement: 'OPTIONAL',
        fieldType: 'ATTACHMENT',
      },
    ];
    const harness = testRuntime(api);

    await expect(
      runSubmit(
        'tollFree',
        submitOptions(directory, dataPath, 'LEASE_TOLL_FREE_AND_SUBMIT'),
        harness.runtime,
      ),
    ).rejects.toThrow('must be a PNG image no larger than 400 KB');
    expect(harness.apiCreations()).toBe(0);
    expect(mutationCalls(api)).toEqual([]);
  });

  it('rejects toll-free opt-in evidence larger than 400 KB before mutation', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    await writeFile(
      join(directory, 'attachments', 'toll-free-opt-in.png'),
      Buffer.alloc(400_001),
    );
    await replaceDataValue(
      dataPath,
      '{"fieldPath":"tollFree.required","text":"District toll-free value"}',
      '{"fieldPath":"tollFree.required","text":"District toll-free value"},{"attachmentFile":"attachments/toll-free-opt-in.png","fieldPath":"messagingUseCase.optInImage"}',
    );
    const api = new FakeApi();
    api.definitionOverride = [
      ...definitions('tollFree'),
      {
        fieldPath: 'messagingUseCase.optInImage',
        fieldRequirement: 'OPTIONAL',
        fieldType: 'ATTACHMENT',
      },
    ];
    const harness = testRuntime(api);

    await expect(
      runSubmit(
        'tollFree',
        submitOptions(directory, dataPath, 'LEASE_TOLL_FREE_AND_SUBMIT'),
        harness.runtime,
      ),
    ).rejects.toThrow('must be between 1 byte and 400 KB');
    expect(harness.apiCreations()).toBe(0);
    expect(mutationCalls(api)).toEqual([]);
  });

  for (const pathKind of ['traversal', 'absolute'] as const) {
    it(`rejects ${pathKind} attachment paths before creating an AWS client`, async () => {
      const directory = await fixtureDirectory();
      const dataPath = await writeData(directory);
      const outsidePath = join(directory, 'private-outside.png');
      await writeFile(
        outsidePath,
        await readFile(join(directory, 'attachments', 'campaign-opt-in.png')),
      );
      const configuredPath =
        pathKind === 'absolute'
          ? outsidePath
          : 'attachments/../private-outside.png';
      await addBrandAttachment(dataPath, configuredPath);
      const api = new FakeApi();
      const harness = testRuntime(api);

      let message = '';
      try {
        await runSubmit(
          'brand',
          submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
          harness.runtime,
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('beneath the private attachments directory');
      expect(message).not.toContain('private-outside.png');
      expect(message).not.toContain(directory);
      expect(harness.apiCreations()).toBe(0);
      expect(api.calls).toEqual([]);
    });
  }

  it('rejects an attachment symlink that escapes the private directory', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const outsidePath = join(directory, 'private-outside.png');
    await writeFile(
      outsidePath,
      await readFile(join(directory, 'attachments', 'campaign-opt-in.png')),
    );
    await symlink(
      outsidePath,
      join(directory, 'attachments', 'private-link.png'),
    );
    await addBrandAttachment(dataPath, 'attachments/private-link.png');
    const api = new FakeApi();
    const harness = testRuntime(api);

    let message = '';
    try {
      await runSubmit(
        'brand',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
        harness.runtime,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('beneath the private attachments directory');
    expect(message).not.toContain('private-link.png');
    expect(message).not.toContain('private-outside.png');
    expect(message).not.toContain(directory);
    expect(harness.apiCreations()).toBe(0);
    expect(api.calls).toEqual([]);
  });

  it('stops when AWS reports an attachment upload failure', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const statePath = join(directory, 'registration-state.json');
    await addBrandAttachment(dataPath, 'attachments/campaign-opt-in.png');
    const api = new FakeApi();
    enableBrandAttachment(api);
    api.attachmentCreateStatus = 'PENDING';
    api.attachmentDescribeStatus = 'UPLOAD_FAILED';

    await expect(
      runSubmit(
        'brand',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
        testRuntime(api).runtime,
      ),
    ).rejects.toThrow('is UPLOAD_FAILED; submission stopped');

    expect(api.calls).toContain('describe-attachments');
    expect(api.calls).not.toContain('submit:registration-brand');
    expect(
      (await loadState(statePath)).brand?.attachments['brand.evidence']
        ?.attachmentStatus,
    ).toBe('UPLOAD_FAILED');
  });

  it('times out closed while an attachment remains pending', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    await addBrandAttachment(dataPath, 'attachments/campaign-opt-in.png');
    const api = new FakeApi();
    enableBrandAttachment(api);
    api.attachmentCreateStatus = 'PENDING';
    api.attachmentDescribeStatus = 'PENDING';

    await expect(
      runSubmit(
        'brand',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
        testRuntime(api).runtime,
      ),
    ).rejects.toThrow('not UPLOAD_COMPLETE');

    expect(
      api.calls.filter((call) => call === 'describe-attachments'),
    ).toHaveLength(10);
    expect(api.calls).not.toContain('submit:registration-brand');
  });
});

describe('live validation before mutation', () => {
  it('rejects unknown and duplicate provider field definitions before writes', async () => {
    const cases: readonly (readonly FieldDefinition[])[] = [
      [
        ...definitions('brand'),
        {
          fieldPath: 'future.required',
          fieldRequirement: 'FUTURE_REQUIRED',
          fieldType: 'TEXT',
        },
      ],
      [
        ...definitions('brand'),
        {
          fieldPath: 'future.type',
          fieldRequirement: 'OPTIONAL',
          fieldType: 'FUTURE_TYPE',
        },
      ],
      [...definitions('brand'), ...definitions('brand')],
    ];

    for (const definitionOverride of cases) {
      const directory = await fixtureDirectory();
      const dataPath = await writeData(directory);
      const api = new FakeApi();
      api.definitionOverride = definitionOverride;

      await expect(
        runSubmit(
          'brand',
          submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
          testRuntime(api).runtime,
        ),
      ).rejects.toThrow('refusing mutation');

      expect(mutationCalls(api)).toEqual([]);
      expect(api.calls).toEqual([
        'identity',
        `definitions:${REGISTRATION_TYPES.brand}`,
      ]);
    }
  });

  it('enforces a provider regex before any registration write', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const api = new FakeApi();
    api.definitionOverride = [
      {
        fieldPath: 'brand.required',
        fieldRequirement: 'REQUIRED',
        fieldType: 'TEXT',
        textValidation: {
          maxLength: 100,
          minLength: 1,
          pattern: '^APPROVED_VALUE$',
        },
      },
    ];
    const harness = testRuntime(api);

    await expect(
      runSubmit(
        'brand',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
        harness.runtime,
      ),
    ).rejects.toThrow('does not match the current AWS validation pattern');
    expect(mutationCalls(api)).toEqual([]);
    expect(api.calls).toEqual([
      'identity',
      `definitions:${REGISTRATION_TYPES.brand}`,
    ]);
  });

  it('requires separate REAL INCIDENT and DRILL samples before mutation', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    await replaceDataValue(
      dataPath,
      'PSD EOC REAL INCIDENT — synthetic staff safety alert. Reply STOP to opt out.',
      'PSD EOC DRILL — second synthetic staff exercise alert. Reply STOP to opt out.',
    );
    const api = new FakeApi();
    const harness = testRuntime(api);

    await expect(
      runStatus(
        {
          check: true,
          confirmedAccount: TARGET_ACCOUNT,
          confirmedRegion: TARGET_REGION,
          dataPath,
          statePath: join(directory, 'registration-state.json'),
          validateData: 'campaign',
        },
        harness.runtime,
      ),
    ).rejects.toThrow('separate, unmistakable REAL INCIDENT and DRILL');
    expect(mutationCalls(api)).toEqual([]);
    expect(api.calls).toEqual([
      'identity',
      `definitions:${REGISTRATION_TYPES.campaign}`,
    ]);
  });

  it('requires an explicit STOP instruction in the message samples before mutation', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    await replaceDataValue(
      dataPath,
      'PSD EOC REAL INCIDENT — synthetic staff safety alert. Reply STOP to opt out.',
      'PSD EOC REAL INCIDENT — synthetic staff safety alert.',
    );
    await replaceDataValue(
      dataPath,
      'PSD EOC DRILL — synthetic staff exercise alert. Reply STOP to opt out.',
      'PSD EOC DRILL — synthetic staff exercise alert.',
    );
    const api = new FakeApi();

    await expect(
      runStatus(
        {
          check: true,
          confirmedAccount: TARGET_ACCOUNT,
          confirmedRegion: TARGET_REGION,
          dataPath,
          statePath: join(directory, 'registration-state.json'),
          validateData: 'campaign',
        },
        testRuntime(api).runtime,
      ),
    ).rejects.toThrow(
      'must include an explicit Reply STOP opt-out instruction in at least one sample',
    );
    expect(mutationCalls(api)).toEqual([]);
    expect(api.calls).toEqual([
      'identity',
      `definitions:${REGISTRATION_TYPES.campaign}`,
    ]);
  });

  it('requires stock details for a public-profit brand before mutation', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    await replaceDataValue(
      dataPath,
      '{"fieldPath":"brand.required","text":"District legal value"}',
      '{"fieldPath":"brand.required","text":"District legal value"},{"fieldPath":"companyInfo.legalType","select":["PUBLIC_PROFIT"]}',
    );
    const api = new FakeApi();
    api.definitionOverride = [
      ...definitions('brand'),
      {
        fieldPath: 'companyInfo.legalType',
        fieldRequirement: 'OPTIONAL',
        fieldType: 'SELECT',
        selectValidation: {
          maxChoices: 1,
          minChoices: 1,
          options: ['PUBLIC_PROFIT'],
        },
      },
    ];

    await expect(
      runSubmit(
        'brand',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
        testRuntime(api).runtime,
      ),
    ).rejects.toThrow(
      'PUBLIC_PROFIT brand registrations require the conditional company fields',
    );
    expect(mutationCalls(api)).toEqual([]);
  });

  it('requires tax details for a non-sole-proprietor before mutation', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    await replaceDataValue(dataPath, 'SOLE_PROPRIETOR', 'CORPORATION');
    const api = new FakeApi();
    api.definitionOverride = definitions('tollFree').map((definition) =>
      definition.fieldPath === 'companyInfo.businessType'
        ? {
            ...definition,
            selectValidation: {
              maxChoices: 1,
              minChoices: 1,
              options: ['CORPORATION'],
            },
          }
        : definition,
    );

    await expect(
      runSubmit(
        'tollFree',
        submitOptions(directory, dataPath, 'LEASE_TOLL_FREE_AND_SUBMIT'),
        testRuntime(api).runtime,
      ),
    ).rejects.toThrow(
      'Non-sole-proprietor toll-free registrations require the conditional company-identification fields',
    );
    expect(mutationCalls(api)).toEqual([]);
  });
});

describe('registration API ordering', () => {
  it('creates, fills, and submits a 10DLC brand in order', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const api = new FakeApi();
    const harness = testRuntime(api);

    await runSubmit(
      'brand',
      submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
      harness.runtime,
    );

    expect(api.calls).toEqual([
      'identity',
      `definitions:${REGISTRATION_TYPES.brand}`,
      `create:${REGISTRATION_TYPES.brand}`,
      'put:brand.required',
      'submit:registration-brand',
    ]);
    expect(
      (await loadState(join(directory, 'registration-state.json'))).brand,
    ).toMatchObject({
      registrationId: 'registration-brand',
      submitted: true,
    });
    expect(harness.stdout.at(-1)).toContain('does not mean approved');
  });

  it('blocks 10DLC campaign submission before AWS or local-state access', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const statePath = join(directory, 'registration-state.json');
    await seedCompletedBrand(statePath);
    const originalState = await readFile(statePath);
    const api = new FakeApi();
    const harness = testRuntime(api);

    await runSubmit(
      'campaign',
      submitOptions(directory, dataPath, '', false),
      harness.runtime,
    );
    expect(harness.stdout.join('\n')).toContain('availability: BLOCKED');
    expect(harness.stdout.join('\n')).not.toContain(
      '--confirm-action SUBMIT_10DLC_CAMPAIGN',
    );

    await expect(
      runSubmit(
        'campaign',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_CAMPAIGN'),
        harness.runtime,
      ),
    ).rejects.toThrow('AWS currently does not permit emergency-alert');
    expect(harness.apiCreations()).toBe(0);
    expect(api.calls).toEqual([]);
    expect(await readFile(statePath)).toEqual(originalState);
  });

  it('fills the toll-free registration before leasing and submitting', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const api = new FakeApi();
    const harness = testRuntime(api);

    await runSubmit(
      'tollFree',
      submitOptions(directory, dataPath, 'LEASE_TOLL_FREE_AND_SUBMIT'),
      harness.runtime,
    );

    expect(api.calls).toEqual([
      'identity',
      `definitions:${REGISTRATION_TYPES.tollFree}`,
      `create:${REGISTRATION_TYPES.tollFree}`,
      'put:tollFree.required',
      'put:companyInfo.businessType',
      'put:messageSamples.messageSample1',
      'put:messageSamples.messageSample2',
      'request-toll-free',
      'describe-phone',
      'submit:registration-toll-free',
    ]);
    const state = await loadState(join(directory, 'registration-state.json'));
    expect(state.tollFree).toMatchObject({
      phoneNumberId: 'phone-1',
      registrationId: 'registration-toll-free',
      submitted: true,
    });
    expect(harness.stdout.join('\n')).toContain('monthly lease price: 2.00');
  });

  it('refuses toll-free submission unless the phone status is safely associated', async () => {
    for (const phoneStatus of [
      'DISASSOCIATING',
      'DELETED',
      'FUTURE_PROVIDER_STATUS',
    ]) {
      const directory = await fixtureDirectory();
      const dataPath = await writeData(directory);
      const api = new FakeApi();
      api.phoneStatus = phoneStatus;

      await expect(
        runSubmit(
          'tollFree',
          submitOptions(directory, dataPath, 'LEASE_TOLL_FREE_AND_SUBMIT'),
          testRuntime(api).runtime,
        ),
      ).rejects.toThrow('not safe for registration submission');

      expect(api.calls).toContain('describe-phone');
      expect(api.calls).not.toContain('submit:registration-toll-free');
    }
  });
});

describe('state isolation and concurrency', () => {
  it('redacts private state paths from read and persist failures', async () => {
    const directory = await fixtureDirectory();
    const readPath = join(directory, 'private-state-read.json');
    await writeFile(readPath, '{');
    let readMessage = '';
    try {
      await loadState(readPath);
    } catch (error) {
      readMessage = error instanceof Error ? error.message : String(error);
    }
    expect(readMessage).toBe(
      'Unable to read the private registration state file.',
    );
    expect(readMessage).not.toContain('private-state-read.json');
    expect(readMessage).not.toContain(directory);

    const persistPath = join(directory, 'private-state-persist');
    await mkdir(persistPath);
    let persistMessage = '';
    try {
      await saveState(persistPath, {
        schemaVersion: 2,
        targetAccount: TARGET_ACCOUNT,
        targetRegion: TARGET_REGION,
      });
    } catch (error) {
      persistMessage = error instanceof Error ? error.message : String(error);
    }
    expect(persistMessage).toBe(
      'Unable to persist the private registration state file.',
    );
    expect(persistMessage).not.toContain('private-state-persist');
    expect(persistMessage).not.toContain(directory);
  });

  it('redacts private paths when state-lock setup fails', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const privateParent = join(directory, 'private-lock-parent');
    const privateStatePath = join(privateParent, 'private-state.json');
    await writeFile(privateParent, 'not a directory');
    const api = new FakeApi();
    let message = '';

    try {
      await runSubmit(
        'brand',
        {
          ...submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
          statePath: privateStatePath,
        },
        testRuntime(api).runtime,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(
      'Unable to prepare the private registration state lock.',
    );
    expect(message).not.toContain('private-lock-parent');
    expect(message).not.toContain('private-state.json');
    expect(message).not.toContain(directory);
    expect(mutationCalls(api)).toEqual([]);
  });

  it('rejects cross-kind, unexpected, and cross-account state', async () => {
    const directory = await fixtureDirectory();
    const statePath = join(directory, 'registration-state.json');
    const registration = {
      attachments: {},
      clientToken: 'synthetic-token',
      inputFingerprint: 'b'.repeat(64),
      registrationId: 'registration-brand',
    };

    await writeFile(
      statePath,
      JSON.stringify({
        brand: { ...registration, kind: 'campaign' },
        schemaVersion: 2,
        targetAccount: TARGET_ACCOUNT,
        targetRegion: TARGET_REGION,
      }),
    );
    expect(await stateFailureCause(statePath)).toContain(
      'state.brand.kind must be brand',
    );

    await writeFile(
      statePath,
      JSON.stringify({
        rogue: true,
        schemaVersion: 2,
        targetAccount: TARGET_ACCOUNT,
        targetRegion: TARGET_REGION,
      }),
    );
    expect(await stateFailureCause(statePath)).toContain('unexpected keys');

    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 2,
        targetAccount: '111122223333',
        targetRegion: TARGET_REGION,
      }),
    );
    expect(await stateFailureCause(statePath)).toContain(
      `targetAccount must be ${TARGET_ACCOUNT}`,
    );
  });

  it('refuses input drift against account-bound state before mutation', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const statePath = join(directory, 'registration-state.json');
    await saveState(statePath, {
      brand: {
        attachments: {},
        clientToken: 'synthetic-token',
        inputFingerprint: 'a'.repeat(64),
        kind: 'brand',
        registrationId: 'registration-brand',
      },
      schemaVersion: 2,
      targetAccount: TARGET_ACCOUNT,
      targetRegion: TARGET_REGION,
    });
    const api = new FakeApi();

    await expect(
      runSubmit(
        'brand',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
        testRuntime(api).runtime,
      ),
    ).rejects.toThrow('input no longer matches');

    expect(mutationCalls(api)).toEqual([]);
    expect((await loadState(statePath)).brand?.inputFingerprint).toBe(
      'a'.repeat(64),
    );
  });

  it('allows only one submit workflow to hold the state lock', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const privateStatePath = join(directory, 'private-state-lock.json');
    const api = new FakeApi();
    const started = deferred();
    const release = deferred();
    api.createRegistrationStarted = started.resolve;
    api.createRegistrationWait = release.promise;
    const first = runSubmit(
      'brand',
      {
        ...submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
        statePath: privateStatePath,
      },
      testRuntime(api).runtime,
    );
    await started.promise;

    try {
      let lockMessage = '';
      try {
        await runSubmit(
          'brand',
          {
            ...submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
            statePath: privateStatePath,
          },
          testRuntime(api).runtime,
        );
      } catch (error) {
        lockMessage = error instanceof Error ? error.message : String(error);
      }
      expect(lockMessage).toContain('Another submit workflow holds');
      expect(lockMessage).not.toContain('private-state-lock.json');
      expect(lockMessage).not.toContain(directory);
    } finally {
      release.resolve();
    }
    await first;

    expect(
      api.calls.filter((call) =>
        call.startsWith(`create:${REGISTRATION_TYPES.brand}`),
      ),
    ).toHaveLength(1);
    expect(
      api.calls.filter((call) => call === 'submit:registration-brand'),
    ).toHaveLength(1);
  });
});

describe('crash-safe live reconciliation', () => {
  it('does not replay submission while prior intent is live-ambiguous', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const statePath = join(directory, 'registration-state.json');
    const api = new FakeApi();
    api.submitCrashAfterWrite = true;
    const options = submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND');

    await expect(
      runSubmit('brand', options, testRuntime(api).runtime),
    ).rejects.toThrow('synthetic crash after submission write');
    expect((await loadState(statePath)).brand).toMatchObject({
      submissionAttempted: true,
    });

    api.hideSubmittedState = true;
    await expect(
      runSubmit('brand', options, testRuntime(api).runtime),
    ).rejects.toThrow('submission has unresolved prior intent');
    expect(
      api.calls.filter((call) => call === 'submit:registration-brand'),
    ).toHaveLength(1);

    api.hideSubmittedState = false;
    await runSubmit('brand', options, testRuntime(api).runtime);
    expect((await loadState(statePath)).brand).toMatchObject({
      submitted: true,
    });
    expect((await loadState(statePath)).brand?.submissionAttempted).toBe(
      undefined,
    );
    expect(
      api.calls.filter((call) => call === 'submit:registration-brand'),
    ).toHaveLength(1);
  });
});

describe('truthful status output', () => {
  it('reports unknown offline without creating an AWS client', async () => {
    const directory = await fixtureDirectory();
    const statePath = join(directory, 'registration-state.json');
    await saveState(statePath, {
      brand: {
        attachments: {},
        clientToken: 'brand-token',
        inputFingerprint: 'a'.repeat(64),
        kind: 'brand',
        registrationId: 'registration-brand',
      },
      schemaVersion: 2,
      targetAccount: TARGET_ACCOUNT,
      targetRegion: TARGET_REGION,
    });
    const api = new FakeApi();
    const harness = testRuntime(api);
    const options: StatusOptions = {
      check: false,
      dataPath: join(directory, 'registration-data.json'),
      statePath,
    };

    await runStatus(options, harness.runtime);

    expect(harness.apiCreations()).toBe(0);
    expect(harness.stdout.join('\n')).toContain('brand: unknown');
  });

  it('prints current required definitions and no approval claim', async () => {
    const directory = await fixtureDirectory();
    const api = new FakeApi();
    const harness = testRuntime(api);
    await runStatus(
      {
        check: true,
        confirmedAccount: TARGET_ACCOUNT,
        confirmedRegion: TARGET_REGION,
        dataPath: join(directory, 'registration-data.json'),
        definitions: 'brand',
        statePath: join(directory, 'registration-state.json'),
      },
      harness.runtime,
    );

    expect(api.calls).toEqual([
      'identity',
      `definitions:${REGISTRATION_TYPES.brand}`,
    ]);
    expect(harness.stdout.join('\n')).toContain(
      'REQUIRED\tTEXT\tbrand.required',
    );
    expect(harness.stdout.join('\n')).not.toContain('approved');
  });

  it('reports a failed provider read as unknown and exits unsuccessfully', async () => {
    const directory = await fixtureDirectory();
    const statePath = join(directory, 'registration-state.json');
    await seedCompletedBrand(statePath);
    const api = new FakeApi();
    api.registrationReadError = true;
    const harness = testRuntime(api);

    await expect(
      runStatus(
        {
          check: true,
          confirmedAccount: TARGET_ACCOUNT,
          confirmedRegion: TARGET_REGION,
          dataPath: join(directory, 'registration-data.json'),
          statePath,
        },
        harness.runtime,
      ),
    ).rejects.toThrow('Unknown is not success');
    expect(harness.stdout.join('\n')).toContain('brand: unknown');
    expect(harness.stderr.join('\n')).toContain('AWS registration read failed');
  });

  it('renders provider feedback without terminal control sequences', async () => {
    const directory = await fixtureDirectory();
    const statePath = join(directory, 'registration-state.json');
    await seedCompletedBrand(statePath);
    const api = new FakeApi();
    api.versionOverride = [
      {
        deniedReasons: [
          {
            documentationLink:
              '\u001b[34mhttps://docs.aws.amazon.com/example\u001b[0m\n\u202elink',
            documentationTitle: '\u001b[35mAWS guidance\u001b[0m\n\u202etitle',
            longDescription:
              '\u001b[36mLong remediation\u001b[0m\n\u202edetail',
            reason: '\u001b[33mDENIED\u001b[0m\nsecond line',
            shortDescription:
              '\u001b[32mShort remediation\u001b[0m\n\u202edetail',
          },
        ],
        feedback: '\u001b[31mUnsafe\u001b[0m\n\u202ereversed',
        status: 'DENIED',
        versionNumber: 1,
      },
    ];
    api.fieldFeedbackOverride = [
      {
        deniedReason: '\u001b[35mFIELD DENIED\u001b[0m\nsecond line',
        feedback: '\u001b[36mField advice\u001b[0m\n\u202ereversed',
        fieldPath: 'campaignInfo.optInDescription',
      },
    ];
    const harness = testRuntime(api);

    await runStatus(
      {
        check: true,
        confirmedAccount: TARGET_ACCOUNT,
        confirmedRegion: TARGET_REGION,
        dataPath: join(directory, 'registration-data.json'),
        statePath,
      },
      harness.runtime,
    );

    const feedbackLine =
      harness.stdout.find((line) => line.includes('feedback:')) ?? '';
    expect(feedbackLine).not.toContain('\u001b');
    expect(feedbackLine).not.toContain('\n');
    expect(feedbackLine).toContain('Unsafe <U+202E>reversed');
    const deniedLine =
      harness.stdout.find((line) => line.includes('denied reason:')) ?? '';
    expect(deniedLine).toContain('DENIED second line');
    for (const [label, expected] of [
      ['denied short description:', 'Short remediation <U+202E>detail'],
      ['denied long description:', 'Long remediation <U+202E>detail'],
      ['denial documentation title:', 'AWS guidance <U+202E>title'],
      [
        'denial documentation link:',
        'https://docs.aws.amazon.com/example <U+202E>link',
      ],
    ] as const) {
      const line =
        harness.stdout.find((output) => output.includes(label)) ?? '';
      expect(line).not.toContain('\u001b');
      expect(line).not.toContain('\n');
      expect(line).toContain(expected);
    }
    const fieldLine =
      harness.stdout.find((line) => line.includes('brand field ')) ?? '';
    expect(fieldLine).not.toContain('\u001b');
    expect(fieldLine).not.toContain('\n');
    expect(fieldLine).toContain('FIELD DENIED second line');
    const fieldFeedbackLine =
      harness.stdout.find(
        (line) => line.includes('brand field ') && line.includes(' feedback:'),
      ) ?? '';
    expect(fieldFeedbackLine).not.toContain('\u001b');
    expect(fieldFeedbackLine).not.toContain('\n');
    expect(fieldFeedbackLine).toContain('Field advice <U+202E>reversed');
  });
});

describe('CLI entrypoint gates', () => {
  it('keeps previews offline and rejects bad flags and confirmations', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const api = new FakeApi();
    const harness = testRuntime(api);

    expect(await submitMain('brand', [], directory, harness.runtime)).toBe(0);
    expect(
      await submitMain('brand', ['--unknown-flag'], directory, harness.runtime),
    ).toBe(1);
    expect(
      await submitMain(
        'brand',
        ['synthetic-private@example.invalid'],
        directory,
        harness.runtime,
      ),
    ).toBe(1);
    expect(await statusMain(['+12065550100'], directory, harness.runtime)).toBe(
      1,
    );
    expect(
      await submitMain(
        'brand',
        [
          '--submit',
          '--confirm-account',
          TARGET_ACCOUNT,
          '--confirm-region',
          TARGET_REGION,
          '--confirm-action',
          'WRONG_ACTION',
          '--data',
          dataPath,
        ],
        directory,
        harness.runtime,
      ),
    ).toBe(1);
    expect(await statusMain(['--check'], directory, harness.runtime)).toBe(1);
    expect(harness.apiCreations()).toBe(0);
    expect(api.calls).toEqual([]);
    expect(harness.stderr.join('\n')).toContain(
      'Unknown argument (value redacted)',
    );
    expect(harness.stderr.join('\n')).not.toContain(
      'synthetic-private@example.invalid',
    );
    expect(harness.stderr.join('\n')).not.toContain('+12065550100');
  });
});
