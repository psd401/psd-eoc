import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import { partnerAdmissionExpiresAt } from '@psd-eoc/contracts';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
  facilities,
  groupMembers,
  groupSources,
  partnerAdmissionEndings,
  partnerAdmissions,
  users,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  type DisposableDatabase,
} from '../testing/database';
import { issueSyntheticPartnerSession } from '../testing/partner-session';
import { decidePartnerAccess } from './partner-admission';
import {
  DrizzleSessionStore,
  SessionAccessError,
  SessionService,
} from './sessions';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

const YEAR_AND_A_DAY_MS = 366 * 24 * 60 * 60 * 1_000;

let connection: PostgresDatabaseConnection | undefined;
let disposable: DisposableDatabase | undefined;
let adminId = '';

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('The database is not open.');
  return connection.db;
}

async function admit(
  email: string,
  admittedAt: Date = new Date(),
): Promise<string> {
  const [row] = await database()
    .insert(partnerAdmissions)
    .values({
      email,
      displayName: 'Synthetic Responder',
      agency: 'Synthetic Fire District',
      invitedByUserId: adminId,
      admittedAt,
    })
    .returning({ id: partnerAdmissions.id });
  if (row === undefined) throw new Error('No admission.');
  return row.id;
}

async function expectRefused(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(SessionAccessError);
    return (error as SessionAccessError).code;
  }
  throw new Error('Expected the session to be refused.');
}

