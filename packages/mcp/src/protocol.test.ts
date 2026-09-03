import { describe, expect, test } from 'bun:test';
import { HUMAN_ONLY_ACTION_IDS } from '@psd-eoc/contracts';

import { AgentApiClient } from './agent-client';
import { MCP_TOOLS } from './manifest';
import { MCP_MODERN_PROTOCOL_VERSION, PsdEocMcpProtocol } from './protocol';

const IDS = Object.freeze({
  facility: '20000000-0000-4000-8000-000000000001',
  request: '20000000-0000-4000-8000-000000000002',
  event: '20000000-0000-4000-8000-000000000003',
  eventType: '20000000-0000-4000-8000-000000000004',
  eventTypeVersion: '20000000-0000-4000-8000-000000000005',
  draft: '20000000-0000-4000-8000-000000000006',
  agent: '20000000-0000-4000-8000-000000000007',
  apiKey: '20000000-0000-4000-8000-000000000008',
  deliveryTestReport: '20000000-0000-4000-8000-000000000009',
  deliveryTestRun: '20000000-0000-4000-8000-000000000010',
});
const PAGE = Object.freeze({
  items: Object.freeze([]),
  pageInfo: Object.freeze({ nextCursor: null, hasMore: false }),
});

const DELIVERY_TEST_REPORT_PAGE = Object.freeze({
  items: Object.freeze([
    Object.freeze({
      id: IDS.deliveryTestReport,
      runId: IDS.deliveryTestRun,
      sequence: 1,
      supersedesReportId: null,
      status: 'incomplete',
      channels: Object.freeze([
        Object.freeze({
          channel: 'push',
          endpointCount: 1,
          activationToProviderAcceptMs: 125,
          latestStateCounts: Object.freeze([
            Object.freeze({ state: 'provider-accepted', count: 1 }),
          ]),
          completedAt: '2026-08-12T17:00:01.000Z',
        }),
        Object.freeze({
          channel: 'email',
          endpointCount: 1,
          activationToProviderAcceptMs: null,
          latestStateCounts: Object.freeze([
            Object.freeze({ state: 'unknown', count: 1 }),
          ]),
          completedAt: null,
        }),
      ]),
      generatedAt: '2026-08-12T17:00:03.000Z',
      finalizedBy: Object.freeze({
        kind: 'system',
        serviceId: 'delivery-test-reporter',
      }),
      source: 'worker',
      reasonCode: 'EVIDENCE_INCOMPLETE',
    }),
  ]),
  pageInfo: Object.freeze({ nextCursor: null, hasMore: false }),
});

function recordsExport(format: 'csv' | 'pdf', id: string) {
  return {
    id,
    format,
    contentType:
      format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
    fileName: `records-${id}.${format}`,
    byteLength: 128,
    contentSha256: (format === 'csv' ? 'c' : 'd').repeat(64),
    rowCount: 1,
    downloadUrl: `https://exports.example.test/${id}.${format}`,
    generatedAt: '2026-08-11T16:00:00.000Z',
    expiresAt: '2026-08-11T16:10:00.000Z',
  };
}

function templateSet(purpose: 'activation' | 'all-clear' | 'reactivation') {
  return {
    templateMode: 'drill' as const,
    purpose,
    push: {
      channel: 'push' as const,
      templateMode: 'drill' as const,
      purpose,
      classificationMarker: 'DRILL' as const,
      title: `${purpose} at {{site}}`,
      body: `${purpose} at {{site}}.`,
    },
    email: {
      channel: 'email' as const,
      templateMode: 'drill' as const,
      purpose,
      classificationMarker: 'DRILL' as const,
      subject: `${purpose} at {{site}}`,
      textBody: `${purpose} at {{site}}.`,
    },
    sms: {
      channel: 'sms' as const,
      templateMode: 'drill' as const,
      purpose,
      classificationMarker: 'DRILL' as const,
      body: `${purpose} at {{site}}.`,
    },
  };
}

function realTemplateSet(purpose: 'activation' | 'all-clear' | 'reactivation') {
  return {
    templateMode: 'real' as const,
    purpose,
    push: {
      channel: 'push' as const,
      templateMode: 'real' as const,
      purpose,
      classificationMarker: 'INCIDENT' as const,
      title: `${purpose} at {{site}}`,
      body: `${purpose} at {{site}}.`,
    },
    email: {
      channel: 'email' as const,
      templateMode: 'real' as const,
      purpose,
      classificationMarker: 'INCIDENT' as const,
      subject: `${purpose} at {{site}}`,
      textBody: `${purpose} at {{site}}.`,
    },
    sms: {
      channel: 'sms' as const,
      templateMode: 'real' as const,
      purpose,
      classificationMarker: 'INCIDENT' as const,
      body: `${purpose} at {{site}}.`,
    },
  };
}

