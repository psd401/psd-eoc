import type { SessionEstablishmentResult } from '@psd-eoc/contracts';

export const TEST_NOW = new Date('2026-08-10T18:00:00.000Z');
export const TEST_TOKEN = 'a'.repeat(43);
export const TEST_NEXT_TOKEN = 'b'.repeat(43);

/**
 * A partner session as the native partner endpoints issue one: no Google
 * subject, the `partner` role, the facilities the admission reaches rather
 * than the district, the partner-admission authorization arm, and a session
 * that expires within the day. It rides the same envelope as the staff
 * fixture below, which is what keeps an installed build able to read it.
 */
export function partnerSessionFixture(
  connectivityEpochId = '00000000-0000-4000-8000-000000000015',
): SessionEstablishmentResult {
  return {
    user: {
      id: '00000000-0000-4000-8000-000000000011',
      googleSubject: null,
      email: 'synthetic.responder@agency.example.invalid',
      displayName: 'Synthetic Responder',
      roles: ['partner'],
      facilityScope: {
        kind: 'facilities',
        facilityIds: ['00000000-0000-4000-8000-0000000000f1'],
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      disabledAt: null,
    },
    session: {
      id: '00000000-0000-4000-8000-000000000012',
      userId: '00000000-0000-4000-8000-000000000011',
      deviceEnrollmentId: '00000000-0000-4000-8000-000000000013',
      createdAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-11T00:00:00.000Z',
      authorization: {
        kind: 'partner-admission',
        partnerAdmissionId: '00000000-0000-4000-8000-000000000014',
        admissionExpiresAt: '2027-08-01T00:00:00.000Z',
      },
      revokedAt: null,
    },
    deviceEnrollment: {
      id: '00000000-0000-4000-8000-000000000013',
      userId: '00000000-0000-4000-8000-000000000011',
      platform: 'android',
      unlockMethod: 'biometric',
      installationId: 'synthetic-installation-0002',
      enrolledAt: '2026-08-10T00:00:00.000Z',
      lastSeenAt: '2026-08-10T17:00:00.000Z',
      revokedAt: null,
    },
    connectivityEpoch: {
      id: connectivityEpochId,
      sessionId: '00000000-0000-4000-8000-000000000012',
      establishedAt: '2026-08-10T17:00:00.000Z',
    },
  };
}

export function sessionFixture(
  connectivityEpochId = '00000000-0000-4000-8000-000000000005',
): SessionEstablishmentResult {
  return {
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      googleSubject: 'synthetic-staff-subject',
      email: 'synthetic.staff@example.invalid',
      displayName: 'Synthetic Staff',
      roles: ['staff'],
      facilityScope: { kind: 'district' },
      createdAt: '2026-08-01T00:00:00.000Z',
      disabledAt: null,
    },
    session: {
      id: '00000000-0000-4000-8000-000000000002',
      userId: '00000000-0000-4000-8000-000000000001',
      deviceEnrollmentId: '00000000-0000-4000-8000-000000000003',
      createdAt: '2026-08-09T00:00:00.000Z',
      expiresAt: '2026-11-09T00:00:00.000Z',
      authorization: {
        kind: 'group-membership',
        source: 'google-group-snapshot',
        membershipSnapshotId: '00000000-0000-4000-8000-000000000004',
        membershipValidUntil: '2026-08-11T00:00:00.000Z',
        membershipGraceUntil: '2026-08-14T00:00:00.000Z',
      },
      revokedAt: null,
    },
    deviceEnrollment: {
      id: '00000000-0000-4000-8000-000000000003',
      userId: '00000000-0000-4000-8000-000000000001',
      platform: 'ios',
      unlockMethod: 'biometric',
      installationId: 'synthetic-installation-0001',
      enrolledAt: '2026-08-09T00:00:00.000Z',
      lastSeenAt: '2026-08-10T17:00:00.000Z',
      revokedAt: null,
    },
    connectivityEpoch: {
      id: connectivityEpochId,
      sessionId: '00000000-0000-4000-8000-000000000002',
      establishedAt: '2026-08-10T17:00:00.000Z',
    },
  };
}
