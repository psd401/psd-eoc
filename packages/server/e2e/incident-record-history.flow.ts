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
    // The retained North drill plus the runner's four live North drills
    // (shared, issue 344, issue 32, and the partner flows' drill).
    await expect(
      page.getByText('DRILL — TRAINING ONLY', { exact: true }),
    ).toHaveCount(5);
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
    // The seed puts North and South on one campus. A South event reaches
    // North staff, so they can open it and post, but ending it stays with
    // South and its record and export stay out of their records list.
    const southExport = await context.request.get(
      `/records/export/events/${fixture.records.southIncidentId}`,
      { maxRedirects: 0 },
    );
    expect(southExport.ok()).toBe(false);
    const southEvent = await page.goto(
      `/events/${fixture.records.southIncidentId}`,
    );
    expect(southEvent?.status()).toBe(200);
    await expect(
      page.getByText('This event is closed. Its timeline is still here.'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'End event', exact: true }),
    ).toHaveCount(0);

    await page.goto('/records');
    await expectAxeClean(page);
    await page.screenshot({
      path: issue341EvidencePath('incident-record-history.png'),
      fullPage: true,
    });
    await context.close();
  });

  test('district staff without administrator authority open every authorized site at once', async ({
    browser,
  }) => {
    const fixture = await readFixture();
    const context = await browser.newContext({
      storageState: statePath('district-staff.json'),
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 1000 });

    const response = await page.goto('/records');
    expect(response?.ok()).toBe(true);
    // Every site the district places them at, without choosing one first.
    await expect(page.getByLabel('Site')).toHaveValue('all');
    await expect(
      page.getByRole('option', { name: 'All authorized sites' }),
    ).toHaveCount(1);
    for (const eventId of [
      fixture.records.northIncidentId,
      fixture.records.northDrillId,
      fixture.records.northTestId,
      fixture.records.southIncidentId,
    ]) {
      await expect(page.locator(`a[href="/events/${eventId}"]`)).toBeVisible();
    }
    await expect(page.getByText('Synthetic North Campus')).not.toHaveCount(0);
    await expect(page.getByText('Synthetic South Campus')).not.toHaveCount(0);
    // One site's retained training export needs one site chosen.
    await expect(
      page.getByRole('link', { name: 'Download training CSV' }),
    ).toHaveCount(0);

    const oneSite = await page.goto(
      `/records?facilityId=00000000-0000-4000-8000-000000000002`,
    );
    expect(oneSite?.ok()).toBe(true);
    await expect(
      page.locator(`a[href="/events/${fixture.records.southIncidentId}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`a[href="/events/${fixture.records.northIncidentId}"]`),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Download training CSV' }),
    ).toBeVisible();

    await page.goto('/records');
    await expectAxeClean(page);
    await page.screenshot({
      path: issue341EvidencePath('records-all-authorized-sites.png'),
      fullPage: true,
    });
    await context.close();
  });

  test('two schools’ staff groups open both schools’ history and nothing beyond it', async ({
    browser,
  }) => {
    const fixture = await readFixture();
    const context = await browser.newContext({
      storageState: statePath('two-campus-staff.json'),
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 1000 });

    const response = await page.goto('/records');
    expect(response?.ok()).toBe(true);
    await expect(page.getByLabel('Site')).toHaveValue('all');
    for (const eventId of [
      fixture.records.northIncidentId,
      fixture.records.northDrillId,
      fixture.records.northTestId,
      fixture.records.southIncidentId,
    ]) {
      await expect(page.locator(`a[href="/events/${eventId}"]`)).toBeVisible();
    }
    // Both of their schools, and only their schools, are offered.
    await expect(page.getByLabel('Site').getByRole('option')).toHaveCount(3);

    await page.screenshot({
      path: issue341EvidencePath('records-two-campus-union.png'),
      fullPage: true,
    });
    await context.close();
  });
});
