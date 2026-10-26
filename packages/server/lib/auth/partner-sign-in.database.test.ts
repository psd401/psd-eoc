import { createHash, randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import { eq } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../db/client';
import {
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
import { DrizzleSessionStore, SessionService } from './sessions';
import { DEFAULT_SESSION_POLICY } from './sessions';
import { completePartnerSignIn, PartnerSignInError } from './partner-sign-in';
import type { PartnerVerifiedClaims } from './partner-otp';

/**
 * Issue #593. The whole partner web sign-in path against a real database:
 * the admission decides, the identity is keyed off the pool's subject, the
 * session lasts at most a day, and one completed sign-in cannot be replayed.
 */

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(90_000);

const POOL_ISSUER =
  'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_Example1';
const CLIENT_ID = 'partner-app-client';
const STAFF_DOMAIN = 'district.example.invalid';
const DAY_MS = 24 * 60 * 60 * 1_000;
const YEAR_AND_A_DAY_MS = 366 * DAY_MS;

let connection: PostgresDatabaseConnection | undefined;
let disposable: DisposableDatabase | undefined;
let adminId = '';

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('The database is not open.');
  return connection.db;
}

function claims(
  email: string,
  subject = `cognito-${randomUUID()}`,
): PartnerVerifiedClaims {
  return Object.freeze({
    issuer: POOL_ISSUER,
    audience: CLIENT_ID,
    subject,
    email,
    claimsDigest: createHash('sha256').update(randomUUID()).digest('hex'),
  });
}

async function admit(
  email: string,
  options: Readonly<{ admittedAt?: Date; displayName?: string }> = {},
): Promise<string> {
  const [row] = await database()
    .insert(partnerAdmissions)
    .values({
      email,
      displayName: options.displayName ?? 'Synthetic Responder',
      agency: 'Synthetic Fire District',
      invitedByUserId: adminId,
      admittedAt: options.admittedAt ?? new Date(),
    })
    .returning({ id: partnerAdmissions.id });
  if (row === undefined) throw new Error('No admission.');
  return row.id;
}

function signIn(
  verified: PartnerVerifiedClaims,
  now = new Date(),
): ReturnType<typeof completePartnerSignIn> {
  return completePartnerSignIn(database(), {
    claims: verified,
    installationId: `web.${randomUUID()}`,
    requestId: randomUUID(),
    now,
    staffDomain: STAFF_DOMAIN,
  });
}

async function expectRefusal(
  operation: Promise<unknown>,
): Promise<string | null> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(PartnerSignInError);
    return (error as PartnerSignInError).refusal;
  }
  throw new Error('Expected the partner sign-in to be refused.');
}

