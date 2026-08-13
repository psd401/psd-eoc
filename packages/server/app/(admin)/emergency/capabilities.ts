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

export const getFanoutControlRegistration: ServerCapabilityRegistration<
  'get-fanout-control',
  AdminCapabilityTransaction
> = {
  id: 'get-fanout-control',
  resolveFacilityId(_input, context) {
    if (context.invocation.actor.kind !== 'human') {
      throw new AdminCapabilityError(
        'FORBIDDEN',
        'An authenticated staff session is required.',
        403,
      );
    }
    return null;
  },
  handler(_input, context) {
    return readFanoutControlEffectiveState(context.transaction.database);
  },
};

export const setFanoutControlRegistration: ServerCapabilityRegistration<
  'set-fanout-control',
  AdminCapabilityTransaction
> = {
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
    const appendedRecord = await appendFanoutControlRecord({
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
    const record = await loadFanoutControlRecordById(
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
