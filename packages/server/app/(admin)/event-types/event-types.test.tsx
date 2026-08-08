import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  EventTypePageSchema,
  EventTypeRenderingPreviewSchema,
  MessageTemplateCatalogSchema,
  SessionEstablishmentResultSchema,
  type AgentCapabilityGrant,
  type CreateEventTypeDraftInput,
  type EventTypePage,
  type EventTypeVersion,
  type EventTypeVersionDraft,
  type MessageTemplateCatalog,
  type MessageTemplateSet,
  type NotificationPurpose,
  type Role,
  type TemplateMode,
} from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import {
  EventTypeCapabilityError,
  executeCreateEventTypeDraftCapability,
  executeListEventTypesCapability,
  isDatabaseConstraintError,
  type AuthenticatedEventTypeAgent,
  type EventTypeStore,
} from '../../../lib/capabilities/event-types';
import {
  TemplateRenderError,
  formatNotificationStartTime,
  measureSmsLength,
  renderTemplateSet,
} from '../../../lib/notify/render';
import { eventTypeLandingResponse } from './landing';
import { PreviewCards, TemplateFields } from './manage/event-type-admin';

const IDS = {
  user: '10000000-0000-4000-8000-000000000001',
  session: '10000000-0000-4000-8000-000000000002',
  device: '10000000-0000-4000-8000-000000000003',
  snapshot: '10000000-0000-4000-8000-000000000004',
  epoch: '10000000-0000-4000-8000-000000000005',
  agent: '10000000-0000-4000-8000-000000000006',
  apiKey: '10000000-0000-4000-8000-000000000007',
  facility: '10000000-0000-4000-8000-000000000008',
} as const;

const NOW = new Date('2026-08-08T17:00:00.000Z');
const VARIABLES = {
  site: 'Synthetic Harbor High School',
  eventType: 'Lockdown',
  startTime: '2026-08-08T16:30:00.000Z',
  initiator: 'Synthetic Staff Member',
} as const;
const DRILL_VARIABLES = { ...VARIABLES, eventType: 'Lockdown Drill' } as const;

function authenticatedSession(roles: readonly Role[]): AuthenticatedSession {
  const result = SessionEstablishmentResultSchema.parse({
    user: {
      id: IDS.user,
      googleSubject: 'synthetic-google-subject',
      email: 'synthetic.staff@psd401.net',
      displayName: 'Synthetic Staff Member',
      roles,
      facilityScope: { kind: 'district' },
      createdAt: '2026-08-01T17:00:00.000Z',
      disabledAt: null,
    },
    session: {
      id: IDS.session,
      userId: IDS.user,
      deviceEnrollmentId: IDS.device,
      createdAt: '2026-08-01T17:00:00.000Z',
      expiresAt: '2026-10-01T17:00:00.000Z',
      authorization: {
        kind: 'group-membership',
        source: 'google-group-snapshot',
        membershipSnapshotId: IDS.snapshot,
        membershipValidUntil: '2026-08-08T18:00:00.000Z',
        membershipGraceUntil: '2026-08-11T18:00:00.000Z',
      },
      revokedAt: null,
    },
    deviceEnrollment: {
      id: IDS.device,
      userId: IDS.user,
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: 'synthetic-event-type-admin-browser',
      enrolledAt: '2026-08-01T17:00:00.000Z',
      lastSeenAt: '2026-08-08T17:00:00.000Z',
      revokedAt: null,
    },
    connectivityEpoch: {
      id: IDS.epoch,
      sessionId: IDS.session,
      establishedAt: '2026-08-08T16:59:00.000Z',
    },
  });
  return Object.freeze({
    actor: {
      kind: 'human' as const,
      userId: IDS.user,
      sessionId: IDS.session,
    },
    source: 'web' as const,
    roles,
    scope: { facilityScope: { kind: 'district' as const } },
    membershipState: 'fresh' as const,
    result,
  });
}

function authenticatedAgent(
  grantedCapabilityIds: readonly AgentCapabilityGrant[],
  facilityScope: AuthenticatedEventTypeAgent['scope']['facilityScope'] = {
    kind: 'district',
  },
): AuthenticatedEventTypeAgent {
  return Object.freeze({
    actor: {
      kind: 'agent' as const,
      agentId: IDS.agent,
      apiKeyId: IDS.apiKey,
    },
    source: 'mcp' as const,
    scope: { facilityScope },
    grantedCapabilityIds,
  });
}

