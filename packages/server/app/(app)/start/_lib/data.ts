import { randomUUID } from 'node:crypto';

import type {
  Event,
  EventTypeListItem,
  Facility,
  PageInfo,
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
import { getDefaultStartFlowCapabilityRuntime } from '../../../../lib/capabilities/start';

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

interface OperationalPage<Item> {
  readonly items: readonly Item[];
  readonly pageInfo: PageInfo;
}

const MAX_OPERATIONAL_PAGES = 1_000;

/**
 * Exhausts a canonical cursor query while failing closed on a broken or
 * unreasonably long continuation chain. Partial operational data must never
 * be presented as the complete authorized view.
 */
export async function collectAllOperationalPages<Item>(
  loadPage: (cursor: string | null) => Promise<OperationalPage<Item>>,
): Promise<readonly Item[]> {
  const items: Item[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let pageCount = 0; pageCount < MAX_OPERATIONAL_PAGES; pageCount += 1) {
    const page = await loadPage(cursor);
    items.push(...page.items);
    if (!page.pageInfo.hasMore) {
      return Object.freeze(items);
    }

    const nextCursor = page.pageInfo.nextCursor;
    if (nextCursor === null || seenCursors.has(nextCursor)) {
      throw new Error(
        'Operational pagination did not advance. No partial dashboard will be shown.',
      );
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error(
    'Operational pagination exceeded its safety bound. No partial dashboard will be shown.',
  );
}

export interface AuthorizedFacilityView {
  readonly facilityNameById: ReadonlyMap<string, string>;
  readonly startFacilities: readonly Facility[];
}

/**
 * Retains inactive authorized names for active-event truth while preventing a
 * new start at a facility that administrators have deactivated.
 */
export function prepareAuthorizedFacilities(
  facilities: readonly Facility[],
): AuthorizedFacilityView {
  return Object.freeze({
    facilityNameById: new Map(
      facilities.map((facility) => [facility.id, facility.name]),
    ),
    startFacilities: Object.freeze(
      facilities.filter((facility) => facility.active),
    ),
  });
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
  const startFlowRuntime = getDefaultStartFlowCapabilityRuntime();
  const eventRuntime = getDefaultEventCapabilityRuntime();
  const [facilities, activeEvents, eventTypes] = await Promise.all([
    collectAllOperationalPages((cursor) =>
      startFlowRuntime.execute(
        'list-facilities',
        { includeInactive: true, cursor, limit: 200 },
        queryInvocation(authenticated),
      ),
    ),
    collectAllOperationalPages((cursor) =>
      eventRuntime.execute(
        'list-active-events',
        { facilityId: null, cursor, limit: 100 },
        queryInvocation(authenticated),
      ),
    ),
    collectAllOperationalPages((cursor) =>
      executeListEventTypesCapability({
        store: eventTypeStore,
        authenticated,
        query: {
          templateMode: null,
          enabled: true,
          cursor,
          limit: 200,
        },
      }),
    ),
  ]);

  const facilityView = prepareAuthorizedFacilities(facilities);
  const latestNames = new Map(
    eventTypes.map((item) => [item.latestVersion.id, item.latestVersion.name]),
  );
  const missingVersionIds = [
    ...new Set(
      activeEvents
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
    facilities: facilityView.startFacilities,
    eventTypes,
    activeEvents: Object.freeze(
      activeEvents.map((event) => ({
        event,
        facilityName:
          facilityView.facilityNameById.get(event.facilityId) ??
          'Authorized facility',
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
