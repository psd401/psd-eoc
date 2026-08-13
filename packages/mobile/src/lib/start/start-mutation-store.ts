import {
  ActivationPreviewIdSchema,
  DeviceEnrollmentIdSchema,
  EventIdSchema,
  EventKindSchema,
  EventTypeVersionRefSchema,
  FacilityIdSchema,
  IdempotencyKeySchema,
  RosterPopulationSchema,
  RosterSnapshotIdSchema,
  SessionIdSchema,
  TemplateModeSchema,
  UserIdSchema,
  type IdempotencyKey,
} from '@psd-eoc/contracts';
import * as SecureStore from 'expo-secure-store';

import type {
  StartMutationActivationEvidence,
  StartMutationCompletion,
  StartMutationDisplay,
  StartMutationOwner,
  StartMutationPersistence,
  StartMutationRecoveryRecord,
} from './start-mutation-coordinator';

export const START_MUTATION_STORE_VERSION = 1 as const;
export const START_MUTATION_STORE_KEY = 'psd-eoc.start-mutation.v1';

const START_MUTATION_STORE_KEYCHAIN_SERVICE = 'net.psd401.eoc.start-mutation';
const START_MUTATION_STORE_OPTIONS: SecureStore.SecureStoreOptions =
  Object.freeze({
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    keychainService: START_MUTATION_STORE_KEYCHAIN_SERVICE,
  });
const INVALID_RECORD_MESSAGE =
  'The stored start-mutation recovery record is invalid.';
const EVENT_TYPE_NAME_MAX_LENGTH = 160;
const PUBLIC_ERROR_MAX_LENGTH = 1_000;

interface EmptyStartMutationStoreRecord {
  readonly version: typeof START_MUTATION_STORE_VERSION;
  readonly phase: 'empty';
}

type VersionedStartMutationRecoveryRecord = StartMutationRecoveryRecord & {
  readonly version: typeof START_MUTATION_STORE_VERSION;
};

export interface StartMutationStoreAdapter {
  getItem(key: string, options: SecureStore.SecureStoreOptions): string | null;
  setItem(
    key: string,
    value: string,
    options: SecureStore.SecureStoreOptions,
  ): void;
}

const EMPTY_RECORD: EmptyStartMutationStoreRecord = Object.freeze({
  version: START_MUTATION_STORE_VERSION,
  phase: 'empty',
});
const EMPTY_RECORD_JSON = JSON.stringify(EMPTY_RECORD);

const DEFAULT_ADAPTER: StartMutationStoreAdapter = Object.freeze({
  getItem(key: string, options: SecureStore.SecureStoreOptions): string | null {
    return SecureStore.getItem(key, options);
  },
  setItem(
    key: string,
    value: string,
    options: SecureStore.SecureStoreOptions,
  ): void {
    SecureStore.setItem(key, value, options);
  },
});

function invalidRecord(): never {
  throw new Error(INVALID_RECORD_MESSAGE);
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidRecord();
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidRecord();
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    invalidRecord();
  }
}

function parseOwner(value: unknown): StartMutationOwner {
  const owner = objectRecord(value);
  assertExactKeys(owner, ['userId', 'sessionId', 'deviceEnrollmentId']);
  try {
    return Object.freeze({
      userId: UserIdSchema.parse(owner.userId),
      sessionId: SessionIdSchema.parse(owner.sessionId),
      deviceEnrollmentId: DeviceEnrollmentIdSchema.parse(
        owner.deviceEnrollmentId,
      ),
    });
  } catch {
    return invalidRecord();
  }
}

function parseEventTypeName(value: unknown): string {
  if (typeof value !== 'string') return invalidRecord();
  const parsed = value.trim();
  if (parsed.length === 0 || parsed.length > EVENT_TYPE_NAME_MAX_LENGTH) {
    return invalidRecord();
  }
  return parsed;
}

