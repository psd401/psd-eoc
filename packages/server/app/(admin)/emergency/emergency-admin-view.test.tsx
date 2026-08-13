import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { FanoutControlEffectiveStateSchema } from '@psd-eoc/contracts';

import {
  EmergencyAdminView,
  NON_ADMIN_EMERGENCY_VIEW,
} from './emergency-admin-view';

const CSRF = 'synthetic-csrf-token';
const IDS = {
  record: '00000000-0000-4000-8000-000000003460',
  epoch: '00000000-0000-4000-8000-000000003461',
  user: '00000000-0000-4000-8000-000000003462',
  session: '00000000-0000-4000-8000-000000003463',
  request: '00000000-0000-4000-8000-000000003464',
} as const;

function enabledState() {
  return FanoutControlEffectiveStateSchema.parse({
    kind: 'current',
    effectiveMode: 'enabled',
    currentEpochId: IDS.epoch,
    currentRecord: {
      id: IDS.record,
      revision: 4,
      previousRecordId: '00000000-0000-4000-8000-000000003459',
      mode: 'enabled',
      enableEpochId: IDS.epoch,
      reason: 'Synthetic recovery verification completed.',
      productOwnerApprovalReference: 'synthetic-po-reference',
      changedByUserId: IDS.user,
      changedWithSessionId: IDS.session,
      changedAt: '2026-08-12T18:30:00.000Z',
      requestId: IDS.request,
    },
  });
}

describe('EmergencyAdminView authorization boundary', () => {
  test('forbidden shape cannot carry control evidence or forms', () => {
    const html = renderToStaticMarkup(
      <EmergencyAdminView view={NON_ADMIN_EMERGENCY_VIEW} />,
    );
    expect(Object.isFrozen(NON_ADMIN_EMERGENCY_VIEW)).toBe(true);
    expect(html).toContain('Administrator access required');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('synthetic-po-reference');
  });
});

describe('EmergencyAdminView consequence previews', () => {
  test('renders prominent current state and two CSRF-protected POST forms', () => {
    const html = renderToStaticMarkup(
      <EmergencyAdminView
        csrfToken={CSRF}
        view={{ kind: 'authorized', state: enabledState() }}
      />,
    );
    expect(html).toContain('Notification fan-out is enabled');
    expect(html).toContain('Consequence preview');
    expect(html).toContain('immediately blocks new notification previews');
    expect(html).toContain('Re-enabling creates a fresh epoch');
    expect(html).toContain('do not self-approve');
    expect(html).toContain('synthetic-po-reference');
    expect(html).toContain(IDS.epoch);
    expect(
      html.match(/<form action="\/emergency\/api" method="post">/gu),
    ).toHaveLength(2);
    expect(html.match(/name="csrfToken"/gu)).toHaveLength(2);
    expect(html.match(/value="synthetic-csrf-token"/gu)).toHaveLength(2);
    expect(html.match(/name="idempotencyKey"/gu)).toHaveLength(2);
    expect(html).not.toContain('name="enableEpochId"');
    expect(html).not.toContain('start a real incident');
  });

  test('makes missing persistence unmistakably disabled', () => {
    const state = FanoutControlEffectiveStateSchema.parse({
      kind: 'missing',
      effectiveMode: 'emergency-disabled',
      currentEpochId: null,
      currentRecord: null,
      reasonCode: 'CONTROL_STATE_MISSING',
    });
    const html = renderToStaticMarkup(
      <EmergencyAdminView
        csrfToken={CSRF}
        view={{ kind: 'authorized', state }}
      />,
    );
    expect(html).toContain(
      'EMERGENCY DISABLE ACTIVE — notification fan-out is blocked',
    );
    expect(html).toContain('CONTROL_STATE_MISSING');
    expect(html).toContain('fail-closed');
  });
});
