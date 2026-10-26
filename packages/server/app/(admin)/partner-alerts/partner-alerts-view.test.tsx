import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PARTNER_ALERT_SETTINGS,
  PartnerAlertSettingsStateSchema,
  type PartnerAlertSettingsState,
} from '@psd-eoc/contracts';
import { renderToStaticMarkup } from 'react-dom/server';

import { AdminForm } from '../facilities/admin-request';
import { parsePartnerAlertSettingsForm } from './api/request';
import { partnerAlertsStatusMessage } from './page-state';
import {
  NON_ADMIN_PARTNER_ALERTS_VIEW,
  PartnerAlertsAdminView,
} from './partner-alerts-view';

const VERSION_ID = '00000000-0000-4000-8000-000000005974';
const ADMIN_ID = '00000000-0000-4000-8000-000000005975';
const AT = '2026-10-26T12:00:00.000Z';

const OPTIONS = {
  responseOptions: [
    { familyKey: 'modified-lockdown', name: 'Modified Lockdown' },
    { familyKey: 'lockdown', name: 'Lockdown' },
    { familyKey: 'evacuation', name: 'Evacuation' },
  ],
  threatOptions: [
    { key: 'synthetic-wildlife', name: 'Synthetic wildlife', active: true },
    { key: 'synthetic-retired', name: 'Synthetic retired', active: false },
    { key: 'synthetic-gone', name: 'Synthetic gone', active: false },
  ],
};

const DEFAULTS = PartnerAlertSettingsStateSchema.parse({
  current: null,
  effective: DEFAULT_PARTNER_ALERT_SETTINGS,
  ...OPTIONS,
});

function render(state: PartnerAlertSettingsState): string {
  return renderToStaticMarkup(
    <PartnerAlertsAdminView
      csrfToken="synthetic-csrf-token"
      view={{ kind: 'authorized', state }}
    />,
  );
}

function checkbox(html: string, name: string, value: string): string {
  const match = new RegExp(
    `<input[^>]*name="${name}"[^>]*value="${value}"[^>]*/>`,
    'u',
  ).exec(html);
  if (match === null) throw new Error(`No ${name} checkbox for ${value}.`);
  return match[0];
}

function form(entries: readonly (readonly [string, string])[]): AdminForm {
  return new AdminForm(
    new URLSearchParams([
      ['csrfToken', 'synthetic-csrf-token'],
      ['idempotencyKey', 'synthetic-key'],
      ['intent', 'set-partner-alert-settings'],
      ...entries.map(([name, value]): string[] => [name, value]),
    ]),
  );
}

describe('partner alerts admin view', () => {
  test('before any save, the default responses are checked and no base version is sent', () => {
    const html = render(DEFAULTS);
    expect(html).toContain('Default settings in effect.');
    expect(checkbox(html, 'responseFamilyKeys', 'lockdown')).toContain(
      'checked',
    );
    expect(checkbox(html, 'responseFamilyKeys', 'modified-lockdown')).toContain(
      'checked',
    );
    expect(checkbox(html, 'responseFamilyKeys', 'evacuation')).not.toContain(
      'checked',
    );
    expect(html).toContain('name="baseVersionId" value=""');
    expect(html).toContain('Drills never alert partners.');
    // Delivery lands in a later change; the page must not imply it is live.
    expect(html).toContain('Partner alert delivery is not turned on yet.');
  });

  test('shows the saved version and keeps a retired threat that is still excluded', () => {
    const html = render(
      PartnerAlertSettingsStateSchema.parse({
        current: {
          id: VERSION_ID,
          version: 3,
          responseFamilyKeys: ['evacuation'],
          excludedThreatKeys: ['synthetic-retired'],
          supersedesVersionId: '00000000-0000-4000-8000-000000005976',
          createdByUserId: ADMIN_ID,
          createdAt: AT,
        },
        effective: {
          responseFamilyKeys: ['evacuation'],
          excludedThreatKeys: ['synthetic-retired'],
        },
        ...OPTIONS,
      }),
    );
    expect(html).toContain('Version 3 in effect');
    expect(html).toContain(`name="baseVersionId" value="${VERSION_ID}"`);
    expect(checkbox(html, 'responseFamilyKeys', 'evacuation')).toContain(
      'checked',
    );
    expect(checkbox(html, 'responseFamilyKeys', 'lockdown')).not.toContain(
      'checked',
    );
    expect(checkbox(html, 'excludedThreatKeys', 'synthetic-retired')).toContain(
      'checked',
    );
    expect(html).toContain('Synthetic retired (retired)');
    // A retired threat nobody excluded is not offered.
    expect(html).not.toContain('Synthetic gone');
  });

  test('a saved response with no published version stays checked and can be removed', () => {
    const html = render(
      PartnerAlertSettingsStateSchema.parse({
        current: null,
        effective: {
          responseFamilyKeys: ['lockdown', 'unpublished-family'],
          excludedThreatKeys: [],
        },
        ...OPTIONS,
      }),
    );
    expect(
      checkbox(html, 'responseFamilyKeys', 'unpublished-family'),
    ).toContain('checked');
    expect(html).toContain('unpublished-family (no published response)');
  });

  test('a non-administrator sees the refusal and no settings', () => {
    const html = renderToStaticMarkup(
      <PartnerAlertsAdminView view={NON_ADMIN_PARTNER_ALERTS_VIEW} />,
    );
    expect(html).toContain('Administrator access required');
    expect(html).not.toContain('responseFamilyKeys');
  });

  test('status messages are allowlisted', () => {
    expect(partnerAlertsStatusMessage('settings-saved')).toContain('saved');
    expect(partnerAlertsStatusMessage('toString')).toBeNull();
    expect(partnerAlertsStatusMessage(['settings-saved'])).toBeNull();
  });
});

describe('partner alerts form', () => {
  test('reads every checked response and threat and the base version', () => {
    expect(
      parsePartnerAlertSettingsForm(
        form([
          ['baseVersionId', VERSION_ID],
          ['responseFamilyKeys', 'lockdown'],
          ['responseFamilyKeys', 'modified-lockdown'],
          ['excludedThreatKeys', 'synthetic-wildlife'],
        ]),
      ),
    ).toEqual({
      responseFamilyKeys: ['lockdown', 'modified-lockdown'],
      excludedThreatKeys: ['synthetic-wildlife'],
      baseVersionId: VERSION_ID,
    });
  });

  test('nothing checked and no saved version is a valid save', () => {
    expect(
      parsePartnerAlertSettingsForm(form([['baseVersionId', '']])),
    ).toEqual({
      responseFamilyKeys: [],
      excludedThreatKeys: [],
      baseVersionId: null,
    });
  });

  test('refuses an unexpected field', () => {
    expect(() =>
      parsePartnerAlertSettingsForm(
        form([
          ['baseVersionId', ''],
          ['channels', 'email'],
        ]),
      ),
    ).toThrow('The administration form is invalid.');
  });
});
