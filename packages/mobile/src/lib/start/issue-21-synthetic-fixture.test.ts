import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  ActivationPreviewSchema,
  CreateActivationPreviewInputSchema,
  FacilityPageSchema,
  type CreateActivationPreviewInput,
} from '@psd-eoc/contracts';

import type { AuthenticatedRequestOptions } from '../api';
import { MobileAuthController, type AuthTimer } from '../auth/auth-controller';
import { OfflineMutationDeniedError } from '../auth/auth-errors';
import {
  activate,
  createPreview,
  join,
  loadStartHomeData,
  type StartAuthenticatedRequest,
} from './start-api-client';
import {
  createIssue21SyntheticAuthFixture,
  createIssue21SyntheticFixtureTransport,
} from './issue-21-synthetic-fixture';

const FIXTURE_NOW = new Date('2026-08-11T18:00:00.000Z');
const IDEMPOTENCY_KEY = 'issue-21-synthetic-idempotency-0001';
const PREVIEW_IDEMPOTENCY_KEY = 'issue-21-synthetic-preview-idempotency-0001';
const originalFixture = process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE;
const developmentGlobal = globalThis as typeof globalThis & {
  __DEV__?: boolean;
};
const originalDevelopment = developmentGlobal.__DEV__;
const inertTimer: AuthTimer = Object.freeze({
  schedule: () => 1,
  cancel: () => {},
});

beforeAll(() => {
  developmentGlobal.__DEV__ = true;
  process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE = 'issue-21';
});

afterAll(() => {
  if (originalFixture === undefined) {
    delete process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE;
  } else {
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE = originalFixture;
  }
  if (originalDevelopment === undefined) {
    delete developmentGlobal.__DEV__;
  } else {
    developmentGlobal.__DEV__ = originalDevelopment;
  }
});

function fixtureRequest(): StartAuthenticatedRequest {
  const transport = createIssue21SyntheticFixtureTransport(
    () => new Date(FIXTURE_NOW),
  );
  return (input) =>
    transport.request(
      'synthetic-test-bearer',
      input,
      new AbortController().signal,
    );
}

function selection(
  facilityId: string,
  eventTypeVersionId: string,
): CreateActivationPreviewInput {
  return CreateActivationPreviewInputSchema.parse({
    facilityId,
    kind: 'drill',
    templateMode: 'drill',
    eventTypeVersion: {
      id: eventTypeVersionId,
      templateMode: 'drill',
    },
    rosterPopulation: 'synthetic',
  });
}

