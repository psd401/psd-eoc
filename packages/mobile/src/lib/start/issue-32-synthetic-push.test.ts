import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { EventSchema } from '@psd-eoc/contracts';

import {
  isIssue32SyntheticPushFixtureEnabled,
  issue32SyntheticPushContent,
} from './issue-32-synthetic-push';

const developmentGlobal = globalThis as typeof globalThis & {
  __DEV__?: boolean;
};
const originalDevelopment = developmentGlobal.__DEV__;
const originalFixture = process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE;
const originalPushFixture =
  process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE;

beforeAll(() => {
  developmentGlobal.__DEV__ = true;
  process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE = 'issue-21';
  process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE = 'issue-32';
});

afterAll(() => {
  if (originalDevelopment === undefined) {
    delete developmentGlobal.__DEV__;
  } else {
    developmentGlobal.__DEV__ = originalDevelopment;
  }
  if (originalFixture === undefined) {
    delete process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE;
  } else {
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE = originalFixture;
  }
  if (originalPushFixture === undefined) {
    delete process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE;
  } else {
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE =
      originalPushFixture;
  }
});

function event(kind: 'drill' | 'incident' = 'drill') {
  const mode = kind === 'drill' ? 'drill' : 'real';
  return EventSchema.parse({
    id: '71000000-0000-4000-8000-000000000012',
    facilityId: '71000000-0000-4000-8000-000000000001',
    kind,
    templateMode: mode,
    eventTypeVersion: {
      id: '71000000-0000-4000-8000-000000000003',
      templateMode: mode,
    },
    status: 'active',
    rosterSnapshotId: '71000000-0000-4000-8000-000000000004',
    rosterPopulation: kind === 'drill' ? 'synthetic' : 'staff',
    createdBy: {
      kind: 'human',
      userId: '71000000-0000-4000-8000-000000000006',
      sessionId: '71000000-0000-4000-8000-000000000007',
    },
    createdAt: '2026-08-11T17:00:00.000Z',
    activatedAt: '2026-08-11T17:00:00.000Z',
    allClearAt: null,
    reactivatedAt: null,
    closedAt: null,
    correctionOfEventId: null,
    correctionReason: null,
    activationAuthorization:
      kind === 'drill'
        ? {
            kind: 'synthetic-training',
            activationPreviewId: '71000000-0000-4000-8000-000000000011',
            consequenceDigest: 'a'.repeat(64),
            requestId: '71000000-0000-4000-8000-000000000010',
          }
        : {
            kind: 'human-confirmed',
            activationPreviewId: '71000000-0000-4000-8000-000000000011',
            preparedActivationId: null,
            confirmationId: '71000000-0000-4000-8000-000000000013',
            consequenceDigest: 'a'.repeat(64),
            requestId: '71000000-0000-4000-8000-000000000010',
          },
  });
}

describe('issue-32 provider-free push fixture', () => {
  test('requires both exact development-only fixture flags', () => {
    expect(isIssue32SyntheticPushFixtureEnabled()).toBe(true);
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE = 'unexpected';
    expect(isIssue32SyntheticPushFixtureEnabled()).toBe(false);
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE = 'issue-32';
    developmentGlobal.__DEV__ = false;
    expect(isIssue32SyntheticPushFixtureEnabled()).toBe(false);
    developmentGlobal.__DEV__ = true;
  });

  test('builds canonical DRILL routing data and rejects a real event', () => {
    expect(issue32SyntheticPushContent(event())).toEqual({
      title: '[DRILL] Synthetic earthquake drill',
      body: '[DRILL] Synthetic recipients only. Open the synthetic event room.',
      data: {
        version: 1,
        eventId: '71000000-0000-4000-8000-000000000012',
        eventKind: 'drill',
        templateMode: 'drill',
        facilityId: '71000000-0000-4000-8000-000000000001',
        eventTypeVersionId: '71000000-0000-4000-8000-000000000003',
        purpose: 'activation',
      },
    });
    expect(() => issue32SyntheticPushContent(event('incident'))).toThrow(
      'accepts only a synthetic drill',
    );
  });
});