describeWithDatabase('partner admission access', () => {
  beforeAll(async () => {
    disposable = await createDisposableDatabase(
      'psd_eoc_partner_access',
      baseUrl,
    );
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: disposable.url,
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') throw new Error('PostgreSQL only.');
    connection = opened;
    await migrateDatabase(opened);
    // A partner acts only at non-isolated facilities, so the district needs
    // at least one for any partner session to be admitted.
    await opened.db
      .insert(facilities)
      .values({ code: 'SYN-OPEN', name: 'Synthetic Open', isolated: false });
    const [admin] = await opened.db
      .insert(users)
      .values({
        googleSubject: 'google-partner-access-admin',
        identityIssuer: 'https://accounts.google.com',
        identitySubject: 'google-partner-access-admin',
        email: 'partner-access-admin@district.example.invalid',
        displayName: 'Synthetic Administrator',
        facilityScopeKind: 'district',
      })
      .returning({ id: users.id });
    adminId = admin?.id ?? '';
  });

  afterAll(async () => {
    await closeAndDropDisposableDatabase(connection?.close, disposable);
  });

  test('decides from the current admission alone', async () => {
    const email = `decide-${randomUUID()}@agency.example.invalid`;
    expect(
      await decidePartnerAccess(database(), { email, checkedAt: new Date() }),
    ).toMatchObject({ granted: false, refusal: 'NO_PARTNER_ADMISSION' });

    const admittedAt = new Date();
    const admissionId = await admit(email, admittedAt);
    expect(
      await decidePartnerAccess(database(), { email, checkedAt: new Date() }),
    ).toMatchObject({ granted: true, admission: { id: admissionId } });

    // Past the expiry the admission is refused at once; no sweep has run.
    expect(
      await decidePartnerAccess(database(), {
        email,
        checkedAt: new Date(admittedAt.getTime() + YEAR_AND_A_DAY_MS),
      }),
    ).toMatchObject({
      granted: false,
      refusal: 'PARTNER_ADMISSION_EXPIRED',
      admission: { id: admissionId },
    });

    await database().insert(partnerAdmissionEndings).values({
      partnerAdmissionId: admissionId,
      reason: 'disabled',
      endedByUserId: adminId,
    });
    expect(
      await decidePartnerAccess(database(), { email, checkedAt: new Date() }),
    ).toMatchObject({ granted: false, refusal: 'PARTNER_ADMISSION_ENDED' });
  });

  test('a group can never admit a partner, even one whose address it lists', async () => {
    const email = `grouped-${randomUUID()}@agency.example.invalid`;
    const groupId = randomUUID();
    await database()
      .insert(groupSources)
      .values({
        id: groupId,
        kind: 'google-group',
        purpose: 'access',
        facilityId: null,
        displayName: 'Synthetic staff access group',
        active: true,
        grantedRole: 'staff',
        membersCapturedAt: new Date(),
        googleGroupId: `synthetic-${groupId}`,
        email: `group-${groupId}@example.invalid`,
        fixtureKey: null,
      });
    await database()
      .insert(groupMembers)
      .values({ groupSourceId: groupId, email, capturedAt: new Date() });
    const issued = await issueSyntheticPartnerSession(database(), {
      email,
      displayName: 'Synthetic Grouped Partner',
      now: new Date(),
    });
    const service = new SessionService(new DrizzleSessionStore(database()));
    // The staff group lists the address, but a partner identity is never
    // asked about groups; with no admission the session cannot be read at all.
    expect(
      await expectRefused(service.authenticate(issued.credential, 'web')),
    ).toBe('INVALID_CREDENTIAL');
  });

  test('a partner session is authorized by its admission and re-checked on every read', async () => {
    const email = `session-${randomUUID()}@agency.example.invalid`;
    const now = new Date();
    const admissionId = await admit(email, now);
    const issued = await issueSyntheticPartnerSession(database(), {
      email,
      displayName: 'Synthetic Session Partner',
      now,
    });
    const service = new SessionService(new DrizzleSessionStore(database()));

    const authenticated = await service.authenticate(issued.credential, 'web');
    expect(authenticated.roles).toEqual(['partner']);
    expect(authenticated.membershipState).toBe('fresh');
    expect(authenticated.result.user.googleSubject).toBeNull();
    expect(authenticated.result.session.authorization).toEqual({
      kind: 'partner-admission',
      partnerAdmissionId: admissionId,
      admissionExpiresAt: partnerAdmissionExpiresAt(now.toISOString()),
    });

    // Ending the admission refuses the very next request.
    await database().insert(partnerAdmissionEndings).values({
      partnerAdmissionId: admissionId,
      reason: 'disabled',
      endedByUserId: adminId,
    });
    expect(
      await expectRefused(service.authenticate(issued.credential, 'web')),
    ).toBe('INVALID_MEMBERSHIP_EVIDENCE');
  });

  test('an expired admission refuses a session before any sweep ends it', async () => {
    const email = `expired-${randomUUID()}@agency.example.invalid`;
    // Admitted a year and a day ago; the session itself is still current.
    const now = new Date();
    await admit(email, new Date(now.getTime() - YEAR_AND_A_DAY_MS));
    const issued = await issueSyntheticPartnerSession(database(), {
      email,
      displayName: 'Synthetic Expired Partner',
      now,
    });
    const service = new SessionService(new DrizzleSessionStore(database()));
    expect(
      await expectRefused(service.authenticate(issued.credential, 'web', now)),
    ).toBe('INVALID_MEMBERSHIP_EVIDENCE');
  });

  test('a renewal keeps an open partner session working', async () => {
    const email = `renewed-${randomUUID()}@agency.example.invalid`;
    const now = new Date();
    const firstId = await admit(email, now);
    const issued = await issueSyntheticPartnerSession(database(), {
      email,
      displayName: 'Synthetic Renewed Partner',
      now,
    });
    let renewedId = '';
    await database().transaction(async (transaction) => {
      const [renewed] = await transaction
        .insert(partnerAdmissions)
        .values({
          email,
          displayName: 'Synthetic Renewed Partner',
          agency: 'Synthetic Fire District',
          invitedByUserId: adminId,
          supersedesAdmissionId: firstId,
        })
        .returning({ id: partnerAdmissions.id });
      renewedId = renewed?.id ?? '';
      await transaction.insert(partnerAdmissionEndings).values({
        partnerAdmissionId: firstId,
        reason: 'superseded',
        endedByUserId: adminId,
      });
    });
    const service = new SessionService(new DrizzleSessionStore(database()));
    const authenticated = await service.authenticate(issued.credential, 'web');
    expect(authenticated.result.session.authorization).toMatchObject({
      kind: 'partner-admission',
      partnerAdmissionId: renewedId,
    });
  });
});
