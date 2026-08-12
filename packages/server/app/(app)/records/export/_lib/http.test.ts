import { describe, expect, test } from 'bun:test';

import {
  RecordsExportRequestError,
  drillExportRedirect,
  eventSummaryRedirect,
  exactExportQuery,
  parseDrillExportInput,
  recordsExportFailure,
} from './http';

const ARTIFACT = Object.freeze({
  id: '10000000-0000-4000-8000-000000000001',
  format: 'csv' as const,
  contentType: 'text/csv; charset=utf-8' as const,
  fileName: 'drill-records.csv',
  byteLength: 128,
  contentSha256: 'a'.repeat(64),
  rowCount: 2,
  downloadUrl: 'https://private-artifacts.example.invalid/drill.csv?grant=test',
  generatedAt: '2026-08-11T18:00:00.000Z',
  expiresAt: '2026-08-11T18:10:00.000Z',
});

describe('records export HTTP boundary', () => {
  test('redirects only a current validated CSV grant with 303 and no-store', () => {
    const response = drillExportRedirect(
      ARTIFACT,
      new Date('2026-08-11T18:01:00.000Z'),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(ARTIFACT.downloadUrl);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  test('binds a PDF grant to the requested event', () => {
    const eventId = '20000000-0000-4000-8000-000000000001';
    const response = eventSummaryRedirect(
      {
        eventId,
        artifact: {
          ...ARTIFACT,
          format: 'pdf',
          contentType: 'application/pdf',
          fileName: 'event-summary.pdf',
          downloadUrl:
            'https://private-artifacts.example.invalid/event.pdf?grant=test',
        },
      },
      eventId,
      new Date('2026-08-11T18:01:00.000Z'),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('event.pdf');
  });

  test('rejects insecure, expired, mismatched, and inexact grants or queries', () => {
    expect(() =>
      drillExportRedirect(
        { ...ARTIFACT, downloadUrl: 'http://example.invalid/drill.csv' },
        new Date('2026-08-11T18:01:00.000Z'),
      ),
    ).toThrow();
    expect(() =>
      drillExportRedirect(ARTIFACT, new Date('2026-08-11T18:10:00.000Z')),
    ).toThrow();
    expect(() =>
      eventSummaryRedirect(
        {
          eventId: '20000000-0000-4000-8000-000000000002',
          artifact: { ...ARTIFACT, format: 'pdf' },
        },
        '20000000-0000-4000-8000-000000000001',
        new Date('2026-08-11T18:01:00.000Z'),
      ),
    ).toThrow();
    expect(() =>
      exactExportQuery(
        new Request('https://eoc.example/records/export?site=one&site=two'),
        ['site'],
      ),
    ).toThrow(RecordsExportRequestError);
  });

  test('maps malformed drill filters to a bounded 400 response', async () => {
    const validQuery = new URLSearchParams({
      facilityId: '10000000-0000-4000-8000-000000000001',
      startedFrom: '2026-08-10',
      startedThrough: '2026-08-11',
      eventTypeId: '',
    });
    expect(
      parseDrillExportInput(
        new Request(`https://eoc.example/records/export?${validQuery}`),
      ),
    ).toMatchObject({ format: 'csv', eventTypeId: null });

    for (const query of [
      new URLSearchParams({
        ...Object.fromEntries(validQuery),
        startedFrom: '',
      }),
      new URLSearchParams({
        ...Object.fromEntries(validQuery),
        facilityId: 'not-a-facility',
      }),
      new URLSearchParams({
        ...Object.fromEntries(validQuery),
        eventTypeId: 'not-an-event-type',
      }),
    ]) {
      let error: unknown;
      try {
        parseDrillExportInput(
          new Request(`https://eoc.example/records/export?${query}`),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RecordsExportRequestError);
      const response = recordsExportFailure(error);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: 'INVALID_EXPORT_REQUEST',
      });
    }
  });
});
