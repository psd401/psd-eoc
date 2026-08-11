import { copyFile, chmod } from 'node:fs/promises';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../../db/client';
import {
  audienceConfigurations,
  audienceTargets,
  events,
  groupSources,
  rosterEndpoints,
  rosterRecipientGroupSources,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshots,
  rosterSnapshotSources,
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
} from '../../../../db/schema';

import prepareEventTypeBrowserSession from '../../../(admin)/event-types/playwright.global-setup';
import { EVENT_TYPE_PLAYWRIGHT_STORAGE_STATE_PATH } from '../../../(admin)/event-types/test-database';
import { PLAYWRIGHT_IDS } from './playwright.fixtures';
import { recreateStartFlowPlaywrightDatabase } from './playwright-database';

export const START_FLOW_PLAYWRIGHT_STORAGE_STATE_PATH =
  '/tmp/psd-eoc-issue15-storage-state.json';

export const START_FLOW_STAFF_ROSTER_VERSION = 2_000_000_015;
export const START_FLOW_STAFF_AUDIENCE_ID =
  '00000000-0000-4000-8000-000000000020';
export const START_FLOW_STAFF_AUDIENCE_VERSION = 2;

const SYNTHETIC_FACILITY_ID = '00000000-0000-4000-8000-000000000001';
const SYNTHETIC_SOUTH_FACILITY_ID = '00000000-0000-4000-8000-000000000002';
const SYNTHETIC_NEIGHBORHOOD_ID = '00000000-0000-4000-8000-000000000010';
const SYNTHETIC_DRILL_VERSION_ID = '00000000-0000-4000-8000-000000000201';
const MEMBER_USER_ID = '10000000-0000-4000-8000-000000000120';
const FIXTURE_TIME = new Date('2026-08-10T18:00:00.000Z');

