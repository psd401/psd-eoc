import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { statusMain, submitMain } from './cli';
import { toRegistrationFieldFeedback } from './aws-adapter';

import {
  REGISTRATION_TYPES,
  TARGET_ACCOUNT,
  TARGET_REGION,
  loadState,
  runStatus,
  runSubmit,
  saveState,
  type FieldDefinition,
  type RegistrationKind,
  type Runtime,
  type SmsRegistrationApi,
  type StatusOptions,
  type SubmitOptions,
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
  await writeFile(
    join(directory, 'campaign-opt-in.png'),
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
            attachmentFile: 'campaign-opt-in.png',
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
        optOutListName: 'psd-eoc-staff',
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
  submitCrashAfterWrite = false;
  versionOverride?: readonly {
    readonly deniedReasons: readonly string[];
    readonly feedback?: string;
    readonly status: string;
    readonly versionNumber: number;
  }[];

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
  }): Promise<{ readonly registrationId: string }> {
    this.calls.push(`create:${input.registrationType}`);
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
        status: 'ACTIVE',
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
  it('preserves all registration field review result variants', () => {
    expect(
      toRegistrationFieldFeedback({
        Feedback: 'Add more detail to the synthetic opt-in description.',
        FieldPath: 'campaignInfo.optInDescription',
      }),
    ).toEqual({
      feedback: 'Add more detail to the synthetic opt-in description.',
      fieldPath: 'campaignInfo.optInDescription',
    });
    expect(
      toRegistrationFieldFeedback({
        DeniedReason: 'Missing consent disclosure.',
        FieldPath: 'campaignInfo.optInDescription',
      }),
    ).toEqual({
      deniedReason: 'Missing consent disclosure.',
      fieldPath: 'campaignInfo.optInDescription',
    });
    expect(
      toRegistrationFieldFeedback({
        DeniedReason: 'Missing consent disclosure.',
        Feedback: 'Add Reply STOP to unsubscribe.',
        FieldPath: 'campaignInfo.optInDescription',
      }),
    ).toEqual({
      deniedReason: 'Missing consent disclosure.',
      feedback: 'Add Reply STOP to unsubscribe.',
      fieldPath: 'campaignInfo.optInDescription',
    });
    expect(
      toRegistrationFieldFeedback({
        FieldPath: 'campaignInfo.optInDescription',
      }),
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
    ).rejects.toThrow('expected <aws-account-id>');
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
        join(directory, 'campaign-opt-in.png'),
      );
      const attachmentName = `campaign-opt-in.${fixture.extension}`;
      await writeFile(
        join(directory, attachmentName),
        fixture.prepare(originalPng),
      );
      if (fixture.extension !== 'png') {
        await replaceDataValue(dataPath, 'campaign-opt-in.png', attachmentName);
      }
      await seedCompletedBrand(join(directory, 'registration-state.json'));
      const api = new FakeApi();
      const harness = testRuntime(api);

      await runSubmit(
        'campaign',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_CAMPAIGN'),
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
      '"attachmentFile":"campaign-opt-in.png"',
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
      join(directory, 'toll-free-opt-in.jpg'),
      jpegWithExifMetadata(),
    );
    await replaceDataValue(
      dataPath,
      '{"fieldPath":"tollFree.required","text":"District toll-free value"}',
      '{"fieldPath":"tollFree.required","text":"District toll-free value"},{"attachmentFile":"toll-free-opt-in.jpg","fieldPath":"messagingUseCase.optInImage"}',
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
      join(directory, 'toll-free-opt-in.png'),
      Buffer.alloc(400_001),
    );
    await replaceDataValue(
      dataPath,
      '{"fieldPath":"tollFree.required","text":"District toll-free value"}',
      '{"fieldPath":"tollFree.required","text":"District toll-free value"},{"attachmentFile":"toll-free-opt-in.png","fieldPath":"messagingUseCase.optInImage"}',
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

  it('stops when AWS reports an attachment upload failure', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const statePath = join(directory, 'registration-state.json');
    await seedCompletedBrand(statePath);
    const api = new FakeApi();
    api.attachmentCreateStatus = 'PENDING';
    api.attachmentDescribeStatus = 'UPLOAD_FAILED';

    await expect(
      runSubmit(
        'campaign',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_CAMPAIGN'),
        testRuntime(api).runtime,
      ),
    ).rejects.toThrow('is UPLOAD_FAILED; submission stopped');

    expect(api.calls).toContain('describe-attachments');
    expect(api.calls).not.toContain('submit:registration-campaign');
    expect(
      (await loadState(statePath)).campaign?.attachments[
        'campaignInfo.optInScreenshot'
      ]?.attachmentStatus,
    ).toBe('UPLOAD_FAILED');
  });

  it('times out closed while an attachment remains pending', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const statePath = join(directory, 'registration-state.json');
    await seedCompletedBrand(statePath);
    const api = new FakeApi();
    api.attachmentCreateStatus = 'PENDING';
    api.attachmentDescribeStatus = 'PENDING';

    await expect(
      runSubmit(
        'campaign',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_CAMPAIGN'),
        testRuntime(api).runtime,
      ),
    ).rejects.toThrow('not UPLOAD_COMPLETE');

    expect(
      api.calls.filter((call) => call === 'describe-attachments'),
    ).toHaveLength(10);
    expect(api.calls).not.toContain('submit:registration-campaign');
  });
});