function templateSet(
  mode: TemplateMode,
  purpose: NotificationPurpose,
  overrides: Readonly<{ smsBody?: string }> = {},
): MessageTemplateSet {
  const classificationMarker = mode === 'real' ? 'INCIDENT' : 'DRILL';
  return {
    templateMode: mode,
    purpose,
    push: {
      channel: 'push',
      templateMode: mode,
      purpose,
      classificationMarker,
      title: '{{eventType}} at {{site}}',
      body: 'Started {{startTime}} by {{initiator}}. Open PSD EOC.',
    },
    email: {
      channel: 'email',
      templateMode: mode,
      purpose,
      classificationMarker,
      subject: '{{eventType}} at {{site}}',
      textBody:
        '{{eventType}} at {{site}} started {{startTime}} by {{initiator}}.',
    },
    sms: {
      channel: 'sms',
      templateMode: mode,
      purpose,
      classificationMarker,
      body: overrides.smsBody ?? '{{eventType}} at {{site}}. Open PSD EOC.',
    },
  };
}

function catalog(
  mode: TemplateMode,
  overrides: Readonly<{ activationSmsBody?: string }> = {},
): MessageTemplateCatalog {
  return MessageTemplateCatalogSchema.parse({
    activation: templateSet(mode, 'activation', {
      ...(overrides.activationSmsBody === undefined
        ? {}
        : { smsBody: overrides.activationSmsBody }),
    }),
    'all-clear': templateSet(mode, 'all-clear'),
    reactivation: templateSet(mode, 'reactivation'),
  });
}

class CountingStore implements EventTypeStore {
  public listCalls = 0;
  public createCalls = 0;

  public async list(): Promise<EventTypePage> {
    this.listCalls += 1;
    return EventTypePageSchema.parse({
      items: [],
      pageInfo: { hasMore: false, nextCursor: null },
    });
  }

  public async getVersion(): Promise<EventTypeVersion> {
    throw new Error('Unexpected version read.');
  }

  public async getDraft(): Promise<EventTypeVersionDraft> {
    throw new Error('Unexpected draft read.');
  }

  public async createDraft(): Promise<EventTypeVersionDraft> {
    this.createCalls += 1;
    throw new Error('The authorization test reached the store.');
  }

  public async updateDraft(): Promise<EventTypeVersionDraft> {
    throw new Error('Unexpected draft update.');
  }

  public async publishVersion(): Promise<EventTypeVersion> {
    throw new Error('Unexpected version publication.');
  }
}

function visibleFields(
  message: ReturnType<typeof renderTemplateSet>[number],
): readonly string[] {
  switch (message.channel) {
    case 'push':
      return [message.title, message.body];
    case 'email':
      return [message.subject, message.textBody];
    case 'sms':
      return [message.body];
  }
}

