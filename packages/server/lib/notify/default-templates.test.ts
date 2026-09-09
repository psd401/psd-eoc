import { describe, expect, test } from 'bun:test';

import {
  defaultMessageTemplateCatalog,
  templateCatalogWording,
} from './default-templates';
import {
  formatNotificationStartTime,
  measureSmsLength,
  renderTemplateSet,
} from './render';

const STARTED = formatNotificationStartTime('2026-09-09T16:01:00.000Z');
const COMPLETED = formatNotificationStartTime('2026-09-09T16:06:00.000Z');

const ACTIVATION_VARIABLES = Object.freeze({
  site: 'Henderson Bay High School',
  eventType: 'Lockdown Drill',
  threat: 'Intruder',
  startTime: '2026-09-09T16:01:00.000Z',
  initiator: 'Jordan Rivera',
});

describe('default message templates', () => {
  test('are valid for both modes and differ only in mode and marker', () => {
    const drill = defaultMessageTemplateCatalog('drill');
    const real = defaultMessageTemplateCatalog('real');
    expect(drill.activation.push.classificationMarker).toBe('DRILL');
    expect(real.activation.push.classificationMarker).toBe('INCIDENT');
    expect(templateCatalogWording(drill)).toBe(templateCatalogWording(real));
  });

  test('render the wording chosen on 2026-09-09: response and school first, then who and when', () => {
    const drill = defaultMessageTemplateCatalog('drill');
    const activation = renderTemplateSet({
      eventKind: 'drill',
      templates: drill.activation,
      variables: ACTIVATION_VARIABLES,
    });
    expect(activation).toMatchObject([
      {
        channel: 'push',
        title: '[DRILL] Lockdown Drill at Henderson Bay High School',
        body: `[DRILL] Started by Jordan Rivera at ${STARTED}. Threat: Intruder. Open PSD EOC for current instructions.`,
      },
      {
        channel: 'email',
        subject: '[DRILL] Lockdown Drill at Henderson Bay High School',
        textBody: `[DRILL] Lockdown Drill at Henderson Bay High School has been started by Jordan Rivera.\nLocation: Henderson Bay High School\nThreat: Intruder\nTime: ${STARTED}\n\nOpen PSD EOC for current instructions. Call 911 first when emergency assistance is needed.`,
      },
      {
        channel: 'sms',
        body: `[DRILL] Lockdown Drill at Henderson Bay High School started by Jordan Rivera, ${STARTED}. Threat: Intruder. Open PSD EOC.`,
      },
    ]);

    const allClear = renderTemplateSet({
      eventKind: 'incident',
      templates: defaultMessageTemplateCatalog('real')['all-clear'],
      variables: {
        ...ACTIVATION_VARIABLES,
        eventType: 'Lockdown',
        updatedBy: 'Emily Scheutzow',
        updatedAt: '2026-09-09T16:06:00.000Z',
      },
    });
    expect(allClear).toMatchObject([
      {
        channel: 'push',
        title: '[INCIDENT] ALL CLEAR: Lockdown at Henderson Bay High School',
        body: `[INCIDENT] ALL CLEAR: Completed by Emily Scheutzow at ${COMPLETED}. Open PSD EOC for current information.`,
      },
      {
        channel: 'email',
        subject: '[INCIDENT] ALL CLEAR: Lockdown at Henderson Bay High School',
        textBody: `[INCIDENT] ALL CLEAR: Emily Scheutzow has completed Lockdown at Henderson Bay High School.\nEvent completed: ${COMPLETED}\nLocation: Henderson Bay High School\n\nOpen PSD EOC for current information.`,
      },
      {
        channel: 'sms',
        body: `[INCIDENT] ALL CLEAR: Lockdown at Henderson Bay High School completed by Emily Scheutzow, ${COMPLETED}. Open PSD EOC.`,
      },
    ]);
  });

  test('keep an ordinary SMS inside one part, and truncate only the tail of a long one', () => {
    const sms = renderTemplateSet({
      eventKind: 'drill',
      templates: defaultMessageTemplateCatalog('drill').activation,
      variables: ACTIVATION_VARIABLES,
    }).find((message) => message.channel === 'sms');
    if (sms?.channel !== 'sms') throw new Error('Expected an SMS rendering.');
    expect(measureSmsLength(sms.body)).toMatchObject({
      encoding: 'gsm-7',
      parts: 1,
    });

    const long = renderTemplateSet({
      eventKind: 'drill',
      templates: defaultMessageTemplateCatalog('drill').activation,
      variables: {
        ...ACTIVATION_VARIABLES,
        site: 'Educational Service Center',
        eventType: 'Modified Lockdown Drill',
        threat: 'Neighborhood Police Activity',
        initiator: 'Emily Scheutzow',
      },
    }).find((message) => message.channel === 'sms');
    if (long?.channel !== 'sms') throw new Error('Expected an SMS rendering.');
    expect(measureSmsLength(long.body).parts).toBe(1);
    expect(long.body).toStartWith(
      `[DRILL] Modified Lockdown Drill at Educational Service Center started by Emily Scheutzow, ${STARTED}.`,
    );
    expect(long.body).toEndWith('...');
  });
});