describe('issue-21 synthetic Maestro transport', () => {
  test('is unavailable outside an explicitly flagged development build', async () => {
    const transport = createIssue21SyntheticFixtureTransport(
      () => new Date(FIXTURE_NOW),
    );
    developmentGlobal.__DEV__ = false;
    try {
      await expect(
        transport.request(
          'synthetic-test-bearer',
          {
            method: 'GET',
            path: '/api/mobile/start/facilities',
            schema: FacilityPageSchema,
          },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(TypeError);
    } finally {
      developmentGlobal.__DEV__ = true;
    }

    const enabledFixture = process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE;
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE = 'unexpected';
    try {
      expect(() =>
        createIssue21SyntheticAuthFixture('ios', () => new Date(FIXTURE_NOW)),
      ).toThrow(TypeError);
    } finally {
      process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE = enabledFixture;
    }
  });

  test('seeds only contract-valid, biometric native sessions in memory', async () => {
    for (const platform of ['ios', 'android'] as const) {
      const fixture = createIssue21SyntheticAuthFixture(
        platform,
        () => new Date(FIXTURE_NOW),
      );
      expect(await fixture.storage.hasEnrollment()).toBe(true);
      const vault = await fixture.storage.readVault();
      expect(vault?.session.deviceEnrollment.platform).toBe(platform);
      expect(vault?.session.deviceEnrollment.unlockMethod).toBe('biometric');
      expect(vault?.session.user.facilityScope).toEqual({
        kind: 'facilities',
        facilityIds: ['71000000-0000-4000-8000-000000000001'],
      });
      expect(vault?.session.user.email).toBe('synthetic.staff@example.invalid');
      expect(
        Date.parse(vault?.session.session.expiresAt ?? '') >
          FIXTURE_NOW.getTime(),
      ).toBe(true);
    }
  });

  test('requires local device authentication before any synthetic request', async () => {
    const fixture = createIssue21SyntheticAuthFixture(
      'ios',
      () => new Date(FIXTURE_NOW),
    );
    const fixtureTransport = createIssue21SyntheticFixtureTransport(
      () => new Date(FIXTURE_NOW),
    );
    let authenticationCount = 0;
    let transportCount = 0;
    const auth = new MobileAuthController({
      api: fixture.api,
      storage: fixture.storage,
      localAuthenticator: {
        async authenticate() {
          authenticationCount += 1;
          return authenticationCount === 1
            ? {
                success: false as const,
                message: 'PSD EOC remains locked.',
              }
            : { success: true as const };
        },
      },
      authenticatedApi: {
        async request<Output>(
          bearer: string,
          input: AuthenticatedRequestOptions<Output>,
          signal: AbortSignal,
        ): Promise<Output> {
          transportCount += 1;
          return fixtureTransport.request(bearer, input, signal);
        },
      },
      createIdempotencyKey: () => 'issue-21-synthetic-refresh-idempotency-0001',
      now: () => new Date(FIXTURE_NOW),
      timer: inertTimer,
    });

    await auth.bootstrap();
    expect(auth.getSnapshot().phase).toBe('locked');
    await auth.foreground();
    expect(auth.getSnapshot().phase).toBe('locked');
    expect(auth.getSnapshot().session).toBeNull();
    await expect(
      auth.requestAuthenticated({
        method: 'GET',
        path: '/api/mobile/start/facilities',
        schema: FacilityPageSchema,
      }),
    ).rejects.toBeInstanceOf(OfflineMutationDeniedError);
    expect(transportCount).toBe(0);

    await auth.foreground();
    expect(authenticationCount).toBe(2);
    expect(auth.getSnapshot().phase).toBe('online');
    const response = await auth.requestAuthenticated({
      method: 'GET',
      path: '/api/mobile/start/facilities',
      schema: FacilityPageSchema,
    });
    expect(response.items).toHaveLength(1);
    expect(transportCount).toBe(1);

    await auth.signOut();
    expect(auth.getSnapshot().phase).toBe('signed-out');
    expect(await fixture.storage.hasEnrollment()).toBe(false);
  });

  test('rotates locally, replays an exact refresh, and rejects stale or aborted refreshes', async () => {
    const fixture = createIssue21SyntheticAuthFixture(
      'android',
      () => new Date(FIXTURE_NOW),
    );
    const original = await fixture.storage.readVault();
    if (original === null) {
      throw new Error('The synthetic enrollment was not seeded.');
    }
    const key = 'issue-21-synthetic-refresh-idempotency-0001';
    const first = await fixture.api.refresh(
      original.refreshToken,
      key,
      new AbortController().signal,
    );
    const replay = await fixture.api.refresh(
      original.refreshToken,
      key,
      new AbortController().signal,
    );
    expect(replay).toEqual(first);
    expect(first.refreshToken).not.toBe(original.refreshToken);
    expect(first.session.connectivityEpoch.id).not.toBe(
      original.session.connectivityEpoch.id,
    );

    await expect(
      fixture.api.refresh(
        original.refreshToken,
        'issue-21-synthetic-refresh-idempotency-0002',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: 'rejected' });

    const abortController = new AbortController();
    abortController.abort();
    await expect(
      fixture.api.refresh(
        first.refreshToken,
        'issue-21-synthetic-refresh-idempotency-0003',
        abortController.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('runs the complete three-tap data path without a provider transport', async () => {
    const request = fixtureRequest();
    const home = await loadStartHomeData(request);
    expect(home.facilities).toHaveLength(1);
    expect(home.eventTypes).toHaveLength(1);
    expect(home.activeEvents).toHaveLength(1);

    const facility = home.facilities[0];
    const eventType = home.eventTypes[0];
    const activeEvent = home.activeEvents[0];
    if (
      facility === undefined ||
      eventType === undefined ||
      activeEvent === undefined
    ) {
      throw new Error('The exact synthetic fixture was not loaded.');
    }
    const preview = await createPreview(
      request,
      selection(facility.id, eventType.latestVersion.id),
      PREVIEW_IDEMPOTENCY_KEY,
    );
    expect(preview.rosterPopulation).toBe('synthetic');
    expect(
      preview.channels.every(
        (item) => item.integrationStatus.label === 'mocked',
      ),
    ).toBe(true);
    expect(preview.activeEventIds).toEqual([activeEvent.event.id]);

    const result = await activate(request, preview, IDEMPOTENCY_KEY);
    expect(result.event.templateMode).toBe('drill');
    expect(result.event.rosterPopulation).toBe('synthetic');
    expect(result.event.activationAuthorization?.kind).toBe(
      'synthetic-training',
    );
    expect(
      result.notificationIntent?.channels.every(
        (item) => item.integrationStatus.label === 'mocked',
      ),
    ).toBe(true);

    await expect(activate(request, preview, IDEMPOTENCY_KEY)).resolves.toEqual(
      result,
    );
  });

  test('joins the exact seeded event without creating notification truth', async () => {
    const request = fixtureRequest();
    const home = await loadStartHomeData(request);
    const event = home.activeEvents[0]?.event;
    if (event === undefined) {
      throw new Error('The seeded synthetic event was not loaded.');
    }

    const result = await join(request, event, IDEMPOTENCY_KEY);

    expect(result.event).toEqual(event);
    expect(result.joined).toBe(true);
  });

  test('fails closed for real, staff, or unexpected operational requests', async () => {
    const transport = createIssue21SyntheticFixtureTransport(
      () => new Date(FIXTURE_NOW),
    );

    await expect(
      transport.request(
        'synthetic-test-bearer',
        {
          method: 'POST',
          path: '/api/mobile/start/preview',
          body: {
            facilityId: '71000000-0000-4000-8000-000000000001',
            kind: 'incident',
            templateMode: 'real',
            eventTypeVersion: {
              id: '71000000-0000-4000-8000-000000000003',
              templateMode: 'real',
            },
            rosterPopulation: 'staff',
          },
          idempotencyKey: PREVIEW_IDEMPOTENCY_KEY,
          schema: ActivationPreviewSchema,
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      transport.request(
        'synthetic-test-bearer',
        {
          method: 'GET',
          path: '/api/unexpected',
          schema: FacilityPageSchema,
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