async function prepareStartFlowEvidence(
  connection: PostgresDatabaseConnection,
): Promise<void> {
  const database = connection.db;
  const staffGroups = [
    {
      id: PLAYWRIGHT_IDS.staffBuildingGroup,
      kind: 'google-group' as const,
      purpose: 'building' as const,
      facilityId: SYNTHETIC_FACILITY_ID,
      displayName: 'Synthetic Browser North Staff',
      googleGroupId: 'synthetic-stale-report-north',
      email: 'stale-report-north-group@example.invalid',
    },
    {
      id: PLAYWRIGHT_IDS.staffSouthBuildingGroup,
      kind: 'google-group' as const,
      purpose: 'building' as const,
      facilityId: SYNTHETIC_SOUTH_FACILITY_ID,
      displayName: 'Synthetic Browser South Staff',
      googleGroupId: 'synthetic-stale-report-south',
      email: 'stale-report-south-group@example.invalid',
    },
    {
      id: PLAYWRIGHT_IDS.staffOthersGroup,
      kind: 'google-group' as const,
      purpose: 'others' as const,
      facilityId: null,
      displayName: 'Synthetic Browser District Staff',
      googleGroupId: 'synthetic-stale-report-others',
      email: 'stale-report-others-group@example.invalid',
    },
  ] as const;
  const actor = {
    kind: 'human' as const,
    userId: MEMBER_USER_ID,
    sessionId: PLAYWRIGHT_IDS.session,
  };
  const syntheticAuthorization = {
    kind: 'synthetic-training' as const,
    activationPreviewId: PLAYWRIGHT_IDS.activationPreview,
    consequenceDigest: 'a'.repeat(64),
    requestId: PLAYWRIGHT_IDS.request,
  };

  await database.transaction(async (transaction) => {
    await transaction
      .insert(groupSources)
      .values(
        staffGroups.map((group) => ({
          ...group,
          active: true,
          fixtureKey: null,
          createdAt: FIXTURE_TIME,
        })),
      )
      .onConflictDoNothing();
    await transaction
      .insert(rosterSourceConfigurations)
      .values({
        id: PLAYWRIGHT_IDS.staffRosterConfiguration,
        version: 1,
        population: 'staff',
        createdAt: FIXTURE_TIME,
      })
      .onConflictDoNothing();
    await transaction
      .insert(rosterSourceConfigurationFacilities)
      .values([
        {
          configurationId: PLAYWRIGHT_IDS.staffRosterConfiguration,
          configurationVersion: 1,
          facilityId: SYNTHETIC_FACILITY_ID,
        },
        {
          configurationId: PLAYWRIGHT_IDS.staffRosterConfiguration,
          configurationVersion: 1,
          facilityId: SYNTHETIC_SOUTH_FACILITY_ID,
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterSourceConfigurationGroups)
      .values(
        staffGroups.map((group) => ({
          configurationId: PLAYWRIGHT_IDS.staffRosterConfiguration,
          configurationVersion: 1,
          population: 'staff' as const,
          groupSourceId: group.id,
          groupSourceKind: group.kind,
          groupPurpose: group.purpose,
        })),
      )
      .onConflictDoNothing();
    await transaction
      .insert(audienceConfigurations)
      .values({
        id: START_FLOW_STAFF_AUDIENCE_ID,
        facilityId: SYNTHETIC_FACILITY_ID,
        version: START_FLOW_STAFF_AUDIENCE_VERSION,
        createdAt: FIXTURE_TIME,
      })
      .onConflictDoNothing();
    await transaction
      .insert(audienceTargets)
      .values([
        {
          audienceConfigId: START_FLOW_STAFF_AUDIENCE_ID,
          audienceConfigVersion: START_FLOW_STAFF_AUDIENCE_VERSION,
          ordinal: 1,
          targetKind: 'building',
          targetFacilityId: SYNTHETIC_FACILITY_ID,
          neighborhoodId: null,
          neighborhoodVersion: null,
          groupSourceId: null,
        },
        {
          audienceConfigId: START_FLOW_STAFF_AUDIENCE_ID,
          audienceConfigVersion: START_FLOW_STAFF_AUDIENCE_VERSION,
          ordinal: 2,
          targetKind: 'neighborhood',
          targetFacilityId: null,
          neighborhoodId: SYNTHETIC_NEIGHBORHOOD_ID,
          neighborhoodVersion: 1,
          groupSourceId: null,
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterSnapshots)
      .values({
        id: PLAYWRIGHT_IDS.staffRosterSnapshot,
        version: START_FLOW_STAFF_ROSTER_VERSION,
        population: 'staff',
        complete: true,
        sourceConfigurationId: PLAYWRIGHT_IDS.staffRosterConfiguration,
        sourceConfigurationVersion: 1,
        syncStartedAt: FIXTURE_TIME,
        capturedAt: FIXTURE_TIME,
      })
      .onConflictDoNothing();
    await transaction
      .insert(rosterSnapshotFacilities)
      .values([
        {
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          facilityId: SYNTHETIC_FACILITY_ID,
        },
        {
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          facilityId: SYNTHETIC_SOUTH_FACILITY_ID,
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterSnapshotSources)
      .values(
        staffGroups.flatMap((group) =>
          (['expected', 'completed'] as const).map((completionKind) => ({
            rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
            population: 'staff' as const,
            groupSourceId: group.id,
            groupSourceKind: group.kind,
            groupPurpose: group.purpose,
            completionKind,
          })),
        ),
      )
      .onConflictDoNothing();
    await transaction
      .insert(rosterRecipients)
      .values([
        {
          id: PLAYWRIGHT_IDS.staffRecipientOne,
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          population: 'staff',
          googleSubject: 'synthetic-browser-staff-one',
          displayName: 'Synthetic Browser Staff One',
        },
        {
          id: PLAYWRIGHT_IDS.staffRecipientTwo,
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          population: 'staff',
          googleSubject: 'synthetic-browser-staff-two',
          displayName: 'Synthetic Browser Staff Two',
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(rosterRecipientGroupSources)
      .values(
        [
          PLAYWRIGHT_IDS.staffRecipientOne,
          PLAYWRIGHT_IDS.staffRecipientTwo,
        ].map((recipientId) => ({
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          recipientId,
          population: 'staff' as const,
          groupSourceId: PLAYWRIGHT_IDS.staffBuildingGroup,
          groupSourceKind: 'google-group' as const,
          groupPurpose: 'building' as const,
        })),
      )
      .onConflictDoNothing();
    await transaction
      .insert(rosterEndpoints)
      .values([
        {
          id: PLAYWRIGHT_IDS.staffRecipientOnePush,
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          recipientId: PLAYWRIGHT_IDS.staffRecipientOne,
          population: 'staff',
          channel: 'push',
          status: 'active',
          capturedAt: FIXTURE_TIME,
          platform: 'ios',
          token: 'synthetic-unroutable:browser-staff-one',
          email: null,
          phoneNumber: null,
        },
        {
          id: PLAYWRIGHT_IDS.staffRecipientOneEmail,
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          recipientId: PLAYWRIGHT_IDS.staffRecipientOne,
          population: 'staff',
          channel: 'email',
          status: 'active',
          capturedAt: FIXTURE_TIME,
          platform: null,
          token: null,
          email: 'synthetic-browser-staff-one@example.invalid',
          phoneNumber: null,
        },
        {
          id: PLAYWRIGHT_IDS.staffRecipientTwoPush,
          rosterSnapshotId: PLAYWRIGHT_IDS.staffRosterSnapshot,
          recipientId: PLAYWRIGHT_IDS.staffRecipientTwo,
          population: 'staff',
          channel: 'push',
          status: 'active',
          capturedAt: FIXTURE_TIME,
          platform: 'android',
          token: 'synthetic-unroutable:browser-staff-two',
          email: null,
          phoneNumber: null,
        },
      ])
      .onConflictDoNothing();
    await transaction
      .insert(events)
      .values([
        {
          id: PLAYWRIGHT_IDS.activeEvent,
          facilityId: SYNTHETIC_FACILITY_ID,
          kind: 'drill',
          templateMode: 'drill',
          eventTypeVersionId: SYNTHETIC_DRILL_VERSION_ID,
          status: 'active',
          rosterSnapshotId: '00000000-0000-4000-8000-000000000041',
          rosterPopulation: 'synthetic',
          createdBy: actor,
          createdAt: FIXTURE_TIME,
          activatedAt: FIXTURE_TIME,
          allClearAt: null,
          reactivatedAt: null,
          closedAt: null,
          correctionOfEventId: null,
          correctionReason: null,
          activationAuthorization: syntheticAuthorization,
        },
        {
          id: PLAYWRIGHT_IDS.activeEventSecond,
          facilityId: SYNTHETIC_FACILITY_ID,
          kind: 'drill',
          templateMode: 'drill',
          eventTypeVersionId: SYNTHETIC_DRILL_VERSION_ID,
          status: 'active',
          rosterSnapshotId: '00000000-0000-4000-8000-000000000041',
          rosterPopulation: 'synthetic',
          createdBy: actor,
          createdAt: new Date(FIXTURE_TIME.getTime() + 5 * 60 * 1_000),
          activatedAt: new Date(FIXTURE_TIME.getTime() + 5 * 60 * 1_000),
          allClearAt: null,
          reactivatedAt: null,
          closedAt: null,
          correctionOfEventId: null,
          correctionReason: null,
          activationAuthorization: syntheticAuthorization,
        },
      ])
      .onConflictDoNothing();
  });
}

/**
 * Reuses the canonical synthetic session fixture, then snapshots it to an
 * issue-owned path so unrelated Playwright suites cannot replace auth state
 * between this suite's isolated browser contexts.
 */
export default async function prepareStartFlowBrowserSession(): Promise<void> {
  const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
  const databaseUrl =
    await recreateStartFlowPlaywrightDatabase(baseDatabaseUrl);
  process.env.TEST_DATABASE_URL = databaseUrl;
  try {
    await prepareEventTypeBrowserSession();
  } finally {
    process.env.TEST_DATABASE_URL = baseDatabaseUrl;
  }
  const created = createDatabaseClient({
    driver: 'postgres',
    url: databaseUrl,
    maxConnections: 2,
  });
  if (created.driver !== 'postgres') {
    throw new Error('Start-flow Playwright requires PostgreSQL.');
  }
  try {
    await prepareStartFlowEvidence(created);
  } finally {
    await created.close();
  }
  await copyFile(
    EVENT_TYPE_PLAYWRIGHT_STORAGE_STATE_PATH,
    START_FLOW_PLAYWRIGHT_STORAGE_STATE_PATH,
  );
  await chmod(START_FLOW_PLAYWRIGHT_STORAGE_STATE_PATH, 0o600);
}
