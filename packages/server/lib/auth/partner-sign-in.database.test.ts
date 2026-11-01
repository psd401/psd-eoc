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
  facilities,
  partnerAdmissionEndings,
  partnerAdmissions,
  securityAuditEntries,
  userFacilityScopes,
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
import {
  completeNativePartnerSignIn,
  completePartnerSignIn,
  PartnerSignInError,
} from './partner-sign-in';
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
let openFacilityIds: readonly string[] = [];
let isolatedFacilityId = '';

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

/** The same sign-in, with a passkey as the first factor instead of a code. */
function signInWithPasskey(
  verified: PartnerVerifiedClaims,
  now = new Date(),
): ReturnType<typeof completePartnerSignIn> {
  return completePartnerSignIn(database(), {
    claims: verified,
    installationId: `web.${randomUUID()}`,
    factor: 'passkey',
    requestId: randomUUID(),
    now,
    staffDomain: STAFF_DOMAIN,
  });
}

function signInFromApp(
  verified: PartnerVerifiedClaims,
  platform: 'ios' | 'android',
  now = new Date(),
): ReturnType<typeof completeNativePartnerSignIn> {
  return completeNativePartnerSignIn(database(), {
    claims: verified,
    installationId: `native.${randomUUID()}`,
    platform,
    requestId: randomUUID(),
    now,
    staffDomain: STAFF_DOMAIN,
  });
}

/** The same native sign-in, with a passkey as the first factor. */
function signInFromAppWithPasskey(
  verified: PartnerVerifiedClaims,
  platform: 'ios' | 'android',
  now = new Date(),
): ReturnType<typeof completeNativePartnerSignIn> {
  return completeNativePartnerSignIn(database(), {
    claims: verified,
    installationId: `native.${randomUUID()}`,
    platform,
    factor: 'passkey',
    requestId: randomUUID(),
    now,
    staffDomain: STAFF_DOMAIN,
  });
}

