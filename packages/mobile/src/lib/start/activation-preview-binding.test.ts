import { describe, expect, test } from 'bun:test';

import type {
  ActivationPreview,
  Event,
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
const ACTIVE_EVENT_ID = uuid(5);
const OTHER_EVENT_ID = uuid(6);

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
    activeEventIds?: readonly string[];
    versionId?: string;
    versionMode?: TemplateMode;
  }> = {},
): ActivationPreview {
  const mode = input.mode ?? 'drill';
  return {
    activeEventIds: input.activeEventIds ?? [],
    facilityId: input.facilityId ?? FACILITY_ID,
    templateMode: mode,
    eventTypeVersion: {
      id: input.versionId ?? VERSION_ID,
      templateMode: input.versionMode ?? mode,
    },
  } as ActivationPreview;
}

function event(
  input: Readonly<{
    facilityId?: FacilityId;
    id?: string;
    status?: Event['status'];
  }> = {},
): Event {
  return {
    facilityId: input.facilityId ?? FACILITY_ID,
    id: input.id ?? ACTIVE_EVENT_ID,
    status: input.status ?? 'active',
  } as Event;
}

describe('getBoundActivationPreview', () => {
  test('returns the exact preview when every current selection dimension matches', () => {
    const preview = activationPreview();

    expect(
      getBoundActivationPreview({
        activeEvents: [],
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
          activeEvents: [],
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
          activeEvents: [],
          facilityId: FACILITY_ID,
          mode: 'drill',
          preview: activationPreview(),
          selectedType: staleSelectedType,
        }),
      ).toBeNull();
    });
  }

  const completeBinding: ActivationPreviewBinding = {
    activeEvents: [],
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

  test('binds referenced active events to the selected facility amid other authorized sites', () => {
    const preview = activationPreview({ activeEventIds: [ACTIVE_EVENT_ID] });

    expect(
      getBoundActivationPreview({
        activeEvents: [
          event({ id: OTHER_EVENT_ID, facilityId: OTHER_FACILITY_ID }),
          event(),
        ],
        facilityId: FACILITY_ID,
        mode: 'drill',
        preview,
        selectedType: eventTypeListItem(),
      }),
    ).toBe(preview);
  });

  test('rejects a preview that omits another active event at the selected facility', () => {
    expect(
      getBoundActivationPreview({
        activeEvents: [event(), event({ id: OTHER_EVENT_ID })],
        facilityId: FACILITY_ID,
        mode: 'drill',
        preview: activationPreview({ activeEventIds: [ACTIVE_EVENT_ID] }),
        selectedType: eventTypeListItem(),
      }),
    ).toBeNull();
  });

  test('rejects an empty preview when the selected facility has an active event', () => {
    expect(
      getBoundActivationPreview({
        activeEvents: [event()],
        facilityId: FACILITY_ID,
        mode: 'drill',
        preview: activationPreview(),
        selectedType: eventTypeListItem(),
      }),
    ).toBeNull();
  });

  test('rejects a referenced event from another authorized facility', () => {
    expect(
      getBoundActivationPreview({
        activeEvents: [event({ facilityId: OTHER_FACILITY_ID })],
        facilityId: FACILITY_ID,
        mode: 'drill',
        preview: activationPreview({ activeEventIds: [ACTIVE_EVENT_ID] }),
        selectedType: eventTypeListItem(),
      }),
    ).toBeNull();
  });

  for (const status of ['all-clear', 'closed'] as const) {
    test(`rejects a referenced ${status} event`, () => {
      expect(
        getBoundActivationPreview({
          activeEvents: [event({ status })],
          facilityId: FACILITY_ID,
          mode: 'drill',
          preview: activationPreview({ activeEventIds: [ACTIVE_EVENT_ID] }),
          selectedType: eventTypeListItem(),
        }),
      ).toBeNull();
    });
  }

  test('rejects a missing or duplicated referenced event record', () => {
    const preview = activationPreview({ activeEventIds: [ACTIVE_EVENT_ID] });
    const binding = {
      facilityId: FACILITY_ID,
      mode: 'drill' as const,
      preview,
      selectedType: eventTypeListItem(),
    };

    expect(
      getBoundActivationPreview({ ...binding, activeEvents: [] }),
    ).toBeNull();
    expect(
      getBoundActivationPreview({
        ...binding,
        activeEvents: [event(), event({ facilityId: OTHER_FACILITY_ID })],
      }),
    ).toBeNull();
  });
});
