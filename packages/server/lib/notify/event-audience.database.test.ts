import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  deviceEnrollments,
  devicePushTokenRegistrations,
  devicePushTokenUnregistrations,
  facilities,
  groupMembers,
  groupSources,
  users,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  type DisposableDatabase,
} from '../testing/database';
import { recipientIdForEmail, resolveEventAudience } from './event-audience';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const SCHOOL = randomUUID();
const EMPTY_SCHOOL = randomUUID();
const STAFF_GROUP = randomUUID();
const EMPTY_GROUP = randomUUID();

// Four members of one school, deliberately in four different states.
const ENROLLED = 'enrolled@example.invalid';
const NEVER_SIGNED_IN = 'neversignedin@example.invalid';
const REVOKED_DEVICE = 'revokeddevice@example.invalid';
const DISABLED_ACCOUNT = 'disabledaccount@example.invalid';

const ENROLLED_USER = randomUUID();
const REVOKED_USER = randomUUID();
const DISABLED_USER = randomUUID();

const LIVE_DEVICE = randomUUID();
const REPLACED_DEVICE = randomUUID();
const REVOKED_DEVICE_ID = randomUUID();
const DISABLED_DEVICE = randomUUID();

const LIVE_REGISTRATION = randomUUID();
const RETIRED_REGISTRATION = randomUUID();

let connection: PostgresDatabaseConnection | undefined;
let disposable: DisposableDatabase | undefined;

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('no database');
  return connection.db;
}