function parseDisplay(
  value: Readonly<Record<string, unknown>>,
): StartMutationDisplay & { readonly idempotencyKey: IdempotencyKey } {
  if (value.operation !== 'activate' && value.operation !== 'join') {
    return invalidRecord();
  }
  try {
    return Object.freeze({
      operation: value.operation,
      eventTypeName: parseEventTypeName(value.eventTypeName),
      mode: TemplateModeSchema.parse(value.mode),
      idempotencyKey: IdempotencyKeySchema.parse(value.idempotencyKey),
    });
  } catch {
    return invalidRecord();
  }
}

function parseActivationEvidence(
  value: unknown,
  display: StartMutationDisplay,
): StartMutationActivationEvidence | null {
  if (value === null) {
    return display.operation === 'join' ? null : invalidRecord();
  }
  if (display.operation !== 'activate') return invalidRecord();
  const evidence = objectRecord(value);
  assertExactKeys(evidence, [
    'previewId',
    'facilityId',
    'kind',
    'mode',
    'eventTypeVersion',
    'rosterSnapshotId',
    'rosterPopulation',
    'consequenceDigest',
  ]);
  try {
    const mode = TemplateModeSchema.parse(evidence.mode);
    const eventTypeVersion = EventTypeVersionRefSchema.parse(
      evidence.eventTypeVersion,
    );
    const kind = EventKindSchema.parse(evidence.kind);
    const rosterPopulation = RosterPopulationSchema.parse(
      evidence.rosterPopulation,
    );
    if (
      mode !== display.mode ||
      eventTypeVersion.templateMode !== mode ||
      (mode === 'real' && kind !== 'incident') ||
      (mode === 'drill' && kind !== 'drill' && kind !== 'test') ||
      typeof evidence.consequenceDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(evidence.consequenceDigest)
    ) {
      return invalidRecord();
    }
    return Object.freeze({
      previewId: ActivationPreviewIdSchema.parse(evidence.previewId),
      facilityId: FacilityIdSchema.parse(evidence.facilityId),
      kind,
      mode,
      eventTypeVersion,
      rosterSnapshotId: RosterSnapshotIdSchema.parse(evidence.rosterSnapshotId),
      rosterPopulation,
      consequenceDigest: evidence.consequenceDigest,
    });
  } catch {
    return invalidRecord();
  }
}

function parsePublicError<OutcomeUnknown extends boolean>(
  value: unknown,
  outcomeUnknown: OutcomeUnknown,
): Readonly<{ message: string; outcomeUnknown: OutcomeUnknown }> {
  const error = objectRecord(value);
  assertExactKeys(error, ['message', 'outcomeUnknown']);
  if (
    error.outcomeUnknown !== outcomeUnknown ||
    typeof error.message !== 'string'
  ) {
    return invalidRecord();
  }
  const message = error.message.trim();
  if (message.length === 0 || message.length > PUBLIC_ERROR_MAX_LENGTH) {
    return invalidRecord();
  }
  return Object.freeze({ message, outcomeUnknown });
}

function parseCompletion(
  value: unknown,
  display: StartMutationDisplay,
): StartMutationCompletion {
  const completion = objectRecord(value);
  assertExactKeys(completion, ['kind', 'eventId', 'eventTypeName', 'mode']);
  const expectedKind =
    display.operation === 'activate' ? 'activated' : 'joined';
  if (
    completion.kind !== expectedKind ||
    parseEventTypeName(completion.eventTypeName) !== display.eventTypeName
  ) {
    return invalidRecord();
  }
  let mode: StartMutationCompletion['mode'];
  try {
    mode = TemplateModeSchema.parse(completion.mode);
  } catch {
    return invalidRecord();
  }
  if (mode !== display.mode) return invalidRecord();
  let eventId: StartMutationCompletion['eventId'];
  try {
    eventId = EventIdSchema.parse(completion.eventId);
  } catch {
    return invalidRecord();
  }
  return Object.freeze({
    kind: expectedKind,
    eventId,
    eventTypeName: display.eventTypeName,
    mode,
  });
}

