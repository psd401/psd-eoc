import { randomUUID } from 'node:crypto';

import type {
  Event,
  EventTypeListItem,
  Facility,
  TemplateMode,
} from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../../../../lib/auth/sessions';
import {
  executeGetEventTypeVersionCapability,
  executeListEventTypesCapability,
  getDefaultEventTypeStore,
} from '../../../../lib/capabilities/event-types';
import { resolveHumanCapabilityInvocation } from '../../../../lib/capabilities/engine';
import { getDefaultEventCapabilityRuntime } from '../../../../lib/capabilities/events';
import { getDefaultStartFlowCapabilityRuntime } from './capabilities';

export interface NamedActiveEvent {
  readonly event: Event;
  readonly eventTypeName: string;
  readonly facilityName: string;
}

export interface OperationalViewData {
  readonly activeEvents: readonly NamedActiveEvent[];
  readonly eventTypes: readonly EventTypeListItem[];
  readonly facilities: readonly Facility[];
}

function queryInvocation(authenticated: AuthenticatedSession) {
  return resolveHumanCapabilityInvocation(authenticated, {
    requestId: randomUUID(),
    mutation: null,
  });
}

/** Loads operational choices only through canonical capability entry points. */
export async function loadOperationalViewData(
  authenticated: AuthenticatedSession,
): Promise<OperationalViewData> {
  const eventTypeStore = getDefaultEventTypeStore();
  const [facilityPage, eventPage, eventTypePage] = await Promise.all([
    getDefaultStartFlowCapabilityRuntime().execute(
      'list-facilities',
      { includeInactive: false, cursor: null, limit: 200 },
      queryInvocation(authenticated),
    ),
    getDefaultEventCapabilityRuntime().execute(
      'list-active-events',
      { facilityId: null, cursor: null, limit: 100 },
      queryInvocation(authenticated),
    ),
    executeListEventTypesCapability({
      store: eventTypeStore,
      authenticated,
      query: {
        templateMode: null,
        enabled: true,
        cursor: null,
        limit: 200,
      },
    }),
  ]);

  const facilityNames = new Map(
    facilityPage.items.map((facility) => [facility.id, facility.name]),
  );
  const latestNames = new Map(
    eventTypePage.items.map((item) => [
      item.latestVersion.id,
      item.latestVersion.name,
    ]),
  );
  const missingVersionIds = [
    ...new Set(
      eventPage.items
        .map((event) => event.eventTypeVersion.id)
        .filter((id) => !latestNames.has(id)),
    ),
  ];
  const historicalVersions = await Promise.all(
    missingVersionIds.map((eventTypeVersionId) =>
      executeGetEventTypeVersionCapability({
        store: eventTypeStore,
        authenticated,
        query: { eventTypeVersionId },
      }),
    ),
  );
  historicalVersions.forEach((version) => {
    latestNames.set(version.id, version.name);
  });

  return Object.freeze({
    facilities: facilityPage.items,
    eventTypes: eventTypePage.items,
    activeEvents: Object.freeze(
      eventPage.items.map((event) => ({
        event,
        facilityName:
          facilityNames.get(event.facilityId) ?? 'Authorized facility',
        eventTypeName:
          latestNames.get(event.eventTypeVersion.id) ??
          (event.templateMode === 'real' ? 'Incident' : 'Drill'),
      })),
    ),
  });
}

export function eventTypesForMode(
  eventTypes: readonly EventTypeListItem[],
  templateMode: TemplateMode,
): readonly EventTypeListItem[] {
  return eventTypes.filter(
    (item) =>
      item.eventType.templateMode === templateMode &&
      item.latestVersion.enabled,
  );
}
