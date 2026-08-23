import { expect, test } from '@playwright/test';

import {
  expectAxeClean,
  issue341EvidencePath,
  readFixture,
  statePath,
} from './support';

test.describe('incident-record-history', () => {
  test('a facility-scoped staff user sees only authorized canonical records and export entry points', async ({
    browser,
  }) => {
    const fixture = await readFixture();
    const context = await browser.newContext({
      storageState: statePath('facility-staff.json'),
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 1000 });

    const response = await page.goto('/records');
    expect(response?.ok()).toBe(true);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Records' }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Authorized operational records' }),
    ).toBeVisible();
    await expect(page.getByText('REAL INCIDENT', { exact: true })).toHaveCount(
      1,
    );
    await expect(
      page.getByText('DRILL — TRAINING ONLY', { exact: true }),
    ).toHaveCount(2);
    await expect(
      page.getByText('TEST — NOT A REAL INCIDENT', { exact: true }),
    ).toHaveCount(1);

    for (const eventId of [
      fixture.records.northIncidentId,
      fixture.records.northDrillId,
      fixture.records.northTestId,
    ]) {
      await expect(page.locator(`a[href="/events/${eventId}"]`)).toBeVisible();
      await expect(
        page.locator(`a[href="/records/export/events/${eventId}"]`),
      ).toBeVisible();
    }
    await expect(page.getByText('Synthetic South Campus')).toHaveCount(0);
    await expect(
      page.locator(`a[href*="${fixture.records.southIncidentId}"]`),
    ).toHaveCount(0);

    const pdf = await context.request.get(
      `/records/export/events/${fixture.records.northIncidentId}`,
      { maxRedirects: 0 },
    );
    // The E2E app deliberately has no live object-store credentials. Reaching
    // the export capability must therefore fail closed after authorization,
    // with actionable public copy rather than looking nonexistent or leaking
    // provider details. PDF generation itself is covered by focused tests.
    expect(pdf.status()).toBe(503);
    await expect(pdf.json()).resolves.toEqual({
      code: 'EXPORT_UNAVAILABLE',
      message: 'The export could not be prepared. Try again later.',
    });

    const southRecords = await page.goto(
      `/records?facilityId=00000000-0000-4000-8000-000000000002`,
    );
    expect(southRecords?.status()).toBe(404);
    const southEvent = await page.goto(
      `/events/${fixture.records.southIncidentId}`,
    );
    expect(southEvent?.status()).toBe(404);

    await page.goto('/records');
    await expectAxeClean(page);
    await page.screenshot({
      path: issue341EvidencePath('incident-record-history.png'),
      fullPage: true,
    });
    await context.close();
  });
});
