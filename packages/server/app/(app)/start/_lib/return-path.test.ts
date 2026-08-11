import { describe, expect, test } from 'bun:test';

import {
  startConfirmationReturnPath,
  startSelectionReturnPath,
} from './return-path';

const FACILITY_ID = '16000000-0000-4000-8000-000000000001';
const EVENT_TYPE_VERSION_ID = '16000000-0000-4000-8000-000000000002';

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

  test('produces only the exact canonical confirmation pathname and query', () => {
    expect(
      String(
        startConfirmationReturnPath({
          facilityId: FACILITY_ID,
          mode: 'drill',
          eventTypeVersionId: EVENT_TYPE_VERSION_ID,
        }),
      ),
    ).toBe(
      `/start/confirm?facilityId=${FACILITY_ID}&mode=drill&eventTypeVersionId=${EVENT_TYPE_VERSION_ID}`,
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
        eventTypeVersionId: `${EVENT_TYPE_VERSION_ID}?next=https://evil.invalid`,
      }),
    ).toThrow();
  });
});
