import type {
  CapabilityInput,
  RosterSyncResult,
  StaleRosterReport,
} from '@psd-eoc/contracts';
import { desc, eq } from 'drizzle-orm';

import { facilities, rosterSyncResults } from '../../../db/schema';
import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import type { ServerCapabilityRegistration } from '../../../lib/capabilities/engine';
import {
  createDrizzleStaleRosterReportStoreFromTransaction,
  executeStaleRosterReportQuery,
} from '../../../lib/roster/stale-report';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
  createRepeatableReadAdminQueryStoreFromStore,
  executeAdminQueryCapability,
  getDefaultAdminDatabase,
  requireAdminCapabilityAuthorization,
  type AdminCapabilityStore,
  type AdminCapabilityTransaction,
  type AdminQueryMetadata,
} from '../../../lib/capabilities/admin';

export type LastRosterSync = Pick<
  RosterSyncResult,
  'completedAt' | 'outcome' | 'population'
>;

function registration(
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
      const report = await executeStaleRosterReportQuery(
        {
          // The split admin query store owns this repeatable-read/read-only
          // transaction. Reuse that exact transaction so authorization, report
          // evidence and last-sync truth share one snapshot without checking out
          // a nested PostgreSQL connection or overlapping statements on one
          // Aurora Data API transaction ID. Report generation keeps the trusted
          // capability invocation time; this store does not change clock policy.
          store: createDrizzleStaleRosterReportStoreFromTransaction(
            context.transaction.database,
          ),
          clock: () => new Date(context.invocation.serverTime.getTime()),
          staleThresholdSeconds: 24 * 60 * 60,
        },
        input,
        {
          facilityScope: context.invocation.scope.facilityScope,
        },
      );
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
  const snapshotStore = createRepeatableReadAdminQueryStoreFromStore(store);
  const report = await executeAdminQueryCapability(
    registration((value) => {
      lastSync = value;
    }),
    input.query,
    input.authenticated,
    snapshotStore,
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