describeWithDatabase('event audience resolved from the domain', () => {
  beforeAll(async () => {
    if (baseUrl === undefined) throw new Error('TEST_DATABASE_URL required');
    disposable = await createDisposableDatabase('psd_eoc_audience', baseUrl);
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: disposable.url,
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') throw new Error('postgres required');
    connection = opened;
    await migrateDatabase(opened);

    await opened.db.insert(facilities).values([
      { id: SCHOOL, code: 'AUD', name: 'Audience School' },
      { id: EMPTY_SCHOOL, code: 'AUDEMPTY', name: 'Empty School' },
    ]);
    for (const [id, facilityId, suffix] of [
      [STAFF_GROUP, SCHOOL, 'aud'],
      [EMPTY_GROUP, EMPTY_SCHOOL, 'audempty'],
    ] as const) {
      await opened.db.insert(groupSources).values({
        id,
        kind: 'google-group',
        purpose: 'building',
        facilityId,
        displayName: `Staff ${suffix}`,
        active: true,
        grantedRole: null,
        membersCapturedAt: new Date('2026-08-22T12:00:00.000Z'),
        googleGroupId: `provider_${suffix}`,
        email: `staff-${suffix}@example.invalid`,
        fixtureKey: null,
      });
    }

    await opened.db
      .insert(groupMembers)
      .values(
        [ENROLLED, NEVER_SIGNED_IN, REVOKED_DEVICE, DISABLED_ACCOUNT].map(
          (email) => ({ groupSourceId: STAFF_GROUP, email }),
        ),
      );

    // Three of the four have signed in; NEVER_SIGNED_IN deliberately has no
    // `users` row at all, which is the case a `users`-based audience drops.
    await opened.db.insert(users).values([
      {
        id: ENROLLED_USER,
        googleSubject: 'subject-enrolled',
        email: ENROLLED,
        displayName: 'Enrolled Person',
        facilityScopeKind: 'district',
      },
      {
        id: REVOKED_USER,
        googleSubject: 'subject-revoked',
        email: REVOKED_DEVICE,
        displayName: 'Revoked Device Person',
        facilityScopeKind: 'district',
      },
      {
        id: DISABLED_USER,
        googleSubject: 'subject-disabled',
        email: DISABLED_ACCOUNT,
        displayName: 'Disabled Person',
        facilityScopeKind: 'district',
        // `users_disabled_after_creation` refuses a row disabled before it was
        // created, so the fixture has to say when the account existed.
        createdAt: new Date('2026-08-20T00:00:00.000Z'),
        disabledAt: new Date('2026-08-21T00:00:00.000Z'),
      },
    ]);

    await opened.db.insert(deviceEnrollments).values([
      {
        id: LIVE_DEVICE,
        userId: ENROLLED_USER,
        platform: 'ios',
        unlockMethod: 'biometric',
        installationId: 'installation-live',
      },
      {
        id: REPLACED_DEVICE,
        userId: ENROLLED_USER,
        platform: 'android',
        unlockMethod: 'biometric',
        installationId: 'installation-replaced',
      },
      {
        id: REVOKED_DEVICE_ID,
        userId: REVOKED_USER,
        platform: 'ios',
        unlockMethod: 'biometric',
        installationId: 'installation-revoked',
        // `device_enrollments_times` requires revocation at or after
        // enrolment, so the fixture has to say when the device enrolled.
        enrolledAt: new Date('2026-08-20T00:00:00.000Z'),
        lastSeenAt: new Date('2026-08-20T12:00:00.000Z'),
        revokedAt: new Date('2026-08-21T00:00:00.000Z'),
      },
      {
        id: DISABLED_DEVICE,
        userId: DISABLED_USER,
        platform: 'ios',
        unlockMethod: 'biometric',
        installationId: 'installation-disabled',
      },
    ]);

    await opened.db.insert(devicePushTokenRegistrations).values([
      {
        id: LIVE_REGISTRATION,
        deviceEnrollmentId: LIVE_DEVICE,
        platform: 'ios',
        token: 'live-token-0000000000000000',
      },
      {
        id: RETIRED_REGISTRATION,
        deviceEnrollmentId: REPLACED_DEVICE,
        platform: 'android',
        token: 'retired-token-000000000000',
      },
      {
        id: randomUUID(),
        deviceEnrollmentId: REVOKED_DEVICE_ID,
        platform: 'ios',
        token: 'revoked-device-token-00000',
      },
      {
        id: randomUUID(),
        deviceEnrollmentId: DISABLED_DEVICE,
        platform: 'ios',
        token: 'disabled-account-token-000',
      },
    ]);
    await opened.db.insert(devicePushTokenUnregistrations).values({
      id: randomUUID(),
      registrationId: RETIRED_REGISTRATION,
      deviceEnrollmentId: REPLACED_DEVICE,
    });
  });

  afterAll(async () => {
    const opened = connection;
    const ownedDatabase = disposable;
    connection = undefined;
    disposable = undefined;
    await closeAndDropDisposableDatabase(
      opened === undefined ? undefined : () => opened.close(),
      ownedDatabase,
    );
  });

  test('addresses every member by email, including those who never signed in', async () => {
    const audience = await resolveEventAudience(database(), {
      facilityId: SCHOOL,
      reach: 'building',
      population: 'staff',
    });

    // The property that makes this read the group and not `users`: a member
    // with no account still gets an address.
    expect(audience.recipients.map(({ email }) => email)).toEqual([
      DISABLED_ACCOUNT,
      ENROLLED,
      NEVER_SIGNED_IN,
      REVOKED_DEVICE,
    ]);
    for (const recipient of audience.recipients) {
      expect(
        recipient.endpoints.filter(({ channel }) => channel === 'email'),
      ).toHaveLength(1);
    }
  });

  test('a member who never signed in has an address and no device', async () => {
    const audience = await resolveEventAudience(database(), {
      facilityId: SCHOOL,
      reach: 'building',
      population: 'staff',
    });
    const recipient = audience.recipients.find(
      ({ email }) => email === NEVER_SIGNED_IN,
    );

    expect(recipient?.displayName).toBeNull();
    expect(recipient?.endpoints.map(({ channel }) => channel)).toEqual([
      'email',
    ]);
  });

  test('adds a push endpoint only for a live registration on a live device', async () => {
    const audience = await resolveEventAudience(database(), {
      facilityId: SCHOOL,
      reach: 'building',
      population: 'staff',
    });
    const recipient = audience.recipients.find(
      ({ email }) => email === ENROLLED,
    );

    // Two devices, but the android one's registration was unregistered.
    const push = recipient?.endpoints.filter(
      ({ channel }) => channel === 'push',
    );
    expect(push).toHaveLength(1);
    expect(push?.[0]?.id).toBe(LIVE_REGISTRATION);
    expect(push?.[0]?.platform).toBe('ios');
    expect(recipient?.displayName).toBe('Enrolled Person');
  });

  test('a revoked device receives nothing', async () => {
    // Revocation is how a lost phone stops being a notification target.
    const audience = await resolveEventAudience(database(), {
      facilityId: SCHOOL,
      reach: 'building',
      population: 'staff',
    });
    const recipient = audience.recipients.find(
      ({ email }) => email === REVOKED_DEVICE,
    );

    expect(recipient?.endpoints.map(({ channel }) => channel)).toEqual([
      'email',
    ]);
  });

  test('a disabled account keeps its address but loses its devices', async () => {
    // Disabling somebody revokes their access to the system, not their
    // employment at the school an incident is happening in.
    const audience = await resolveEventAudience(database(), {
      facilityId: SCHOOL,
      reach: 'building',
      population: 'staff',
    });
    const recipient = audience.recipients.find(
      ({ email }) => email === DISABLED_ACCOUNT,
    );

    expect(recipient).toBeDefined();
    expect(recipient?.endpoints.map(({ channel }) => channel)).toEqual([
      'email',
    ]);
  });

  test('never emits a push token belonging to somebody else', async () => {
    const audience = await resolveEventAudience(database(), {
      facilityId: SCHOOL,
      reach: 'building',
      population: 'staff',
    });

    for (const recipient of audience.recipients) {
      for (const endpoint of recipient.endpoints) {
        if (endpoint.channel !== 'push') continue;
        // Only one live registration exists in this fixture, and it belongs to
        // exactly one person. A join fault would surface here.
        expect(recipient.email).toBe(ENROLLED);
        expect(endpoint.token).toBe('live-token-0000000000000000');
      }
    }
  });

  test('recipient identity is derived, stable, and case-insensitive', async () => {
    const audience = await resolveEventAudience(database(), {
      facilityId: SCHOOL,
      reach: 'building',
      population: 'staff',
    });
    const recipient = audience.recipients.find(
      ({ email }) => email === ENROLLED,
    );

    expect(recipient?.recipientId).toBe(recipientIdForEmail(ENROLLED));
    expect(recipientIdForEmail('Enrolled@Example.invalid')).toBe(
      recipientIdForEmail(ENROLLED),
    );
    // A v5-shaped UUID, because the contract requires a UUID and the value
    // should not merely look like one.
    expect(recipient?.recipientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(recipientIdForEmail(NEVER_SIGNED_IN)).not.toBe(
      recipientIdForEmail(ENROLLED),
    );
  });

  test('a school whose staff group has no members resolves to nobody', async () => {
    const audience = await resolveEventAudience(database(), {
      facilityId: EMPTY_SCHOOL,
      reach: 'building',
      population: 'staff',
    });

    expect(audience.recipients).toEqual([]);
    expect(audience.unconfiguredFacilityIds).toEqual([]);
    expect(audience.facilityIds).toEqual([EMPTY_SCHOOL]);
  });

  test('carries the staleness the preview has to show', async () => {
    const audience = await resolveEventAudience(database(), {
      facilityId: SCHOOL,
      reach: 'building',
      population: 'staff',
    });

    expect(audience.oldestCapturedAt?.toISOString()).toBe(
      '2026-08-22T12:00:00.000Z',
    );
    expect(audience.unreadFacilityIds).toEqual([]);
  });
});
