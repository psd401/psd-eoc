import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  FanoutControlEffectiveStateSchema,
  type FanoutControlEffectiveState,
} from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../../lib/auth/sessions';
import {
  FanoutControlBanner,
  loadFanoutControlBannerState,
} from './fanout-control-banner';
import {
  OperationalLayoutFrame,
  loadOperationalFanoutControlState,
  type OperationalFanoutControlDependencies,
} from './layout';

const IDS = {
  record: '00000000-0000-4000-8000-000000003480',
  previousRecord: '00000000-0000-4000-8000-000000003481',
  epoch: '00000000-0000-4000-8000-000000003482',
  user: '00000000-0000-4000-8000-000000003483',
  session: '00000000-0000-4000-8000-000000003484',
  request: '00000000-0000-4000-8000-000000003485',
} as const;

function currentState(
  mode: 'enabled' | 'emergency-disabled',
): FanoutControlEffectiveState {
  const enabled = mode === 'enabled';
  return FanoutControlEffectiveStateSchema.parse({
    kind: 'current',
    effectiveMode: mode,
    currentEpochId: enabled ? IDS.epoch : null,
    currentRecord: {
      id: IDS.record,
      revision: 2,
      previousRecordId: IDS.previousRecord,
      mode,
      enableEpochId: enabled ? IDS.epoch : null,
      reason: enabled
        ? 'Synthetic recovery verification completed.'
        : 'Synthetic provider outcome is uncertain.',
      productOwnerApprovalReference: enabled
        ? 'synthetic-product-owner-reference'
        : null,
      changedByUserId: IDS.user,
      changedWithSessionId: IDS.session,
      changedAt: '2026-08-12T21:00:00.000Z',
      requestId: IDS.request,
    },
  });
}

function missingState(): FanoutControlEffectiveState {
  return FanoutControlEffectiveStateSchema.parse({
    kind: 'missing',
    effectiveMode: 'emergency-disabled',
    currentEpochId: null,
    currentRecord: null,
    reasonCode: 'CONTROL_STATE_MISSING',
  });
}

function authenticated(
  source: AuthenticatedSession['source'] = 'web',
): AuthenticatedSession {
  return {
    actor: { kind: 'human', userId: IDS.user, sessionId: IDS.session },
    source,
    roles: ['staff'],
    scope: { facilityScope: { kind: 'district' } },
  } as unknown as AuthenticatedSession;
}