/** The one success entry the access-gate ledger holds for one sign-in. */
async function successAudit(
  sessionId: string,
): Promise<Readonly<{ source: string; outcome: string }>> {
  const [row] = await database()
    .select({
      source: securityAuditEntries.source,
      outcome: securityAuditEntries.outcome,
    })
    .from(securityAuditEntries)
    // A successful sign-in targets the session it issued.
    .where(eq(securityAuditEntries.targetId, sessionId));
  if (row === undefined) {
    throw new Error('The sign-in wrote no access-gate audit entry.');
  }
  return row;
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
    // Two ordinary schools and one isolated facility (the store reviewer's
    // kind), which a partner must never be able to act at.
    const inserted = await opened.db
      .insert(facilities)
      .values([
        { code: 'SYN-NORTH', name: 'Synthetic North', isolated: false },
        { code: 'SYN-SOUTH', name: 'Synthetic South', isolated: false },
        { code: 'SYN-RVW', name: 'Synthetic Review', isolated: true },
      ])
      .returning({ id: facilities.id, isolated: facilities.isolated });
    openFacilityIds = inserted
      .filter((row) => !row.isolated)
      .map((row) => row.id)
      .sort();
    isolatedFacilityId = inserted.find((row) => row.isolated)?.id ?? '';
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
    // A partner acts at every ordinary facility and never an isolated one,
    // whatever district-wide limit the account row stores.
    expect(row?.facilityScopeKind).toBe('district');
    expect(authenticated.scope.facilityScope).toEqual({
      kind: 'facilities',
      facilityIds: openFacilityIds,
    });
    const scoped = authenticated.scope.facilityScope;
    expect(
      scoped.kind === 'facilities' &&
        scoped.facilityIds.includes(isolatedFacilityId),
    ).toBe(false);
    expect(authenticated.scope.campusFacilityIds).toBeUndefined();

    // An administrator's per-person limit still narrows a partner, and an
    // isolated facility in that limit is dropped rather than honored.
    const [north] = openFacilityIds;
    if (north === undefined) throw new Error('No open facility.');
    await database()
      .update(users)
      .set({ facilityScopeKind: 'facilities' })
      .where(eq(users.id, completed.session.user.id));
    await database()
      .insert(userFacilityScopes)
      .values([
        { userId: completed.session.user.id, facilityId: north },
        { userId: completed.session.user.id, facilityId: isolatedFacilityId },
      ]);
    const limited = await service.authenticate(completed.cookie.value, 'web');
    expect(limited.scope.facilityScope).toEqual({
      kind: 'facilities',
      facilityIds: [north],
    });
  });

  // Issue #598. A partner was a browser-only principal until the native app
  // could sign one in. The ledger is append-only, so a sign-in recorded
  // against the wrong surface can only be corrected forward: an investigator
  // reconstructing how an account authenticated would be sent to the browser
  // when the real surface was a phone.
  test('the ledger records the surface a partner actually signed in from', async () => {
    const email = `surface-${randomUUID()}@agency.example.invalid`;
    await admit(email);
    const browser = await signIn(claims(email));
    expect(await successAudit(browser.session.session.id)).toEqual({
      outcome: 'success',
      source: 'web',
    });

    for (const platform of ['ios', 'android'] as const) {
      const native = `native-${platform}-${randomUUID()}@agency.example.invalid`;
      await admit(native);
      const app = await signInFromApp(claims(native), platform);
      expect(await successAudit(app.session.session.id)).toEqual({
        outcome: 'success',
        source: 'mobile',
      });
      // The same session the app is handed, carried on a bearer rather than
      // a cookie.
      expect(app.bearer.length).toBeGreaterThan(0);
      expect(app.session.deviceEnrollment.platform).toBe(platform);
    }
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

  /**
   * Issue #599. A passkey is a second first factor, never a second set of
   * rules. Every refusal the emailed code gets, the passkey gets, because the
   * admission is checked after the pool has proven the factor and knows
   * nothing about which factor it was.
   */
  describe('a passkey is a faster way in, never a wider one', () => {
    test('an admitted partner signs in with a passkey, one-day session', async () => {
      const email = `passkey-${randomUUID()}@agency.example.invalid`;
      await admit(email);
      const now = new Date();
      const completed = await signInWithPasskey(claims(email), now);
      expect(completed.session.user.roles).toEqual(['partner']);
      expect(completed.cookie.maxAge).toBeLessThanOrEqual(DAY_MS / 1_000);
      // A passkey sign-in is recorded in the access-gate ledger exactly as a
      // code sign-in is.
      expect(await successAudit(completed.session.session.id)).toEqual({
        outcome: 'success',
        source: 'web',
      });
    });

    test('a disabled account’s passkey is refused', async () => {
      // Two layers stop a disabled partner: the pool refuses the assertion
      // because AdminDisableUser killed the credential, and this check
      // refuses the sign-in even if a pool somehow proved one.
      const email = `passkey-disabled-${randomUUID()}@agency.example.invalid`;
      await admit(email);
      const subject = `cognito-${randomUUID()}`;
      const completed = await signInWithPasskey(claims(email, subject));
      await database()
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, completed.session.user.id));
      expect(
        await expectRefusal(signInWithPasskey(claims(email, subject))),
      ).toBe('ACCOUNT_DISABLED');
    });

    test('an ended admission’s passkey is refused', async () => {
      const email = `passkey-ended-${randomUUID()}@agency.example.invalid`;
      const admissionId = await admit(email);
      await database().insert(partnerAdmissionEndings).values({
        partnerAdmissionId: admissionId,
        reason: 'disabled',
        endedByUserId: adminId,
        endedAt: new Date(),
      });
      expect(await expectRefusal(signInWithPasskey(claims(email)))).toBe(
        'PARTNER_ADMISSION_ENDED',
      );
    });

    test('an expired admission’s passkey is refused', async () => {
      // Yearly expiry is what makes a passkey stop working without anyone
      // having to go and delete it from the pool.
      const email = `passkey-expired-${randomUUID()}@agency.example.invalid`;
      await admit(email, {
        admittedAt: new Date(Date.now() - YEAR_AND_A_DAY_MS),
      });
      expect(await expectRefusal(signInWithPasskey(claims(email)))).toBe(
        'PARTNER_ADMISSION_EXPIRED',
      );
    });

    test('an address with no admission gets no session from a passkey', async () => {
      const email = `passkey-unknown-${randomUUID()}@agency.example.invalid`;
      expect(await expectRefusal(signInWithPasskey(claims(email)))).toBe(
        'NO_PARTNER_ADMISSION',
      );
    });

    test('a district address never signs in as a partner with a passkey', async () => {
      const email = `staff-${randomUUID()}@${STAFF_DOMAIN}`;
      await admit(email);
      expect(await expectRefusal(signInWithPasskey(claims(email)))).toBe(
        'STAFF_ADDRESS',
      );
    });

    test('one completed passkey sign-in cannot be replayed', async () => {
      const email = `passkey-replay-${randomUUID()}@agency.example.invalid`;
      await admit(email);
      const verified = claims(email);
      await signInWithPasskey(verified);
      // The same proven exchange a second time is the same digest, so the
      // idempotency reservation refuses it rather than issuing a second
      // session.
      await expect(signInWithPasskey(verified)).rejects.toThrow();
    });

    test('a code and a passkey for one identity are two exchanges', async () => {
      // The factor is part of the response digest, so the same proven
      // identity arriving by each factor is not read as a replay of the
      // other — a partner may hold both.
      const email = `passkey-both-${randomUUID()}@agency.example.invalid`;
      await admit(email);
      const verified = claims(email);
      const byCode = await signIn(verified);
      const byPasskey = await signInWithPasskey(verified);
      expect(byPasskey.session.user.id).toBe(byCode.session.user.id);
      expect(byPasskey.cookie.value).not.toBe(byCode.cookie.value);
    });
  });

  /**
   * Issue #647. The app's passkey path is the same path: the pool proves the
   * factor, the admission decides, and the ledger records the phone it came
   * from. What is worth proving against a real database is that none of the
   * refusals the emailed code gets are missing here, because a passkey that
   * outlived an admission would be a credential nobody can see to revoke.
   */
  describe('a partner signs in from the app with a passkey', () => {
    test('an admitted partner is let in, on a one-day mobile session', async () => {
      for (const platform of ['ios', 'android'] as const) {
        const email = `app-passkey-${platform}-${randomUUID()}@agency.example.invalid`;
        await admit(email);
        const now = new Date();
        const completed = await signInFromAppWithPasskey(
          claims(email),
          platform,
          now,
        );
        expect(completed.session.user.roles).toEqual(['partner']);
        expect(completed.session.deviceEnrollment.platform).toBe(platform);
        expect(
          Date.parse(completed.session.session.expiresAt) - now.getTime(),
        ).toBeLessThanOrEqual(DAY_MS);
        expect(await successAudit(completed.session.session.id)).toEqual({
          outcome: 'success',
          source: 'mobile',
        });
      }
    });

    test('an ended, expired, or disabled account is refused', async () => {
      const ended = `app-passkey-ended-${randomUUID()}@agency.example.invalid`;
      const admissionId = await admit(ended);
      await database().insert(partnerAdmissionEndings).values({
        partnerAdmissionId: admissionId,
        reason: 'disabled',
        endedByUserId: adminId,
        endedAt: new Date(),
      });
      expect(
        await expectRefusal(signInFromAppWithPasskey(claims(ended), 'ios')),
      ).toBe('PARTNER_ADMISSION_ENDED');

      const expired = `app-passkey-expired-${randomUUID()}@agency.example.invalid`;
      await admit(expired, {
        admittedAt: new Date(Date.now() - YEAR_AND_A_DAY_MS),
      });
      expect(
        await expectRefusal(
          signInFromAppWithPasskey(claims(expired), 'android'),
        ),
      ).toBe('PARTNER_ADMISSION_EXPIRED');

      const disabled = `app-passkey-disabled-${randomUUID()}@agency.example.invalid`;
      await admit(disabled);
      const subject = `cognito-${randomUUID()}`;
      const completed = await signInFromAppWithPasskey(
        claims(disabled, subject),
        'ios',
      );
      await database()
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, completed.session.user.id));
      expect(
        await expectRefusal(
          signInFromAppWithPasskey(claims(disabled, subject), 'ios'),
        ),
      ).toBe('ACCOUNT_DISABLED');

      const unknown = `app-passkey-unknown-${randomUUID()}@agency.example.invalid`;
      expect(
        await expectRefusal(signInFromAppWithPasskey(claims(unknown), 'ios')),
      ).toBe('NO_PARTNER_ADMISSION');

      const staff = `app-passkey-staff-${randomUUID()}@${STAFF_DOMAIN}`;
      await admit(staff);
      expect(
        await expectRefusal(signInFromAppWithPasskey(claims(staff), 'android')),
      ).toBe('STAFF_ADDRESS');
    });
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
