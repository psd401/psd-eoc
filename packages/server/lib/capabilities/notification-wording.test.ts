import { describe, expect, test } from 'bun:test';

import { defaultMessageTemplateCatalog } from '../notify/default-templates';
import {
  CONFIRMATION_BOUND_TIME_COPY,
  confirmationBoundTemplates,
  notificationVariables,
  RECORDED_INITIATOR_FALLBACK,
  RECORDED_OPERATOR_FALLBACK,
  type NotificationWording,
} from './notification-wording';

const catalog = defaultMessageTemplateCatalog('drill');

function wording(
  overrides: Partial<NotificationWording> = {},
): NotificationWording {
  return {
    templates: catalog.activation,
    facilityName: 'Harbor Ridge High School',
    eventTypeName: 'Lockdown Drill',
    initiatorDisplayName: 'Taylor Morgan',
    actorDisplayName: 'Jordan Lee',
    ...overrides,
  };
}

describe('confirmation-bound templates', () => {
  test('binds the token for the time the action has not happened yet', () => {
    const activation = confirmationBoundTemplates(catalog.activation);
    expect(activation.push.body).not.toContain('{{startTime}}');
    expect(activation.push.body).toContain(CONFIRMATION_BOUND_TIME_COPY);
    expect(activation.email.textBody).toContain(CONFIRMATION_BOUND_TIME_COPY);
    expect(activation.sms.body).toContain(CONFIRMATION_BOUND_TIME_COPY);

    const allClear = confirmationBoundTemplates(catalog['all-clear']);
    expect(allClear.push.body).not.toContain('{{updatedAt}}');
    expect(allClear.push.body).toContain(CONFIRMATION_BOUND_TIME_COPY);
    // An all-clear's start time is known: it stays a token for the renderer.
    expect(JSON.stringify(allClear)).not.toContain('{{updatedAt}}');
    expect(
      JSON.stringify(confirmationBoundTemplates(catalog.reactivation)),
    ).not.toContain('{{updatedAt}}');
  });
});

describe('notification variables', () => {
  const base = {
    responseDetail: null,
    threat: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Intruder',
      detail: null,
    },
    activatedAt: '2026-09-09T16:01:00.000Z',
  };

  test('an activation names who started the event and never a later action', () => {
    expect(
      notificationVariables({
        wording: wording(),
        purpose: 'activation',
        ...base,
        at: '2026-09-09T16:01:00.000Z',
      }),
    ).toEqual({
      site: 'Harbor Ridge High School',
      eventType: 'Lockdown Drill',
      threat: 'Intruder',
      startTime: '2026-09-09T16:01:00.000Z',
      initiator: 'Taylor Morgan',
    });
  });

  test('a lifecycle action names its actor and time, and the preview leaves the time to the bound copy', () => {
    expect(
      notificationVariables({
        wording: wording({ templates: catalog['all-clear'] }),
        purpose: 'all-clear',
        ...base,
        responseDetail: 'Gym roof',
        at: '2026-09-09T16:06:00.000Z',
      }),
    ).toEqual({
      site: 'Harbor Ridge High School',
      eventType: 'Lockdown Drill — Gym roof',
      threat: 'Intruder',
      startTime: '2026-09-09T16:01:00.000Z',
      initiator: 'Taylor Morgan',
      updatedBy: 'Jordan Lee',
      updatedAt: '2026-09-09T16:06:00.000Z',
    });
    expect(
      notificationVariables({
        wording: wording({ templates: catalog.reactivation }),
        purpose: 'reactivation',
        ...base,
        at: null,
      }),
    ).not.toHaveProperty('updatedAt');
  });

  test('names nobody by a made-up name when the record has no display name', () => {
    const variables = notificationVariables({
      wording: wording({
        templates: catalog['all-clear'],
        initiatorDisplayName: null,
        actorDisplayName: null,
      }),
      purpose: 'all-clear',
      ...base,
      at: '2026-09-09T16:06:00.000Z',
    });
    expect(variables.initiator).toBe(RECORDED_INITIATOR_FALLBACK);
    expect(variables.updatedBy).toBe(RECORDED_OPERATOR_FALLBACK);
  });
});