describeWithDatabase('partner web sign-in', () => {
  beforeAll(async () => {
    disposable = await createDisposableDatabase(
      'psd_eoc_partner_sign_in',
      baseUrl,
    );
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: disposable.url,
      maxConnections: 3,
    });
    if (opened.driver !== 'postgres') throw new Error('PostgreSQL only.');
    connection = opened;
    await migrateDatabase(opened);
    const [admin] = await opened.db
      .insert(users)
      .values({
        googleSubject: 'google-partner-sign-in-admin',
        identityIssuer: 'https://accounts.google.com',
        identitySubject: 'google-partner-sign-in-admin',
        email: `partner-sign-in-admin@${STAFF_DOMAIN}`,
        displayName: 'Synthetic Administrator',
        facilityScopeKind: 'district',
      })
      .returning({ id: users.id });
    adminId = admin?.id ?? '';
  });

  afterAll(async () => {
    await closeAndDropDisposableDatabase(connection?.close, disposable);
  });

  test('an admitted partner signs in and the session lasts one day', async () => {
    const email = `admitted-${randomUUID()}@agency.example.invalid`;
    const admissionId = await admit(email, { displayName: 'Chief Responder' });
    const now = new Date();
    const verified = claims(email);
    const completed = await signIn(verified, now);

    // Identity is the pool's issuer and subject; the address is metadata.
    const [row] = await database()
      .select()
      .from(users)
      .where(eq(users.id, completed.session.user.id));
    expect(row?.identityIssuer).toBe(POOL_ISSUER);
    expect(row?.identitySubject).toBe(verified.subject);
    expect(row?.googleSubject).toBeNull();
    expect(row?.email).toBe(email);
    expect(row?.displayName).toBe('Chief Responder');

    expect(completed.session.user.roles).toEqual(['partner']);
    expect(completed.session.session.authorization).toMatchObject({
      kind: 'partner-admission',
      partnerAdmissionId: admissionId,
    });
    const lifetimeMs =
      Date.parse(completed.session.session.expiresAt) - now.getTime();
    expect(lifetimeMs).toBeLessThanOrEqual(DAY_MS);
    expect(lifetimeMs).toBeGreaterThan(0);
    expect(completed.cookie.maxAge).toBeLessThanOrEqual(DAY_MS / 1_000);

    // Staff keep the long session this change deliberately did not touch.
    expect(DEFAULT_SESSION_POLICY.sessionLifetimeSeconds).toBe(
      90 * 24 * 60 * 60,
    );

    // The credential in the cookie authenticates the partner's session.
    const service = new SessionService(new DrizzleSessionStore(database()));
    const authenticated = await service.authenticate(
      completed.cookie.value,
      'web',
    );
    expect(authenticated.actor.userId).toBe(completed.session.user.id);
    expect(authenticated.roles).toEqual(['partner']);
    // Its scope carries the marker the engine reads for the partner allowlist.
    expect(authenticated.scope.partner).toBe(true);
  });

  test('the same partner signs in again as the same person', async () => {
    const email = `again-${randomUUID()}@agency.example.invalid`;
    await admit(email);
    const subject = `cognito-${randomUUID()}`;
    const first = await signIn(claims(email, subject));
    const second = await signIn(claims(email, subject));
    expect(second.session.user.id).toBe(first.session.user.id);
    expect(second.session.session.id).not.toBe(first.session.session.id);
  });

  test('one completed sign-in cannot be replayed', async () => {
    const email = `replay-${randomUUID()}@agency.example.invalid`;
    await admit(email);
    const verified = claims(email);
    const installationId = `web.${randomUUID()}`;
    const now = new Date();
    // The route mints a fresh request id for every POST, so a double-submitted
    // code arrives under two ids. The replay guard must not depend on it.
    const replay = () =>
      completePartnerSignIn(database(), {
        claims: verified,
        installationId,
        requestId: randomUUID(),
        now,
        staffDomain: STAFF_DOMAIN,
      });
    await replay();
    await expect(replay()).rejects.toMatchObject({
      code: 'SESSION_REPLAY_REJECTED',
    });
  });

  test('an address with no admission is refused', async () => {
    const email = `unknown-${randomUUID()}@agency.example.invalid`;
    expect(await expectRefusal(signIn(claims(email)))).toBe(
      'NO_PARTNER_ADMISSION',
    );
    expect(
      await database().select().from(users).where(eq(users.email, email)),
    ).toHaveLength(0);
  });

  test('an ended admission is refused', async () => {
    const email = `ended-${randomUUID()}@agency.example.invalid`;
    const admissionId = await admit(email);
    await database().insert(partnerAdmissionEndings).values({
      partnerAdmissionId: admissionId,
      reason: 'disabled',
      endedByUserId: adminId,
      endedAt: new Date(),
    });
    expect(await expectRefusal(signIn(claims(email)))).toBe(
      'PARTNER_ADMISSION_ENDED',
    );
  });

  test('an expired admission is refused', async () => {
    const email = `expired-${randomUUID()}@agency.example.invalid`;
    await admit(email, {
      admittedAt: new Date(Date.now() - YEAR_AND_A_DAY_MS),
    });
    expect(await expectRefusal(signIn(claims(email)))).toBe(
      'PARTNER_ADMISSION_EXPIRED',
    );
  });

  test('a district address signs in as staff, never as a partner', async () => {
    const email = `district-person-${randomUUID()}@${STAFF_DOMAIN}`;
    // Even with an admission on file, the address decides.
    await admit(email);
    expect(await expectRefusal(signIn(claims(email)))).toBe('STAFF_ADDRESS');
  });

  test('an address that already has a staff account is refused', async () => {
    const email = `existing-staff-${randomUUID()}@agency.example.invalid`;
    await admit(email);
    const staffSubject = `google-${randomUUID()}`;
    await database().insert(users).values({
      googleSubject: staffSubject,
      identityIssuer: 'https://accounts.google.com',
      identitySubject: staffSubject,
      email,
      displayName: 'Synthetic Staff Member',
      facilityScopeKind: 'district',
    });
    expect(await expectRefusal(signIn(claims(email)))).toBe('STAFF_ADDRESS');
  });

  test('another pool subject for the same address is refused', async () => {
    const email = `rebind-${randomUUID()}@agency.example.invalid`;
    await admit(email);
    await signIn(claims(email, `cognito-${randomUUID()}`));
    expect(
      await expectRefusal(signIn(claims(email, `cognito-${randomUUID()}`))),
    ).toBe('IDENTITY_MISMATCH');
  });

  test('a disabled partner account is refused', async () => {
    const email = `disabled-${randomUUID()}@agency.example.invalid`;
    await admit(email);
    const subject = `cognito-${randomUUID()}`;
    const completed = await signIn(claims(email, subject));
    await database()
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, completed.session.user.id));
    expect(await expectRefusal(signIn(claims(email, subject)))).toBe(
      'ACCOUNT_DISABLED',
    );
  });

  test('a corrected name on a re-invite reaches the account', async () => {
    const email = `renamed-${randomUUID()}@agency.example.invalid`;
    const admissionId = await admit(email, { displayName: 'Wrong Name' });
    const subject = `cognito-${randomUUID()}`;
    const first = await signIn(claims(email, subject));
    expect(first.session.user.displayName).toBe('Wrong Name');

    await database().insert(partnerAdmissionEndings).values({
      partnerAdmissionId: admissionId,
      reason: 'disabled',
      endedByUserId: adminId,
      endedAt: new Date(),
    });
    await admit(email, { displayName: 'Correct Name' });
    const second = await signIn(claims(email, subject));
    expect(second.session.user.id).toBe(first.session.user.id);
    expect(second.session.user.displayName).toBe('Correct Name');
  });
});
