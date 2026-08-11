import { describe, expect, test } from 'bun:test';

import type {
  CapabilityInput,
  DrillRecordPage,
  FacilityScope,
  JournalEntryPage,
  RecordsExport,
} from '@psd-eoc/contracts';

import type {
  CapabilityAuditEvent,
  TrustedCapabilityInvocation,
} from './engine';
import {
  executeJournalCapability,
  type JournalCapabilityStore,
  type JournalCapabilityTransaction,
} from './journal';
import {
  executeRecordsCapability,
  executeRecordsExportCapability,
} from './records';
import type {
  RecordsArtifactStore,
  StoreRecordsArtifactInput,
} from './records/artifact-store';
import type { EventSummarySnapshot } from './records/pdf';

const IDS = Object.freeze({
  agent: '00000000-0000-4000-8000-000000000701',
  apiKey: '00000000-0000-4000-8000-000000000702',
  facility: '00000000-0000-4000-8000-000000000703',
  otherFacility: '00000000-0000-4000-8000-000000000704',
  event: '00000000-0000-4000-8000-000000000705',
  eventTypeVersion: '00000000-0000-4000-8000-000000000706',
  request: '00000000-0000-4000-8000-000000000707',
  eventType: '00000000-0000-4000-8000-000000000708',
});

function invocation(facilityScope: FacilityScope): TrustedCapabilityInvocation {
  return Object.freeze({
    actor: {
      kind: 'agent' as const,
      agentId: IDS.agent,
      apiKeyId: IDS.apiKey,
    },
    source: 'agent-rest' as const,
    scope: { facilityScope },
    requestId: IDS.request,
    serverTime: new Date('2026-08-11T17:30:00.000Z'),
    connectivityEpochId: null,
    mutation: null,
  });
}

function drillPage(facilityId = IDS.facility): DrillRecordPage {
  return {
    items: [
      {
        id: IDS.event,
        eventId: IDS.event,
        facilityId,
        kind: 'drill',
        eventTypeVersion: {
          id: IDS.eventTypeVersion,
          templateMode: 'drill',
        },
        eventTypeName: 'Synthetic Lockdown Drill',
        status: 'closed',
        startedAt: '2026-08-11T16:00:00.000Z',
        allClearAt: '2026-08-11T16:10:00.000Z',
        reactivatedAt: null,
        closedAt: '2026-08-11T16:11:00.000Z',
      },
    ],
    pageInfo: { hasMore: false, nextCursor: null },
  };
}

interface RecordsHarness {
  readonly store: JournalCapabilityStore;
  readonly audits: CapabilityAuditEvent[];
  readonly calls: Array<{
    readonly input: CapabilityInput<'list-drill-records'>;
    readonly scope: TrustedCapabilityInvocation['scope'];
  }>;
}

function recordsHarness(result: DrillRecordPage = drillPage()): RecordsHarness {
  const audits: CapabilityAuditEvent[] = [];
  const calls: RecordsHarness['calls'][number][] = [];
  const transaction = {
    async listDrillRecords(
      input: CapabilityInput<'list-drill-records'>,
      scope: TrustedCapabilityInvocation['scope'],
    ) {
      calls.push({ input, scope });
      return result;
    },
    async appendCapabilityAudit(event: CapabilityAuditEvent) {
      audits.push(event);
    },
  } as unknown as JournalCapabilityTransaction;
  const store: JournalCapabilityStore = {
    async transaction<Result>(
      operation: (transaction: JournalCapabilityTransaction) => Promise<Result>,
    ) {
      return operation(transaction);
    },
    async appendCapabilityAudit(event: CapabilityAuditEvent) {
      audits.push(event);
    },
  };
  return {
    audits,
    calls,
    store,
  };
}