describe('FanoutControlBanner', () => {
  test('renders nothing only for canonical current enabled truth', () => {
    expect(
      renderToStaticMarkup(
        <FanoutControlBanner state={currentState('enabled')} />,
      ),
    ).toBe('');
  });

  test('makes emergency disable prominent without claiming a send or changing classification', () => {
    const html = renderToStaticMarkup(
      <FanoutControlBanner state={currentState('emergency-disabled')} />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('data-fanout-control-state="disabled"');
    expect(html).toContain('Emergency notification sending is disabled');
    expect(html).toContain('will refuse new notification previews');
    expect(html).toContain('This status banner did not send a notification');
    expect(html).toContain(
      'Real incidents remain real and drills remain drills',
    );
    expect(html).toContain('background-color:#7f1d1d');
    expect(html).toContain('color:#ffffff');
    expect(html).not.toContain('Synthetic provider outcome is uncertain');
    expect(html).not.toContain('synthetic-product-owner-reference');
  });

  test('makes missing control truth honestly unavailable and fail-closed', () => {
    const html = renderToStaticMarkup(
      <FanoutControlBanner state={missingState()} />,
    );

    expect(html).toContain('data-fanout-control-state="unavailable"');
    expect(html).toContain(
      'Notification status unavailable — sending is blocked',
    );
    expect(html).toContain(
      'cannot prove the current notification fan-out state',
    );
    expect(html).toContain('CONTROL_STATE_MISSING');
    expect(html).not.toContain('Notification fan-out is enabled');
  });

  test('places the alert before every authenticated route child', () => {
    const html = renderToStaticMarkup(
      <OperationalLayoutFrame fanoutControlState={missingState()}>
        <main id="main-content">Synthetic operational route</main>
      </OperationalLayoutFrame>,
    );

    expect(html).toContain('<html lang="en">');
    expect(html).toContain('href="#main-content"');
    expect(html.indexOf('role="alert"')).toBeGreaterThan(-1);
    expect(html.indexOf('role="alert"')).toBeLessThan(
      html.indexOf('<main id="main-content">'),
    );
  });
});

describe('loadFanoutControlBannerState', () => {
  test('revalidates canonical state returned by the capability reader', async () => {
    const expected = currentState('emergency-disabled');
    await expect(
      loadFanoutControlBannerState(async () => expected),
    ).resolves.toEqual(expected);
  });

  test('fails closed without reflecting a database error', async () => {
    const secretErrorText = 'must-not-be-reflected-database-detail';
    const state = await loadFanoutControlBannerState(async () => {
      throw new Error(secretErrorText);
    });

    expect(state).toEqual({
      kind: 'unavailable',
      effectiveMode: 'emergency-disabled',
      currentEpochId: null,
      currentRecord: null,
      reasonCode: 'CONTROL_STATE_UNREADABLE',
    });
    expect(JSON.stringify(state)).not.toContain(secretErrorText);
  });

  test('fails closed on malformed or permissive noncanonical state', async () => {
    const state = await loadFanoutControlBannerState(async () => ({
      kind: 'current',
      effectiveMode: 'enabled',
      currentEpochId: null,
      currentRecord: null,
    }));

    expect(state.effectiveMode).toBe('emergency-disabled');
    expect(state.kind).toBe('unavailable');
  });
});

describe('loadOperationalFanoutControlState', () => {
  function dependencies(input: {
    readonly sessionToken?: string;
    readonly authenticated?: AuthenticatedSession;
    readonly state?: unknown;
  }): Readonly<{
    calls: string[];
    value: OperationalFanoutControlDependencies;
  }> {
    const calls: string[] = [];
    return {
      calls,
      value: {
        async readSessionToken() {
          calls.push('read-session-token');
          return input.sessionToken;
        },
        async authenticate(sessionToken) {
          calls.push(`authenticate:${sessionToken}`);
          return input.authenticated ?? authenticated();
        },
        async execute(value) {
          calls.push(`execute:${value.source}:${value.actor.kind}`);
          return input.state;
        },
      },
    };
  }

  test('authenticates web human provenance before the canonical query', async () => {
    const expected = currentState('emergency-disabled');
    const fixture = dependencies({
      sessionToken: 'synthetic-session-token',
      authenticated: authenticated('web'),
      state: expected,
    });

    await expect(
      loadOperationalFanoutControlState(fixture.value),
    ).resolves.toEqual(expected);
    expect(fixture.calls).toEqual([
      'read-session-token',
      'authenticate:synthetic-session-token',
      'execute:web:human',
    ]);
  });

  test('does not query control truth without an authenticated session', async () => {
    const fixture = dependencies({ state: currentState('enabled') });

    const state = await loadOperationalFanoutControlState(fixture.value);
    expect(state.effectiveMode).toBe('emergency-disabled');
    expect(state.kind).toBe('unavailable');
    expect(fixture.calls).toEqual(['read-session-token']);
  });

  test('denies mobile provenance at the web layout boundary', async () => {
    const fixture = dependencies({
      sessionToken: 'synthetic-session-token',
      authenticated: authenticated('mobile'),
      state: currentState('enabled'),
    });

    const state = await loadOperationalFanoutControlState(fixture.value);
    expect(state.effectiveMode).toBe('emergency-disabled');
    expect(state.kind).toBe('unavailable');
    expect(fixture.calls).toEqual([
      'read-session-token',
      'authenticate:synthetic-session-token',
    ]);
  });
});
