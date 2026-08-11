import {
  DrillRecordPageSchema,
  type CapabilityOutput,
  type DrillRecordPage,
} from '@psd-eoc/contracts';

import {
  executeCapability,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from './engine';
import type {
  JournalCapabilityStore,
  JournalCapabilityTransaction,
} from './journal';

export const listDrillRecordsRegistration: ServerCapabilityRegistration<
  'list-drill-records',
  JournalCapabilityTransaction
> = {
  id: 'list-drill-records',
  resolveFacilityId: (input) => input.facilityId,
  async handler(input, context): Promise<DrillRecordPage> {
    return DrillRecordPageSchema.parse(
      await context.transaction.listDrillRecords(
        input,
        context.invocation.scope,
      ),
    );
  },
};

/** Executes the records read through the existing atomic journal store. */
export function executeRecordsCapability(
  input: unknown,
  invocation: TrustedCapabilityInvocation,
  store: JournalCapabilityStore,
): Promise<CapabilityOutput<'list-drill-records'>> {
  return executeCapability(
    listDrillRecordsRegistration,
    input,
    invocation,
    store,
  );
}

export interface RecordsCapabilityRuntime {
  execute(
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<CapabilityOutput<'list-drill-records'>>;
}

/** Reuses the journal store so the records read and audit commit atomically. */
export function createRecordsCapabilityRuntime(
  store: JournalCapabilityStore,
): RecordsCapabilityRuntime {
  return Object.freeze({
    execute: (input: unknown, invocation: TrustedCapabilityInvocation) =>
      executeRecordsCapability(input, invocation, store),
  });
}
