import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';

import { createDatabaseClient, readDatabaseConfig } from '../db/client';
import { channelConfigurations, integrationStatuses } from '../db/schema';
import { expectAxeClean, issue277EvidencePath } from './support';

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
      await verification.click();
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
});
