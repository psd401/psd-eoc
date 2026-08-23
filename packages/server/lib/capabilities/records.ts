import {
  DrillRecordPageSchema,
  EventSummaryExportSchema,
  RecordsExportSchema,
  type CapabilityOutput,
} from '@psd-eoc/contracts';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseConnection,
} from '../../db/client';
import { organizationName } from '../config/deployment';
import {
  executeCapability,
  readCapabilityTime,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from './engine';
import {
  createDrizzleRecordsCapabilityStore,
  type JournalCapabilityStore,
  type JournalCapabilityTransaction,
} from './journal';
import {
  createRecordsArtifactStore,
  RecordsArtifactStoreError,
  type RecordsArtifactStore,
  type StoreRecordsArtifactInput,
} from './records/artifact-store';
import { serializeDrillRecordsCsv } from './records/csv';
import { renderEventSummaryPdf } from './records/pdf';

export type RecordsCapabilityId =
  | 'list-drill-records'
  | 'export-drill-records'
  | 'export-event-summary';

export const listDrillRecordsRegistration: ServerCapabilityRegistration<
  'list-drill-records',
  JournalCapabilityTransaction
> = {
  id: 'list-drill-records',
  resolveFacilityId: (input) => input.facilityId,
  async handler(input, context) {
    return DrillRecordPageSchema.parse(
      await context.transaction.listDrillRecords(
        input,
        context.invocation.scope,
      ),
    );
  },
};

const PACIFIC_FILE_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function pacificFileDate(timestamp: string): string {
  const parts = PACIFIC_FILE_DATE_FORMATTER.formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((candidate) => candidate.type === type)?.value;
    if (value === undefined) {
      throw new RecordsArtifactStoreError(
        'The drill-record export filename date is unavailable.',
      );
    }
    return value;
  };
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function exportDrillRecordsRegistration(
  artifactStore: RecordsArtifactStore,
): ServerCapabilityRegistration<
  'export-drill-records',
  JournalCapabilityTransaction
> {
  return {
    id: 'export-drill-records',
    resolveFacilityId: (input) => input.facilityId,
    async handler(input, context) {
      const generatedAt = await readCapabilityTime(context);
      const rows =
        await context.transaction.loadDrillRecordsExportSnapshot(input);
      const artifact = RecordsExportSchema.parse(
        await artifactStore.store({
          bytes: serializeDrillRecordsCsv(rows),
          format: 'csv',
          fileName: `drill-records-${input.facilityId.slice(0, 8)}-${pacificFileDate(input.startedFrom)}-${pacificFileDate(input.startedThrough)}.csv`,
          rowCount: rows.length,
          generatedAt,
        }),
      );
      if (artifact.format !== 'csv') {
        throw new RecordsArtifactStoreError(
          'The drill-record export artifact format is inconsistent.',
        );
      }
      return artifact;
    },
  };
}

function exportEventSummaryRegistration(
  artifactStore: RecordsArtifactStore,
): ServerCapabilityRegistration<
  'export-event-summary',
  JournalCapabilityTransaction
> {
  return {
    id: 'export-event-summary',
    resolveFacilityId: (input, context) =>
      context.transaction.resolveEventFacilityId(input.eventId),
    async handler(input, context) {
      const generatedAt = await readCapabilityTime(context);
      const snapshot = await context.transaction.loadEventSummarySnapshot(
        input.eventId,
        generatedAt.toISOString(),
      );
      const artifact = await artifactStore.store({
        bytes: await renderEventSummaryPdf(snapshot, organizationName()),
        format: 'pdf',
        fileName: `event-summary-${snapshot.event.id}.pdf`,
        rowCount: snapshot.journal.length,
        generatedAt,
      });
      return EventSummaryExportSchema.parse({
        eventId: snapshot.event.id,
        artifact,
      });
    },
  };
}

/** Preserves the focused P4.2 list helper over an explicitly supplied store. */
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

/** Executes one export through the same canonical authorization/audit engine. */
export function executeRecordsExportCapability<
  Id extends 'export-drill-records' | 'export-event-summary',
>(
  capabilityId: Id,
  input: unknown,
  invocation: TrustedCapabilityInvocation,
  store: JournalCapabilityStore,
  artifactStore: RecordsArtifactStore,
): Promise<CapabilityOutput<Id>> {
  const registration =
    capabilityId === 'export-drill-records'
      ? exportDrillRecordsRegistration(artifactStore)
      : exportEventSummaryRegistration(artifactStore);
  return executeCapability(
    registration as ServerCapabilityRegistration<
      Id,
      JournalCapabilityTransaction
    >,
    input,
    invocation,
    store,
  );
}

export interface RecordsCapabilityRuntime {
  execute<Id extends RecordsCapabilityId>(
    capabilityId: Id,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<CapabilityOutput<Id>>;
  close(): Promise<void>;
}

function lazyRecordsArtifactStore(): RecordsArtifactStore {
  let resolved: RecordsArtifactStore | undefined;
  return Object.freeze({
    store(input: StoreRecordsArtifactInput) {
      resolved ??= createRecordsArtifactStore();
      return resolved.store(input);
    },
  });
}

/** Builds the shared web/REST/MCP runtime around one database connection. */
export function createRecordsCapabilityRuntime(
  connection: DatabaseConnection,
  artifactStore: RecordsArtifactStore = lazyRecordsArtifactStore(),
): RecordsCapabilityRuntime {
  const store = createDrizzleRecordsCapabilityStore(connection.db);
  return Object.freeze({
    execute<Id extends RecordsCapabilityId>(
      capabilityId: Id,
      input: unknown,
      invocation: TrustedCapabilityInvocation,
    ): Promise<CapabilityOutput<Id>> {
      if (capabilityId === 'list-drill-records') {
        return executeRecordsCapability(input, invocation, store) as Promise<
          CapabilityOutput<Id>
        >;
      }
      return executeRecordsExportCapability(
        capabilityId,
        input,
        invocation,
        store,
        artifactStore,
      ) as Promise<CapabilityOutput<Id>>;
    },
    close: () => connection.close(),
  });
}

let defaultRuntime: RecordsCapabilityRuntime | undefined;

/** Lazily creates the web records runtime without touching provider storage. */
export function getDefaultRecordsCapabilityRuntime(): RecordsCapabilityRuntime {
  defaultRuntime ??= createRecordsCapabilityRuntime(
    createDatabaseClient(readDatabaseConfig()),
  );
  return defaultRuntime;
}

export async function closeDefaultRecordsCapabilityRuntime(): Promise<void> {
  const runtime = defaultRuntime;
  defaultRuntime = undefined;
  await runtime?.close();
}