describe('live validation before mutation', () => {
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
      runSubmit(
        'campaign',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_CAMPAIGN'),
        harness.runtime,
      ),
    ).rejects.toThrow('separate, unmistakable REAL INCIDENT and DRILL');
    expect(mutationCalls(api)).toEqual([]);
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
      runSubmit(
        'campaign',
        submitOptions(directory, dataPath, 'SUBMIT_10DLC_CAMPAIGN'),
        testRuntime(api).runtime,
      ),
    ).rejects.toThrow(
      'must include an explicit Reply STOP opt-out instruction in at least one sample',
    );
    expect(mutationCalls(api)).toEqual([]);
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

  it('requires a COMPLETE brand before associating and submitting a campaign', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const statePath = join(directory, 'registration-state.json');
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
    const api = new FakeApi();
    const harness = testRuntime(api);

    await runSubmit(
      'campaign',
      submitOptions(directory, dataPath, 'SUBMIT_10DLC_CAMPAIGN'),
      harness.runtime,
    );

    expect(api.calls).toEqual([
      'identity',
      `definitions:${REGISTRATION_TYPES.campaign}`,
      'describe-registrations:registration-brand',
      `create:${REGISTRATION_TYPES.campaign}`,
      'list-associations:registration-campaign',
      'associate:registration-campaign:registration-brand',
      'list-associations:registration-campaign',
      'put:campaign.required',
      'put:campaignInfo.termsAndConditionsLink',
      'put:campaignInfo.privacyPolicyLink',
      'create-attachment',
      'put:campaignInfo.optInScreenshot',
      'put:messageSamples.messageSample1',
      'put:messageSamples.messageSample2',
      'submit:registration-campaign',
    ]);
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
});

describe('state isolation and concurrency', () => {
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
    const api = new FakeApi();
    const started = deferred();
    const release = deferred();
    api.createRegistrationStarted = started.resolve;
    api.createRegistrationWait = release.promise;
    const first = runSubmit(
      'brand',
      submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
      testRuntime(api).runtime,
    );
    await started.promise;

    try {
      await expect(
        runSubmit(
          'brand',
          submitOptions(directory, dataPath, 'SUBMIT_10DLC_BRAND'),
          testRuntime(api).runtime,
        ),
      ).rejects.toThrow('Another submit workflow holds');
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
  it('does not replay a campaign association with unresolved intent', async () => {
    const directory = await fixtureDirectory();
    const dataPath = await writeData(directory);
    const statePath = join(directory, 'registration-state.json');
    await seedCompletedBrand(statePath);
    const api = new FakeApi();
    api.associationCrashAfterWrite = true;
    const options = submitOptions(directory, dataPath, 'SUBMIT_10DLC_CAMPAIGN');

    await expect(
      runSubmit('campaign', options, testRuntime(api).runtime),
    ).rejects.toThrow('synthetic crash after association write');
    expect((await loadState(statePath)).campaign).toMatchObject({
      associationAttempted: true,
      registrationId: 'registration-campaign',
    });

    api.hideAssociations = true;
    await expect(
      runSubmit('campaign', options, testRuntime(api).runtime),
    ).rejects.toThrow('unresolved prior association intent');
    expect(
      api.calls.filter((call) => call.startsWith('associate:')),
    ).toHaveLength(1);

    api.hideAssociations = false;
    await runSubmit('campaign', options, testRuntime(api).runtime);
    expect((await loadState(statePath)).campaign).toMatchObject({
      associatedBrand: true,
      submitted: true,
    });
    expect((await loadState(statePath)).campaign?.associationAttempted).toBe(
      undefined,
    );
    expect(
      api.calls.filter((call) => call.startsWith('associate:')),
    ).toHaveLength(1);
  });

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
        deniedReasons: ['\u001b[33mDENIED\u001b[0m\nsecond line'],
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
    const fieldLine =
      harness.stdout.find((line) => line.includes('brand field ')) ?? '';
    expect(fieldLine).not.toContain('\u001b');
    expect(fieldLine).not.toContain('\n');
    expect(fieldLine).toContain('FIELD DENIED second line');
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
  });
});
