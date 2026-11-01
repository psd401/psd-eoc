import { createHash, randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import { MOBILE_PARTNER_PASSKEY_ENROLLMENT_HEADER } from '@psd-eoc/contracts';
import { NextRequest } from 'next/server';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../../../../db/client';
import {
  facilities,
  partnerAdmissions,
  users,
} from '../../../../../../db/schema';
import { migrateDatabase } from '../../../../../../drizzle/migrate';
import { sealPartnerSignInFlow } from '../../../../../../lib/auth/partner-flow-cookie';
import { syntheticPartnerOtpCode } from '../../../../../../lib/auth/partner-otp';
import { openPartnerPasskeyEnrollment } from '../../../../../../lib/auth/partner-passkey-enrollment';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  type DisposableDatabase,
} from '../../../../../../lib/testing/database';
import { POST } from './route';

/**
 * Issue #647. The one thing about the native emailed-code sign-in that a
 * database-free test cannot show: a completed sign-in offers the passkey
 * enrollment hand-off, in a response header, without changing the session
 * envelope every installed build parses strictly.
 *
 * It takes a real database because the offer is made only after the admission
 * has let the partner in, which is the property worth binding it to: a
 * refused sign-in must offer nothing to enroll against.
 */

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(90_000);

const STAFF_DOMAIN = 'district.example.invalid';
const INSTALLATION_ID = 'native-partner-installation';
const SECRET = Buffer.alloc(32, 29).toString('base64url');

const names = [
  'PSD_EOC_PARTNER_USER_POOL_ID',
  'PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN',
  'GOOGLE_OIDC_COOKIE_SECRET',
  'GOOGLE_OIDC_HOSTED_DOMAIN',
  'DATABASE_DRIVER',
  'DATABASE_URL',
  'DATABASE_HOST',
  'DATABASE_SSL_ROOT_CERT',
] as const;
const original = new Map<string, string | undefined>();

let connection: PostgresDatabaseConnection | undefined;
let disposable: DisposableDatabase | undefined;
let adminId = '';

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('The database is not open.');
  return connection.db;
}

async function admit(email: string): Promise<void> {
  await database().insert(partnerAdmissions).values({
    email,
    displayName: 'Synthetic Responder',
    agency: 'Synthetic Fire District',
    invitedByUserId: adminId,
    admittedAt: new Date(),
  });
}

/**
 * The continuation the stand-in directory issues for one address. The real
 * pool's is opaque; the stand-in derives it, and refuses anything else.
 */
function syntheticFlowSession(email: string): string {
  return `synthetic-partner-otp:${createHash('sha256')
    .update(email, 'utf8')
    .digest('hex')}`;
}

function verifyRequest(
  email: string,
  platform: 'ios' | 'android',
  code: string,
): NextRequest {
  return new NextRequest(
    'http://localhost:3000/api/auth/mobile/partner/verify',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 254) + 1}`,
      },
      body: JSON.stringify({
        flowToken: sealPartnerSignInFlow(
          {
            email,
            flowSession: syntheticFlowSession(email),
            installationId: INSTALLATION_ID,
            platform,
            expiresAt: Date.now() + 5 * 60 * 1_000,
          },
          process.env,
          'native',
        ),
        code,
      }),
    },
  );
}

describeWithDatabase('the native partner emailed-code sign-in', () => {
  beforeAll(async () => {
    for (const name of names) original.set(name, process.env[name]);
    disposable = await createDisposableDatabase(
      'psd_eoc_native_partner_verify',
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
        googleSubject: 'google-native-partner-verify-admin',
        identityIssuer: 'https://accounts.google.com',
        identitySubject: 'google-native-partner-verify-admin',
        email: `native-verify-admin@${STAFF_DOMAIN}`,
        displayName: 'Synthetic Administrator',
        facilityScopeKind: 'district',
      })
      .returning({ id: users.id });
    adminId = admin?.id ?? '';
    await opened.db
      .insert(facilities)
      .values([{ code: 'SYN-NV', name: 'Synthetic Campus', isolated: false }]);
    Reflect.set(process.env, 'PSD_EOC_PARTNER_USER_POOL_ID', 'SYNTHETIC');
    Reflect.set(process.env, 'PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN', 'allowed');
    Reflect.set(process.env, 'GOOGLE_OIDC_COOKIE_SECRET', SECRET);
    Reflect.set(process.env, 'GOOGLE_OIDC_HOSTED_DOMAIN', STAFF_DOMAIN);
    Reflect.set(process.env, 'DATABASE_DRIVER', 'postgres');
    Reflect.set(process.env, 'DATABASE_URL', disposable.url);
    Reflect.deleteProperty(process.env, 'DATABASE_HOST');
    Reflect.deleteProperty(process.env, 'DATABASE_SSL_ROOT_CERT');
  });

  afterAll(async () => {
    await closeAndDropDisposableDatabase(connection?.close, disposable);
    for (const name of names) {
      const value = original.get(name);
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        Reflect.set(process.env, name, value);
      }
    }
  });

  test('offers a passkey hand-off for the device that just signed in', async () => {
    const email = `native-offer-${randomUUID()}@agency.example.invalid`;
    await admit(email);
    const response = await POST(
      verifyRequest(email, 'android', syntheticPartnerOtpCode(email)),
    );
    expect(response.status).toBe(200);
    // The session envelope is unchanged: an installed build with no passkey
    // code parses exactly what it always parsed (issue #470).
    const payload = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'refreshToken',
      'session',
      'tokenType',
    ]);
    const offered = response.headers.get(
      MOBILE_PARTNER_PASSKEY_ENROLLMENT_HEADER,
    );
    expect(offered).not.toBeNull();
    // It is the app's own hand-off: sealed for the native surface, naming the
    // address the pool proved and the platform the flow enrolled, and
    // unreadable as the browser's cookie.
    expect(
      openPartnerPasskeyEnrollment(offered, new Date(), process.env, 'native'),
    ).toMatchObject({ email, platform: 'android' });
    expect(
      openPartnerPasskeyEnrollment(offered, new Date(), process.env),
    ).toBeNull();
    // The hand-off carries the pool's token, so it must not be legible.
    expect(offered).not.toContain(email);
  });

  test('a refused sign-in offers nothing to enroll against', async () => {
    const email = `native-refused-${randomUUID()}@agency.example.invalid`;
    // No admission: the pool proves the address and the admission refuses it.
    const response = await POST(
      verifyRequest(email, 'ios', syntheticPartnerOtpCode(email)),
    );
    expect(response.status).toBe(401);
    expect(
      response.headers.get(MOBILE_PARTNER_PASSKEY_ENROLLMENT_HEADER),
    ).toBeNull();
  });

  test('a wrong code offers nothing either', async () => {
    const email = `native-wrong-${randomUUID()}@agency.example.invalid`;
    await admit(email);
    const response = await POST(verifyRequest(email, 'ios', '000000'));
    expect(response.status).toBe(401);
    expect(
      response.headers.get(MOBILE_PARTNER_PASSKEY_ENROLLMENT_HEADER),
    ).toBeNull();
  });
});
