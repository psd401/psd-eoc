import { describe, expect, test } from 'bun:test';

import type { PartnerAdmission } from '@psd-eoc/contracts';

import { partnerAccessAsAccessDecision } from './partner-admission';

const NOW = new Date('2026-10-25T18:00:00.000Z');
const ADMITTED = Object.freeze({
  granted: true as const,
  admission: {} as PartnerAdmission,
});
const OPEN_SCOPE = Object.freeze({
  kind: 'facilities' as const,
  facilityIds: Object.freeze(['00000000-0000-4000-8000-000000000001']),
});

describe('a partner decision as an access decision', () => {
  test('a current admission acts at the partner facility scope', () => {
    expect(partnerAccessAsAccessDecision(ADMITTED, NOW, OPEN_SCOPE)).toEqual({
      granted: true,
      roles: ['partner'],
      groupSourceIds: [],
      admittedAccountId: null,
      facilityScope: OPEN_SCOPE,
      capturedAt: NOW,
    });
  });

  test('with no facility a partner may act at, nobody is admitted', () => {
    expect(partnerAccessAsAccessDecision(ADMITTED, NOW, null)).toEqual({
      granted: false,
      refusal: 'NO_PARTNER_FACILITIES',
    });
  });

  test('a refused admission stays refused whatever the scope', () => {
    expect(
      partnerAccessAsAccessDecision(
        { granted: false, refusal: 'PARTNER_ADMISSION_ENDED', admission: null },
        NOW,
        OPEN_SCOPE,
      ),
    ).toEqual({ granted: false, refusal: 'PARTNER_ADMISSION_ENDED' });
  });
});
