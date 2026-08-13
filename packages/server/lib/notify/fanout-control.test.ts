import { describe, expect, test } from 'bun:test';

import type { PostgresDatabase } from '../../db/client';
import {
  FANOUT_CONTROL_ADVISORY_LOCK_SQL,
  FanoutControlDeniedError,
  authorizeCurrentNotificationIntentForFanout,
  assertCurrentNotificationFanoutEnabled,
  createFanoutEnableEpochId,
  isNotificationIntentAuthorizedForCurrentFanout,
  readFanoutControlEffectiveState,
} from './fanout-control';

const IDS = {
  record: '00000000-0000-4000-8000-000000003401',
  epoch: '00000000-0000-4000-8000-000000003402',
  user: '00000000-0000-4000-8000-000000003403',
  session: '00000000-0000-4000-8000-000000003404',
  request: '00000000-0000-4000-8000-000000003405',
  intent: '00000000-0000-4000-8000-000000003406',
  secondRecord: '00000000-0000-4000-8000-000000003407',
  secondEpoch: '00000000-0000-4000-8000-000000003408',
} as const;

function databaseWithRows(
  rows: readonly Record<string, unknown>[],
  executeError: Error | null = null,
): PostgresDatabase {
  return {
    execute() {
      if (executeError !== null) return Promise.reject(executeError);
      return Promise.resolve([]);
    },
    select() {
      return {
        from() {
          return {
            orderBy() {
              return {
                limit() {
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as PostgresDatabase;
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.record,
    revision: 1,
    previousRecordId: null,
    mode: 'enabled',
    enableEpochId: IDS.epoch,
    reason: 'Synthetic enablement for a unit test.',
    productOwnerApprovalReference: 'synthetic-po-reference',
    changedByUserId: IDS.user,
    changedWithSessionId: IDS.session,
    changedAt: new Date('2026-08-12T18:00:00.000Z'),
    requestId: IDS.request,
    ...overrides,
  };
}

function mutableFanoutDatabase() {
  const state = {
    controlRows: [record()],
    authorizations: new Map<
      string,
      Readonly<{ controlRecordId: string; enableEpochId: string }>
    >(),
    authorizationInsertCount: 0,
  };
  const database = {
    execute() {
      return Promise.resolve([]);
    },
    select(selection?: unknown) {
      return {
        from() {
          return selection === undefined
            ? {
                orderBy() {
                  return {
                    limit() {
                      return Promise.resolve(state.controlRows);
                    },
                  };
                },
              }
            : {
                where() {
                  return {
                    limit() {
                      const authorization = state.authorizations.get(
                        IDS.intent,
                      );
                      return Promise.resolve(
                        authorization === undefined
                          ? []
                          : [
                              {
                                enableEpochId: authorization.enableEpochId,
                              },
                            ],
                      );
                    },
                  };
                },
              };
        },
      };
    },
    insert() {
      return {
        values(value: {
          intentId: string;
          controlRecordId: string;
          enableEpochId: string;
        }) {
          return {
            onConflictDoNothing() {
              return {
                returning() {
                  if (state.authorizations.has(value.intentId)) {
                    return Promise.resolve([]);
                  }
                  state.authorizationInsertCount += 1;
                  const inserted = Object.freeze({
                    controlRecordId: value.controlRecordId,
                    enableEpochId: value.enableEpochId,
                  });
                  state.authorizations.set(value.intentId, inserted);
                  return Promise.resolve([inserted]);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as PostgresDatabase;
  return { database, state };
}

describe('fan-out control fail-closed reader', () => {
  test('derives missing and unreadable persistence as emergency-disabled', async () => {
    await expect(
      readFanoutControlEffectiveState(databaseWithRows([])),
    ).resolves.toEqual({
      kind: 'missing',
      effectiveMode: 'emergency-disabled',
      currentEpochId: null,
      currentRecord: null,
      reasonCode: 'CONTROL_STATE_MISSING',
    });
    await expect(
      readFanoutControlEffectiveState(
        databaseWithRows([], new Error('synthetic read failure')),
      ),
    ).resolves.toEqual({
      kind: 'unavailable',
      effectiveMode: 'emergency-disabled',
      currentEpochId: null,
      currentRecord: null,
      reasonCode: 'CONTROL_STATE_UNREADABLE',
    });
  });

  test('returns an enabled record only when its complete contract parses', async () => {
    const state = await readFanoutControlEffectiveState(
      databaseWithRows([record()]),
    );
    expect(state.kind).toBe('current');
    expect(state.effectiveMode).toBe('enabled');
    expect(state.currentEpochId).toBe(IDS.epoch);
    if (state.kind === 'current') {
      expect(state.currentRecord.changedAt).toBe('2026-08-12T18:00:00.000Z');
    }

    const malformed = await readFanoutControlEffectiveState(
      databaseWithRows([record({ enableEpochId: null })]),
    );
    expect(malformed).toMatchObject({
      kind: 'unavailable',
      effectiveMode: 'emergency-disabled',
      reasonCode: 'CONTROL_STATE_UNREADABLE',
    });
  });

  test('rejects gaps or forks in the retained chain', async () => {
    const current = record({
      id: '00000000-0000-4000-8000-000000003410',
      revision: 3,
      previousRecordId: '00000000-0000-4000-8000-000000003409',
    });
    const nonAdjacentPrevious = record({
      id: '00000000-0000-4000-8000-000000003409',
      revision: 1,
      mode: 'emergency-disabled',
      enableEpochId: null,
      productOwnerApprovalReference: null,
    });
    await expect(
      readFanoutControlEffectiveState(
        databaseWithRows([current, nonAdjacentPrevious]),
      ),
    ).resolves.toMatchObject({
      kind: 'unavailable',
      effectiveMode: 'emergency-disabled',
    });
  });

  test('requires enabled state before any consequence preview', async () => {
    await expect(
      assertCurrentNotificationFanoutEnabled(databaseWithRows([])),
    ).rejects.toMatchObject({ reasonCode: 'CONTROL_STATE_MISSING' });
    await expect(
      assertCurrentNotificationFanoutEnabled(
        databaseWithRows([
          record({
            mode: 'emergency-disabled',
            enableEpochId: null,
            productOwnerApprovalReference: null,
          }),
        ]),
      ),
    ).rejects.toMatchObject({ reasonCode: 'EMERGENCY_DISABLED' });
    await expect(
      assertCurrentNotificationFanoutEnabled(databaseWithRows([record()])),
    ).resolves.toMatchObject({ mode: 'enabled', enableEpochId: IDS.epoch });
  });
});

describe('fan-out control invariants', () => {
  test('rejects a preview created at or before the current enable epoch', async () => {
    for (const previewCreatedAt of [
      '2026-08-12T17:59:59.999Z',
      '2026-08-12T18:00:00.000Z',
    ]) {
      const fixture = mutableFanoutDatabase();
      await expect(
        authorizeCurrentNotificationIntentForFanout({
          database: fixture.database,
          intentId: IDS.intent,
          previewCreatedAt: new Date(previewCreatedAt),
          authorizedAt: new Date('2026-08-12T18:01:00.000Z'),
        }),
      ).rejects.toMatchObject({ reasonCode: 'STALE_CONSEQUENCE_PREVIEW' });
      expect(fixture.state.authorizationInsertCount).toBe(0);
    }
  });

  test('pins intent authorization to one epoch and never releases it after re-enable', async () => {
    const fixture = mutableFanoutDatabase();
    await expect(
      authorizeCurrentNotificationIntentForFanout({
        database: fixture.database,
        intentId: IDS.intent,
        previewCreatedAt: new Date('2026-08-12T18:00:00.001Z'),
        authorizedAt: new Date('2026-08-12T18:01:00.000Z'),
      }),
    ).resolves.toEqual({
      controlRecordId: IDS.record,
      enableEpochId: IDS.epoch,
    });
    await expect(
      isNotificationIntentAuthorizedForCurrentFanout(
        fixture.database,
        IDS.intent,
      ),
    ).resolves.toEqual({ authorized: true, currentEpochId: IDS.epoch });

    fixture.state.controlRows = [
      record({
        id: IDS.secondRecord,
        revision: 2,
        previousRecordId: IDS.record,
        enableEpochId: IDS.secondEpoch,
        productOwnerApprovalReference: 'synthetic-new-po-reference',
        changedAt: new Date('2026-08-12T18:02:00.000Z'),
      }),
      record(),
    ];
    await expect(
      isNotificationIntentAuthorizedForCurrentFanout(
        fixture.database,
        IDS.intent,
      ),
    ).resolves.toEqual({
      authorized: false,
      currentEpochId: IDS.secondEpoch,
      reasonCode: 'ENABLE_EPOCH_MISMATCH',
    });
    expect(fixture.state.authorizationInsertCount).toBe(1);
  });

  test('uses one stable shared advisory lock and server-owned fresh epochs', () => {
    expect(FANOUT_CONTROL_ADVISORY_LOCK_SQL).toBeDefined();
    const first = createFanoutEnableEpochId();
    const second = createFanoutEnableEpochId();
    expect(first).toMatch(/^[a-f0-9-]{36}$/u);
    expect(second).toMatch(/^[a-f0-9-]{36}$/u);
    expect(first).not.toBe(second);
  });

  test('exposes bounded operational denial evidence without provider data', () => {
    const error = new FanoutControlDeniedError('ENABLE_EPOCH_MISMATCH');
    expect(error.reasonCode).toBe('ENABLE_EPOCH_MISMATCH');
    expect(error.message).not.toContain('provider');
    expect(error.message).not.toContain('recipient');
  });
});
