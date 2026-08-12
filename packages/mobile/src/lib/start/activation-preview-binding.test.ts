import { describe, expect, test } from 'bun:test';

import type {
  ActivationPreview,
  EventTypeListItem,
  FacilityId,
  TemplateMode,
} from '@psd-eoc/contracts';

import {
  getBoundActivationPreview,
  type ActivationPreviewBinding,
} from './activation-preview-binding';

const uuid = (suffix: number): string =>
  `65000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const FACILITY_ID = uuid(1) as FacilityId;
const OTHER_FACILITY_ID = uuid(2) as FacilityId;
const EVENT_TYPE_ID = uuid(3);
const VERSION_ID = uuid(4);

function eventTypeListItem(
  input: Readonly<{
    eventTypeId?: string;
    eventTypeMode?: TemplateMode;
    versionEventTypeId?: string;
    versionId?: string;
    versionMode?: TemplateMode;
  }> = {},
): EventTypeListItem {
  const eventTypeId = input.eventTypeId ?? EVENT_TYPE_ID;
  const eventTypeMode = input.eventTypeMode ?? 'drill';
  return {
    eventType: {
      id: eventTypeId,
      templateMode: eventTypeMode,
    },
    latestVersion: {
      id: input.versionId ?? VERSION_ID,
      eventTypeId: input.versionEventTypeId ?? eventTypeId,
      templateMode: input.versionMode ?? eventTypeMode,
    },
  } as EventTypeListItem;
}

function activationPreview(
  input: Readonly<{
    facilityId?: FacilityId;
    mode?: TemplateMode;
    versionId?: string;
    versionMode?: TemplateMode;
  }> = {},
): ActivationPreview {
  const mode = input.mode ?? 'drill';
  return {
    facilityId: input.facilityId ?? FACILITY_ID,
    templateMode: mode,
    eventTypeVersion: {
      id: input.versionId ?? VERSION_ID,
      templateMode: input.versionMode ?? mode,
    },
  } as ActivationPreview;
}

describe('getBoundActivationPreview', () => {
  test('returns the exact preview when every current selection dimension matches', () => {
    const preview = activationPreview();

    expect(
      getBoundActivationPreview({
        facilityId: FACILITY_ID,
        mode: 'drill',
        preview,
        selectedType: eventTypeListItem(),
      }),
    ).toBe(preview);
  });

  for (const [label, stalePreview] of [
    ['facility', activationPreview({ facilityId: OTHER_FACILITY_ID })],
    ['top-level mode', activationPreview({ mode: 'real' })],
    ['latest-version identity', activationPreview({ versionId: uuid(5) })],
    [
      'preview version mode',
      activationPreview({ mode: 'drill', versionMode: 'real' }),
    ],
  ] as const) {
    test(`rejects a preview with stale ${label}`, () => {
      expect(
        getBoundActivationPreview({
          facilityId: FACILITY_ID,
          mode: 'drill',
          preview: stalePreview,
          selectedType: eventTypeListItem(),
        }),
      ).toBeNull();
    });
  }

  for (const [label, staleSelectedType] of [
    [
      'event-type mode',
      eventTypeListItem({ eventTypeMode: 'real', versionMode: 'real' }),
    ],
    ['latest-version mode', eventTypeListItem({ versionMode: 'real' })],
    [
      'latest-version owner',
      eventTypeListItem({ versionEventTypeId: uuid(6) }),
    ],
    ['latest-version identity', eventTypeListItem({ versionId: uuid(7) })],
  ] as const) {
    test(`rejects a stale selected ${label}`, () => {
      expect(
        getBoundActivationPreview({
          facilityId: FACILITY_ID,
          mode: 'drill',
          preview: activationPreview(),
          selectedType: staleSelectedType,
        }),
      ).toBeNull();
    });
  }

  const completeBinding: ActivationPreviewBinding = {
    facilityId: FACILITY_ID,
    mode: 'drill',
    preview: activationPreview(),
    selectedType: eventTypeListItem(),
  };
  for (const [label, incompleteBinding] of [
    ['facility', { ...completeBinding, facilityId: null }],
    ['mode', { ...completeBinding, mode: null }],
    ['preview', { ...completeBinding, preview: null }],
    ['selected type', { ...completeBinding, selectedType: null }],
  ] as const) {
    test(`rejects a missing current ${label}`, () => {
      expect(getBoundActivationPreview(incompleteBinding)).toBeNull();
    });
  }
});
