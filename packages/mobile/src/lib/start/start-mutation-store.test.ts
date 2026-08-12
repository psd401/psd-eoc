import { describe, expect, mock, test } from 'bun:test';

let nativeValue: string | null = null;
const nativeWrites: Array<
  readonly [string, string, Readonly<Record<string, unknown>>]
> = [];

mock.module('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
  getItem: (): string | null => nativeValue,
  setItem: (
    key: string,
    value: string,
    options: Readonly<Record<string, unknown>>,
  ): void => {
    nativeWrites.push([key, value, options]);
    nativeValue = value;
  },
}));

const {
  START_MUTATION_STORE_KEY,
  START_MUTATION_STORE_VERSION,
  createStartMutationStore,
  parseStartMutationStoreRecord,
} = await import('./start-mutation-store');

const OWNER = Object.freeze({
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  deviceEnrollmentId: '00000000-0000-4000-8000-000000000003',
});
const KEY = 'start-mutation-store-key-0001';
const ACTIVATION_EVIDENCE = Object.freeze({
  previewId: '00000000-0000-4000-8000-000000000004',
  facilityId: '00000000-0000-4000-8000-000000000005',
  kind: 'drill' as const,
  mode: 'drill' as const,
  eventTypeVersion: Object.freeze({
    id: '00000000-0000-4000-8000-000000000006',
    templateMode: 'drill' as const,
  }),
  rosterSnapshotId: '00000000-0000-4000-8000-000000000007',
  rosterPopulation: 'synthetic' as const,
  consequenceDigest: 'a'.repeat(64),
});

const UNRESOLVED = Object.freeze({
  phase: 'unresolved' as const,
  owner: OWNER,
  operation: 'activate' as const,
  eventTypeName: 'Practice Lockdown',
  mode: 'drill' as const,
  idempotencyKey: KEY,
  activationEvidence: ACTIVATION_EVIDENCE,
  error: Object.freeze({
    message: 'The server outcome is unknown.',
    outcomeUnknown: true as const,
  }),
});

const SUCCEEDED = Object.freeze({
  phase: 'succeeded' as const,
  owner: OWNER,
  operation: 'join' as const,
  eventTypeName: 'Lockdown',
  mode: 'real' as const,
  idempotencyKey: KEY,
  activationEvidence: null,
  completion: Object.freeze({
    kind: 'joined' as const,
    eventTypeName: 'Lockdown',
    mode: 'real' as const,
  }),
  feedbackClaimed: false,
});

const FAILED = Object.freeze({
  phase: 'failed' as const,
  owner: OWNER,
  operation: 'activate' as const,
  eventTypeName: 'Practice Lockdown',
  mode: 'drill' as const,
  idempotencyKey: KEY,
  activationEvidence: ACTIVATION_EVIDENCE,
  error: Object.freeze({
    message: 'The request was rejected before transport.',
    outcomeUnknown: false as const,
  }),
});

interface MemoryAdapter {
  readonly adapter: {
    getItem(
      key: string,
      options: Readonly<Record<string, unknown>>,
    ): string | null;
    setItem(
      key: string,
      value: string,
      options: Readonly<Record<string, unknown>>,
    ): void;
  };
  value(): string | null;
}

function memoryAdapter(initial: string | null = null): MemoryAdapter {
  let stored = initial;
  return {
    adapter: {
      getItem: () => stored,
      setItem: (_key, value) => {
        stored = value;
      },
    },
    value: () => stored,
  };
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function expectRejected(value: unknown): void {
  const versioned =
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'version')
      ? value
      : {
          version: START_MUTATION_STORE_VERSION,
          ...(value as Record<string, unknown>),
        };
  expect(() => parseStartMutationStoreRecord(serialized(versioned))).toThrow(
    'The stored start-mutation recovery record is invalid.',
  );
}

