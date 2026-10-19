import { describe, expect, test } from 'bun:test';

import {
  isAgentGrantableCapabilityId,
  type AgentGrantableCapabilityId,
} from '@psd-eoc/contracts';

import {
  AgentRestGateway,
  type AgentCapabilityDispatcher,
  type AgentGatewayAuditEvent,
} from './gateway';
import { AgentApiKeyError, type AuthenticatedAgentApiKey } from './keys';
import {
  AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR,
  AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE,
} from './rate-limit';

const IDS = Object.freeze({
  agent: '00000000-0000-4000-8000-000000000701',
  apiKey: '00000000-0000-4000-8000-000000000702',
  otherAgent: '00000000-0000-4000-8000-000000000703',
  otherApiKey: '00000000-0000-4000-8000-000000000704',
  issuer: '00000000-0000-4000-8000-000000000705',
  facility: '00000000-0000-4000-8000-000000000706',
  event: '00000000-0000-4000-8000-000000000707',
  artifact: '00000000-0000-4000-8000-000000000708',
});

const CAPABILITY_IDS = Object.freeze([
  'list-active-events',
  'export-event-summary',
  'export-drill-records',
  'start-event',
] as const satisfies readonly AgentGrantableCapabilityId[]);

const CREDENTIALS = Object.freeze({
  first:
    'psd_eoc_agent_v1_abcdefghijkl.abcdefghijklmnopqrstuvwxyzABCDEFGHijklmno',
  second:
    'psd_eoc_agent_v1_mnopqrstuvwx.abcdefghijklmnopqrstuvwxyzABCDEFGHijklmno',
});

const SERVER_TIME = new Date('2026-10-18T18:00:00.000Z');

const PAGE = Object.freeze({
  items: [],
  pageInfo: { hasMore: false, nextCursor: null },
});

const EXPORT = Object.freeze({
  eventId: IDS.event,
  artifact: {
    id: IDS.artifact,
    format: 'pdf',
    contentType: 'application/pdf',
    fileName: 'event-summary.pdf',
    byteLength: 1_024,
    contentSha256: 'a'.repeat(64),
    rowCount: 0,
    downloadUrl: 'https://eoc.example.test/exports/event-summary.pdf',
    generatedAt: '2026-10-18T18:00:00.000Z',
    expiresAt: '2026-10-18T18:10:00.000Z',
  },
});

function authenticatedKey(
  agentId: string,
  apiKeyId: string,
  keyPrefix: string,
): AuthenticatedAgentApiKey {
  const facilityScope = { kind: 'district' as const };
  return Object.freeze({
    actor: { kind: 'agent' as const, agentId, apiKeyId },
    scope: { facilityScope },
    capabilityIds: CAPABILITY_IDS,
    key: {
      id: apiKeyId,
      agentId,
      displayName: 'Synthetic budget agent',
      facilityScope,
      capabilityIds: CAPABILITY_IDS,
      keyPrefix,
      issuedByUserId: IDS.issuer,
      issuedAt: '2026-08-10T18:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
    },
  });
}

const firstKey = authenticatedKey(IDS.agent, IDS.apiKey, 'abcdefghijkl');
const secondKey = authenticatedKey(
  IDS.otherAgent,
  IDS.otherApiKey,
  'mnopqrstuvwx',
);

interface Harness {
  readonly gateway: AgentRestGateway;
  readonly audits: AgentGatewayAuditEvent[];
  readonly dispatches: string[];
}

function harness(): Harness {
  const audits: AgentGatewayAuditEvent[] = [];
  const dispatches: string[] = [];
  const dispatcher: AgentCapabilityDispatcher = {
    auditOwnership: () => 'gateway',
    async execute(capabilityId) {
      dispatches.push(capabilityId);
      return capabilityId === 'export-event-summary' ? EXPORT : PAGE;
    },
  };
  const gateway = new AgentRestGateway({
    keys: {
      async authenticate(credential) {
        if (credential === CREDENTIALS.first) return firstKey;
        if (credential === CREDENTIALS.second) return secondKey;
        throw new AgentApiKeyError(
          'INVALID_CREDENTIAL',
          'The agent API key is invalid.',
        );
      },
      authorizeCapability(resolved, capabilityId) {
        if (
          !isAgentGrantableCapabilityId(capabilityId) ||
          !resolved.capabilityIds.includes(capabilityId)
        ) {
          throw new AgentApiKeyError(
            'CAPABILITY_NOT_GRANTED',
            'The agent API key does not grant this capability.',
          );
        }
        return capabilityId;
      },
    },
    dispatcher,
    audit: {
      async append(event) {
        audits.push(event);
      },
    },
  });
  return { gateway, audits, dispatches };
}