describe('renderer-owned real-versus-drill classification', () => {
  for (const [eventKind, mode, prefix] of [
    ['incident', 'real', '[INCIDENT] REAL INCIDENT: '],
    ['drill', 'drill', '[DRILL] TRAINING ONLY: '],
    ['test', 'drill', '[DRILL] TRAINING ONLY: '],
  ] as const) {
    test(`${eventKind} prefixes every visible channel field with the full canonical statement`, () => {
      const messages = renderTemplateSet({
        eventKind,
        templates: catalog(mode).activation,
        variables: mode === 'drill' ? DRILL_VARIABLES : VARIABLES,
      });
      expect(messages.map((message) => message.channel)).toEqual([
        'push',
        'email',
        'sms',
      ]);
      for (const message of messages) {
        expect(message.templateMode).toBe(mode);
        for (const field of visibleFields(message)) {
          expect(field.startsWith(prefix)).toBe(true);
        }
      }
    });
  }

  test('drill marking cannot be removed through editable wording', () => {
    const plain = templateSet('drill', 'activation');
    const messages = renderTemplateSet({
      eventKind: 'drill',
      templates: {
        ...plain,
        push: { ...plain.push, title: 'Proceed at {{site}}' },
        email: { ...plain.email, subject: 'Proceed at {{site}}' },
        sms: { ...plain.sms, body: 'Proceed at {{site}}' },
      },
      variables: DRILL_VARIABLES,
    });
    for (const message of messages) {
      for (const field of visibleFields(message)) {
        expect(field.startsWith('[DRILL] TRAINING ONLY: ')).toBe(true);
      }
    }
  });

  test('preserves classification-like prose unless it is a delimited editable label', () => {
    const real = templateSet('real', 'activation');
    const realMessages = renderTemplateSet({
      eventKind: 'incident',
      templates: {
        ...real,
        push: {
          ...real.push,
          title: 'Real incident response at {{site}}',
        },
      },
      variables: VARIABLES,
    });
    expect(realMessages[0].channel).toBe('push');
    expect(
      realMessages[0].channel === 'push' ? realMessages[0].title : '',
    ).toContain('Real incident response at Synthetic Harbor High School');

    const drill = templateSet('drill', 'activation');
    const drillMessages = renderTemplateSet({
      eventKind: 'drill',
      templates: {
        ...drill,
        push: {
          ...drill.push,
          title: 'Training only staff should respond',
        },
      },
      variables: DRILL_VARIABLES,
    });
    expect(drillMessages[0].channel).toBe('push');
    expect(
      drillMessages[0].channel === 'push' ? drillMessages[0].title : '',
    ).toContain('Training only staff should respond');
  });

  test('replaces seed-shaped classification leads while retaining purpose labels', () => {
    for (const [eventKind, mode, variables, editableLead, renderedLead] of [
      [
        'incident',
        'real',
        VARIABLES,
        'REAL INCIDENT ACTIVATION',
        '[INCIDENT] REAL INCIDENT: ACTIVATION',
      ],
      [
        'drill',
        'drill',
        DRILL_VARIABLES,
        'DRILL — TRAINING ONLY ACTIVATION',
        '[DRILL] TRAINING ONLY: ACTIVATION',
      ],
    ] as const) {
      const base = templateSet(mode, 'activation');
      const rendered = renderTemplateSet({
        eventKind,
        templates: {
          ...base,
          push: {
            ...base.push,
            title: `${editableLead}: {{eventType}}`,
            body: `${editableLead} at {{site}}.`,
          },
          email: {
            ...base.email,
            subject: `${editableLead}: {{eventType}} at {{site}}`,
            textBody: `${editableLead}\n\nEvent type: {{eventType}}`,
          },
          sms: {
            ...base.sms,
            body: `${editableLead}: {{eventType}} at {{site}}.`,
          },
        },
        variables,
      });
      for (const message of rendered) {
        for (const field of visibleFields(message)) {
          expect(field.startsWith(renderedLead)).toBe(true);
          expect(field).not.toContain(editableLead);
        }
      }
    }
  });

  test('rejects editable prose that contradicts real or drill classification', () => {
    const drill = templateSet('drill', 'activation');
    expect(() =>
      renderTemplateSet({
        eventKind: 'drill',
        templates: {
          ...drill,
          sms: {
            ...drill.sms,
            body: 'REAL INCIDENT — NOT A DRILL. Follow emergency directions.',
          },
        },
        variables: DRILL_VARIABLES,
      }),
    ).toThrow('Drill wording cannot claim to be a real incident');

    const real = templateSet('real', 'activation');
    expect(() =>
      renderTemplateSet({
        eventKind: 'incident',
        templates: {
          ...real,
          push: {
            ...real.push,
            title: 'TRAINING ONLY exercise at {{site}}',
          },
        },
        variables: VARIABLES,
      }),
    ).toThrow(
      'Real-incident wording cannot contradict its real classification',
    );

    expect(() =>
      renderTemplateSet({
        eventKind: 'incident',
        templates: {
          ...real,
          sms: { ...real.sms, body: 'This is not a real emergency.' },
        },
        variables: VARIABLES,
      }),
    ).toThrow(
      'Real-incident wording cannot contradict its real classification',
    );
    expect(() =>
      renderTemplateSet({
        eventKind: 'drill',
        templates: {
          ...drill,
          sms: { ...drill.sms, body: 'This is an emergency.' },
        },
        variables: DRILL_VARIABLES,
      }),
    ).toThrow('Drill wording cannot claim to be a real incident');
    for (const body of [
      'This is only a test.',
      'This is a training exercise.',
      'This is a simulated incident.',
      'This is a rehearsal.',
    ]) {
      expect(() =>
        renderTemplateSet({
          eventKind: 'incident',
          templates: { ...real, sms: { ...real.sms, body } },
          variables: VARIABLES,
        }),
      ).toThrow(
        'Real-incident wording cannot contradict its real classification',
      );
    }
    expect(() =>
      renderTemplateSet({
        eventKind: 'drill',
        templates: {
          ...drill,
          sms: { ...drill.sms, body: 'This is no drill.' },
        },
        variables: DRILL_VARIABLES,
      }),
    ).toThrow('Drill wording cannot claim to be a real incident');

    for (const body of [
      'This is not a drill.',
      'This is not a test.',
      'This is no drill.',
      'This isn’t a drill.',
    ]) {
      expect(() =>
        renderTemplateSet({
          eventKind: 'incident',
          templates: { ...real, sms: { ...real.sms, body } },
          variables: VARIABLES,
        }),
      ).not.toThrow();
    }
    for (const body of [
      'Open PSD EOC for live updates.',
      'Practice the actual response procedure.',
      'This is a rehearsal.',
    ]) {
      expect(() =>
        renderTemplateSet({
          eventKind: 'drill',
          templates: { ...drill, sms: { ...drill.sms, body } },
          variables: DRILL_VARIABLES,
        }),
      ).not.toThrow();
    }
    for (const body of [
      'This is not a test.',
      'This is not an exercise.',
      'This is not a rehearsal.',
    ]) {
      expect(() =>
        renderTemplateSet({
          eventKind: 'drill',
          templates: { ...drill, sms: { ...drill.sms, body } },
          variables: DRILL_VARIABLES,
        }),
      ).toThrow('Drill wording cannot claim to be a real incident');
    }
  });

  test('rejects U+2028 and U+2029 in editable templates and variables', () => {
    for (const separator of ['\u2028', '\u2029']) {
      const template = templateSet('drill', 'activation');
      expect(() =>
        renderTemplateSet({
          eventKind: 'drill',
          templates: {
            ...template,
            push: {
              ...template.push,
              title: `Proceed${separator}at {{site}}`,
            },
          },
          variables: DRILL_VARIABLES,
        }),
      ).toThrow('unsafe invisible or control text');

      expect(() =>
        renderTemplateSet({
          eventKind: 'drill',
          templates: template,
          variables: {
            ...DRILL_VARIABLES,
            site: `Synthetic${separator}Campus`,
          },
        }),
      ).toThrow('site rendering variable is not safe visible text');
    }
  });

  test('rejects mode substitution and reserved marker injection before truncation', () => {
    expect(() =>
      renderTemplateSet({
        eventKind: 'incident',
        templates: catalog('drill').activation,
        variables: DRILL_VARIABLES,
      }),
    ).toThrow(TemplateRenderError);
    expect(() =>
      renderTemplateSet({
        eventKind: 'drill',
        templates: catalog('drill', {
          activationSmsBody: `${'A'.repeat(980)} [INCIDENT]`,
        }).activation,
        variables: DRILL_VARIABLES,
      }),
    ).toThrow('reserved classification marker');
    expect(() =>
      renderTemplateSet({
        eventKind: 'drill',
        templates: catalog('drill', {
          activationSmsBody: 'Proceed ［INCIDENT］ at {{site}}',
        }).activation,
        variables: DRILL_VARIABLES,
      }),
    ).toThrow('reserved classification marker');
  });

  test('interpolates tokens once and rejects multiline roster values', () => {
    const rendered = renderTemplateSet({
      eventKind: 'incident',
      templates: catalog('real').activation,
      variables: { ...VARIABLES, site: '{{eventType}}' },
    });
    const push = rendered[0];
    if (push.channel !== 'push') {
      throw new Error('Expected push rendering first.');
    }
    expect(push.title).toContain('{{eventType}}');
    expect(() =>
      renderTemplateSet({
        eventKind: 'incident',
        templates: catalog('real').activation,
        variables: { ...VARIABLES, initiator: 'Synthetic\nInjected' },
      }),
    ).toThrow('initiator rendering variable is not safe visible text');
  });

  test('never strips classification-like words from dynamic event names', () => {
    const real = renderTemplateSet({
      eventKind: 'incident',
      templates: catalog('real').activation,
      variables: { ...VARIABLES, eventType: 'Real Incident Response' },
    });
    const drill = renderTemplateSet({
      eventKind: 'drill',
      templates: catalog('drill').activation,
      variables: { ...VARIABLES, eventType: 'Training Only Readiness Drill' },
    });
    expect(visibleFields(real[0]).join(' ')).toContain(
      'Real Incident Response',
    );
    expect(visibleFields(drill[0]).join(' ')).toContain(
      'Training Only Readiness Drill',
    );
    for (const eventType of [
      'Emergency Evacuation Drill',
      'Actual Incident Tabletop Drill',
      'Real Alert Recognition Drill',
    ]) {
      const rendered = renderTemplateSet({
        eventKind: 'drill',
        templates: catalog('drill').activation,
        variables: { ...DRILL_VARIABLES, eventType },
      });
      expect(visibleFields(rendered[0]).join(' ')).toContain(eventType);
    }
    for (const eventType of [
      'REAL INCIDENT — NOT A DRILL Training Exercise',
      'This Isn’t a Drill Training Exercise',
      'No Test Training Exercise',
      'Not a Mock Incident Exercise',
      'Not a Simulated Incident Exercise',
    ]) {
      expect(() =>
        renderTemplateSet({
          eventKind: 'drill',
          templates: catalog('drill').activation,
          variables: { ...DRILL_VARIABLES, eventType },
        }),
      ).toThrow(
        'The event-type name must visibly match its immutable real-or-drill mode',
      );
    }
  });

  test('formats district time deterministically across standard and daylight time', () => {
    expect(formatNotificationStartTime('2026-01-15T20:00:00.000Z')).toContain(
      '12:00 PM PST',
    );
    expect(formatNotificationStartTime('2026-07-15T19:00:00.000Z')).toContain(
      '12:00 PM PDT',
    );
  });

  test('measures GSM extension septets and truncates without splitting Unicode', () => {
    expect(measureSmsLength('[ ]')).toMatchObject({
      encoding: 'gsm-7',
      units: 5,
      parts: 1,
      exceedsProviderLimit: false,
    });
    const gsm = renderTemplateSet({
      eventKind: 'incident',
      templates: catalog('real', {
        activationSmsBody: 'A'.repeat(1_000),
      }).activation,
      variables: VARIABLES,
    })[2];
    expect(gsm.channel).toBe('sms');
    if (gsm.channel !== 'sms') {
      throw new Error('Expected SMS rendering.');
    }
    expect(measureSmsLength(gsm.body).parts).toBe(1);
    expect(gsm.body.startsWith('[INCIDENT] REAL INCIDENT: ')).toBe(true);
    expect(gsm.body.endsWith('...')).toBe(true);

    const unicode = renderTemplateSet({
      eventKind: 'drill',
      templates: catalog('drill', {
        activationSmsBody: '😀'.repeat(490),
      }).activation,
      variables: DRILL_VARIABLES,
    })[2];
    if (unicode.channel !== 'sms') {
      throw new Error('Expected SMS rendering.');
    }
    expect(measureSmsLength(unicode.body).parts).toBe(1);
    expect(measureSmsLength(unicode.body).exceedsProviderLimit).toBe(false);
    expect(unicode.body.startsWith('[DRILL] TRAINING ONLY: ')).toBe(true);
    expect(unicode.body.endsWith('...')).toBe(true);
    expect(unicode.body.slice(0, -3)).not.toMatch(/[\uD800-\uDBFF]$/u);
  });

  test('truncates long valid variables in every bounded field and keeps SMS single-part', () => {
    const base = templateSet('real', 'activation');
    const longTemplates: MessageTemplateSet = {
      ...base,
      push: {
        ...base.push,
        title: '{{eventType}}',
        body: '{{initiator}}',
      },
      email: {
        ...base.email,
        subject: '{{site}}',
        textBody: `${'A'.repeat(9_510)}{{site}}`,
      },
      sms: {
        ...base.sms,
        body: '{{site}}',
      },
    };
    const longValue = 'A'.repeat(500);
    const [push, email, sms] = renderTemplateSet({
      eventKind: 'incident',
      templates: longTemplates,
      variables: {
        ...VARIABLES,
        site: longValue,
        eventType: longValue,
        initiator: longValue,
      },
    });

    expect(push.channel).toBe('push');
    expect(email.channel).toBe('email');
    expect(sms.channel).toBe('sms');
    if (
      push.channel !== 'push' ||
      email.channel !== 'email' ||
      sms.channel !== 'sms'
    ) {
      throw new Error('Expected push, email, and SMS rendering in order.');
    }
    expect(push.title).toHaveLength(120);
    expect(push.body).toHaveLength(500);
    expect(email.subject).toHaveLength(200);
    expect(email.textBody).toHaveLength(10_000);
    for (const field of [
      push.title,
      push.body,
      email.subject,
      email.textBody,
      sms.body,
    ]) {
      expect(field.startsWith('[INCIDENT] REAL INCIDENT: ')).toBe(true);
      expect(field.endsWith('...')).toBe(true);
    }
    expect(measureSmsLength(sms.body)).toMatchObject({
      encoding: 'gsm-7',
      parts: 1,
      exceedsProviderLimit: false,
    });
  });
});

