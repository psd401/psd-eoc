import { randomUUID } from 'node:crypto';

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
  groupSources,
  partnerAccessReviews,
  partnerAdmissionEndings,
  partnerAdmissions,
  partnerNotices,
  sessionRevocations,
  users,
} from '../../db/schema';
import { migrateDatabase } from '../../drizzle/migrate';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  type DisposableDatabase,
} from '../testing/database';
import { issueSyntheticPartnerSession } from '../testing/partner-session';
import { invitePartner, listPartnerAccess } from './access';
import {
  PartnerProviderError,
  type PartnerMailMessage,
  type PartnerProviders,
} from './providers';
import {
  partnerInactivityReview,
  reviewQuarter,
  runPartnerAccessSweep,
} from './sweep';

const baseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = baseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

const DAY = 24 * 60 * 60 * 1_000;
const ADMIN_GROUP_EMAIL = 'eoc-admins@district.example.invalid';
const MESSAGE_CONTEXT = Object.freeze({
  organizationName: 'Synthetic Example School District',
  applicationOrigin: 'https://eoc.example.invalid',
  displayTimeZone: 'America/Los_Angeles',
});

let connection: PostgresDatabaseConnection | undefined;
let disposable: DisposableDatabase | undefined;
let adminId = '';

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('The database is not open.');
  return connection.db;
}

function providers() {
  const calls: string[] = [];
  const mail: PartnerMailMessage[] = [];
  const state = { mailFails: false };
  const value: PartnerProviders = {
    mode: 'synthetic',
    directory: {
      ensureEnabled: (email) => {
        calls.push(`enable:${email}`);
        return Promise.resolve({ subject: `subject-${email}` });
      },
      ensureDisabled: (email) => {
        calls.push(`disable:${email}`);
        return Promise.resolve();
      },
    },
    mailer: {
      send: (message) => {
        if (state.mailFails) {
          return Promise.reject(
            new PartnerProviderError('PARTNER_MAIL_FAILED', 'Synthetic.'),
          );
        }
        mail.push(message);
        return Promise.resolve();
      },
    },
  };
  return { value, calls, mail, state };
}

function sweep(now: Date, fake: ReturnType<typeof providers>) {
  return runPartnerAccessSweep({
    database: database(),
    providers: fake.value,
    messageContext: MESSAGE_CONTEXT,
    now,
  });
}

async function admit(email: string, admittedAt: Date): Promise<string> {
  const admission = await database().transaction((transaction) =>
    invitePartner(
      transaction,
      {
        email,
        displayName: 'Synthetic Responder',
        agency: 'Synthetic Fire District',
        replacesAdmissionId: null,
      },
      adminId,
      admittedAt,
      null,
    ),
  );
  return admission.id;
}