function requestId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function listRequest(credential: string, sequence: number, offsetMs = 0) {
  return {
    credential,
    capabilityId: 'list-active-events',
    input: { facilityId: null, cursor: null, limit: 25 },
    idempotencyKey: null,
    requestId: requestId(sequence),
    serverTime: new Date(SERVER_TIME.getTime() + offsetMs),
  };
}

function exportRequest(credential: string, sequence: number, offsetMs = 0) {
  return {
    credential,
    capabilityId: 'export-event-summary',
    input: { eventId: IDS.event, format: 'pdf' },
    idempotencyKey: null,
    requestId: requestId(sequence),
    serverTime: new Date(SERVER_TIME.getTime() + offsetMs),
  };
}

describe('agent gateway request budget', () => {
  test('refuses the request after the per-minute budget with 429, audits it, and never dispatches', async () => {
    const { gateway, audits, dispatches } = harness();

    for (
      let sequence = 1;
      sequence <= AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE;
      sequence += 1
    ) {
      await expect(
        gateway.execute(
          listRequest(CREDENTIALS.first, sequence, sequence * 10),
        ),
      ).resolves.toEqual(PAGE);
    }
    expect(dispatches).toHaveLength(AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE);
    expect(audits).toHaveLength(AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE);

    const refusedSequence = AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE + 1;
    await expect(
      gateway.execute(
        listRequest(CREDENTIALS.first, refusedSequence, refusedSequence * 10),
      ),
    ).rejects.toMatchObject({
      name: 'AgentGatewayRateLimitError',
      code: 'RATE_LIMITED',
      status: 429,
      retryable: true,
      reasonCode: 'RATE_LIMITED',
      retryAfterSeconds: 60,
    });

    expect(dispatches).toHaveLength(AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE);
    expect(audits).toHaveLength(refusedSequence);
    expect(audits.at(-1)).toMatchObject({
      category: 'access-denial',
      action: 'list-active-events',
      actionIds: [],
      outcome: 'denied',
      actor: { kind: 'agent', agentId: IDS.agent, apiKeyId: IDS.apiKey },
      source: 'agent-rest',
      requestId: requestId(refusedSequence),
      reasonCode: 'RATE_LIMITED',
    });
  });

  test('audits one RATE_LIMITED fact per lockout, however many requests are refused', async () => {
    const { gateway, audits, dispatches } = harness();
    for (
      let sequence = 1;
      sequence <= AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE;
      sequence += 1
    ) {
      await gateway.authorize(listRequest(CREDENTIALS.first, sequence));
    }
    expect(audits).toEqual([]);

    for (let sequence = 61; sequence <= 100; sequence += 1) {
      await expect(
        gateway.authorize(listRequest(CREDENTIALS.first, sequence)),
      ).rejects.toMatchObject({ status: 429 });
    }
    expect(audits).toEqual([
      expect.objectContaining({
        reasonCode: 'RATE_LIMITED',
        requestId: requestId(61),
      }),
    ]);

    // After the window, admissions resume and a later lockout is a new fact.
    for (
      let sequence = 101;
      sequence <= 100 + AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE;
      sequence += 1
    ) {
      await gateway.authorize(listRequest(CREDENTIALS.first, sequence, 60_000));
    }
    await expect(
      gateway.authorize(listRequest(CREDENTIALS.first, 161, 60_000)),
    ).rejects.toMatchObject({ status: 429 });
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({
      reasonCode: 'RATE_LIMITED',
      requestId: requestId(161),
    });
    expect(dispatches).toEqual([]);
  });

  test('caps exports per hour at dispatch for one key while another key is still admitted', async () => {
    const { gateway, audits, dispatches } = harness();

    // Two minutes apart, so only the hourly budget can be the reason.
    for (
      let sequence = 1;
      sequence <= AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR;
      sequence += 1
    ) {
      await expect(
        gateway.execute(
          exportRequest(CREDENTIALS.first, sequence, sequence * 120_000),
        ),
      ).resolves.toEqual(EXPORT);
    }
    expect(dispatches).toHaveLength(AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR);

    const refusedSequence = AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR + 1;
    await expect(
      gateway.execute(
        exportRequest(
          CREDENTIALS.first,
          refusedSequence,
          refusedSequence * 120_000,
        ),
      ),
    ).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      window: 'per-hour',
    });
    expect(dispatches).toHaveLength(AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR);
    expect(audits).toHaveLength(refusedSequence);
    expect(audits.at(-1)).toMatchObject({
      category: 'access-denial',
      action: 'export-event-summary',
      outcome: 'denied',
      actor: firstKey.actor,
      requestId: requestId(refusedSequence),
      reasonCode: 'RATE_LIMITED',
    });

    // The other costly capability shares the same hourly budget for that
    // key, and a repeated refusal inside the lockout adds no audit row.
    await expect(
      gateway.execute({
        credential: CREDENTIALS.first,
        capabilityId: 'export-drill-records',
        input: {
          facilityId: IDS.facility,
          eventTypeId: null,
          startedFrom: '2026-10-01T00:00:00.000Z',
          startedThrough: '2026-10-18T00:00:00.000Z',
          format: 'csv',
        },
        idempotencyKey: null,
        requestId: requestId(refusedSequence + 1),
        serverTime: new Date(
          SERVER_TIME.getTime() + (refusedSequence + 1) * 120_000,
        ),
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(dispatches).toHaveLength(AGENT_RATE_LIMIT_COSTLY_REQUESTS_PER_HOUR);
    expect(audits).toHaveLength(refusedSequence);

    // A different key is unaffected, and the exhausted key may still read.
    await expect(
      gateway.execute(
        exportRequest(
          CREDENTIALS.second,
          refusedSequence + 2,
          (refusedSequence + 2) * 120_000,
        ),
      ),
    ).resolves.toEqual(EXPORT);
    await expect(
      gateway.execute(
        listRequest(
          CREDENTIALS.first,
          refusedSequence + 3,
          (refusedSequence + 3) * 120_000,
        ),
      ),
    ).resolves.toEqual(PAGE);
    expect(dispatches.slice(-2)).toEqual([
      'export-event-summary',
      'list-active-events',
    ]);
    expect(audits).toHaveLength(refusedSequence + 2);
    expect(
      audits.filter((audit) => audit.reasonCode === 'RATE_LIMITED'),
    ).toHaveLength(1);
  });

  test('does not charge the hourly budget at authorization', async () => {
    const { gateway, dispatches } = harness();
    for (let sequence = 1; sequence <= 50; sequence += 1) {
      await expect(
        gateway.authorize(exportRequest(CREDENTIALS.first, sequence)),
      ).resolves.toMatchObject({ capabilityId: 'export-event-summary' });
    }
    await expect(
      gateway.execute(exportRequest(CREDENTIALS.first, 51)),
    ).resolves.toEqual(EXPORT);
    expect(dispatches).toEqual(['export-event-summary']);
  });

  test('bounds protected-action attempts with the same budget without losing their signal', async () => {
    const { gateway, audits, dispatches } = harness();
    const protectedRequest = (sequence: number) => ({
      credential: CREDENTIALS.first,
      capabilityId: 'start-real-incident',
      requestId: requestId(sequence),
      serverTime: SERVER_TIME,
    });

    // Within budget every attempt is recorded as a human-only rejection.
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      await expect(
        gateway.authorize(protectedRequest(sequence)),
      ).rejects.toMatchObject({
        status: 403,
        reasonCode: 'HUMAN_ONLY_REQUIRED',
      });
    }
    expect(audits).toHaveLength(3);
    expect(audits[2]).toMatchObject({
      category: 'human-only-rejection',
      actionIds: ['start-real-incident'],
      reasonCode: 'HUMAN_ONLY_REQUIRED',
    });

    // Those attempts spent budget like any other request.
    for (
      let sequence = 4;
      sequence <= AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE;
      sequence += 1
    ) {
      await gateway.authorize(listRequest(CREDENTIALS.first, sequence));
    }
    await expect(
      gateway.authorize(
        listRequest(
          CREDENTIALS.first,
          AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE + 1,
        ),
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(audits).toHaveLength(4);
    expect(audits[3]).toMatchObject({
      category: 'access-denial',
      actionIds: [],
      reasonCode: 'RATE_LIMITED',
    });

    // Past budget a protected-action attempt is refused, and even after a
    // read was refused first, the lockout still records one fact naming it.
    for (let sequence = 62; sequence <= 70; sequence += 1) {
      await expect(
        gateway.authorize(protectedRequest(sequence)),
      ).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    }
    expect(audits).toHaveLength(5);
    expect(audits[4]).toMatchObject({
      category: 'human-only-rejection',
      action: 'start-event',
      actionIds: ['start-real-incident'],
      outcome: 'denied',
      requestId: requestId(62),
      reasonCode: 'RATE_LIMITED',
    });
    expect(dispatches).toEqual([]);
  });

  test('does not spend a key budget on an invalid credential', async () => {
    const { gateway } = harness();
    for (let sequence = 1; sequence <= 70; sequence += 1) {
      await expect(
        gateway.authorize({
          credential: 'psd_eoc_agent_v1_zzzzzzzzzzzz.' + 'z'.repeat(43),
          capabilityId: 'list-active-events',
          requestId: requestId(sequence),
          serverTime: SERVER_TIME,
        }),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      gateway.authorize(listRequest(CREDENTIALS.first, 71)),
    ).resolves.toMatchObject({ authenticated: firstKey });
  });
});