describe('canonical drill-record reads', () => {
  test('returns RCW date/time/type evidence and writes the canonical agent audit', async () => {
    const harness = recordsHarness();
    const call = invocation({
      kind: 'facilities',
      facilityIds: [IDS.facility],
    });
    const input = {
      facilityId: IDS.facility,
      eventTypeId: null,
      startedFrom: '2026-08-01T00:00:00.000Z',
      startedThrough: '2026-08-31T23:59:59.999Z',
      cursor: null,
      limit: 25,
    };

    const result = await executeRecordsCapability(input, call, harness.store);

    expect(result.items[0]).toMatchObject({
      facilityId: IDS.facility,
      eventTypeName: 'Synthetic Lockdown Drill',
      startedAt: '2026-08-11T16:00:00.000Z',
      kind: 'drill',
    });
    expect(harness.calls).toEqual([{ input, scope: call.scope }]);
    expect(harness.audits).toEqual([
      expect.objectContaining({
        action: 'list-drill-records',
        actor: call.actor,
        category: 'agent-access',
        facilityId: IDS.facility,
        outcome: 'success',
        requestId: IDS.request,
      }),
    ]);
  });

  test('passes a null-site query to a store with the trusted facility scope', async () => {
    const harness = recordsHarness();
    const call = invocation({
      kind: 'facilities',
      facilityIds: [IDS.facility],
    });

    await executeRecordsCapability(
      {
        facilityId: null,
        eventTypeId: null,
        startedFrom: null,
        startedThrough: null,
        cursor: null,
        limit: 25,
      },
      call,
      harness.store,
    );

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.scope).toEqual(call.scope);
  });

  test('fails closed if persistence ever projects a real incident as a drill record', async () => {
    const valid = drillPage();
    const harness = recordsHarness({
      ...valid,
      items: [
        {
          ...valid.items[0]!,
          kind: 'incident',
          eventTypeVersion: {
            ...valid.items[0]!.eventTypeVersion,
            templateMode: 'real',
          },
        },
      ],
    } as unknown as DrillRecordPage);
    const call = invocation({
      kind: 'facilities',
      facilityIds: [IDS.facility],
    });

    await expect(
      executeRecordsCapability(
        {
          facilityId: IDS.facility,
          eventTypeId: null,
          startedFrom: null,
          startedThrough: null,
          cursor: null,
          limit: 25,
        },
        call,
        harness.store,
      ),
    ).rejects.toThrow();

    expect(harness.calls).toHaveLength(1);
    expect(harness.audits).toEqual([
      expect.objectContaining({
        action: 'list-drill-records',
        category: 'capability-execution',
        facilityId: IDS.facility,
        outcome: 'failure',
        reasonCode: 'PERSISTENCE_CONFLICT',
      }),
    ]);
  });

  test('denies an explicit out-of-scope site before any records are read', async () => {
    const harness = recordsHarness();
    const call = invocation({
      kind: 'facilities',
      facilityIds: [IDS.facility],
    });

    await expect(
      executeRecordsCapability(
        {
          facilityId: IDS.otherFacility,
          eventTypeId: null,
          startedFrom: null,
          startedThrough: null,
          cursor: null,
          limit: 25,
        },
        call,
        harness.store,
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CAPABILITY_SCOPE_DENIED',
      status: 403,
    });
    expect(harness.calls).toEqual([]);
    expect(harness.audits).toEqual([
      expect.objectContaining({
        action: 'list-drill-records',
        category: 'access-denial',
        facilityId: IDS.otherFacility,
        outcome: 'denied',
        reasonCode: 'CAPABILITY_SCOPE_DENIED',
      }),
    ]);
  });
});

interface ExportHarness {
  readonly store: JournalCapabilityStore;
  readonly artifacts: StoreRecordsArtifactInput[];
  readonly audits: CapabilityAuditEvent[];
  readonly drillReads: unknown[];
  readonly eventReads: unknown[];
  readonly artifactStore: RecordsArtifactStore;
}