describe('start mutation store', () => {
  const roundTripFixtures = [
    ['unresolved', UNRESOLVED],
    ['succeeded', SUCCEEDED],
    ['failed', FAILED],
  ] as const;
  for (const [name, record] of roundTripFixtures) {
    test(`round-trips a minimized ${name} record`, () => {
      const memory = memoryAdapter();
      const store = createStartMutationStore(memory.adapter);

      store.write(record);

      expect(store.read()).toEqual(record);
      const persisted = JSON.parse(memory.value() ?? '') as Record<
        string,
        unknown
      >;
      expect(persisted.version).toBe(START_MUTATION_STORE_VERSION);
      expect(persisted).not.toHaveProperty('preview');
      expect(persisted).not.toHaveProperty('event');
      expect(memory.value()).not.toContain('recipientCount');
      expect(memory.value()).not.toContain('channels');
    });
  }

  test('rejects corrupt JSON, unsupported versions, phases, and unknown fields', () => {
    expect(() => parseStartMutationStoreRecord('{not-json')).toThrow(
      'The stored start-mutation recovery record is invalid.',
    );
    expectRejected({
      version: 2,
      ...UNRESOLVED,
    });
    expectRejected({ ...UNRESOLVED, phase: 'pending' });
    expectRejected({ ...UNRESOLVED, unexpected: true });
    expectRejected({
      ...UNRESOLVED,
      owner: { ...OWNER, unexpected: true },
    });
    expectRejected({
      ...UNRESOLVED,
      error: { ...UNRESOLVED.error, unexpected: true },
    });
    expectRejected({
      ...SUCCEEDED,
      completion: { ...SUCCEEDED.completion, unexpected: true },
    });
    expectRejected({
      ...UNRESOLVED,
      activationEvidence: { ...ACTIVATION_EVIDENCE, unexpected: true },
    });
  });

  test('rejects invalid identities, classification, names, and keys', () => {
    expectRejected({
      ...UNRESOLVED,
      owner: { ...OWNER, userId: 'not-a-user-id' },
    });
    expectRejected({
      ...UNRESOLVED,
      owner: { ...OWNER, sessionId: 'not-a-session-id' },
    });
    expectRejected({
      ...UNRESOLVED,
      owner: { ...OWNER, deviceEnrollmentId: 'not-an-enrollment-id' },
    });
    expectRejected({ ...UNRESOLVED, mode: 'test' });
    expectRejected({ ...UNRESOLVED, operation: 'close' });
    expectRejected({ ...UNRESOLVED, eventTypeName: '   ' });
    expectRejected({ ...UNRESOLVED, idempotencyKey: 'too-short' });
    expectRejected({
      ...UNRESOLVED,
      activationEvidence: {
        ...ACTIVATION_EVIDENCE,
        previewId: 'not-a-preview-id',
      },
    });
    expectRejected({
      ...UNRESOLVED,
      activationEvidence: {
        ...ACTIVATION_EVIDENCE,
        mode: 'real',
      },
    });
    expectRejected({
      ...UNRESOLVED,
      activationEvidence: {
        ...ACTIVATION_EVIDENCE,
        consequenceDigest: 'not-a-digest',
      },
    });
    expectRejected({ ...SUCCEEDED, activationEvidence: ACTIVATION_EVIDENCE });
    expectRejected({ ...UNRESOLVED, activationEvidence: null });
  });

  test('rejects mismatched success evidence and error truth', () => {
    expectRejected({
      ...SUCCEEDED,
      completion: { ...SUCCEEDED.completion, kind: 'activated' },
    });
    expectRejected({
      ...SUCCEEDED,
      completion: {
        ...SUCCEEDED.completion,
        eventTypeName: 'Different event type',
      },
    });
    expectRejected({
      ...SUCCEEDED,
      completion: { ...SUCCEEDED.completion, mode: 'drill' },
    });
    expectRejected({ ...SUCCEEDED, feedbackClaimed: 'false' });
    expectRejected({
      ...UNRESOLVED,
      error: { ...UNRESOLVED.error, outcomeUnknown: false },
    });
    expectRejected({
      ...FAILED,
      error: { ...FAILED.error, outcomeUnknown: true },
    });
    expectRejected({ ...FAILED, error: { ...FAILED.error, message: '' } });
  });

  test('propagates adapter read, write, and clear failures', () => {
    const readFailure = new Error('synthetic read failure');
    const writeFailure = new Error('synthetic write failure');
    const readStore = createStartMutationStore({
      getItem: () => {
        throw readFailure;
      },
      setItem: () => {},
    });
    const writeStore = createStartMutationStore({
      getItem: () => null,
      setItem: () => {
        throw writeFailure;
      },
    });

    expect(() => readStore.read()).toThrow(readFailure);
    expect(() => writeStore.write(UNRESOLVED)).toThrow(writeFailure);
    expect(() => writeStore.clear()).toThrow(writeFailure);
  });

  test('clears with a versioned tombstone and reads it as empty', () => {
    const memory = memoryAdapter(
      serialized({ version: START_MUTATION_STORE_VERSION, ...UNRESOLVED }),
    );
    const store = createStartMutationStore(memory.adapter);

    store.clear();

    expect(JSON.parse(memory.value() ?? '')).toEqual({
      version: START_MUTATION_STORE_VERSION,
      phase: 'empty',
    });
    expect(store.read()).toBeNull();
  });

  test('default storage is synchronous, device-only, and dedicated', () => {
    nativeValue = null;
    nativeWrites.length = 0;
    const store = createStartMutationStore();

    store.write(FAILED);

    expect(nativeWrites).toHaveLength(1);
    expect(nativeWrites[0]?.[0]).toBe(START_MUTATION_STORE_KEY);
    expect(nativeWrites[0]?.[2]).toEqual({
      keychainAccessible: 7,
      keychainService: 'net.psd401.eoc.start-mutation',
    });
    expect(store.read()).toEqual(FAILED);
  });
});
