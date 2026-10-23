import { describe, expect, test } from 'bun:test';

import { CreateGroupSourceInputSchema } from './group';
import {
  GroupMembershipSessionAuthorizationSchema,
  SessionAuthorizationSchema,
  SessionSchema,
  UserSchema,
} from './identity';
import {
  PartnerAdmissionEndingSchema,
  PartnerAdmissionSchema,
  partnerAdmissionExpiresAt,
  partnerAdmissionStatus,
} from './partner-admission';
import { isExclusiveRoleSet, RoleSchema, StaffRoleSchema } from './shared';

const ADMISSION_ID = '00000000-0000-4000-8000-000000059001';
const ADMIN_ID = '00000000-0000-4000-8000-000000059002';
const USER_ID = '00000000-0000-4000-8000-000000059003';

function admission(overrides: Record<string, unknown> = {}) {
  return {
    id: ADMISSION_ID,
    email: 'responder@agency.example.invalid',
    displayName: 'Synthetic Responder',
    agency: 'Synthetic Fire District',
    invitedByUserId: ADMIN_ID,
    admittedAt: '2026-10-23T16:00:00.000Z',
    expiresAt: '2027-10-23T16:00:00.000Z',
    supersedesAdmissionId: null,
    ending: null,
    ...overrides,
  };
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    googleSubject: null,
    email: 'responder@agency.example.invalid',
    displayName: 'Synthetic Responder',
    roles: ['partner'],
    facilityScope: { kind: 'district' },
    createdAt: '2026-10-23T16:00:00.000Z',
    disabledAt: null,
    ...overrides,
  };
}

describe('the partner role', () => {
  test('is a role, but never one an access group can grant', () => {
    expect(RoleSchema.options).toEqual(['staff', 'admin', 'partner']);
    expect(StaffRoleSchema.options).toEqual(['staff', 'admin']);
    expect(StaffRoleSchema.safeParse('partner').success).toBe(false);
    const accessGroup = (grantedRole: string) =>
      CreateGroupSourceInputSchema.safeParse({
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: 'Synthetic responders',
        active: true,
        grantedRole,
        googleGroupId: 'synthetic-responders',
        email: 'responders@example.invalid',
      }).success;
    expect(accessGroup('partner')).toBe(false);
    expect(accessGroup('admin')).toBe(true);
  });

  test('never sits beside a staff role', () => {
    expect(isExclusiveRoleSet(['partner'])).toBe(true);
    expect(isExclusiveRoleSet(['staff', 'admin'])).toBe(true);
    expect(isExclusiveRoleSet([])).toBe(true);
    expect(isExclusiveRoleSet(['partner', 'staff'])).toBe(false);
    expect(isExclusiveRoleSet(['admin', 'partner'])).toBe(false);
    expect(UserSchema.safeParse(user()).success).toBe(true);
    expect(
      UserSchema.safeParse(user({ roles: ['partner', 'staff'] })).success,
    ).toBe(false);
    expect(
      UserSchema.safeParse(user({ roles: ['admin', 'partner'] })).success,
    ).toBe(false);
  });

  test('is never held by a Google staff identity', () => {
    expect(
      UserSchema.safeParse(user({ googleSubject: 'google-subject-1' })).success,
    ).toBe(false);
    expect(
      UserSchema.safeParse(
        user({ googleSubject: 'google-subject-1', roles: ['staff'] }),
      ).success,
    ).toBe(true);
  });
});

describe('partner admission expiry', () => {
  test('is the same UTC time one calendar year later', () => {
    expect(partnerAdmissionExpiresAt('2026-10-23T16:00:00.000Z')).toBe(
      '2027-10-23T16:00:00.000Z',
    );
    expect(partnerAdmissionExpiresAt('2026-12-31T23:59:59.999Z')).toBe(
      '2027-12-31T23:59:59.999Z',
    );
  });

  test('falls back from February 29 to February 28, as PostgreSQL does', () => {
    expect(partnerAdmissionExpiresAt('2028-02-29T10:00:00.000Z')).toBe(
      '2029-02-28T10:00:00.000Z',
    );
  });

  test('a record whose expiry is not admission plus one year is refused', () => {
    expect(PartnerAdmissionSchema.safeParse(admission()).success).toBe(true);
    expect(
      PartnerAdmissionSchema.safeParse(
        admission({ expiresAt: '2028-10-23T16:00:00.000Z' }),
      ).success,
    ).toBe(false);
  });
});

