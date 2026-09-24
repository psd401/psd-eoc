import { describe, expect, test } from 'bun:test';

import { serializeDrillRecordsCsv, type DrillRecordCsvRow } from './csv';

const textDecoder = new TextDecoder();

const BASE_ROW: DrillRecordCsvRow = Object.freeze({
  facilityName: 'Summit Heights Elementary',
  facilityCode: 'HHE',
  eventType: 'Lockdown',
  threatName: 'Wildlife',
  threatDetail: null,
  responseDetail: null,
  kind: 'drill',
  startedAt: '2024-03-10T09:30:00.000Z',
  durationSeconds: 10 * 60,
  participantCount: 35,
});

function decode(rows: readonly DrillRecordCsvRow[]): string {
  return textDecoder.decode(serializeDrillRecordsCsv(rows));
}

describe('drill-record CSV serialization', () => {
  test('emits the fixed RCW header, local date/time, labels, and duration', () => {
    const csv = decode([
      BASE_ROW,
      {
        ...BASE_ROW,
        kind: 'test',
        eventType: 'Evacuation',
        startedAt: '2024-03-10T10:30:00.000Z',
        durationSeconds: null,
        participantCount: 0,
      },
    ]);

    expect(csv).toBe(
      'site,date,time,threat,type,duration,participants_count\r\n' +
        'Summit Heights Elementary [HHE],2024-03-10,01:30:00 PST,Wildlife,[DRILL] Lockdown,00:10:00,35\r\n' +
        'Summit Heights Elementary [HHE],2024-03-10,03:30:00 PDT,Wildlife,[TEST] Evacuation,,0\r\n',
    );
  });

  test('carries typed descriptions and leaves the threat empty for a drill that predates the catalog', () => {
    const csv = decode([
      {
        ...BASE_ROW,
        threatName: 'Other',
        threatDetail: 'Gas smell in the gym',
        eventType: 'Other',
        responseDetail: 'Move everyone to the field',
      },
      { ...BASE_ROW, threatName: null, threatDetail: null },
    ]);

    expect(csv).toBe(
      'site,date,time,threat,type,duration,participants_count\r\n' +
        'Summit Heights Elementary [HHE],2024-03-10,01:30:00 PST,Other — Gas smell in the gym,[DRILL] Other — Move everyone to the field,00:10:00,35\r\n' +
        'Summit Heights Elementary [HHE],2024-03-10,01:30:00 PST,,[DRILL] Lockdown,00:10:00,35\r\n',
    );
  });

  test('uses the correct repeated-hour timezone labels when DST ends', () => {
    const csv = decode([
      {
        ...BASE_ROW,
        startedAt: '2024-11-03T08:30:00.000Z',
      },
      {
        ...BASE_ROW,
        startedAt: '2024-11-03T09:30:00.000Z',
      },
    ]);

    expect(csv).toContain(',2024-11-03,01:30:00 PDT,');
    expect(csv).toContain(',2024-11-03,01:30:00 PST,');
  });

  test('quotes commas, quotes, and normalized embedded newlines', () => {
    const csv = decode([
      {
        ...BASE_ROW,
        facilityName: '=HYPERLINK("https://example.invalid","Site, A")\nAnnex',
        facilityCode: '+CSV',
        eventType: '@SUM(1,2)\r"Lockdown"',
      },
    ]);
    const expectedSite =
      '"\'=HYPERLINK(""https://example.invalid"",""Site, A"")\r\nAnnex [\'+CSV]"';
    const expectedType = '"[DRILL] \'@SUM(1,2)\r\n""Lockdown"""';

    expect(csv).toBe(
      `site,date,time,threat,type,duration,participants_count\r\n${expectedSite},2024-03-10,01:30:00 PST,Wildlife,${expectedType},00:10:00,35\r\n`,
    );
    const withoutCrLf = csv.replaceAll('\r\n', '');
    expect(withoutCrLf).not.toContain('\r');
    expect(withoutCrLf).not.toContain('\n');
  });

  test('formula-neutralizes every spreadsheet trigger in site and type text', () => {
    const formulas = ['=1+1', '+1+1', '-1+1', '@SUM(1,1)'] as const;
    const csv = decode(
      formulas.map((formula, index) => ({
        ...BASE_ROW,
        facilityName: formula,
        facilityCode: `=${index}`,
        eventType: index === 0 ? ` \t${formula}` : formula,
        kind: index % 2 === 0 ? 'drill' : 'test',
      })),
    );

    for (const [index, formula] of formulas.entries()) {
      expect(csv).toContain(`'${formula} ['=${index}]`);
      expect(csv).toContain(
        `${index % 2 === 0 ? '[DRILL]' : '[TEST]'} '${index === 0 ? ` \t${formula}` : formula}`,
      );
    }
  });

  test('returns deterministic UTF-8 bytes and leaves unknown duration blank', () => {
    const row = {
      ...BASE_ROW,
      facilityName: 'École synthétique',
      durationSeconds: null,
    } as const;

    const first = serializeDrillRecordsCsv([row]);
    const second = serializeDrillRecordsCsv([row]);
    const csv = textDecoder.decode(first);

    expect(first).toEqual(second);
    expect(first.byteLength).toBeGreaterThan(csv.length);
    expect(csv).toContain('École synthétique [HHE]');
    expect(csv).toContain('[DRILL] Lockdown,,35\r\n');
  });

  test('rejects real-incident labels and malformed numeric or time values', () => {
    expect(() =>
      serializeDrillRecordsCsv([
        { ...BASE_ROW, kind: 'incident' } as unknown as DrillRecordCsvRow,
      ]),
    ).toThrow('classified as drill or test');
    expect(() =>
      serializeDrillRecordsCsv([{ ...BASE_ROW, participantCount: -1 }]),
    ).toThrow('participantCount');
    expect(() =>
      serializeDrillRecordsCsv([{ ...BASE_ROW, durationSeconds: Number.NaN }]),
    ).toThrow('durationSeconds');
    expect(() =>
      serializeDrillRecordsCsv([{ ...BASE_ROW, startedAt: 'not-a-time' }]),
    ).toThrow('startedAt');
    expect(() =>
      serializeDrillRecordsCsv([
        { ...BASE_ROW, startedAt: '2024-03-10T01:30:00' },
      ]),
    ).toThrow('startedAt');
  });
});
