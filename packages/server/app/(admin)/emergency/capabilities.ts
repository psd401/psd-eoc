import {
  SetFanoutControlInputSchema,
  SetFanoutControlResultSchema,
  type CapabilityInput,
  type FanoutControlRecord,
} from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import {
  digestCapabilityValue,
  readCapabilityTime,
  type ServerCapabilityRegistration,
} from '../../../lib/capabilities/engine';
import {
  appendFanoutControlRecord,
  FanoutControlDeniedError,
  loadFanoutControlRecordById,
  readFanoutControlEffectiveState,
} from '../../../lib/notify/fanout-control';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
  executeAdminMutationCapability,
  executeAdminQueryCapability,
  getDefaultAdminDatabase,
  requireAdminCapabilityAuthorization,
  type AdminCapabilityStore,
  type AdminCapabilityTransaction,
  type AdminMutationMetadata,
  type AdminQueryMetadata,
} from '../facilities/admin-core';

interface FanoutControlCapabilityPersistence {
  readonly appendRecord: typeof appendFanoutControlRecord;
  readonly loadRecordById: typeof loadFanoutControlRecordById;
  readonly readEffectiveState: typeof readFanoutControlEffectiveState;
}

const defaultFanoutControlCapabilityPersistence: FanoutControlCapabilityPersistence =
  Object.freeze({
    appendRecord: appendFanoutControlRecord,
    loadRecordById: loadFanoutControlRecordById,
    readEffectiveState: readFanoutControlEffectiveState,
  });

function resultReference(record: FanoutControlRecord): string {
  return Buffer.from(
    JSON.stringify({
      recordId: record.id,
      outputDigest: digestCapabilityValue(record),
    }),
    'utf8',
  ).toString('base64url');
}

function parseResultReference(value: string): Readonly<{
  recordId: string;
  outputDigest: string;
}> {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null) throw new TypeError();
    const recordId = Reflect.get(parsed, 'recordId');
    const outputDigest = Reflect.get(parsed, 'outputDigest');
    if (
      typeof recordId !== 'string' ||
      typeof outputDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(outputDigest)
    ) {
      throw new TypeError();
    }
    return Object.freeze({ recordId, outputDigest });
  } catch {
    throw new AdminCapabilityError(
      'CONFLICT',
      'The fan-out control replay reference is invalid.',
      409,
    );
  }
}

export function createGetFanoutControlRegistration(
  persistence: Pick<
    FanoutControlCapabilityPersistence,
    'readEffectiveState'
  > = defaultFanoutControlCapabilityPersistence,
): ServerCapabilityRegistration<
  'get-fanout-control',
  AdminCapabilityTransaction
> {
  return {
    id: 'get-fanout-control',
    resolveFacilityId(_input, context) {
      requireAdminCapabilityAuthorization(
        context.invocation.actor,
        context.transaction,
      );
      return null;
    },
    handler(_input, context) {
      return persistence.readEffectiveState(context.transaction.database);
    },
  };
}

export const getFanoutControlRegistration =
  createGetFanoutControlRegistration();

export function createSetFanoutControlRegistration(
  persistence: Pick<
    FanoutControlCapabilityPersistence,
    'appendRecord' | 'loadRecordById'
  > = defaultFanoutControlCapabilityPersistence,
): ServerCapabilityRegistration<
  'set-fanout-control',
  AdminCapabilityTransaction
> {
  return {
    id: 'set-fanout-control',
    resolveFacilityId(_input, context) {
      requireAdminCapabilityAuthorization(
        context.invocation.actor,
        context.transaction,
      );
      return null;
    },
    async handler(inputValue, context) {
      const input = SetFanoutControlInputSchema.parse(inputValue);
      const actor = context.invocation.actor;
      if (actor.kind !== 'human') {
        throw new AdminCapabilityError(
          'FORBIDDEN',
          'A human district administrator must make this change.',
          403,
        );
      }
      const changedAt = await readCapabilityTime(context);
      let appendedRecord;
      try {
        appendedRecord = await persistence.appendRecord({
          database: context.transaction.database,
          actor,
          requestId: context.invocation.requestId,
          expectedCurrentRecordId: input.expectedCurrentRecordId,
          desiredMode: input.desiredMode,
          reason: input.reason,
          productOwnerApprovalReference:
            input.desiredMode === 'enabled'
              ? input.productOwnerApprovalReference
              : null,
          changedAt,
        });
      } catch (error) {
        if (
          error instanceof FanoutControlDeniedError &&
          error.reasonCode === 'APPROVAL_REFERENCE_REUSED'
        ) {
          throw new AdminCapabilityError(
            'CONFLICT',
            'A fresh product-owner authorization reference is required.',
            409,
          );
        }
        throw error;
      }
      context.transaction.setAuditTarget({
        kind: 'configuration',
        id: appendedRecord.id,
      });
      return SetFanoutControlResultSchema.parse({
        appendedRecord,
        effectiveState: {
          kind: 'current',
          effectiveMode: appendedRecord.mode,
          currentEpochId: appendedRecord.enableEpochId,
          currentRecord: appendedRecord,
        },
      });
    },
    resultReference: (output) => resultReference(output.appendedRecord),
    async loadReplay(reference, context) {
      const parsed = parseResultReference(reference);
      const record = await persistence.loadRecordById(
        context.transaction.database,
        parsed.recordId,
      );
      if (
        record === null ||
        digestCapabilityValue(record) !== parsed.outputDigest
      ) {
        throw new AdminCapabilityError(
          'CONFLICT',
          'The original fan-out control result is unavailable; replay was refused rather than returning changed data.',
          409,
        );
      }
      return SetFanoutControlResultSchema.parse({
        appendedRecord: record,
        effectiveState: {
          kind: 'current',
          effectiveMode: record.mode,
          currentEpochId: record.enableEpochId,
          currentRecord: record,
        },
      });
    },
    resolveReplayFacilityId(reference, context) {
      requireAdminCapabilityAuthorization(
        context.invocation.actor,
        context.transaction,
      );
      parseResultReference(reference);
      return null;
    },
    replayFacilityId: () => null,
  };
}

export const setFanoutControlRegistration =
  createSetFanoutControlRegistration();

function store(
  authenticated: AuthenticatedSession,
  injected: AdminCapabilityStore | undefined,
): AdminCapabilityStore {
  return (
    injected ??
    createDrizzleAdminCapabilityStore(getDefaultAdminDatabase(), authenticated)
  );
}

export function executeGetFanoutControlCapability(input: {
  readonly authenticated: AuthenticatedSession;
  readonly store?: AdminCapabilityStore;
  readonly metadata?: AdminQueryMetadata;
}) {
  return executeAdminQueryCapability(
    getFanoutControlRegistration,
    {},
    input.authenticated,
    store(input.authenticated, input.store),
    input.metadata,
  );
}

export function executeSetFanoutControlCapability(input: {
  readonly authenticated: AuthenticatedSession;
  readonly command: CapabilityInput<'set-fanout-control'>;
  readonly metadata: AdminMutationMetadata;
  readonly store?: AdminCapabilityStore;
}) {
  return executeAdminMutationCapability(
    setFanoutControlRegistration,
    input.command,
    input.authenticated,
    store(input.authenticated, input.store),
    input.metadata,
  );
}
