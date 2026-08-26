import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import { desc, eq, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  databaseExecuteRows,
  readDatabaseConfig,
} from '../db/client';
import {
  channelConfigurations,
  groupSources,
  integrationStatuses,
  rosterEndpoints,
  rosterRecipientGroupSources,
  rosterRecipients,
  rosterSnapshotFacilities,
  rosterSnapshots,
  rosterSnapshotSources,
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
} from '../db/schema';
import { expectAxeClean, issue277EvidencePath } from './support';

const SYNTHETIC_FACILITY_ID = '00000000-0000-4000-8000-000000000001';

interface ControlledEmailFixture {
  readonly endpointId: string;
  readonly recipientId: string;
  readonly rosterSnapshotId: string;
}

async function installControlledEmailFixture(): Promise<
  Readonly<{
    close(): Promise<void>;
    fixture: ControlledEmailFixture;
    previousEmailConfiguration: typeof channelConfigurations.$inferSelect;
  }>
> {
  const connection = createDatabaseClient(readDatabaseConfig());
  const [previousEmailConfiguration] = await connection.db
    .select()
    .from(channelConfigurations)
    .where(eq(channelConfigurations.integrationId, 'ses-email'))
    .limit(1);
  if (previousEmailConfiguration === undefined) {
    await connection.close();
    throw new Error('The synthetic SES channel configuration is missing.');
  }

  const [latestStaffSnapshot] = await connection.db
    .select({
      sourceConfigurationId: rosterSnapshots.sourceConfigurationId,
      sourceConfigurationVersion: rosterSnapshots.sourceConfigurationVersion,
      version: rosterSnapshots.version,
    })
    .from(rosterSnapshots)
    .where(eq(rosterSnapshots.population, 'staff'))
    .orderBy(desc(rosterSnapshots.version))
    .limit(1);
  if (latestStaffSnapshot === undefined) {
    await connection.close();
    throw new Error('The synthetic staff roster lineage is missing.');
  }
  const configurationId = latestStaffSnapshot.sourceConfigurationId;
  const configurationVersion =
    latestStaffSnapshot.sourceConfigurationVersion + 1;
  const groupSourceId = randomUUID();
  const rosterSnapshotId = randomUUID();
  const recipientId = randomUUID();
  const endpointId = randomUUID();
  const capturedAt = new Date(Date.now() - 2 * 60 * 60_000);
  const integrationObservedAt = new Date();

  await connection.db.transaction(async (transaction) => {
    await transaction.insert(groupSources).values({
      id: groupSourceId,
      kind: 'google-group',
      purpose: 'building',
      facilityId: SYNTHETIC_FACILITY_ID,
      displayName: 'Synthetic controlled email canary group',
      active: true,
      googleGroupId: `synthetic-e2e-email-canary-${groupSourceId}`,
      email: `synthetic-e2e-email-canary-${groupSourceId}@example.invalid`,
      fixtureKey: null,
      createdAt: capturedAt,
    });
    await transaction.insert(rosterSourceConfigurations).values({
      id: configurationId,
      version: configurationVersion,
      population: 'staff',
      createdAt: capturedAt,
    });
    await transaction.insert(rosterSourceConfigurationFacilities).values({
      configurationId,
      configurationVersion,
      facilityId: SYNTHETIC_FACILITY_ID,
    });
    await transaction.insert(rosterSourceConfigurationGroups).values({
      configurationId,
      configurationVersion,
      population: 'staff',
      groupSourceId,
      groupSourceKind: 'google-group',
      groupPurpose: 'building',
    });
    await transaction.insert(rosterSnapshots).values({
      id: rosterSnapshotId,
      version: latestStaffSnapshot.version + 1,
      population: 'staff',
      complete: true,
      sourceConfigurationId: configurationId,
      sourceConfigurationVersion: configurationVersion,
      syncStartedAt: new Date(capturedAt.getTime() - 60_000),
      capturedAt,
    });
    await transaction.insert(rosterSnapshotFacilities).values({
      rosterSnapshotId,
      facilityId: SYNTHETIC_FACILITY_ID,
    });
    await transaction.insert(rosterSnapshotSources).values([
      {
        rosterSnapshotId,
        population: 'staff',
        groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'building',
        completionKind: 'expected',
      },
      {
        rosterSnapshotId,
        population: 'staff',
        groupSourceId,
        groupSourceKind: 'google-group',
        groupPurpose: 'building',
        completionKind: 'completed',
      },
    ]);
    await transaction.insert(rosterRecipients).values({
      id: recipientId,
      rosterSnapshotId,
      population: 'staff',
      googleSubject: `synthetic-e2e-email-canary-${recipientId}`,
      staffEmail: null,
      displayName: 'Synthetic controlled email canary',
    });
    await transaction.insert(rosterRecipientGroupSources).values({
      rosterSnapshotId,
      recipientId,
      population: 'staff',
      groupSourceId,
      groupSourceKind: 'google-group',
      groupPurpose: 'building',
    });
    await transaction.insert(rosterEndpoints).values({
      id: endpointId,
      rosterSnapshotId,
      recipientId,
      population: 'staff',
      channel: 'email',
      status: 'active',
      capturedAt,
      platform: null,
      token: null,
      email: `synthetic-controlled-canary-${endpointId}@example.invalid`,
      phoneNumber: null,
    });
    const statusId = randomUUID();
    await transaction.insert(integrationStatuses).values({
      id: statusId,
      integrationId: 'ses-email',
      label: 'live-verified',
      verifiedAt: integrationObservedAt,
      verifiedByUserId: process.env.PSD_EOC_PRODUCT_OWNER_USER_ID,
      authorizationReference:
        process.env.PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE,
      reasonCode: null,
      observedAt: integrationObservedAt,
    });
    await transaction
      .update(channelConfigurations)
      .set({
        enabled: true,
        statusId,
        statusLabel: 'live-verified',
        changedAt: integrationObservedAt,
      })
      .where(eq(channelConfigurations.integrationId, 'ses-email'));
  });

  return Object.freeze({
    fixture: Object.freeze({ endpointId, recipientId, rosterSnapshotId }),
    previousEmailConfiguration,
    close: () => connection.close(),
  });
}