function parseStoredValue(
  value: unknown,
): VersionedStartMutationRecoveryRecord | EmptyStartMutationStoreRecord {
  const stored = objectRecord(value);
  if (stored.version !== START_MUTATION_STORE_VERSION) {
    return invalidRecord();
  }
  if (stored.phase === 'empty') {
    assertExactKeys(stored, ['version', 'phase']);
    return EMPTY_RECORD;
  }

  const commonKeys = [
    'version',
    'phase',
    'owner',
    'operation',
    'eventTypeName',
    'mode',
    'idempotencyKey',
    'activationEvidence',
  ] as const;
  const terminalKey = stored.phase === 'succeeded' ? 'completion' : 'error';
  const expectedKeys =
    stored.phase === 'succeeded'
      ? [...commonKeys, terminalKey, 'feedbackClaimed']
      : [...commonKeys, terminalKey];
  if (
    stored.phase !== 'unresolved' &&
    stored.phase !== 'succeeded' &&
    stored.phase !== 'failed'
  ) {
    return invalidRecord();
  }
  assertExactKeys(stored, expectedKeys);

  const owner = parseOwner(stored.owner);
  const display = parseDisplay(stored);
  const activationEvidence = parseActivationEvidence(
    stored.activationEvidence,
    display,
  );
  const common = {
    version: START_MUTATION_STORE_VERSION,
    owner,
    ...display,
    activationEvidence,
  } as const;

  if (stored.phase === 'unresolved') {
    return Object.freeze({
      ...common,
      phase: 'unresolved',
      error: parsePublicError(stored.error, true),
    });
  }
  if (stored.phase === 'failed') {
    return Object.freeze({
      ...common,
      phase: 'failed',
      error: parsePublicError(stored.error, false),
    });
  }
  if (typeof stored.feedbackClaimed !== 'boolean') return invalidRecord();
  return Object.freeze({
    ...common,
    phase: 'succeeded',
    completion: parseCompletion(stored.completion, display),
    feedbackClaimed: stored.feedbackClaimed,
  });
}

/** Parses only the minimized, versioned ledger format; corruption fails closed. */
export function parseStartMutationStoreRecord(
  serialized: string,
): StartMutationRecoveryRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return invalidRecord();
  }
  const parsed = parseStoredValue(value);
  if (parsed.phase === 'empty') return null;
  const common = {
    owner: parsed.owner,
    operation: parsed.operation,
    eventTypeName: parsed.eventTypeName,
    mode: parsed.mode,
    idempotencyKey: parsed.idempotencyKey,
    activationEvidence: parsed.activationEvidence,
  } as const;
  if (parsed.phase === 'unresolved') {
    return Object.freeze({
      ...common,
      phase: 'unresolved',
      error: parsed.error,
    });
  }
  if (parsed.phase === 'failed') {
    return Object.freeze({
      ...common,
      phase: 'failed',
      error: parsed.error,
    });
  }
  return Object.freeze({
    ...common,
    phase: 'succeeded',
    completion: parsed.completion,
    feedbackClaimed: parsed.feedbackClaimed,
  });
}

/** Synchronous native ledger. Callers persist before starting any transport. */
export function createStartMutationStore(
  adapter: StartMutationStoreAdapter = DEFAULT_ADAPTER,
): StartMutationPersistence {
  return Object.freeze({
    read(): StartMutationRecoveryRecord | null {
      const serialized = adapter.getItem(
        START_MUTATION_STORE_KEY,
        START_MUTATION_STORE_OPTIONS,
      );
      return serialized === null
        ? null
        : parseStartMutationStoreRecord(serialized);
    },
    write(record: StartMutationRecoveryRecord): void {
      const validated = parseStoredValue({
        version: START_MUTATION_STORE_VERSION,
        ...record,
      });
      if (validated.phase === 'empty') return invalidRecord();
      adapter.setItem(
        START_MUTATION_STORE_KEY,
        JSON.stringify(validated),
        START_MUTATION_STORE_OPTIONS,
      );
    },
    clear(): void {
      adapter.setItem(
        START_MUTATION_STORE_KEY,
        EMPTY_RECORD_JSON,
        START_MUTATION_STORE_OPTIONS,
      );
    },
  });
}
