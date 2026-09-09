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
  type EventKind,
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
  type EventTypeCapabilityStore,
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
import { NAV_DESTINATIONS } from '../../nav/primary-nav-model';

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
  site: 'Harbor Ridge High School',
  eventType: 'Lockdown',
  threat: 'Intruder',
  startTime: '2026-08-08T16:30:00.000Z',
  initiator: 'Taylor Morgan',
} as const;
const DRILL_VARIABLES = { ...VARIABLES, eventType: 'Lockdown Drill' } as const;

function authenticatedSession(roles: readonly Role[]): AuthenticatedSession {
  const result = SessionEstablishmentResultSchema.parse({
    user: {
      id: IDS.user,
      googleSubject: 'synthetic-google-subject',
      email: 'synthetic.staff@example.invalid',
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
  const wording =
    purpose === 'activation'
      ? {
          title: '{{eventType}} at {{site}}',
          body: 'Started {{startTime}} by {{initiator}}. Open PSD EOC.',
          textBody:
            '{{eventType}} at {{site}} started {{startTime}} by {{initiator}}.',
          sms: '{{eventType}} at {{site}}. Open PSD EOC.',
        }
      : purpose === 'all-clear'
        ? {
            title: 'ALL CLEAR: {{eventType}} at {{site}}',
            body: '{{eventType}} at {{site}} is all clear. Open PSD EOC for current information.',
            textBody:
              'The {{eventType}} at {{site}} is complete. The notification began {{startTime}}.',
            sms: '{{eventType}} complete at {{site}}. Open PSD EOC for current information.',
          }
        : {
            title: 'REACTIVATION: {{eventType}} at {{site}}',
            body: '{{eventType}} at {{site}} is active again. Open PSD EOC for current instructions.',
            textBody:
              'The {{eventType}} at {{site}} is active again. The notification originally began {{startTime}} and was initiated by {{initiator}}.',
            sms: '{{eventType}} reactivated at {{site}}. Open PSD EOC for current instructions.',
          };
  return {
    templateMode: mode,
    purpose,
    push: {
      channel: 'push',
      templateMode: mode,
      purpose,
      classificationMarker,
      title: wording.title,
      body: wording.body,
    },
    email: {
      channel: 'email',
      templateMode: mode,
      purpose,
      classificationMarker,
      subject: wording.title,
      textBody: wording.textBody,
    },
    sms: {
      channel: 'sms',
      templateMode: mode,
      purpose,
      classificationMarker,
      body: overrides.smsBody ?? wording.sms,
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

function capabilityStore(eventTypes: EventTypeStore): EventTypeCapabilityStore {
  return {
    transaction: (operation) =>
      operation({
        eventTypes,
        readCurrentTime: (receivedAt) => Promise.resolve(receivedAt),
        claimIdempotency: () =>
          Promise.reject(new Error('Unexpected engine idempotency claim.')),
        completeIdempotency: () =>
          Promise.reject(
            new Error('Unexpected engine idempotency completion.'),
          ),
        getHumanConfirmation: () => Promise.resolve(null),
        consumeHumanConfirmation: () => Promise.resolve(false),
        appendCapabilityAudit: () => Promise.resolve(),
      }),
    appendCapabilityAudit: () => Promise.resolve(),
  };
}

/**
 * Every independently visible field. Each carries the same renderer-owned
 * lead: the classification marker, then the state a lifecycle notification
 * announces (and, for a synthetic delivery test, what it is). There is no
 * trailing marker: a message that ran long lost it exactly when it mattered,
 * and the lead alone is what the installed mobile app checks.
 */
function visibleFields(
  message: ReturnType<typeof renderTemplateSet>[number],
): readonly Readonly<{ value: string; headline: boolean }>[] {
  switch (message.channel) {
    case 'push':
      return [
        { value: message.title, headline: true },
        { value: message.body, headline: false },
      ];
    case 'email':
      return [
        { value: message.subject, headline: true },
        { value: message.textBody, headline: false },
      ];
    case 'sms':
      return [{ value: message.body, headline: false }];
  }
}

describe('renderer-owned notification frames', () => {
  const purposes = [
    'activation',
    'all-clear',
    'reactivation',
  ] as const satisfies readonly NotificationPurpose[];

  function expectedFrame(
    eventKind: EventKind,
    mode: TemplateMode,
    purpose: NotificationPurpose,
  ): Readonly<{ prefix: string; suffix: string }> {
    const marker = mode === 'real' ? 'INCIDENT' : 'DRILL';
    const state =
      purpose === 'activation'
        ? ''
        : purpose === 'all-clear'
          ? 'ALL CLEAR: '
          : 'REACTIVATED: ';
    const lead =
      eventKind === 'test'
        ? state === ''
          ? 'TEST - NOT A REAL INCIDENT: '
          : `TEST - NOT A REAL INCIDENT - ${state}`
        : state;
    return { prefix: `[${marker}] ${lead}`, suffix: '' };
  }

  function frameFor(
    _field: Readonly<{ headline: boolean }>,
    eventKind: EventKind,
    mode: TemplateMode,
    purpose: NotificationPurpose,
  ): Readonly<{ prefix: string; suffix: string }> {
    return expectedFrame(eventKind, mode, purpose);
  }

  test('frames every independently visible field for every mode and purpose', () => {
    for (const [eventKind, mode, variables] of [
      ['incident', 'real', VARIABLES],
      ['drill', 'drill', DRILL_VARIABLES],
      ['test', 'drill', DRILL_VARIABLES],
    ] as const) {
      for (const purpose of purposes) {
        const messages = renderTemplateSet({
          eventKind,
          templates: templateSet(mode, purpose),
          variables,
        });
        expect(messages.map((message) => message.channel)).toEqual([
          'push',
          'email',
          'sms',
        ]);
        for (const message of messages) {
          expect(message.templateMode).toBe(mode);
          expect(message.purpose).toBe(purpose);
          for (const field of visibleFields(message)) {
            const expected = frameFor(field, eventKind, mode, purpose);
            expect(field.value.startsWith(expected.prefix)).toBe(true);
            // The marker leads every field, headline or not, so configurable
            // copy can never remove or impersonate it; nothing trails.
            expect(expected.prefix).toContain(
              mode === 'real' ? '[INCIDENT]' : '[DRILL]',
            );
            expect(field.value.endsWith(' [DRILL]')).toBe(false);
            expect(field.value.endsWith(' [INCIDENT]')).toBe(false);
          }
        }
      }
    }
  });

  test('preserves arbitrary safe Unicode names, context, and configured copy', () => {
    const base = templateSet('drill', 'activation');
    const templates: MessageTemplateSet = {
      ...base,
      push: {
        ...base.push,
        title: '自由な管理文言 🚨 — {{eventType}}',
        body: 'Это реальное происшествие. Site: {{site}}. By {{initiator}}.',
      },
      email: {
        ...base.email,
        subject: 'Aviso configurable — {{eventType}}',
        textBody:
          'هذا حادث حقيقي وفق النص الإداري.\n場所: {{site}}\nAuteur: {{initiator}}',
      },
      sms: {
        ...base.sms,
        body: 'これは実際の事件です — {{eventType}}',
      },
    };
    const variables = {
      ...DRILL_VARIABLES,
      eventType: 'Évacuation / 避難 / إخلاء 🚨',
      site: 'École 東京 — مبنى 🚒',
      initiator: 'José 李 — أمل 🙂',
    };
    const messages = renderTemplateSet({
      eventKind: 'drill',
      templates,
      variables,
    });
    const visible = messages
      .flatMap(visibleFields)
      .map((field) => field.value)
      .join('\n');
    expect(visible).toContain(variables.eventType);
    expect(visible).toContain(variables.site);
    expect(visible).toContain(variables.initiator);
    expect(visible).toContain('Это реальное происшествие');
    expect(visible).toContain('هذا حادث حقيقي وفق النص الإداري');
    expect(visible).toContain('これは実際の事件です');
    for (const field of messages.flatMap(visibleFields)) {
      expect(field.value.startsWith('[DRILL] ')).toBe(true);
    }
  });

  test('allows arbitrary contradictory semantics only inside immutable frames', () => {
    for (const [eventKind, mode, variables, configuredCopy] of [
      [
        'incident',
        'real',
        { ...VARIABLES, eventType: 'Training Exercise / Simulacro' },
        'THIS IS ONLY A DRILL. Ceci est un exercice.',
      ],
      [
        'drill',
        'drill',
        { ...DRILL_VARIABLES, eventType: 'Actual Emergency / Incidente real' },
        'THIS IS A REAL INCIDENT. Esto es una emergencia real.',
      ],
    ] as const) {
      const base = templateSet(mode, 'activation');
      const messages = renderTemplateSet({
        eventKind,
        templates: {
          ...base,
          push: { ...base.push, title: configuredCopy, body: configuredCopy },
          email: {
            ...base.email,
            subject: configuredCopy,
            textBody: configuredCopy,
          },
          sms: { ...base.sms, body: configuredCopy },
        },
        variables,
      });
      for (const field of messages.flatMap(visibleFields)) {
        const expected = frameFor(field, eventKind, mode, 'activation');
        expect(field.value.startsWith(expected.prefix)).toBe(true);
        expect(field.value).toContain(configuredCopy);
        expect(field.value.endsWith(expected.suffix)).toBe(true);
      }
    }
  });

  test('fails closed when configurable copy attempts to forge a reserved marker', () => {
    const base = templateSet('drill', 'activation');
    const markStrippedTr39Cases = [
      {
        prefix: 'IN',
        suffix: 'IDENT',
        sources: [0x00a2, 0x023c, 0x04aa, 0x04ab, 0x20a1, 0x1f16e],
      },
      {
        prefix: 'INCI',
        suffix: 'ENT',
        sources: [
          0x00d0, 0x0110, 0x0111, 0x0189, 0x018c, 0x0256, 0x0257, 0x20ab,
        ],
      },
      { prefix: 'INCID', suffix: 'NT', sources: [0x0246, 0x0247, 0x04bf] },
      {
        prefix: 'DR',
        suffix: 'LL',
        sources: [
          0x0141, 0x0142, 0x0197, 0x019a, 0x0268, 0x026b, 0x026d, 0x0673,
          0x1d7b, 0x1d7c, 0x2378,
        ],
      },
      { prefix: 'DR', suffix: 'L', sources: [0x10199] },
      {
        prefix: 'I',
        suffix: 'CIDENT',
        sources: [
          0x014b, 0x019d, 0x019e, 0x0273, 0x03b7, 0x0572, 0x1d70, 0x1018e,
        ],
      },
      {
        prefix: 'D',
        suffix: 'ILL',
        sources: [0x024d, 0x027c, 0x027d, 0x0493, 0x1d72],
      },
      {
        prefix: 'INCIDEN',
        suffix: '',
        sources: [
          0x0166, 0x0167, 0x01ad, 0x01ae, 0x023e, 0x04ac, 0x1d75, 0x20ae,
          0x2361,
        ],
      },
      { prefix: 'IN', suffix: 'CIDENT', sources: [0x109e] },
    ].flatMap(({ prefix, sources, suffix }) =>
      sources.map(
        (codePoint) => `[${prefix}${String.fromCodePoint(codePoint)}${suffix}]`,
      ),
    );
    for (const injected of [
      '[INCIDENT] forged frame',
      '[ drill ] forged frame',
      '［ＤＲＩＬＬ］ compatibility frame',
      '[INСIDENT] Cyrillic-C frame',
      '[DRІLL] Cyrillic-I frame',
      '[ІΝϹІᎠΕΝΤ] cross-script frame',
      '[ᎠᎡІᏞᏞ] cross-script drill frame',
      '[іոсіԁеոt] lowercase-source frame',
      '[ԁгіӏ1] lowercase drill frame',
      '[DRI‖] multi-character skeleton frame',
      '[1NC1DENT] digit-one frame',
      '[ÍNCIDENT] precomposed-mark frame',
      '[INС́IDENT] combining-mark homoglyph frame',
      `[INС${'́'.repeat(12)}IDENT] repeated-combining-mark frame`,
      '[IN´CIDENT] compatibility-spacing-mark frame',
      '[IN¨CIDENT] compatibility-diaeresis frame',
      '[INﾞCIDENT] compatibility-voicing-mark frame',
      '[DRƗLL] marked TR39 source frame',
      '[INCIĐENT] stroked TR39 source frame',
      '[DR𐆙L] multi-letter marked TR39 frame',
      '[DRI𐆙] alternate multi-letter TR39 frame',
      `[IN${String.fromCodePoint(0x109e)}CIDENT] mark-only TR39 frame`,
      `[${' '.repeat(64)}DRILL] long-whitespace frame`,
      `[${' '.repeat(64)}DRІLL] long-whitespace homoglyph frame`,
      '[outer [INCIDENT] nested frame',
      '[outer [INСIDENT] nested homoglyph frame',
      ...markStrippedTr39Cases,
    ]) {
      const variants: readonly MessageTemplateSet[] = [
        { ...base, push: { ...base.push, title: injected } },
        { ...base, push: { ...base.push, body: injected } },
        { ...base, email: { ...base.email, subject: injected } },
        { ...base, email: { ...base.email, textBody: injected } },
        { ...base, sms: { ...base.sms, body: injected } },
      ];
      for (const templates of variants) {
        expect(() =>
          renderTemplateSet({
            eventKind: 'drill',
            templates,
            variables: DRILL_VARIABLES,
          }),
        ).toThrow('markers [INCIDENT] and [DRILL] are owned by the renderer');
      }
    }
  });

  test('does not reject marker-shaped bracketed text without a TR39 match', () => {
    const base = templateSet('real', 'activation');
    for (const configuredCopy of [
      '[INΣIDENT]',
      '[IνCIDENT]',
      '[INCIDεNT]',
      '[INCIDENτ]',
      '[école 安全]',
      '[Đistrict office]',
      '[Ɨnformation]',
    ]) {
      const messages = renderTemplateSet({
        eventKind: 'incident',
        templates: {
          ...base,
          push: { ...base.push, title: configuredCopy },
        },
        variables: VARIABLES,
      });
      const push = messages[0];
      expect(push.channel).toBe('push');
      if (push.channel !== 'push') {
        throw new Error('Expected push rendering first.');
      }
      expect(push.title).toContain(configuredCopy);
      expect(push.title.startsWith('[INCIDENT] ')).toBe(true);
    }
  });

  test('preserves ordinary bracketed copy and variables inside the immutable frame', () => {
    const base = templateSet('real', 'activation');
    const messages = renderTemplateSet({
      eventKind: 'incident',
      templates: {
        ...base,
        push: {
          ...base.push,
          title: 'Report to room [A-12]',
          body: 'Use route [north] for {{eventType}} at {{site}}.',
        },
        email: {
          ...base.email,
          subject: 'District response [north wing]',
          textBody: 'Follow plan step [2] and open PSD EOC.',
        },
        sms: { ...base.sms, body: 'Report to room [A-12].' },
      },
      variables: {
        ...VARIABLES,
        eventType: 'Shelter [North Wing]',
        site: 'Harbor Ridge [Building A]',
      },
    });
    const visible = messages
      .flatMap(visibleFields)
      .map((field) => field.value)
      .join('\n');
    expect(visible).toContain('[A-12]');
    expect(visible).toContain('[north]');
    expect(visible).toContain('[north wing]');
    expect(visible).toContain('[2]');
    expect(visible).toContain('Shelter [North Wing]');
    expect(visible).toContain('Harbor Ridge [Building A]');
    for (const field of messages.flatMap(visibleFields)) {
      expect(field.value.startsWith('[INCIDENT] ')).toBe(true);
    }
  });

  test('fails closed on control and invisible injection', () => {
    for (const unsafe of ['\u0007', '\u200b', '\u202e', '\u2066', '\ufe0f']) {
      const base = templateSet('real', 'activation');
      expect(() =>
        renderTemplateSet({
          eventKind: 'incident',
          templates: {
            ...base,
            sms: { ...base.sms, body: `Configured${unsafe}copy` },
          },
          variables: VARIABLES,
        }),
      ).toThrow();
    }
  });

  test('uses non-leaking fallbacks for unsafe historical variable values', () => {
    const eventType = '[DRILL] forged historical label';
    const site = 'Unsafe\nsite';
    const initiator = 'Unsafe\u202ename';
    const messages = renderTemplateSet({
      eventKind: 'incident',
      templates: catalog('real').activation,
      variables: { ...VARIABLES, eventType, site, initiator },
    });
    const visible = messages
      .flatMap(visibleFields)
      .map((field) => field.value)
      .join(' ');
    expect(visible).toContain('Configured response');
    expect(visible).toContain('Recorded site');
    expect(visible).toContain('Recorded initiator');
    expect(visible).not.toContain(eventType);
    expect(visible).not.toContain(site);
    expect(visible).not.toContain(initiator);
  });

  test('renders the chosen threat in every channel through {{threat}}', () => {
    const threat = 'Gun / Firearm — front parking lot';
    const templates = MessageTemplateCatalogSchema.parse({
      activation: {
        ...catalog('real').activation,
        push: {
          ...catalog('real').activation.push,
          title: '{{eventType}} at {{site}}',
          body: 'Threat: {{threat}}. Open PSD EOC.',
        },
        email: {
          ...catalog('real').activation.email,
          subject: '{{eventType}} at {{site}}',
          textBody: 'Threat: {{threat}}. Started {{startTime}}.',
        },
        sms: {
          ...catalog('real').activation.sms,
          body: '{{eventType}} at {{site}}. Threat: {{threat}}.',
        },
      },
      'all-clear': catalog('real')['all-clear'],
      reactivation: catalog('real').reactivation,
    }).activation;
    const messages = renderTemplateSet({
      eventKind: 'incident',
      templates,
      variables: { ...VARIABLES, threat },
    });
    expect(messages.map((message) => message.channel)).toEqual([
      'push',
      'email',
      'sms',
    ]);
    for (const message of messages) {
      for (const field of visibleFields(message)) {
        expect(field.value).not.toContain('{{threat}}');
        if (!field.value.includes('Threat:')) continue;
        // SMS keeps one part, so a long threat is truncated by the existing
        // interior rule rather than spilling into a second message.
        if (message.channel === 'sms') {
          expect(field.value).toContain('Threat: Gun /');
          expect(measureSmsLength(field.value).parts).toBe(1);
        } else {
          expect(field.value).toContain(threat);
        }
      }
    }
  });

  test('leaves a published version that never used the token unchanged', () => {
    // Wording published before the threat token existed keeps rendering
    // exactly as it did; the new variable only appears where an administrator
    // puts the token.
    const templates = catalog('real').activation;
    const before = renderTemplateSet({
      eventKind: 'incident',
      templates,
      variables: VARIABLES,
    });
    const after = renderTemplateSet({
      eventKind: 'incident',
      templates,
      variables: { ...VARIABLES, threat: 'Gun / Firearm' },
    });
    expect(after).toEqual(before);
    expect(
      after
        .flatMap(visibleFields)
        .map((field) => field.value)
        .join(' '),
    ).not.toContain('Gun / Firearm');
  });

  test('uses a non-leaking fallback for an unsafe threat value', () => {
    const threat = '[INCIDENT] forged threat\nlabel';
    const messages = renderTemplateSet({
      eventKind: 'drill',
      templates: MessageTemplateCatalogSchema.parse({
        activation: {
          ...catalog('drill').activation,
          push: {
            ...catalog('drill').activation.push,
            body: 'Threat: {{threat}}. Open PSD EOC.',
          },
        },
        'all-clear': catalog('drill')['all-clear'],
        reactivation: catalog('drill').reactivation,
      }).activation,
      variables: { ...DRILL_VARIABLES, threat },
    });
    const visible = messages
      .flatMap(visibleFields)
      .map((field) => field.value)
      .join(' ');
    expect(visible).toContain('Recorded threat');
    expect(visible).not.toContain('forged threat');
  });

  test('uses non-leaking fallbacks for homoglyph marker variables', () => {
    const eventType = '[INСIDENT] forged historical label';
    const site = '[DRІLL] forged historical site';
    const initiator = '[іոсіԁеոt] forged historical initiator';
    const messages = renderTemplateSet({
      eventKind: 'drill',
      templates: catalog('drill').activation,
      variables: { ...DRILL_VARIABLES, eventType, site, initiator },
    });
    const visible = messages
      .flatMap(visibleFields)
      .map((field) => field.value)
      .join(' ');
    expect(visible).toContain('Configured drill response');
    expect(visible).toContain('Recorded site');
    expect(visible).toContain('Recorded initiator');
    expect(visible).not.toContain(eventType);
    expect(visible).not.toContain(site);
    expect(visible).not.toContain(initiator);
  });

  test('uses truth-neutral fallbacks when interpolation would forge a marker', () => {
    for (const [eventKind, mode, collision] of [
      ['incident', 'real', 'Incident'],
      ['drill', 'drill', 'Drill'],
    ] as const) {
      const base = templateSet(mode, 'activation');
      const messages = renderTemplateSet({
        eventKind,
        templates: {
          ...base,
          push: {
            ...base.push,
            title: '[{{site}}]',
            body: '[{{eventType}}]',
          },
          email: {
            ...base.email,
            subject: '[{{initiator}}]',
            textBody: '[{{site}}]',
          },
          sms: { ...base.sms, body: '[{{eventType}}]' },
        },
        variables: {
          ...(mode === 'real' ? VARIABLES : DRILL_VARIABLES),
          site: collision,
          eventType: collision,
          initiator: collision,
        },
      });
      const visible = messages.flatMap(visibleFields);
      const visibleText = visible.map((field) => field.value);
      expect(visibleText.join('\n')).toContain('[Recorded site]');
      expect(visibleText.join('\n')).toContain('[Recorded initiator]');
      expect(visibleText.join('\n')).toContain(
        mode === 'real'
          ? '[Configured response]'
          : '[Configured drill response]',
      );
      for (const field of visible) {
        const expected = frameFor(field, eventKind, mode, 'activation');
        expect(field.value.startsWith(expected.prefix)).toBe(true);
        expect(field.value.endsWith(expected.suffix)).toBe(true);
        const interior = field.value.slice(
          expected.prefix.length,
          -expected.suffix.length,
        );
        expect(interior).not.toMatch(/\[\s*(?:incident|drill)\s*\]/iu);
      }
    }

    const base = templateSet('drill', 'activation');
    for (const [body, site, forgedMarker] of [
      ['Use [IN{{site}}IDENT].', 'С', '[INСIDENT]'],
      ['Use [IN{{site}}CIDENT].', '´', '[IN´CIDENT]'],
      ['Use [DR{{site}}L].', '𐆙', '[DR𐆙L]'],
      ['Use [DR{{site}}LL].', 'Ɨ', '[DRƗLL]'],
      [
        'Use [IN{{site}}CIDENT].',
        String.fromCodePoint(0x109e),
        `[IN${String.fromCodePoint(0x109e)}CIDENT]`,
      ],
    ] as const) {
      const splitCollision = renderTemplateSet({
        eventKind: 'drill',
        templates: {
          ...base,
          sms: { ...base.sms, body },
        },
        variables: { ...DRILL_VARIABLES, site },
      });
      const sms = splitCollision[2];
      expect(sms.channel).toBe('sms');
      if (sms.channel !== 'sms') {
        throw new Error('Expected SMS rendering third.');
      }
      expect(sms.body).toContain('Recorded site');
      expect(sms.body).not.toContain(forgedMarker);
      expect(sms.body.startsWith('[DRILL] ')).toBe(true);
    }
  });

  test('strips only matching legacy mode and purpose leads', () => {
    for (const [eventKind, mode, purpose, legacyLead] of [
      ['incident', 'real', 'activation', 'REAL INCIDENT ACTIVATION'],
      ['incident', 'real', 'all-clear', 'REAL INCIDENT ALL-CLEAR'],
      ['incident', 'real', 'reactivation', 'REAL INCIDENT REACTIVATION'],
      ['drill', 'drill', 'activation', 'DRILL — TRAINING ONLY ACTIVATION'],
      ['drill', 'drill', 'all-clear', 'DRILL — TRAINING ONLY ALL-CLEAR'],
      ['drill', 'drill', 'reactivation', 'DRILL — TRAINING ONLY REACTIVATION'],
    ] as const) {
      const base = templateSet(mode, purpose);
      // The lead may be punctuated or run straight into the wording, as the
      // first seeded templates did ("ACTIVATION at {{site}}"); the sent text
      // once read "ACTIVATION: ACTIVATION at" because only the punctuated
      // form was stripped.
      for (const configured of [
        `${legacyLead}: Keep this configured text`,
        `${legacyLead} at Keep this configured text`,
      ]) {
        const messages = renderTemplateSet({
          eventKind,
          templates: {
            ...base,
            push: { ...base.push, title: configured },
          },
          variables: mode === 'real' ? VARIABLES : DRILL_VARIABLES,
        });
        const push = messages[0];
        if (push.channel !== 'push') {
          throw new Error('Expected push rendering first.');
        }
        expect(push.title).not.toContain(legacyLead);
        expect(push.title).toContain('Keep this configured text');
        expect(push.title).toBe(
          `${expectedFrame(eventKind, mode, purpose).prefix}${
            configured.startsWith(`${legacyLead}:`) ? '' : 'at '
          }Keep this configured text`,
        );
      }
    }

    const base = templateSet('drill', 'activation');
    const mismatched = renderTemplateSet({
      eventKind: 'drill',
      templates: {
        ...base,
        sms: { ...base.sms, body: 'REAL INCIDENT: retained admin wording' },
      },
      variables: DRILL_VARIABLES,
    });
    const sms = mismatched[2];
    if (sms.channel !== 'sms') {
      throw new Error('Expected SMS rendering last.');
    }
    expect(sms.body).toContain('REAL INCIDENT: retained admin wording');
    expect(
      sms.body.startsWith(expectedFrame('drill', 'drill', 'activation').prefix),
    ).toBe(true);
    expect(
      sms.body.endsWith(expectedFrame('drill', 'drill', 'activation').suffix),
    ).toBe(true);
  });

  test('truncates only interiors while preserving both frame edges in all fields', () => {
    for (const [eventKind, mode, variables] of [
      ['incident', 'real', VARIABLES],
      ['drill', 'drill', DRILL_VARIABLES],
    ] as const) {
      for (const purpose of purposes) {
        const base = templateSet(mode, purpose);
        const messages = renderTemplateSet({
          eventKind,
          templates: {
            ...base,
            push: {
              ...base.push,
              title: 'T'.repeat(120),
              body: 'B'.repeat(500),
            },
            email: {
              ...base.email,
              subject: 'S'.repeat(200),
              textBody: 'E'.repeat(10_000),
            },
            sms: { ...base.sms, body: 'M'.repeat(1_000) },
          },
          variables,
        });
        const frame = expectedFrame(eventKind, mode, purpose);
        const [push, email, sms] = messages;
        if (
          push.channel !== 'push' ||
          email.channel !== 'email' ||
          sms.channel !== 'sms'
        ) {
          throw new Error('Expected stable push, email, and SMS ordering.');
        }
        // Headlines carry the compact frame, bodies the full one; truncation
        // still removes only interior, never either owned edge.
        for (const [field, limit, headline] of [
          [push.title, 120, true],
          [push.body, 500, false],
          [email.subject, 200, true],
          [email.textBody, 10_000, false],
        ] as const) {
          expect(field.length).toBeLessThanOrEqual(limit);
          const expected = frameFor({ headline }, eventKind, mode, purpose);
          expect(field.startsWith(expected.prefix)).toBe(true);
          expect(field.endsWith(expected.suffix)).toBe(true);
          expect(field).toContain(`...${expected.suffix}`);
        }
        expect(sms.body.startsWith(frame.prefix)).toBe(true);
        expect(sms.body.endsWith(frame.suffix)).toBe(true);
        expect(sms.body).toContain(`...${frame.suffix}`);
        expect(measureSmsLength(sms.body)).toMatchObject({
          parts: 1,
          exceedsProviderLimit: false,
        });
      }
    }
  });

  test('keeps Unicode SMS truncation grapheme-safe and in one part', () => {
    const base = templateSet('drill', 'reactivation');
    const messages = renderTemplateSet({
      eventKind: 'drill',
      templates: {
        ...base,
        sms: { ...base.sms, body: '避難🚨'.repeat(200) },
      },
      variables: DRILL_VARIABLES,
    });
    const sms = messages[2];
    if (sms.channel !== 'sms') {
      throw new Error('Expected SMS rendering last.');
    }
    const frame = expectedFrame('drill', 'drill', 'reactivation');
    expect(sms.body.startsWith(frame.prefix)).toBe(true);
    expect(sms.body.endsWith(frame.suffix)).toBe(true);
    expect(sms.body).toContain(`...${frame.suffix}`);
    expect(sms.body).not.toContain('\ud83d...');
    expect(measureSmsLength(sms.body)).toMatchObject({
      encoding: 'ucs-2',
      parts: 1,
      exceedsProviderLimit: false,
    });
  });

  test('rejects mode substitution while formatting time deterministically', () => {
    expect(() =>
      renderTemplateSet({
        eventKind: 'incident',
        templates: catalog('drill').activation,
        variables: DRILL_VARIABLES,
      }),
    ).toThrow(TemplateRenderError);
    expect(formatNotificationStartTime('2026-01-15T20:00:00.000Z')).toContain(
      '12:00 PM PST',
    );
    expect(formatNotificationStartTime('2026-07-15T19:00:00.000Z')).toContain(
      '12:00 PM PDT',
    );
    expect(measureSmsLength('[ ]')).toMatchObject({
      encoding: 'gsm-7',
      units: 5,
      parts: 1,
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
        requiresDetail: false,
      },
      name: 'Secure',
      description: null,
      enabled: true,
      templates: catalog('real'),
    };
    const nonAdminStore = new CountingStore();
    await expect(
      executeCreateEventTypeDraftCapability({
        store: nonAdminStore,
        capabilityStore: capabilityStore(nonAdminStore),
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
        capabilityStore: capabilityStore(adminStore),
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
        requiresDetail: false,
      },
      name: 'Medical',
      description: null,
      enabled: true,
      templates: catalog('real'),
    };
    const execute = (
      store: CountingStore,
      authenticated: AuthenticatedEventTypeAgent,
      key: string,
    ) =>
      executeCreateEventTypeDraftCapability({
        store,
        capabilityStore: capabilityStore(store),
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
    ).rejects.toMatchObject({
      name: 'CapabilityEngineError',
      code: 'INTERNAL_ERROR',
      reasonCode: 'PERSISTENCE_CONFLICT',
      message: 'The capability could not be completed.',
      status: 500,
    });
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
      draftRevision: 'a'.repeat(64),
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

  test('calls the configured objects responses everywhere an operator reads', async () => {
    // Routes, API paths, and identifiers keep the event-type names; only the
    // words an operator reads change. The live admin page is asserted by the
    // operator-shell-navigation browser flow.
    expect(
      NAV_DESTINATIONS.find(({ href }) => href === '/event-types')?.label,
    ).toBe('Responses');
    const forbidden = await eventTypeLandingResponse(
      'https://eoc.example.test/event-types',
      authenticatedSession(['staff']),
      new CountingStore(),
    );
    expect(forbidden.status).toBe(403);
    const markup = await forbidden.text();
    expect(markup).toContain('manage responses and message templates');
    expect(markup.toLowerCase()).not.toContain('event type');
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