function address(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@agency.example.invalid`;
}

async function noticesFor(admissionId: string) {
  return database()
    .select({ kind: partnerNotices.kind })
    .from(partnerNotices)
    .where(eq(partnerNotices.partnerAdmissionId, admissionId));
}

async function endingFor(admissionId: string) {
  const [ending] = await database()
    .select()
    .from(partnerAdmissionEndings)
    .where(eq(partnerAdmissionEndings.partnerAdmissionId, admissionId));
  return ending;
}

describeWithDatabase('the partner access sweep', () => {
  beforeAll(async () => {
    disposable = await createDisposableDatabase(
      'psd_eoc_partner_sweep',
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
    const [admin] = await opened.db
      .insert(users)
      .values({
        googleSubject: 'google-sweep-admin',
        identityIssuer: 'https://accounts.google.com',
        identitySubject: 'google-sweep-admin',
        email: 'sweep-admin@district.example.invalid',
        displayName: 'Synthetic Administrator',
        facilityScopeKind: 'district',
      })
      .returning();
    adminId = admin?.id ?? '';
    await opened.db.insert(groupSources).values({
      kind: 'google-group',
      purpose: 'access',
      facilityId: null,
      displayName: 'Synthetic administrators',
      active: true,
      grantedRole: 'admin',
      membersCapturedAt: new Date(),
      googleGroupId: 'synthetic-sweep-admins',
      email: ADMIN_GROUP_EMAIL,
      fixtureKey: null,
    });
  });

  afterAll(async () => {
    await closeAndDropDisposableDatabase(connection?.close, disposable);
  });

  test('sends exactly one notice 14 days before expiry, with replies going to administrators', async () => {
    const admittedAt = new Date('2025-01-10T16:00:00.000Z');
    const email = address('notice');
    const admissionId = await admit(email, admittedAt);
    const expiresAt = new Date('2026-01-10T16:00:00.000Z');
    const fake = providers();

    // 15 days out: nothing yet.
    await sweep(new Date(expiresAt.getTime() - 15 * DAY), fake);
    expect(await noticesFor(admissionId)).toEqual([]);

    // 14 days out: one notice, and a retried run sends nothing more.
    const first = await sweep(new Date(expiresAt.getTime() - 14 * DAY), fake);
    expect(first.noticesSent).toBe(1);
    await sweep(new Date(expiresAt.getTime() - 13 * DAY), fake);
    const sent = fake.mail.filter((message) => message.to === email);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.replyTo).toEqual([ADMIN_GROUP_EMAIL]);
    expect(sent[0]?.subject).toContain('ends on');
    expect(sent[0]?.textBody).toContain('reply to this email');
    expect(await noticesFor(admissionId)).toEqual([{ kind: 'expiry-notice' }]);
  });

  test('a failed notice is retried by the next run instead of being skipped', async () => {
    const email = address('retry');
    const admissionId = await admit(
      email,
      new Date('2025-02-01T16:00:00.000Z'),
    );
    const fake = providers();
    fake.state.mailFails = true;
    const failed = await sweep(new Date('2026-01-25T16:00:00.000Z'), fake);
    expect(failed.noticesFailed).toBeGreaterThanOrEqual(1);
    expect(await noticesFor(admissionId)).toEqual([]);
    fake.state.mailFails = false;
    await sweep(new Date('2026-01-26T16:00:00.000Z'), fake);
    expect(await noticesFor(admissionId)).toEqual([{ kind: 'expiry-notice' }]);
    expect(fake.mail.filter((message) => message.to === email)).toHaveLength(1);
  });

  test('ends the admission on its date as the system, cuts the partner out, and disables the account; idempotent', async () => {
    const admittedAt = new Date('2025-03-01T16:00:00.000Z');
    const email = address('expire');
    const admissionId = await admit(email, admittedAt);
    const partner = await issueSyntheticPartnerSession(database(), {
      email,
      displayName: 'Synthetic Responder',
      now: new Date('2026-02-28T16:00:00.000Z'),
    });
    const fake = providers();
    const afterExpiry = new Date('2026-03-01T17:00:00.000Z');

    const result = await sweep(afterExpiry, fake);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const ending = await endingFor(admissionId);
    expect(ending?.reason).toBe('expired');
    expect(ending?.endedByUserId).toBeNull();
    const revocations = await database()
      .select()
      .from(sessionRevocations)
      .where(eq(sessionRevocations.sessionId, partner.sessionId));
    expect(revocations).toHaveLength(1);
    expect(revocations[0]?.reasonCode).toBe('PARTNER_ADMISSION_EXPIRED');
    expect(revocations[0]?.revokedBy).toEqual({
      kind: 'system',
      serviceId: 'partner-access-sweep',
    });
    expect(fake.calls).toContain(`disable:${email}`);

    const again = providers();
    await sweep(new Date(afterExpiry.getTime() + DAY), again);
    expect(again.calls).not.toContain(`disable:${email}`);
    expect(
      await database()
        .select()
        .from(partnerAdmissionEndings)
        .where(eq(partnerAdmissionEndings.partnerAdmissionId, admissionId)),
    ).toHaveLength(1);
  });

  test('a renewal resets expiry to a year from renewal and the old date ends nothing', async () => {
    const email = address('renew');
    const firstId = await admit(email, new Date('2025-04-01T16:00:00.000Z'));
    const renewedAt = new Date('2026-03-20T16:00:00.000Z');
    const renewed = await database().transaction((transaction) =>
      invitePartner(
        transaction,
        {
          email,
          displayName: 'Synthetic Responder',
          agency: 'Synthetic Fire District',
          replacesAdmissionId: firstId,
        },
        adminId,
        renewedAt,
        null,
      ),
    );
    expect(renewed.supersedesAdmissionId).toBe(firstId);
    expect(renewed.expiresAt).toBe('2027-03-20T16:00:00.000Z');
    expect((await endingFor(firstId))?.reason).toBe('superseded');

    const fake = providers();
    await sweep(new Date('2026-04-02T16:00:00.000Z'), fake);
    expect(await endingFor(renewed.id)).toBeUndefined();
    // The superseded admission shares the address with a current one, so the
    // account stays enabled.
    expect(fake.calls).not.toContain(`disable:${email}`);
  });

  test('lists never-signed-in and 90-day-inactive partners for review, never disabling them', async () => {
    const now = new Date('2026-05-01T16:00:00.000Z');
    const neverEmail = address('never');
    const staleEmail = address('stale');
    const freshEmail = address('fresh');
    await admit(neverEmail, new Date('2026-02-01T16:00:00.000Z'));
    const staleId = await admit(
      staleEmail,
      new Date('2026-01-01T16:00:00.000Z'),
    );
    await admit(freshEmail, new Date('2026-01-01T16:00:00.000Z'));
    await issueSyntheticPartnerSession(database(), {
      email: staleEmail,
      displayName: 'Synthetic Stale',
      now: new Date(now.getTime() - 120 * DAY),
    });
    await issueSyntheticPartnerSession(database(), {
      email: freshEmail,
      displayName: 'Synthetic Fresh',
      now: new Date(now.getTime() - 10 * DAY),
    });
    const review = partnerInactivityReview(
      await listPartnerAccess(database(), { includeEnded: false }, now),
      now,
    );
    const emails = (records: typeof review.inactive) =>
      records.map((record) => record.admission.email);
    expect(emails(review.neverSignedIn)).toContain(neverEmail);
    expect(emails(review.neverSignedIn)).not.toContain(staleEmail);
    expect(emails(review.inactive)).toContain(staleEmail);
    expect(emails(review.inactive)).not.toContain(freshEmail);

    const fake = providers();
    await sweep(now, fake);
    expect(await endingFor(staleId)).toBeUndefined();
    expect(fake.calls).not.toContain(`disable:${staleEmail}`);
  });

  test('sends the review to administrators once per quarter', async () => {
    const now = new Date('2026-07-02T16:00:00.000Z');
    const fake = providers();
    const first = await sweep(now, fake);
    expect(first.reviewSent).toBe(true);
    const second = await sweep(new Date(now.getTime() + DAY), fake);
    expect(second.reviewSent).toBe(false);
    const reviews = fake.mail.filter(
      (message) =>
        Array.isArray(message.to) && message.to.includes(ADMIN_GROUP_EMAIL),
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.subject).toContain('Quarterly partner access review');
    expect(reviews[0]?.textBody).toContain('Nobody has been disabled');
    const rows = await database()
      .select({ quarter: partnerAccessReviews.quarter })
      .from(partnerAccessReviews)
      .where(eq(partnerAccessReviews.quarter, reviewQuarter(now)));
    expect(rows).toEqual([{ quarter: '2026-Q3' }]);
  });

  test('admission rows are only ever appended by the sweep', async () => {
    const before = await database().select().from(partnerAdmissions);
    await sweep(new Date('2026-08-01T16:00:00.000Z'), providers());
    const after = await database().select().from(partnerAdmissions);
    expect(after).toEqual(before);
  });
});