describe('partner admission endings', () => {
  test('expiry is the system’s and carries no actor', () => {
    expect(
      PartnerAdmissionEndingSchema.safeParse({
        reason: 'expired',
        endedByUserId: null,
        endedAt: '2027-10-23T16:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      PartnerAdmissionEndingSchema.safeParse({
        reason: 'expired',
        endedByUserId: ADMIN_ID,
        endedAt: '2027-10-23T16:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  test('disable and supersession always name an administrator', () => {
    for (const reason of ['disabled', 'superseded'] as const) {
      expect(
        PartnerAdmissionEndingSchema.safeParse({
          reason,
          endedByUserId: null,
          endedAt: '2026-11-01T16:00:00.000Z',
        }).success,
      ).toBe(false);
      expect(
        PartnerAdmissionEndingSchema.safeParse({
          reason,
          endedByUserId: ADMIN_ID,
          endedAt: '2026-11-01T16:00:00.000Z',
        }).success,
      ).toBe(true);
    }
  });

  test('an admission cannot end before it began or supersede itself', () => {
    expect(
      PartnerAdmissionSchema.safeParse(
        admission({
          ending: {
            reason: 'disabled',
            endedByUserId: ADMIN_ID,
            endedAt: '2026-10-22T16:00:00.000Z',
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      PartnerAdmissionSchema.safeParse(
        admission({ supersedesAdmissionId: ADMISSION_ID }),
      ).success,
    ).toBe(false);
  });
});

describe('partner admission status', () => {
  const parsed = PartnerAdmissionSchema.parse(admission());

  test('is active until the expiry instant and expired from it on', () => {
    expect(
      partnerAdmissionStatus(parsed, new Date('2027-10-23T15:59:59.999Z')),
    ).toBe('active');
    expect(
      partnerAdmissionStatus(parsed, new Date('2027-10-23T16:00:00.000Z')),
    ).toBe('expired');
  });

  test('keeps disabled, expired and superseded distinct', () => {
    for (const reason of ['disabled', 'superseded'] as const) {
      expect(
        partnerAdmissionStatus(
          {
            ...parsed,
            ending: {
              reason,
              endedByUserId: ADMIN_ID,
              endedAt: '2026-11-01T00:00:00.000Z',
            },
          },
          new Date('2026-11-02T00:00:00.000Z'),
        ),
      ).toBe(reason);
    }
    expect(
      partnerAdmissionStatus(
        {
          ...parsed,
          ending: {
            reason: 'expired',
            endedByUserId: null,
            endedAt: '2027-10-23T16:00:00.000Z',
          },
        },
        new Date('2027-10-24T00:00:00.000Z'),
      ),
    ).toBe('expired');
  });
});

describe('session authorization variants', () => {
  const staffAuthorization = {
    kind: 'group-membership',
    source: 'google-group-snapshot',
    membershipSnapshotId: null,
    membershipValidUntil: '2026-10-24T16:00:00.000Z',
    membershipGraceUntil: '2026-10-26T16:00:00.000Z',
  };
  const session = (authorization: unknown) => ({
    id: '00000000-0000-4000-8000-000000059010',
    userId: USER_ID,
    deviceEnrollmentId: '00000000-0000-4000-8000-000000059011',
    createdAt: '2026-10-23T16:00:00.000Z',
    expiresAt: '2026-10-24T16:00:00.000Z',
    authorization,
    revokedAt: null,
  });

  test('a staff session keeps the exact shape installed mobile builds parse', () => {
    // Installed builds know only this strict object. Its keys must not grow
    // or the next staff session payload fails to parse on every phone.
    expect(
      Object.keys(
        GroupMembershipSessionAuthorizationSchema.parse(staffAuthorization),
      ),
    ).toEqual([
      'kind',
      'source',
      'membershipSnapshotId',
      'membershipValidUntil',
      'membershipGraceUntil',
    ]);
    expect(
      SessionAuthorizationSchema.safeParse({
        ...staffAuthorization,
        partnerAdmissionId: ADMISSION_ID,
      }).success,
    ).toBe(false);
    expect(SessionSchema.safeParse(session(staffAuthorization)).success).toBe(
      true,
    );
  });

  test('a partner session carries its admission and no membership windows', () => {
    const partnerAuthorization = {
      kind: 'partner-admission',
      partnerAdmissionId: ADMISSION_ID,
      admissionExpiresAt: '2027-10-23T16:00:00.000Z',
    };
    expect(
      SessionAuthorizationSchema.safeParse(partnerAuthorization).success,
    ).toBe(true);
    expect(SessionSchema.safeParse(session(partnerAuthorization)).success).toBe(
      true,
    );
    expect(
      SessionAuthorizationSchema.safeParse({
        ...partnerAuthorization,
        membershipValidUntil: '2026-10-24T16:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