function exportHarness(eventFacilityId: string = IDS.facility): ExportHarness {
  const artifacts: StoreRecordsArtifactInput[] = [];
  const audits: CapabilityAuditEvent[] = [];
  const drillReads: unknown[] = [];
  const eventReads: unknown[] = [];
  const summary: EventSummarySnapshot = {
    generatedAt: '2026-08-11T17:30:00.000Z',
    event: {
      id: IDS.event,
      kind: 'incident',
      templateMode: 'real',
      status: 'active',
      createdAt: '2026-08-11T17:00:00.000Z',
      activatedAt: '2026-08-11T17:01:00.000Z',
      allClearAt: null,
      reactivatedAt: null,
      closedAt: null,
      correctionOfEventId: null,
      correctionReason: null,
    },
    facility: { code: 'SYN', name: 'Synthetic North Campus' },
    eventType: { id: IDS.eventTypeVersion, name: 'Synthetic Lockdown' },
    recordedParticipantCount: 0,
    journal: [],
    photos: [],
    delivery: [],
  };
  const transaction = {
    async readCurrentTime() {
      return new Date('2026-08-11T17:30:00.000Z');
    },
    async loadDrillRecordsExportSnapshot(input: unknown) {
      drillReads.push(input);
      return [
        {
          facilityName: 'Synthetic North Campus',
          facilityCode: 'SYN',
          eventType: 'Synthetic Lockdown Drill',
          kind: 'drill' as const,
          startedAt: '2026-08-11T16:00:00.000Z',
          durationSeconds: 600,
          participantCount: 7,
        },
      ];
    },
    async resolveEventFacilityId() {
      return eventFacilityId;
    },
    async loadEventSummarySnapshot(eventId: string, generatedAt: string) {
      eventReads.push({ eventId, generatedAt });
      return { ...summary, generatedAt };
    },
    async appendCapabilityAudit(event: CapabilityAuditEvent) {
      audits.push(event);
    },
  } as unknown as JournalCapabilityTransaction;
  const store: JournalCapabilityStore = {
    async transaction<Result>(
      operation: (transaction: JournalCapabilityTransaction) => Promise<Result>,
    ) {
      return operation(transaction);
    },
    async appendCapabilityAudit(event: CapabilityAuditEvent) {
      audits.push(event);
    },
  };
  const artifactStore: RecordsArtifactStore = {
    async store(input): Promise<RecordsExport> {
      artifacts.push(input);
      return {
        id: IDS.eventType,
        format: input.format,
        contentType:
          input.format === 'csv'
            ? 'text/csv; charset=utf-8'
            : 'application/pdf',
        fileName: input.fileName,
        byteLength: input.bytes.byteLength,
        contentSha256: 'a'.repeat(64),
        rowCount: input.rowCount,
        downloadUrl: 'https://private.example.test/synthetic-export',
        generatedAt: input.generatedAt.toISOString(),
        expiresAt: new Date(
          input.generatedAt.getTime() + 5 * 60 * 1_000,
        ).toISOString(),
      };
    },
  };
  return { store, artifactStore, artifacts, audits, drillReads, eventReads };
}

