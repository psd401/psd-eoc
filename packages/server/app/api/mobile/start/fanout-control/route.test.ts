import { describe, expect, test } from 'bun:test';

import { FanoutStatusSchema, HUMAN_ONLY_ACTION_IDS } from '@psd-eoc/contracts';

import {
  SessionAccessError,
  type AuthenticatedSession,
} from '../../../../../lib/auth/sessions';
import {
  handleGetMobileFanoutControl,
  type MobileFanoutControlRouteRuntime,
} from './runtime';

const IDS = {
  user: '52000000-0000-4000-8000-000000000001',
  session: '52000000-0000-4000-8000-000000000002',
  request: '52000000-0000-4000-8000-000000000003',
  record: '52000000-0000-4000-8000-000000000004',
  epoch: '52000000-0000-4000-8000-000000000005',
} as const;

const NOW = new Date('2026-08-12T18:00:00.000Z');
const SESSION_TOKEN = 'B'.repeat(43);

function authenticated(): AuthenticatedSession {
  return {
    actor: { kind: 'human', userId: IDS.user, sessionId: IDS.session },
    source: 'mobile',
    roles: ['staff'],
    scope: { facilityScope: { kind: 'district' } },
  } as unknown as AuthenticatedSession;
}

function currentEnabledState() {
  return FanoutStatusSchema.parse({ status: 'enabled' });
}

function testRuntime(input: {
  readonly state?: unknown;
  readonly executionError?: unknown;
  readonly authenticationError?: unknown;
}) {
  const calls: string[] = [];
  const runtime: MobileFanoutControlRouteRuntime = {
    createRequestId: () => IDS.request,
    now: () => NOW,
    async authenticate() {
      calls.push('authenticate');
      if (input.authenticationError !== undefined) {
        throw input.authenticationError;
      }
      return authenticated();
    },
    async execute(authenticatedSession, capabilityInput, metadata) {
      calls.push('execute');
      expect(authenticatedSession).toEqual(authenticated());
      expect(capabilityInput).toEqual({});
      expect(metadata).toEqual({ requestId: IDS.request, now: NOW });
      if (input.executionError !== undefined) throw input.executionError;
      return input.state;
    },
  };
  return { calls, runtime };
}

function request(
  path = '/api/mobile/start/fanout-control',
  init: RequestInit = {},
): Request {
  return new Request(`https://eoc.example.test${path}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${SESSION_TOKEN}` },
    ...init,
  });
}

describe('mobile fanout-control status route', () => {
  test('returns only canonical authenticated GET status without caching', async () => {
    const state = currentEnabledState();
    const { calls, runtime } = testRuntime({ state });

    const response = await handleGetMobileFanoutControl(request(), runtime);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Authorization, Cookie');
    expect(await response.json()).toEqual(state);
    expect(calls).toEqual(['authenticate', 'execute']);

    const serialized = JSON.stringify(state);
    for (const forbiddenField of [
      'currentRecord',
      'currentEpochId',
      'reason',
      'reasonCode',
      'productOwnerApprovalReference',
      'changedByUserId',
      'changedWithSessionId',
      'requestId',
      'changedAt',
      'previousRecordId',
      'revision',
      'enableEpochId',
      IDS.record,
      IDS.epoch,
    ]) {
      expect(serialized).not.toContain(forbiddenField);
    }
    expect(serialized).not.toContain('capabilityId');
    for (const actionId of HUMAN_ONLY_ACTION_IDS) {
      expect(serialized).not.toContain(actionId);
    }
  });

  test('turns unreadable or malformed state into canonical unavailable fail-closed status', async () => {
    const privateMarker = 'private-admin-provenance-must-not-cross';
    for (const input of [
      { executionError: new Error('Synthetic database failure.') },
      { state: { kind: 'current', effectiveMode: 'enabled' } },
      {
        state: {
          status: 'enabled',
          currentRecord: {
            id: IDS.record,
            reason: privateMarker,
            productOwnerApprovalReference: privateMarker,
            changedByUserId: IDS.user,
            changedWithSessionId: IDS.session,
            requestId: IDS.request,
            changedAt: NOW.toISOString(),
          },
        },
      },
    ]) {
      const { runtime } = testRuntime(input);
      const response = await handleGetMobileFanoutControl(request(), runtime);

      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({
        status: 'unavailable',
      });
      expect(JSON.stringify(payload)).not.toContain(privateMarker);
    }
  });

  test('authenticates first and rejects every mutation-shaped request', async () => {
    for (const invalidRequest of [
      request('/api/mobile/start/fanout-control?mode=enabled'),
      request('/api/mobile/start/fanout-control', { method: 'POST' }),
      request('/api/mobile/start/fanout-control', {
        headers: {
          authorization: `Bearer ${SESSION_TOKEN}`,
          'idempotency-key': 'not-permitted-on-read',
        },
      }),
      request('/api/mobile/start/fanout-control', {
        headers: {
          authorization: `Bearer ${SESSION_TOKEN}`,
          'human-confirmation-id': IDS.record,
        },
      }),
    ]) {
      const { calls, runtime } = testRuntime({ state: currentEnabledState() });
      const response = await handleGetMobileFanoutControl(
        invalidRequest,
        runtime,
      );

      expect(response.status).toBe(400);
      expect(calls).toEqual(['authenticate']);
    }
  });

  test('never reads state for an unauthenticated request', async () => {
    const { calls, runtime } = testRuntime({
      authenticationError: new SessionAccessError(
        'INVALID_CREDENTIAL',
        'Authentication is required.',
      ),
    });
    const response = await handleGetMobileFanoutControl(request(), runtime);

    expect(response.status).toBe(401);
    expect(calls).toEqual(['authenticate']);
  });
});
