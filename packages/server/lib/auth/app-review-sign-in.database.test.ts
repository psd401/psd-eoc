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
import { admittedAccounts, users } from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  type DisposableDatabase,
} from '../testing/database';
import {
  AppReviewSignInError,
  appReviewSignInDigest,
  completeAppReviewSignIn,
} from './app-review-sign-in';
import {
  DrizzleSessionStore,
  SessionService,
  readSessionPolicy,
} from './sessions';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(30_000);

const REVIEW_EMAIL = 'app-review@example.invalid';
const REVIEW_SUBJECT = 'app-review-google-subject';
const CODE = 'synthetic-review-code-0123456789abcdef';
const DIGEST = appReviewSignInDigest(REVIEW_EMAIL, CODE);

let connection: PostgresDatabaseConnection | undefined;
let disposable: DisposableDatabase | undefined;

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) {
    throw new Error('The review sign-in integration database is not open.');
  }
  return connection.db;
}

function signIn(
  overrides: Partial<{
    email: string;
    code: string;
    expectedDigest: string | null;
    installationId: string;
  }> = {},
) {
  return completeAppReviewSignIn(database(), {
    request: {
      email: overrides.email ?? REVIEW_EMAIL,
      code: overrides.code ?? CODE,
      platform: 'android',
      installationId:
        overrides.installationId ?? `review-installation-${randomUUID()}`,
    },
    expectedDigest:
      overrides.expectedDigest === undefined
        ? DIGEST
        : overrides.expectedDigest,
    clientId: 'synthetic-client-id',
    requestId: randomUUID(),
    now: new Date(),
    policy: readSessionPolicy({}),
    initialMobileTransitionEmailDigest: null,
  });
}

async function expectRefusal(
  attempt: Promise<unknown>,
  code: AppReviewSignInError['code'],
): Promise<void> {
  try {
    await attempt;
  } catch (error) {
    expect(error).toBeInstanceOf(AppReviewSignInError);
    expect((error as AppReviewSignInError).code).toBe(code);
    return;
  }
  throw new Error(`Expected the review sign-in to be refused with ${code}.`);
}

describeWithDatabase('app review sign-in against the database', () => {
  beforeAll(async () => {
    if (baseUrl === undefined) {
      throw new Error('TEST_DATABASE_URL is required.');
    }
    disposable = await createDisposableDatabase('psd_eoc_app_review', baseUrl);
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: disposable.url,
      maxConnections: 4,
    });
    if (opened.driver !== 'postgres') {
      throw new Error('The direct PostgreSQL driver is required.');
    }
    connection = opened;
    await migrateDatabase(opened);
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

  test('refuses before the account exists, and while it is not admitted', async () => {
    await expectRefusal(signIn(), 'ACCOUNT_NOT_READY');

    const now = new Date();
    await database().insert(users).values({
      id: randomUUID(),
      googleSubject: REVIEW_SUBJECT,
      email: REVIEW_EMAIL,
      displayName: 'App review account',
      facilityScopeKind: 'district',
      createdAt: now,
      disabledAt: null,
    });
    await expectRefusal(signIn(), 'ACCESS_DENIED');
  });

  test('signs the admitted review account in and issues a working mobile session', async () => {
    const adminId = randomUUID();
    await database().insert(users).values({
      id: adminId,
      googleSubject: 'app-review-admitting-admin',
      email: 'admitting-admin@example.invalid',
      displayName: 'Admitting administrator',
      facilityScopeKind: 'district',
      createdAt: new Date(),
      disabledAt: null,
    });
    await database().insert(admittedAccounts).values({
      email: REVIEW_EMAIL,
      note: 'App store review',
      admittedByUserId: adminId,
    });

    const result = await signIn();
    expect(result.session.user.email).toBe(REVIEW_EMAIL);
    expect([...result.session.user.roles]).toEqual(['staff']);

    const service = new SessionService(new DrizzleSessionStore(database()));
    const authenticated = await service.authenticate(result.bearer, 'mobile');
    expect([...authenticated.roles]).toEqual(['staff']);
  });

  test('a second device signs in independently of the first', async () => {
    const first = await signIn();
    const second = await signIn();
    expect(first.bearer).not.toBe(second.bearer);
  });

  test('refuses a wrong code and a switched-off deployment without issuing anything', async () => {
    await expectRefusal(signIn({ code: `${CODE}x` }), 'REJECTED');
    await expectRefusal(
      signIn({ email: 'someone-else@example.invalid' }),
      'REJECTED',
    );
    await expectRefusal(signIn({ expectedDigest: null }), 'DISABLED');
  });
});