describe('canonical records exports', () => {
  test('exports one facility-bound RCW CSV and appends canonical audit evidence', async () => {
    const harness = exportHarness();
    const call = invocation({
      kind: 'facilities',
      facilityIds: [IDS.facility],
    });
    const input = {
      facilityId: IDS.facility,
      eventTypeId: null,
      startedFrom: '2026-08-01T07:00:00.000Z',
      startedThrough: '2026-09-01T06:59:59.999Z',
      format: 'csv' as const,
    };

    const result = await executeRecordsExportCapability(
      'export-drill-records',
      input,
      call,
      harness.store,
      harness.artifactStore,
    );

    expect(result).toMatchObject({
      format: 'csv',
      contentType: 'text/csv; charset=utf-8',
      rowCount: 1,
    });
    expect(harness.drillReads).toEqual([input]);
    expect(new TextDecoder().decode(harness.artifacts[0]?.bytes)).toContain(
      '[DRILL] Synthetic Lockdown Drill',
    );
    expect(harness.artifacts[0]?.fileName).toBe(
      `drill-records-${IDS.facility.slice(0, 8)}-2026-08-01-2026-08-31.csv`,
    );
    expect(harness.audits).toEqual([
      expect.objectContaining({
        action: 'export-drill-records',
        category: 'agent-access',
        facilityId: IDS.facility,
        outcome: 'success',
      }),
    ]);
  });

  test('fails closed if artifact storage returns a non-CSV drill export', async () => {
    const harness = exportHarness();
    const call = invocation({
      kind: 'facilities',
      facilityIds: [IDS.facility],
    });
    const mismatchedStore: RecordsArtifactStore = {
      async store(input): Promise<RecordsExport> {
        return {
          id: IDS.eventType,
          format: 'pdf',
          contentType: 'application/pdf',
          fileName: 'event-summary.pdf',
          byteLength: input.bytes.byteLength,
          contentSha256: 'a'.repeat(64),
          rowCount: input.rowCount,
          downloadUrl: 'https://private.example.test/wrong-format',
          generatedAt: input.generatedAt.toISOString(),
          expiresAt: new Date(
            input.generatedAt.getTime() + 5 * 60 * 1_000,
          ).toISOString(),
        };
      },
    };

    await expect(
      executeRecordsExportCapability(
        'export-drill-records',
        {
          facilityId: IDS.facility,
          eventTypeId: null,
          startedFrom: '2026-08-01T07:00:00.000Z',
          startedThrough: '2026-09-01T06:59:59.999Z',
          format: 'csv',
        },
        call,
        harness.store,
        mismatchedStore,
      ),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      reasonCode: 'PERSISTENCE_CONFLICT',
      status: 500,
    });
    expect(harness.audits).toEqual([
      expect.objectContaining({
        action: 'export-drill-records',
        outcome: 'failure',
      }),
    ]);
  });

  test('exports a real event with the unmistakable incident PDF header and audit', async () => {
    const harness = exportHarness();
    const call = invocation({
      kind: 'facilities',
      facilityIds: [IDS.facility],
    });

    const result = await executeRecordsExportCapability(
      'export-event-summary',
      { eventId: IDS.event, format: 'pdf' },
      call,
      harness.store,
      harness.artifactStore,
    );

    expect(result).toMatchObject({
      eventId: IDS.event,
      artifact: {
        format: 'pdf',
        contentType: 'application/pdf',
        rowCount: 0,
      },
    });
    expect(harness.eventReads).toEqual([
      {
        eventId: IDS.event,
        generatedAt: '2026-08-11T17:30:00.000Z',
      },
    ]);
    expect(
      new TextDecoder().decode(harness.artifacts[0]?.bytes.slice(0, 8)),
    ).toBe('%PDF-1.7');
    expect(harness.audits).toEqual([
      expect.objectContaining({
        action: 'export-event-summary',
        category: 'agent-access',
        facilityId: IDS.facility,
        outcome: 'success',
      }),
    ]);
  });

  test('denies an out-of-scope event before snapshot assembly or artifact storage', async () => {
    const harness = exportHarness(IDS.otherFacility);
    const call = invocation({
      kind: 'facilities',
      facilityIds: [IDS.facility],
    });

    await expect(
      executeRecordsExportCapability(
        'export-event-summary',
        { eventId: IDS.event, format: 'pdf' },
        call,
        harness.store,
        harness.artifactStore,
      ),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      reasonCode: 'CAPABILITY_SCOPE_DENIED',
    });

    expect(harness.eventReads).toEqual([]);
    expect(harness.artifacts).toEqual([]);
    expect(harness.audits).toEqual([
      expect.objectContaining({
        action: 'export-event-summary',
        category: 'access-denial',
        facilityId: IDS.otherFacility,
        outcome: 'denied',
      }),
    ]);
  });
});

describe('canonical journal search registration', () => {
  test('passes only trusted facility scope into the canonical search store', async () => {
    const calls: Array<{
      input: CapabilityInput<'search-journal-entries'>;
      scope: TrustedCapabilityInvocation['scope'];
    }> = [];
    const audits: CapabilityAuditEvent[] = [];
    const page: JournalEntryPage = {
      items: [],
      pageInfo: { hasMore: false, nextCursor: null },
    };
    const transaction = {
      async searchJournalEntries(
        input: CapabilityInput<'search-journal-entries'>,
        scope: TrustedCapabilityInvocation['scope'],
      ) {
        calls.push({ input, scope });
        return page;
      },
      async appendCapabilityAudit(event: CapabilityAuditEvent) {
        audits.push(event);
      },
    } as unknown as JournalCapabilityTransaction;
    const store: JournalCapabilityStore = {
      async transaction<Result>(
        operation: (
          transaction: JournalCapabilityTransaction,
        ) => Promise<Result>,
      ) {
        return operation(transaction);
      },
      async appendCapabilityAudit(event: CapabilityAuditEvent) {
        audits.push(event);
      },
    };
    const call = invocation({
      kind: 'facilities',
      facilityIds: [IDS.facility],
    });
    const input = {
      eventId: null,
      kind: 'text' as const,
      query: 'synthetic search',
      occurredFrom: null,
      occurredThrough: null,
      cursor: null,
      limit: 25,
    };

    await expect(
      executeJournalCapability('search-journal-entries', input, call, store),
    ).resolves.toEqual(page);

    expect(calls).toEqual([{ input, scope: call.scope }]);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'search-journal-entries',
        actor: call.actor,
        category: 'agent-access',
        facilityId: null,
        outcome: 'success',
      }),
    ]);
  });
});
