import { describe, expect, test } from 'bun:test';

import {
  HUMAN_ONLY_ACTION_IDS,
  type SecurityAuditEntry,
} from '@psd-eoc/contracts';

import { buildSecurityAuditEntry } from './entry';
import {
  isHumanOnlyAgentForbiddenError,
  rejectHumanOnlyAgentCapability,
} from './human-only';
import type { SecurityAuditWriter } from './writer';

const capabilityByAction = {
  'start-real-incident': 'start-event',
  'send-real-notification': 'start-event',
  'all-clear': 'all-clear-event',
  'close-real-event': 'close-event',
} as const;

function memoryWriter(entries: SecurityAuditEntry[]): SecurityAuditWriter {
  return {
    async append(fact) {
      const entry = buildSecurityAuditEntry(fact, entries.at(-1) ?? null);
      entries.push(entry);
      return entry;
    },
  };
}

describe('human-only agent rejection audit', () => {
  test('appends a minimized denial before every helper-produced 403', async () => {
    const entries: SecurityAuditEntry[] = [];
    const writer = memoryWriter(entries);

    for (const [index, actionId] of HUMAN_ONLY_ACTION_IDS.entries()) {
      const requestId = `00000000-0000-4000-8000-${String(index + 1).padStart(
        12,
        '0',
      )}`;
      try {
        await rejectHumanOnlyAgentCapability(writer, {
          actor: {
            kind: 'agent',
            agentId: '00000000-0000-4000-8000-000000000401',
            apiKeyId: '00000000-0000-4000-8000-000000000402',
          },
          source: index % 2 === 0 ? 'agent-rest' : 'mcp',
          capabilityId: capabilityByAction[actionId],
          actionIds: [actionId],
          facilityId: '00000000-0000-4000-8000-000000000403',
          requestId,
          occurredAt: `2026-08-08T12:00:0${index}.000Z`,
        });
        throw new Error('Expected the human-only boundary to reject.');
      } catch (error) {
        expect(isHumanOnlyAgentForbiddenError(error)).toBe(true);
        if (!isHumanOnlyAgentForbiddenError(error)) {
          throw error;
        }
        expect(error.status).toBe(403);
        expect(error.requestId).toBe(requestId);
        expect(entries).toHaveLength(index + 1);
        expect(entries.at(-1)).toMatchObject({
          category: 'human-only-rejection',
          action: capabilityByAction[actionId],
          actionIds: [actionId],
          confirmationId: null,
          outcome: 'denied',
          requestId,
          reasonCode: 'HUMAN_ONLY_ACTION_REQUIRES_HUMAN',
        });
      }
    }

    expect(
      entries.every(
        (entry) =>
          entry.principal.kind === 'agent' &&
          (entry.source === 'agent-rest' || entry.source === 'mcp'),
      ),
    ).toBe(true);
  });

  test('records every protected action in a multi-action rejection', async () => {
    const entries: SecurityAuditEntry[] = [];
    const requestId = '00000000-0000-4000-8000-000000000409';

    let rejection: unknown;
    try {
      await rejectHumanOnlyAgentCapability(memoryWriter(entries), {
        actor: {
          kind: 'agent',
          agentId: '00000000-0000-4000-8000-000000000401',
          apiKeyId: '00000000-0000-4000-8000-000000000402',
        },
        source: 'agent-rest',
        capabilityId: 'start-event',
        actionIds: ['start-real-incident', 'send-real-notification'],
        facilityId: '00000000-0000-4000-8000-000000000403',
        requestId,
        occurredAt: '2026-08-08T12:00:05.000Z',
      });
    } catch (error) {
      rejection = error;
    }
    expect(isHumanOnlyAgentForbiddenError(rejection)).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      requestId,
      action: 'start-event',
      actionIds: ['start-real-incident', 'send-real-notification'],
      outcome: 'denied',
    });
  });

  test('fails closed without returning an unaudited 403 when storage fails', async () => {
    const storageError = new Error('synthetic append failure');
    const writer: SecurityAuditWriter = {
      append: () => Promise.reject(storageError),
    };
    const rejection = rejectHumanOnlyAgentCapability(writer, {
      actor: {
        kind: 'agent',
        agentId: '00000000-0000-4000-8000-000000000411',
        apiKeyId: '00000000-0000-4000-8000-000000000412',
      },
      source: 'agent-rest',
      capabilityId: 'close-event',
      actionIds: ['close-real-event'],
      facilityId: null,
      requestId: '00000000-0000-4000-8000-000000000413',
      occurredAt: '2026-08-08T12:01:00.000Z',
    });

    await expect(rejection).rejects.toBe(storageError);
  });
});