const TEMPLATES = Object.freeze({
  activation: templateSet('activation'),
  'all-clear': templateSet('all-clear'),
  reactivation: templateSet('reactivation'),
});

const REAL_TEMPLATES = Object.freeze({
  activation: realTemplateSet('activation'),
  'all-clear': realTemplateSet('all-clear'),
  reactivation: realTemplateSet('reactivation'),
});

function draft(revision: string, name: string) {
  return {
    id: IDS.draft,
    eventTypeId: IDS.eventType,
    status: 'draft' as const,
    templateMode: 'drill' as const,
    name,
    description: null,
    baseVersionId: IDS.eventTypeVersion,
    enabled: true,
    templates: TEMPLATES,
    draftedBy: {
      kind: 'agent' as const,
      agentId: IDS.agent,
      apiKeyId: IDS.apiKey,
    },
    draftRevision: revision,
    createdAt: '2026-08-11T16:00:00.000Z',
  };
}

function publishedVersion() {
  return {
    id: IDS.eventTypeVersion,
    eventTypeId: IDS.eventType,
    version: 1,
    templateMode: 'drill' as const,
    name: 'Lockdown Drill',
    description: 'Synthetic drill template',
    enabled: true,
    templates: TEMPLATES,
    supersedesVersionId: null,
    createdBy: {
      kind: 'agent' as const,
      agentId: IDS.agent,
      apiKeyId: IDS.apiKey,
    },
    publicationAuthorization: {
      kind: 'agent-configuration' as const,
      agentId: IDS.agent,
      apiKeyId: IDS.apiKey,
      authorizationReference: 'authorized-template-publication',
    },
    createdAt: '2026-08-11T15:00:00.000Z',
  };
}

function realDraft(revision: string) {
  return {
    ...draft(revision, 'Lockdown'),
    templateMode: 'real' as const,
    templates: REAL_TEMPLATES,
  };
}

function realPublishedVersion() {
  return {
    ...publishedVersion(),
    templateMode: 'real' as const,
    name: 'Lockdown',
    description: 'Real incident template',
    templates: REAL_TEMPLATES,
  };
}

function currentMeta(
  clientInfo: unknown = { name: 'test-client', version: '1' },
) {
  return {
    'io.modelcontextprotocol/protocolVersion': MCP_MODERN_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
    ...(clientInfo === undefined
      ? {}
      : { 'io.modelcontextprotocol/clientInfo': clientInfo }),
  };
}

function request(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: { ...params, _meta: currentMeta() },
  };
}

function protocolWithFetch(
  implementation: (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => Promise<Response> = async () => Response.json(PAGE),
) {
  return new PsdEocMcpProtocol(
    new AgentApiClient(
      {
        baseUrl: 'https://eoc.example.test/api/agent/v1',
        apiKey: 'safe-test-key',
      },
      { fetch: implementation as unknown as typeof fetch },
    ),
  );
}

describe('MCP lifecycle and discovery', () => {
  test('negotiates initialization-based clients', async () => {
    const result = await protocolWithFetch().handle({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'legacy-test', version: '1' },
      },
    });
    expect(result).toMatchObject({
      jsonrpc: '2.0',
      id: 'init',
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {}, resources: {} },
      },
    });
  });

  test('implements modern discovery and accepts omitted optional clientInfo', async () => {
    const result = await protocolWithFetch().handle({
      jsonrpc: '2.0',
      id: 'discover',
      method: 'server/discover',
      params: { _meta: currentMeta(undefined) },
    });
    expect(result).toMatchObject({
      id: 'discover',
      result: {
        resultType: 'complete',
        supportedVersions: expect.arrayContaining(['2026-07-28', '2025-06-18']),
        cacheScope: 'private',
      },
    });
  });

  test('rejects missing required modern metadata and malformed optional identity', async () => {
    const missingCapabilities = await protocolWithFetch().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion':
            MCP_MODERN_PROTOCOL_VERSION,
        },
      },
    });
    expect(missingCapabilities).toMatchObject({
      error: { code: -32602, message: 'Invalid params' },
    });

    const badClientInfo = await protocolWithFetch().handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'server/discover',
      params: { _meta: currentMeta({ name: '', version: '1' }) },
    });
    expect(badClientInfo).toMatchObject({ error: { code: -32602 } });
  });

  test('rejects conflicting transport and request protocol versions', async () => {
    const result = await protocolWithFetch().handle(request('tools/list'), {
      protocolVersion: '2025-06-18',
    });

    expect(result).toMatchObject({
      id: 1,
      error: {
        code: -32022,
        message: 'Protocol version mismatch',
        data: {
          requested: MCP_MODERN_PROTOCOL_VERSION,
          transport: '2025-06-18',
          supported: expect.arrayContaining(['2025-06-18']),
        },
      },
    });
  });
});

