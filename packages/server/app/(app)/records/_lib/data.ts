import { randomUUID } from 'node:crypto';

import type {
  EventTypeListItem,
  Facility,
  ListDrillRecordsInput,
} from '@psd-eoc/contracts';

import type { AuthenticatedSession } from '../../../../lib/auth/sessions';
import { resolveHumanCapabilityInvocation } from '../../../../lib/capabilities/engine';
import {
  executeListEventTypesCapability,
  getDefaultEventTypeStore,
} from '../../../../lib/capabilities/event-types';
import { getDefaultRecordsCapabilityRuntime } from '../../../../lib/capabilities/records';
import { getDefaultStartFlowCapabilityRuntime } from '../../start/_lib/capabilities';
import { collectAllOperationalPages } from '../../start/_lib/data';

export interface RecordsFilterOptions {
  readonly eventTypes: readonly EventTypeListItem[];
  readonly facilities: readonly Facility[];
}

function queryInvocation(authenticated: AuthenticatedSession) {
  return resolveHumanCapabilityInvocation(authenticated, {
    requestId: randomUUID(),
    mutation: null,
  });
}

/** Loads complete, authorized filter choices through canonical read paths. */
export async function loadRecordsFilterOptions(
  authenticated: AuthenticatedSession,
): Promise<RecordsFilterOptions> {
  const [facilities, eventTypes] = await Promise.all([
    collectAllOperationalPages((cursor) =>
      getDefaultStartFlowCapabilityRuntime().execute(
        'list-facilities',
        { includeInactive: true, cursor, limit: 200 },
        queryInvocation(authenticated),
      ),
    ),
    collectAllOperationalPages((cursor) =>
      executeListEventTypesCapability({
        store: getDefaultEventTypeStore(),
        authenticated,
        query: {
          templateMode: 'drill',
          enabled: null,
          cursor,
          limit: 200,
        },
        requestId: randomUUID(),
      }),
    ),
  ]);

  return Object.freeze({
    facilities: Object.freeze(
      [...facilities].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    ),
    eventTypes: Object.freeze(
      [...eventTypes].sort((left, right) =>
        left.latestVersion.name.localeCompare(right.latestVersion.name),
      ),
    ),
  });
}

/** Lists one authorized page of drill records through canonical execution. */
export async function loadDrillRecordPage(
  authenticated: AuthenticatedSession,
  input: ListDrillRecordsInput,
) {
  return getDefaultRecordsCapabilityRuntime().execute(
    'list-drill-records',
    input,
    queryInvocation(authenticated),
  );
}