async function irreversibleBoundaryCounts(): Promise<
  Readonly<{
    attempts: number;
    deliveryEvidence: number;
    events: number;
    outbox: number;
    providerIo: number;
  }>
> {
  const connection = createDatabaseClient(readDatabaseConfig());
  try {
    const [counts] = databaseExecuteRows(
      await connection.db.execute<{
        attempts: number;
        deliveryEvidence: number;
        events: number;
        outbox: number;
        providerIo: number;
      }>(sql`
        select
          (select count(*)::integer from channel_attempts) as attempts,
          (select count(*)::integer from delivery_evidence) as "deliveryEvidence",
          (select count(*)::integer from events) as events,
          (select count(*)::integer from outbox) as outbox,
          (select count(*)::integer from ses_email_provider_io) as "providerIo"
      `),
    );
    if (counts === undefined) throw new Error('Canary boundary counts failed.');
    return counts;
  } finally {
    await connection.close();
  }
}

test.describe('email-integration-readiness', () => {
  test('shows the explicit no-send verification boundary accessibly', async ({
    page,
  }) => {
    const connection = createDatabaseClient(readDatabaseConfig());
    const [previous] = await connection.db
      .select()
      .from(channelConfigurations)
      .where(eq(channelConfigurations.integrationId, 'ses-email'))
      .limit(1);
    if (previous === undefined) {
      await connection.close();
      throw new Error('The synthetic SES channel configuration is missing.');
    }
    const observedAt = new Date();
    const statusId = randomUUID();
    await connection.db.insert(integrationStatuses).values({
      id: statusId,
      integrationId: 'ses-email',
      label: 'configured-unverified',
      verifiedAt: null,
      verifiedByUserId: null,
      authorizationReference: null,
      reasonCode: null,
      observedAt,
    });
    await connection.db
      .update(channelConfigurations)
      .set({
        enabled: false,
        statusId,
        statusLabel: 'configured-unverified',
        changedAt: observedAt,
      })
      .where(eq(channelConfigurations.integrationId, 'ses-email'));

    try {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto('/integrations');
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: 'Integrations administration',
        }),
      ).toBeVisible();
      const verification = page.getByRole('button', {
        name: 'Verify and enable email',
      });
      await expect(verification).toBeVisible();
      await expect(
        page.getByText(
          'Uses the retained, address-free SES verification reference configured on this deployment. This does not send an email.',
        ),
      ).toBeVisible();
      await verification.focus();
      await expect(verification).toBeFocused();
      await expectAxeClean(page);
      await verification.press('Enter');
      await expect(page).toHaveURL(/\/integrations\?status=email-verified$/u);
      await expect(page.getByRole('status')).toHaveText(
        'SES verification evidence was recorded and the email channel was enabled. No email was sent.',
      );
      await expect(
        page.getByRole('button', { name: 'Re-verify email deployment' }),
      ).toBeVisible();
      const [verified] = await connection.db
        .select({
          authorizationReference: integrationStatuses.authorizationReference,
          enabled: channelConfigurations.enabled,
          integrationLabel: integrationStatuses.label,
          statusLabel: channelConfigurations.statusLabel,
        })
        .from(channelConfigurations)
        .innerJoin(
          integrationStatuses,
          eq(channelConfigurations.statusId, integrationStatuses.id),
        )
        .where(eq(channelConfigurations.integrationId, 'ses-email'))
        .limit(1);
      expect(verified).toEqual({
        authorizationReference:
          process.env.PSD_EOC_SES_CREDENTIAL_VERIFICATION_REFERENCE,
        enabled: true,
        integrationLabel: 'live-verified',
        statusLabel: 'live-verified',
      });
      await expectAxeClean(page);
      await page.screenshot({
        path: issue277EvidencePath('email-integration-readiness.png'),
        fullPage: true,
      });
    } finally {
      await connection.db
        .update(channelConfigurations)
        .set({
          enabled: previous.enabled,
          statusId: previous.statusId,
          statusLabel: previous.statusLabel,
          changedAt: previous.changedAt,
        })
        .where(eq(channelConfigurations.integrationId, 'ses-email'));
      await connection.close();
    }
  });

  test('previews exactly one controlled DRILL email without activating it', async ({
    page,
  }) => {
    const installed = await installControlledEmailFixture();
    const before = await irreversibleBoundaryCounts();
    const { fixture, previousEmailConfiguration } = installed;
    try {
      await page.setViewportSize({ width: 1440, height: 1200 });
      await page.goto('/delivery-tests');
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: 'Monthly live delivery test',
        }),
      ).toBeVisible();

      const targetMode = page.getByLabel('Target mode');
      await targetMode.selectOption('controlled-email-canary');
      await expect(targetMode).toHaveValue('controlled-email-canary');
      await expect(page.getByLabel('Channel')).toHaveValue('email');

      await page
        .getByLabel('Facility')
        .first()
        .selectOption(SYNTHETIC_FACILITY_ID);
      await page
        .getByLabel('Current staff roster snapshot ID')
        .first()
        .fill(fixture.rosterSnapshotId);
      await page.getByLabel('Recipient ID').fill(fixture.recipientId);
      await page.getByLabel('Endpoint ID').fill(fixture.endpointId);
      await page
        .getByLabel('Recorded opt-in time')
        .fill(
          new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 16),
        );
      await page
        .getByLabel('Non-secret opaque authorization reference')
        .fill('synthetic-e2e-controlled-email-opt-in');
      const recordEligibility = page.getByRole('button', {
        name: 'Record eligibility decision',
      });
      await recordEligibility.focus();
      await recordEligibility.press('Enter');
      await expect(
        page.getByText('No event was started and no notification was sent.'),
      ).toBeVisible();

      await page
        .getByLabel('Facility')
        .nth(1)
        .selectOption(SYNTHETIC_FACILITY_ID);
      await page
        .getByLabel('Current staff roster snapshot ID')
        .nth(1)
        .fill(fixture.rosterSnapshotId);
      const saveTarget = page.getByRole('button', {
        name: /Save target version/u,
      });
      await saveTarget.focus();
      await saveTarget.press('Enter');
      await expect(
        page.getByText(
          'Saving did not start a DRILL or send any notification. A fresh preview and explicit human confirmation are still required.',
        ),
      ).toBeVisible();

      const loadPreview = page.getByRole('button', { name: 'Load preview' });
      await loadPreview.focus();
      await loadPreview.press('Enter');
      await expect(
        page.getByRole('heading', {
          level: 2,
          name: '3. Review consequences and confirm',
        }),
      ).toBeVisible();
      await expect(
        page.getByText('1 approved recipients across 1 channels:'),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 3, name: 'Email' }),
      ).toBeVisible();
      await expect(page.getByText('1 exact approved endpoint')).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 4, name: 'Exact DRILL message' }),
      ).toBeVisible();
      const confirmation = page.getByRole('button', {
        name: 'Confirm and start DRILL live canary',
      });
      await expect(confirmation).toBeEnabled();
      await expectAxeClean(page);

      expect(await irreversibleBoundaryCounts()).toEqual(before);
      await confirmation.focus();
      const previewEvidence = page.locator(
        '[aria-labelledby="live-canary-confirm-heading"]',
      );
      await expect(previewEvidence).toBeVisible();
      await previewEvidence.screenshot({
        path: issue277EvidencePath('controlled-email-canary-preview.png'),
      });
    } finally {
      const connection = createDatabaseClient(readDatabaseConfig());
      try {
        await connection.db
          .update(channelConfigurations)
          .set({
            enabled: previousEmailConfiguration.enabled,
            statusId: previousEmailConfiguration.statusId,
            statusLabel: previousEmailConfiguration.statusLabel,
            changedAt: previousEmailConfiguration.changedAt,
          })
          .where(eq(channelConfigurations.integrationId, 'ses-email'));
      } finally {
        await connection.close();
        await installed.close();
      }
    }
  });
});
