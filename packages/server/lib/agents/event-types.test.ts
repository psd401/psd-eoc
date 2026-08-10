import { describe, expect, test } from 'bun:test';

import type {
  EventTypeMutationMetadata,
  EventTypeStore,
} from '../capabilities/event-types';
import {
  AtomicAgentEventTypeStore,
  type AgentEventTypeMutationUnitOfWork,
} from './event-types';

const IDS = Object.freeze({
  agent: '00000000-0000-4000-8000-000000000601',
  apiKey: '00000000-0000-4000-8000-000000000602',
  request: '00000000-0000-4000-8000-000000000603',
  user: '00000000-0000-4000-8000-000000000604',
  session: '00000000-0000-4000-8000-000000000605',
});

const NOW = new Date('2026-08-10T21:00:00.000Z');

function metadata(
  capabilityId: EventTypeMutationMetadata['capabilityId'],
): EventTypeMutationMetadata {
  return {
    actor: {
      kind: 'agent',
      agentId: IDS.agent,
      apiKeyId: IDS.apiKey,
    },
    capabilityId,
    idempotencyKey: `${capabilityId}-idempotency`,
    requestId: IDS.request,
    now: NOW,
  };
}

function unexpectedStore(): EventTypeStore {
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected event-type operation.');
  };
  return {
    list: unexpected,
    getVersion: unexpected,
    getDraft: unexpected,
    createDraft: unexpected,
    updateDraft: unexpected,
    publishVersion: unexpected,
  };
}

function harness(options: Readonly<{ auditFails?: boolean }> = {}) {
  const queryResult = {
    items: [],
    pageInfo: { hasMore: false, nextCursor: null },
  } as const;
  let committedMutations: string[] = [];
  const auditEvents: unknown[] = [];
  let transactions = 0;
  const queries: EventTypeStore = {
    ...unexpectedStore(),
    async list() {
      return queryResult;
    },
  };
  const unitOfWork: AgentEventTypeMutationUnitOfWork = {
    async transaction(operation) {
      transactions += 1;
      const staged = [...committedMutations];
      const eventTypes: EventTypeStore = {
        ...unexpectedStore(),
        async createDraft() {
          staged.push('create-event-type-draft');
          return { result: 'created' } as never;
        },
        async updateDraft() {
          staged.push('update-event-type-draft');
          return { result: 'updated' } as never;
        },
        async publishVersion() {
          staged.push('publish-event-type-version');
          return { result: 'published' } as never;
        },
      };
      const result = await operation({
        eventTypes,
        audit: {
          async append(event) {
            if (options.auditFails === true) {
              throw new Error('Synthetic security-audit outage.');
            }
            auditEvents.push(event);
          },
        },
      });
      committedMutations = staged;
      return result;
    },
  };
  return {
    store: new AtomicAgentEventTypeStore(queries, unitOfWork),
    queryResult,
    auditEvents,
    transactions: () => transactions,
    committedMutations: () => committedMutations,
  };
}

describe('atomic agent event-type adapter', () => {
  test('keeps reads on the canonical query store without a mutation transaction', async () => {
    const subject = harness();

    await expect(
      subject.store.list({
        templateMode: null,
        enabled: true,
        cursor: null,
        limit: 25,
      }),
    ).resolves.toBe(subject.queryResult);
    expect(subject.transactions()).toBe(0);
    expect(subject.auditEvents).toHaveLength(0);
  });

  test('commits each mutation only after its matching success audit is appended', async () => {
    for (const [capabilityId, method, expectedResult] of [
      ['create-event-type-draft', 'createDraft', 'created'],
      ['update-event-type-draft', 'updateDraft', 'updated'],
      ['publish-event-type-version', 'publishVersion', 'published'],
    ] as const) {
      const subject = harness();
      const output: unknown =
        method === 'createDraft'
          ? await subject.store.createDraft({} as never, metadata(capabilityId))
          : method === 'updateDraft'
            ? await subject.store.updateDraft(
                {} as never,
                metadata(capabilityId),
              )
            : await subject.store.publishVersion(
                {} as never,
                metadata(capabilityId),
              );

      expect(output).toEqual({ result: expectedResult });
      expect(subject.committedMutations()).toEqual([capabilityId]);
      expect(subject.auditEvents).toEqual([
        {
          category: 'agent-access',
          action: capabilityId,
          actionIds: [],
          confirmationId: null,
          outcome: 'success',
          actor: {
            kind: 'agent',
            agentId: IDS.agent,
            apiKeyId: IDS.apiKey,
          },
          source: 'agent-rest',
          facilityId: null,
          requestId: IDS.request,
          reasonCode: null,
          occurredAt: NOW,
        },
      ]);
    }
  });

  test('rolls back the canonical mutation when the audit append fails', async () => {
    const subject = harness({ auditFails: true });

    await expect(
      subject.store.createDraft(
        {} as never,
        metadata('create-event-type-draft'),
      ),
    ).rejects.toThrow('Synthetic security-audit outage.');
    expect(subject.committedMutations()).toEqual([]);
    expect(subject.auditEvents).toEqual([]);
  });

  test('rejects non-agent use before an unaudited mutation can commit', async () => {
    const subject = harness();
    const humanMetadata: EventTypeMutationMetadata = {
      ...metadata('create-event-type-draft'),
      actor: { kind: 'human', userId: IDS.user, sessionId: IDS.session },
    };

    await expect(
      subject.store.createDraft({} as never, humanMetadata),
    ).rejects.toThrow(
      'The agent event-type store requires an authenticated agent actor.',
    );
    expect(subject.committedMutations()).toEqual([]);
  });
});
