import type {
  CapabilityInput,
  RosterSyncResult,
  StaleRosterReport,
} from '@psd-eoc/contracts';
import { desc, eq } from 'drizzle-orm';

import { facilities, rosterSyncResults } from '../../../db/schema';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import type { ServerCapabilityRegistration } from '../../../lib/capabilities/engine';
import type { Database } from '../../../db/client';
import {
  createDrizzleStaleRosterReportStore,
  createGetStaleRosterReportHandler,
} from '../../../lib/roster/stale-report';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
  executeAdminQueryCapability,
  getAdminCapabilityStoreDatabase,
  getDefaultAdminDatabase,
  requireAdminCapabilityAuthorization,
  type AdminCapabilityStore,
  type AdminCapabilityTransaction,
  type AdminQueryMetadata,
} from '../facilities/admin-core';

export type LastRosterSync = Pick<
  RosterSyncResult,
  'completedAt' | 'outcome' | 'population'
>;

function registration(
  rootDatabase: Database,
  captureLastSync: (value: LastRosterSync | null) => void,
): ServerCapabilityRegistration<
  'get-stale-roster-report',
  AdminCapabilityTransaction
> {
  return {
    id: 'get-stale-roster-report',
    async resolveFacilityId(input, context) {
      requireAdminCapabilityAuthorization(
        context.invocation.actor,
        context.transaction,
      );
      if (input.facilityId === null) return null;
      const [facility] = await context.transaction.database
        .select({ id: facilities.id })
        .from(facilities)
        .where(eq(facilities.id, input.facilityId))
        .limit(1);
      if (facility === undefined) {
        throw new AdminCapabilityError(
          'NOT_FOUND',
          'The roster-health facility was not found.',
          404,
        );
      }
      return facility.id;
    },
    async handler(input, context) {
      const reportHandler = createGetStaleRosterReportHandler({
        // The stale-report store owns a repeatable-read/read-only transaction.
        // Start it from the exact injected root database: nesting it under the
        // capability transaction is invalid on PostgreSQL/Data API, while a
        // process-global fallback could mix authorization and report state.
        store: createDrizzleStaleRosterReportStore(rootDatabase),
        clock: () => new Date(context.invocation.serverTime.getTime()),
        staleThresholdSeconds: 24 * 60 * 60,
      });
      const report = await reportHandler.handler(input, {
        facilityScope: context.invocation.scope.facilityScope,
      });
      const latestRows = await context.transaction.database
        .select({
          population: rosterSyncResults.population,
          outcome: rosterSyncResults.outcome,
          completedAt: rosterSyncResults.completedAt,
        })
        .from(rosterSyncResults)
        .where(eq(rosterSyncResults.population, input.population))
        .orderBy(
          desc(rosterSyncResults.completedAt),
          desc(rosterSyncResults.id),
        )
        .limit(1);
      const latest = latestRows[0];
      captureLastSync(
        latest === undefined
          ? null
          : Object.freeze({
              population: latest.population,
              outcome: latest.outcome,
              completedAt: latest.completedAt.toISOString(),
            }),
      );
      return report;
    },
  };
}

/** Runs the canonical stale-report query and its minimized last-sync projection. */
export async function executeRosterHealthProjection(input: {
  readonly authenticated: AuthenticatedSession;
  readonly query: CapabilityInput<'get-stale-roster-report'>;
  readonly store?: AdminCapabilityStore;
  readonly metadata?: AdminQueryMetadata;
}): Promise<
  Readonly<{
    report: StaleRosterReport;
    lastSync: LastRosterSync | null;
  }>
> {
  let lastSync: LastRosterSync | null | undefined;
  const store =
    input.store ??
    createDrizzleAdminCapabilityStore(
      getDefaultAdminDatabase(),
      input.authenticated,
    );
  const rootDatabase = getAdminCapabilityStoreDatabase(store);
  const report = await executeAdminQueryCapability(
    registration(rootDatabase, (value) => {
      lastSync = value;
    }),
    input.query,
    input.authenticated,
    store,
    input.metadata,
  );
  if (lastSync === undefined) {
    throw new AdminCapabilityError(
      'INTERNAL_ERROR',
      'The roster-health projection was not produced.',
      500,
    );
  }
  return Object.freeze({ report, lastSync });
}
