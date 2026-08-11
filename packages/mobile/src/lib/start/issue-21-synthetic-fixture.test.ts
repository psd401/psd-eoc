import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  CreateActivationPreviewInputSchema,
  type CreateActivationPreviewInput,
} from '@psd-eoc/contracts';

import {
  activate,
  createPreview,
  join,
  loadStartHomeData,
  type StartAuthenticatedRequest,
} from './start-api-client';
import { createIssue21SyntheticFixtureTransport } from './issue-21-synthetic-fixture';

const FIXTURE_NOW = new Date('2026-08-11T18:00:00.000Z');
const IDEMPOTENCY_KEY = 'issue-21-synthetic-idempotency-0001';
const originalFixture = process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE;
const developmentGlobal = globalThis as typeof globalThis & {
  __DEV__?: boolean;
};
const originalDevelopment = developmentGlobal.__DEV__;

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
  return (input) => transport('synthetic-test-bearer', input);
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
        transport('synthetic-test-bearer', {
          operation: 'query',
          method: 'GET',
          path: '/api/mobile/start/facilities',
        }),
      ).rejects.toBeInstanceOf(TypeError);
    } finally {
      developmentGlobal.__DEV__ = true;
    }
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
      transport('synthetic-test-bearer', {
        operation: 'query',
        method: 'POST',
        path: '/api/mobile/start/preview',
        body: JSON.stringify({
          facilityId: '71000000-0000-4000-8000-000000000001',
          kind: 'incident',
          templateMode: 'real',
          eventTypeVersion: {
            id: '71000000-0000-4000-8000-000000000003',
            templateMode: 'real',
          },
          rosterPopulation: 'staff',
        }),
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      transport('synthetic-test-bearer', {
        operation: 'query',
        method: 'GET',
        path: '/api/unexpected',
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