describe('MCP tools', () => {
  test('lists only the fixed safe catalog with modern cache hints', async () => {
    const result = await protocolWithFetch().handle(request('tools/list'));
    expect(result).toMatchObject({
      result: {
        resultType: 'complete',
        tools: MCP_TOOLS,
        ttlMs: 300_000,
        cacheScope: 'public',
      },
    });
    const serialized = JSON.stringify(result);
    for (const actionId of HUMAN_ONLY_ACTION_IDS) {
      expect(serialized).not.toContain(actionId);
    }
    for (const protectedWorkflowId of [
      'create-delivery-test-target-set-version',
      'create-delivery-test-preview',
      'finalize-delivery-test-report',
    ]) {
      expect(MCP_TOOLS.map(({ name }) => name)).not.toContain(
        protectedWorkflowId,
      );
    }
    expect(
      MCP_TOOLS.find((tool) => tool.name === 'create-activation-preview')
        ?.annotations.readOnlyHint,
    ).toBe(false);
    expect(
      MCP_TOOLS.find((tool) => tool.name === 'prepare-activation')?.description,
    ).toContain('authenticated human');
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'list-event-types',
        'get-event-type-version',
        'export-drill-records',
        'export-event-summary',
        'list-delivery-test-reports',
      ]),
    );
    const deliveryTestReports = MCP_TOOLS.find(
      (tool) => tool.name === 'list-delivery-test-reports',
    );
    expect(deliveryTestReports?.description).toContain('destination-free');
    expect(deliveryTestReports?.description).toContain('unknown');
    expect(deliveryTestReports?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const capabilityId of [
      'export-drill-records',
      'export-event-summary',
    ] as const) {
      const tool = MCP_TOOLS.find(({ name }) => name === capabilityId);
      expect(tool?.description).toContain('private, short-lived');
      expect(tool?.description).toContain('compliance determination');
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
  });

  test('returns drill record evidence with site, date/time, and type', async () => {
    const drillPage = {
      items: [
        {
          id: IDS.event,
          eventId: IDS.event,
          facilityId: IDS.facility,
          kind: 'drill',
          eventTypeVersion: {
            id: IDS.eventTypeVersion,
            templateMode: 'drill',
          },
          eventTypeName: 'Lockdown Drill',
          threatName: 'Synthetic wildlife',
          threatDetail: null,
          responseDetail: null,
          status: 'closed',
          startedAt: '2026-08-11T16:00:00.000Z',
          allClearAt: '2026-08-11T16:10:00.000Z',
          reactivatedAt: null,
          closedAt: '2026-08-11T16:11:00.000Z',
        },
      ],
      pageInfo: { nextCursor: null, hasMore: false },
    };
    const protocol = protocolWithFetch(async () => Response.json(drillPage));
    const result = await protocol.handle(
      request('tools/call', {
        name: 'list-drill-records',
        arguments: {
          facilityId: IDS.facility,
          eventTypeId: null,
          startedFrom: null,
          startedThrough: null,
          cursor: null,
          limit: 20,
        },
      }),
    );
    expect(result).toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          items: [
            {
              facilityId: IDS.facility,
              startedAt: '2026-08-11T16:00:00.000Z',
              eventTypeName: 'Lockdown Drill',
            },
          ],
        },
      },
    });
  });

  test('routes destination-free delivery-test report reads through the canonical capability', async () => {
    let captured:
      | Readonly<{ url: string; headers: Headers; body: unknown }>
      | undefined;
    const protocol = protocolWithFetch(async (input, init = {}) => {
      captured = Object.freeze({
        url: String(input),
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)) as unknown,
      });
      return Response.json(DELIVERY_TEST_REPORT_PAGE);
    });
    const input = {
      facilityId: IDS.facility,
      status: 'incomplete',
      generatedFrom: null,
      generatedThrough: null,
      cursor: null,
      limit: 20,
    } as const;

    const result = await protocol.handle(
      request('tools/call', {
        name: 'list-delivery-test-reports',
        arguments: input,
      }),
    );

    expect(result).toMatchObject({
      result: {
        isError: false,
        structuredContent: DELIVERY_TEST_REPORT_PAGE,
      },
    });
    expect(captured).toMatchObject({
      url: 'https://eoc.example.test/api/agent/v1/capabilities/list-delivery-test-reports',
      body: input,
    });
    expect(captured?.headers.has('idempotency-key')).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /recipientId|endpointId|phoneNumber|emailAddress|token|destination/u,
    );
    for (const actionId of HUMAN_ONLY_ACTION_IDS) {
      expect(serialized).not.toContain(actionId);
    }
  });

  test('routes both private export tools through their canonical agent API capabilities', async () => {
    const calls: Array<{
      readonly url: string;
      readonly method: string | undefined;
      readonly headers: Headers;
      readonly body: unknown;
    }> = [];
    const drillArtifact = recordsExport('csv', IDS.request);
    const eventArtifact = recordsExport('pdf', IDS.apiKey);
    const protocol = protocolWithFetch(async (input, init = {}) => {
      const url = String(input);
      calls.push({
        url,
        method: init.method,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)) as unknown,
      });
      return Response.json(
        url.endsWith('/export-drill-records')
          ? drillArtifact
          : { eventId: IDS.event, artifact: eventArtifact },
      );
    });
    const drillInput = {
      facilityId: IDS.facility,
      eventTypeId: null,
      startedFrom: '2026-08-01T07:00:00.000Z',
      startedThrough: '2026-08-12T06:59:59.999Z',
      format: 'csv',
    };
    const eventInput = { eventId: IDS.event, format: 'pdf' };

    const drillResult = await protocol.handle(
      request('tools/call', {
        name: 'export-drill-records',
        arguments: drillInput,
      }),
    );
    const eventResult = await protocol.handle(
      request('tools/call', {
        name: 'export-event-summary',
        arguments: eventInput,
      }),
    );

    expect(drillResult).toMatchObject({
      result: {
        isError: false,
        structuredContent: drillArtifact,
      },
    });
    expect(eventResult).toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          eventId: IDS.event,
          artifact: eventArtifact,
        },
      },
    });
    expect(
      calls.map(({ url, method, headers, body }) => ({
        url,
        method,
        hasIdempotencyKey: headers.has('idempotency-key'),
        body,
      })),
    ).toEqual([
      {
        url: 'https://eoc.example.test/api/agent/v1/capabilities/export-drill-records',
        method: 'POST',
        hasIdempotencyKey: false,
        body: drillInput,
      },
      {
        url: 'https://eoc.example.test/api/agent/v1/capabilities/export-event-summary',
        method: 'POST',
        hasIdempotencyKey: false,
        body: eventInput,
      },
    ]);
    const serializedTools = JSON.stringify(
      MCP_TOOLS.filter(({ name }) =>
        ['export-drill-records', 'export-event-summary'].includes(name),
      ),
    );
    for (const actionId of HUMAN_ONLY_ACTION_IDS) {
      expect(serializedTools).not.toContain(actionId);
    }
  });

  test('creates and updates a safe unpublished message draft facade', async () => {
    const firstRevision = 'a'.repeat(64);
    const secondRevision = 'b'.repeat(64);
    const calls: Array<{
      readonly url: string;
      readonly headers: Headers;
      readonly body: unknown;
    }> = [];
    const protocol = protocolWithFetch(async (input, init = {}) => {
      const url = String(input);
      calls.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)) as unknown,
      });
      if (url.endsWith('/get-event-type-version')) {
        return Response.json(publishedVersion());
      }
      if (url.endsWith('/create-event-type-draft')) {
        return Response.json(draft(firstRevision, 'Lockdown Drill'));
      }
      if (url.endsWith('/get-event-type-draft')) {
        return Response.json(draft(firstRevision, 'Lockdown Drill'));
      }
      return Response.json(draft(secondRevision, 'Lockdown Drill'));
    });
    const created = await protocol.handle(
      request('tools/call', {
        name: 'draft-message-template-revision',
        arguments: {
          source: {
            kind: 'published-version',
            baseVersionId: IDS.eventTypeVersion,
          },
          phase: 'resolution',
          wording: {
            channel: 'push',
            title: 'Resolved at {{site}}',
            body: 'The drill at {{site}} is resolved.',
          },
        },
      }),
    );
    expect(created).toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          draftRevision: firstRevision,
          changedPhase: 'resolution',
          changedChannel: 'push',
        },
      },
    });
    expect(calls[1]?.headers.has('idempotency-key')).toBe(true);
    expect(calls[1]?.body).toMatchObject({
      target: {
        kind: 'existing-event-type',
        eventTypeId: IDS.eventType,
        baseVersionId: IDS.eventTypeVersion,
      },
      name: 'Lockdown Drill',
      description: 'Synthetic drill template',
      enabled: true,
      templates: {
        activation: TEMPLATES.activation,
        'all-clear': {
          templateMode: 'drill',
          purpose: 'all-clear',
          push: {
            templateMode: 'drill',
            purpose: 'all-clear',
            classificationMarker: 'DRILL',
            title: 'Resolved at {{site}}',
            body: 'The drill at {{site}} is resolved.',
          },
        },
      },
    });

    const updated = await protocol.handle(
      request('tools/call', {
        name: 'draft-message-template-revision',
        arguments: {
          source: {
            kind: 'existing-draft',
            draftId: IDS.draft,
            expectedDraftRevision: firstRevision,
          },
          phase: 'activation',
          wording: {
            channel: 'email',
            subject: 'Updated drill at {{site}}',
            textBody: 'Updated drill instructions for {{site}}.',
          },
        },
      }),
    );
    expect(updated).toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          draftRevision: secondRevision,
          changedPhase: 'activation',
          changedChannel: 'email',
        },
      },
    });
    expect(calls[3]?.headers.has('idempotency-key')).toBe(true);
    expect(calls[3]?.body).toMatchObject({
      draftId: IDS.draft,
      expectedDraftRevision: firstRevision,
      name: 'Lockdown Drill',
      enabled: true,
      templates: {
        activation: {
          templateMode: 'drill',
          purpose: 'activation',
          email: {
            templateMode: 'drill',
            purpose: 'activation',
            classificationMarker: 'DRILL',
            subject: 'Updated drill at {{site}}',
            textBody: 'Updated drill instructions for {{site}}.',
          },
        },
        reactivation: TEMPLATES.reactivation,
      },
    });
    expect(secondRevision).not.toBe(firstRevision);
  });

  test('preserves real mode, INCIDENT classification, and lifecycle purpose in facade drafts', async () => {
    const revision = 'c'.repeat(64);
    const calls: Array<{ readonly url: string; readonly body: unknown }> = [];
    const protocol = protocolWithFetch(async (input, init = {}) => {
      const url = String(input);
      calls.push({
        url,
        body: JSON.parse(String(init.body)) as unknown,
      });
      return Response.json(
        url.endsWith('/get-event-type-version')
          ? realPublishedVersion()
          : realDraft(revision),
      );
    });

    const result = await protocol.handle(
      request('tools/call', {
        name: 'draft-message-template-revision',
        arguments: {
          source: {
            kind: 'published-version',
            baseVersionId: IDS.eventTypeVersion,
          },
          phase: 'activation',
          wording: {
            channel: 'sms',
            body: 'Incident instructions for {{site}}.',
          },
        },
      }),
    );

    expect(result).toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          templateMode: 'real',
          changedPhase: 'activation',
          changedChannel: 'sms',
        },
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({
      name: 'Lockdown',
      description: 'Real incident template',
      templates: {
        activation: {
          templateMode: 'real',
          purpose: 'activation',
          push: REAL_TEMPLATES.activation.push,
          sms: {
            templateMode: 'real',
            purpose: 'activation',
            classificationMarker: 'INCIDENT',
            body: 'Incident instructions for {{site}}.',
          },
        },
        'all-clear': REAL_TEMPLATES['all-clear'],
        reactivation: REAL_TEMPLATES.reactivation,
      },
    });

    let rejectedCalls = 0;
    const rejectingProtocol = protocolWithFetch(async () => {
      rejectedCalls += 1;
      return Response.json(realPublishedVersion());
    });
    const rejected = await rejectingProtocol.handle(
      request('tools/call', {
        name: 'draft-message-template-revision',
        arguments: {
          source: {
            kind: 'published-version',
            baseVersionId: IDS.eventTypeVersion,
          },
          phase: 'activation',
          wording: {
            channel: 'sms',
            body: 'Incident instructions for {{site}}.',
            templateMode: 'drill',
            classificationMarker: 'DRILL',
            purpose: 'reactivation',
          },
        },
      }),
    );
    expect(rejected).toMatchObject({ error: { code: -32602 } });
    expect(rejectedCalls).toBe(0);
  });

  test('calls the scoped REST adapter and returns compatible text plus structured data', async () => {
    let calls = 0;
    const protocol = protocolWithFetch(async () => {
      calls += 1;
      return Response.json(PAGE);
    });
    const result = await protocol.handle(
      request('tools/call', {
        name: 'list-active-events',
        arguments: {
          facilityId: IDS.facility,
          cursor: null,
          limit: 10,
        },
      }),
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      result: {
        resultType: 'complete',
        content: [{ type: 'text', text: JSON.stringify(PAGE) }],
        structuredContent: PAGE,
        isError: false,
      },
    });
  });

  test('never routes unknown or protected names to fetch', async () => {
    let calls = 0;
    const protocol = protocolWithFetch(async () => {
      calls += 1;
      return Response.json(PAGE);
    });
    for (const name of ['anything-at-all', ...HUMAN_ONLY_ACTION_IDS]) {
      const result = await protocol.handle(
        request('tools/call', { name, arguments: {} }),
      );
      expect(result).toMatchObject({ error: { code: -32602 } });
      expect(JSON.stringify(result)).not.toContain(name);
    }
    expect(calls).toBe(0);
  });

  test('returns informative scope-safe tool errors', async () => {
    const hidden = 'hidden-facility-record';
    const protocol = protocolWithFetch(async () =>
      Promise.resolve(
        Response.json(
          {
            code: 'FORBIDDEN',
            message: hidden,
            requestId: IDS.request,
            retryable: false,
            fieldErrors: [],
          },
          { status: 403 },
        ),
      ),
    );
    const result = await protocol.handle(
      request('tools/call', {
        name: 'list-active-events',
        arguments: { facilityId: null, cursor: null, limit: 10 },
      }),
    );
    expect(result).toMatchObject({
      result: {
        resultType: 'complete',
        isError: true,
        structuredContent: {
          error: { code: 'FORBIDDEN', retryable: false },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(hidden);
  });

  test('rejects invalid canonical arguments before fetch', async () => {
    let calls = 0;
    const protocol = protocolWithFetch(async () => {
      calls += 1;
      return Response.json(PAGE);
    });
    const result = await protocol.handle(
      request('tools/call', {
        name: 'list-active-events',
        arguments: { facilityId: null, cursor: null, limit: 0 },
      }),
    );
    expect(result).toMatchObject({
      error: { code: -32602, data: { details: expect.any(Array) } },
    });
    expect(calls).toBe(0);
  });
});

describe('MCP resources', () => {
  test('lists and reads only current documentation resources', async () => {
    const protocol = protocolWithFetch();
    const listed = await protocol.handle(request('resources/list'));
    expect(listed).toMatchObject({
      result: {
        resultType: 'complete',
        ttlMs: 300_000,
        cacheScope: 'public',
        resources: [
          {
            uri: 'psd-eoc://docs/architecture',
            mimeType: 'text/markdown',
          },
          {
            uri: 'psd-eoc://docs/readiness',
            mimeType: 'text/markdown',
          },
        ],
      },
    });
    for (const [uri, heading] of [
      ['psd-eoc://docs/architecture', '# Architecture and contributing'],
      ['psd-eoc://docs/readiness', '# Operational readiness register'],
    ] as const) {
      const read = await protocol.handle(request('resources/read', { uri }));
      expect(read).toMatchObject({
        result: {
          resultType: 'complete',
          contents: [
            {
              uri,
              mimeType: 'text/markdown',
              text: expect.stringContaining(heading),
            },
          ],
        },
      });
    }

    const stalePlan = await protocol.handle(
      request('resources/read', { uri: 'psd-eoc://docs/plan' }),
    );
    expect(stalePlan).toMatchObject({
      error: { code: -32602, message: 'Resource not found' },
    });
  });

  test('rejects unknown URIs without resolving them as filesystem paths', async () => {
    const result = await protocolWithFetch().handle(
      request('resources/read', {
        uri: 'psd-eoc://docs/../../AGENTS.md',
      }),
    );
    expect(result).toMatchObject({
      error: { code: -32602, message: 'Resource not found' },
    });
  });
});
