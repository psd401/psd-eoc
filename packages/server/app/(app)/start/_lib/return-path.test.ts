import { describe, expect, test } from 'bun:test';

import {
  startConfirmationReturnPath,
  startResponseReturnPath,
  startSelectionReturnPath,
} from './return-path';

const FACILITY_ID = '16000000-0000-4000-8000-000000000001';
const EVENT_TYPE_VERSION_ID = '16000000-0000-4000-8000-000000000002';
const THREAT_ID = '16000000-0000-4000-8000-000000000003';

describe('start-flow return paths', () => {
  test('produces only the exact canonical selection pathname and query', () => {
    expect(
      String(
        startSelectionReturnPath({ facilityId: FACILITY_ID, mode: 'real' }),
      ),
    ).toBe(`/start?facilityId=${FACILITY_ID}&mode=real`);
    expect(
      String(
        startSelectionReturnPath({ facilityId: FACILITY_ID, mode: 'drill' }),
      ),
    ).toBe(`/start?facilityId=${FACILITY_ID}&mode=drill`);
  });

  test('produces the response step with the threat and its typed description', () => {
    expect(
      String(
        startResponseReturnPath({
          facilityId: FACILITY_ID,
          mode: 'drill',
          threatId: THREAT_ID,
          threatDetail: null,
        }),
      ),
    ).toBe(`/start?facilityId=${FACILITY_ID}&mode=drill&threatId=${THREAT_ID}`);
    expect(
      String(
        startResponseReturnPath({
          facilityId: FACILITY_ID,
          mode: 'real',
          threatId: THREAT_ID,
          threatDetail: 'Gas smell near the gym',
        }),
      ),
    ).toBe(
      `/start?facilityId=${FACILITY_ID}&mode=real&threatId=${THREAT_ID}&threatDetail=Gas+smell+near+the+gym`,
    );
  });

  test('produces only the exact canonical confirmation pathname and query', () => {
    expect(
      String(
        startConfirmationReturnPath({
          facilityId: FACILITY_ID,
          mode: 'drill',
          threatId: THREAT_ID,
          threatDetail: null,
          eventTypeVersionId: EVENT_TYPE_VERSION_ID,
          responseDetail: null,
        }),
      ),
    ).toBe(
      `/start/confirm?facilityId=${FACILITY_ID}&mode=drill&threatId=${THREAT_ID}&eventTypeVersionId=${EVENT_TYPE_VERSION_ID}`,
    );
    expect(
      String(
        startConfirmationReturnPath({
          facilityId: FACILITY_ID,
          mode: 'drill',
          threatId: THREAT_ID,
          threatDetail: 'Gas smell',
          eventTypeVersionId: EVENT_TYPE_VERSION_ID,
          responseDetail: 'Move to the field',
        }),
      ),
    ).toBe(
      `/start/confirm?facilityId=${FACILITY_ID}&mode=drill&threatId=${THREAT_ID}&threatDetail=Gas+smell&eventTypeVersionId=${EVENT_TYPE_VERSION_ID}&responseDetail=Move+to+the+field`,
    );
  });

  test('rejects path, query, duplicate-value, and mode injection inputs', () => {
    for (const facilityId of [
      `${FACILITY_ID}&mode=drill`,
      `${FACILITY_ID}/../../login`,
      [FACILITY_ID, FACILITY_ID],
    ]) {
      expect(() =>
        startSelectionReturnPath({ facilityId, mode: 'real' }),
      ).toThrow();
    }
    expect(() =>
      startSelectionReturnPath({ facilityId: FACILITY_ID, mode: 'real&x=1' }),
    ).toThrow();
    expect(() =>
      startConfirmationReturnPath({
        facilityId: FACILITY_ID,
        mode: 'real',
        threatId: THREAT_ID,
        threatDetail: null,
        eventTypeVersionId: `${EVENT_TYPE_VERSION_ID}?next=https://evil.invalid`,
        responseDetail: null,
      }),
    ).toThrow();
    expect(() =>
      startResponseReturnPath({
        facilityId: FACILITY_ID,
        mode: 'real',
        threatId: `${THREAT_ID}&mode=drill`,
        threatDetail: null,
      }),
    ).toThrow();
  });

  test('refuses a description the message contract would refuse', () => {
    for (const threatDetail of ['', '   ', 'a'.repeat(201), 'bad​word']) {
      expect(() =>
        startResponseReturnPath({
          facilityId: FACILITY_ID,
          mode: 'real',
          threatId: THREAT_ID,
          threatDetail,
        }),
      ).toThrow();
    }
  });
});