describe('capability-level administrator authorization', () => {
  test('returns HTTP 403 before a non-admin handler can reach storage', async () => {
    const store = new CountingStore();
    const response = await eventTypeLandingResponse(
      'https://eoc.example.test/event-types',
      authenticatedSession(['staff']),
      store,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('Administrator access required');
    expect(store.listCalls).toBe(0);
  });

  test('admits an admin and redirects only after capability authorization', async () => {
    const store = new CountingStore();
    const response = await eventTypeLandingResponse(
      'https://eoc.example.test/event-types',
      authenticatedSession(['staff', 'admin']),
      store,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'https://eoc.example.test/event-types/manage',
    );
    expect(store.listCalls).toBe(1);
  });

  test('denies non-admin mutation and mismatched web transport before storage', async () => {
    const command: CreateEventTypeDraftInput = {
      target: {
        kind: 'new-event-type',
        key: 'synthetic-secure',
        familyKey: 'synthetic-secure',
        templateMode: 'real',
      },
      name: 'Synthetic Secure',
      description: null,
      templates: catalog('real'),
    };
    const nonAdminStore = new CountingStore();
    await expect(
      executeCreateEventTypeDraftCapability({
        store: nonAdminStore,
        authenticated: authenticatedSession(['staff']),
        command,
        idempotencyKey: 'event-type-test-key-0001',
        transport: {
          kind: 'web-interactive',
          method: 'POST',
          interaction: 'explicit-user-submit',
          csrfVerified: true,
        },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(nonAdminStore.createCalls).toBe(0);

    const adminStore = new CountingStore();
    await expect(
      executeCreateEventTypeDraftCapability({
        store: adminStore,
        authenticated: authenticatedSession(['staff', 'admin']),
        command,
        idempotencyKey: 'event-type-test-key-0002',
        transport: {
          kind: 'mobile-interactive',
          interaction: 'explicit-user-submit',
        },
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(adminStore.createCalls).toBe(0);
  });

  test('keeps enabled published lists available to staff without exposing admin lists', async () => {
    const store = new CountingStore();
    await expect(
      executeListEventTypesCapability({
        store,
        authenticated: authenticatedSession(['staff']),
        query: {
          templateMode: null,
          enabled: true,
          cursor: null,
          limit: 20,
        },
      }),
    ).resolves.toMatchObject({ items: [] });
    expect(store.listCalls).toBe(1);
    await expect(
      executeListEventTypesCapability({
        store,
        authenticated: authenticatedSession(['staff']),
        query: {
          templateMode: null,
          enabled: null,
          cursor: null,
          limit: 20,
        },
      }),
    ).rejects.toBeInstanceOf(EventTypeCapabilityError);
    expect(store.listCalls).toBe(1);
  });

  test('requires an agent exact capability grant and district scope for configuration', async () => {
    const command: CreateEventTypeDraftInput = {
      target: {
        kind: 'new-event-type',
        key: 'synthetic-agent-config',
        familyKey: 'synthetic-agent-config',
        templateMode: 'real',
      },
      name: 'Synthetic Agent Configuration',
      description: null,
      templates: catalog('real'),
    };
    const execute = (
      store: CountingStore,
      authenticated: AuthenticatedEventTypeAgent,
      key: string,
    ) =>
      executeCreateEventTypeDraftCapability({
        store,
        authenticated,
        command,
        idempotencyKey: key,
        transport: { kind: 'mcp-tool-call' },
        now: NOW,
      });

    const allowedStore = new CountingStore();
    await expect(
      execute(
        allowedStore,
        authenticatedAgent(['create-event-type-draft']),
        'event-type-agent-allow-0001',
      ),
    ).rejects.toThrow('authorization test reached the store');
    expect(allowedStore.createCalls).toBe(1);

    const wrongGrantStore = new CountingStore();
    await expect(
      execute(
        wrongGrantStore,
        authenticatedAgent(['update-event-type-draft']),
        'event-type-agent-wrong-grant-0001',
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(wrongGrantStore.createCalls).toBe(0);

    const facilityStore = new CountingStore();
    await expect(
      execute(
        facilityStore,
        authenticatedAgent(['create-event-type-draft'], {
          kind: 'facilities',
          facilityIds: [IDS.facility],
        }),
        'event-type-agent-scope-deny-0001',
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(facilityStore.createCalls).toBe(0);
  });
});

describe('database error classification', () => {
  test('recognizes a wrapped RDS Data API SQLState 23505 without leaking details', () => {
    const dataApiError = Object.assign(new Error('Database request failed.'), {
      name: 'DatabaseErrorException',
      message:
        'ERROR: duplicate key value violates unique constraint; SQLState: 23505',
    });
    const wrapped = Object.assign(new Error('Drizzle query failed.'), {
      cause: Object.assign(new Error('RDS Data API failed.'), {
        cause: dataApiError,
      }),
    });
    expect(isDatabaseConstraintError(wrapped)).toBe(true);
    expect(
      isDatabaseConstraintError({
        name: 'DatabaseErrorException',
        message: 'ERROR: value too long; SQLState: 22001',
      }),
    ).toBe(false);
  });
});

describe('admin UI semantics', () => {
  test('labels every editable channel field and never exposes classification as an input', () => {
    const markup = renderToStaticMarkup(
      <TemplateFields templates={catalog('drill')} />,
    );
    expect(markup.match(/<fieldset/g)).toHaveLength(3);
    expect(markup).toContain('<legend>Activation messages</legend>');
    expect(markup).toContain('Lock-screen title');
    expect(markup).toContain('SMS body');
    expect(markup).toContain('Plaintext email body');
    expect(markup).not.toContain('name="templateMode"');
    expect(markup).not.toContain('name="classificationMarker"');
  });

  test('renders drill preview text, landmarks, and all exact channel markers', () => {
    const messages = renderTemplateSet({
      eventKind: 'drill',
      templates: catalog('drill').activation,
      variables: DRILL_VARIABLES,
    });
    const preview = EventTypeRenderingPreviewSchema.parse({
      draftId: '20000000-0000-4000-8000-000000000001',
      eventKind: 'drill',
      templateMode: 'drill',
      purpose: 'activation',
      messages,
    });
    const markup = renderToStaticMarkup(<PreviewCards preview={preview} />);
    expect(markup).toContain('DRILL — TRAINING ONLY');
    expect(markup).toContain('Push lock screen');
    expect(markup).toContain('SMS');
    expect(markup).toContain('Email');
    expect(markup.match(/\[DRILL\]/g)?.length).toBeGreaterThanOrEqual(5);
  });

  test('ships visible keyboard focus and minimum target sizing in owned CSS', () => {
    const stylesheet = readFileSync(
      new URL('./styles.css', import.meta.url),
      'utf8',
    );
    expect(stylesheet).toContain(':focus-visible');
    expect(stylesheet).toContain('min-height: 2.75rem');
    expect(stylesheet).toContain('.skip-link:focus');
    expect(stylesheet).toContain('@media (max-width: 52rem)');
  });
});
