import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { and, eq, isNull, sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  type PostgresDatabaseConnection,
} from '../../../db/client';
import {
  deviceEnrollments,
  devicePushTokenRegistrations,
  devicePushTokenUnregistrations,
  partnerNotices,
  partnerProviderSyncs,
  sessionRevocations,
  sessions,
  staffSmsConsents,
  users,
} from '../../../db/schema';
import { migrateDatabase } from '../../../drizzle/migrate';
import {
  DrizzleSessionStore,
  SessionAccessError,
  SessionService,
  type AuthenticatedSession,
} from '../../../lib/auth/sessions';
import {
  AdminCapabilityError,
  createDrizzleAdminCapabilityStore,
} from '../../../lib/capabilities/admin';
import {
  PartnerProviderError,
  type PartnerMailMessage,
  type PartnerProviders,
} from '../../../lib/partners/providers';
import {
  closeAndDropDisposableDatabase,
  createDisposableDatabase,
  requireSyntheticTestDatabaseUrl,
  type DisposableDatabase,
} from '../../../lib/testing/database';
import { issueSyntheticPartnerSession } from '../../../lib/testing/partner-session';
import {
  executeDisablePartnerCapability,
  executeInvitePartnerCapability,
  executeListPartnersCapability,
  executeReconcilePartnerAccessCapability,
} from './partner-capabilities';

const configuredTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseTestDatabaseUrl =
  configuredTestDatabaseUrl === undefined
    ? undefined
    : requireSyntheticTestDatabaseUrl(configuredTestDatabaseUrl);
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

setDefaultTimeout(60_000);

const MESSAGE_CONTEXT = Object.freeze({
  organizationName: 'Synthetic Example School District',
  applicationOrigin: 'https://eoc.example.invalid',
  displayTimeZone: 'America/Los_Angeles',
});

let connection: PostgresDatabaseConnection | undefined;
let ownedDatabase: DisposableDatabase | undefined;
let admin: AuthenticatedSession;

function database(): PostgresDatabaseConnection['db'] {
  if (connection === undefined) throw new Error('The database is not open.');
  return connection.db;
}

/** Records every provider call; `fail` makes the next calls throw. */
function recordingProviders() {
  const calls: string[] = [];
  const mail: PartnerMailMessage[] = [];
  const state = { fail: false };
  const down = () =>
    Promise.reject(
      new PartnerProviderError('PARTNER_DIRECTORY_FAILED', 'Synthetic outage.'),
    );
  const providers: PartnerProviders = {
    mode: 'synthetic',
    directory: {
      ensureEnabled(email) {
        calls.push(`enable:${email}`);
        if (state.fail) return down();
        return Promise.resolve({ subject: `subject-${email}` });
      },
      ensureDisabled(email) {
        calls.push(`disable:${email}`);
        if (state.fail) return down();
        return Promise.resolve();
      },
    },
    mailer: {
      send(message) {
        if (state.fail) return down();
        mail.push({ ...message });
        return Promise.resolve();
      },
    },
  };
  return { providers, calls, mail, state };
}

function adminSession(): AuthenticatedSession {
  return {
    actor: { kind: 'human', userId: randomUUID(), sessionId: randomUUID() },
    source: 'web',
    roles: ['admin', 'staff'],
    scope: { facilityScope: { kind: 'district' } },
    membershipState: 'fresh',
    result: { connectivityEpoch: { id: randomUUID() } },
  } as unknown as AuthenticatedSession;
}

async function persistActor(authenticated: AuthenticatedSession) {
  if (authenticated.actor.kind !== 'human') throw new Error('human only');
  const suffix = authenticated.actor.userId.slice(0, 8);
  const now = new Date();
  const deviceId = randomUUID();
  await database()
    .insert(users)
    .values({
      id: authenticated.actor.userId,
      googleSubject: `partner-admin-${suffix}`,
      identityIssuer: 'https://accounts.google.com',
      identitySubject: `partner-admin-${suffix}`,
      email: `partner-admin-${suffix}@district.example.invalid`,
      displayName: `Partner admin ${suffix}`,
      facilityScopeKind: 'district',
      createdAt: now,
    });
  await database()
    .insert(deviceEnrollments)
    .values({
      id: deviceId,
      userId: authenticated.actor.userId,
      platform: 'web',
      unlockMethod: 'secure-session-cookie',
      installationId: `partner-admin-device-${suffix}`,
      enrolledAt: now,
      lastSeenAt: now,
    });
  await database()
    .insert(sessions)
    .values({
      id: authenticated.actor.sessionId,
      userId: authenticated.actor.userId,
      deviceEnrollmentId: deviceId,
      membershipSnapshotId: null,
      membershipValidUntil: new Date(now.getTime() + 60 * 60 * 1_000),
      membershipGraceUntil: new Date(now.getTime() + 2 * 60 * 60 * 1_000),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3 * 60 * 60 * 1_000),
    });
}

function store() {
  return createDrizzleAdminCapabilityStore(database(), admin);
}

function metadata() {
  return {
    idempotencyKey: `partner-${randomUUID()}`,
    requestId: randomUUID(),
    now: new Date(),
  };
}

function invite(
  email: string,
  replacesAdmissionId: string | null = null,
  authenticated: AuthenticatedSession = admin,
) {
  return executeInvitePartnerCapability({
    authenticated,
    store: createDrizzleAdminCapabilityStore(database(), authenticated),
    command: {
      email,
      displayName: 'Synthetic Responder',
      agency: 'Synthetic Fire District',
      replacesAdmissionId,
    },
    metadata: metadata(),
  });
}

function reconcile(
  partnerAdmissionId: string,
  providers: PartnerProviders,
  resendInvitation = false,
) {
  return executeReconcilePartnerAccessCapability({
    authenticated: admin,
    store: store(),
    command: { partnerAdmissionId, resendInvitation },
    metadata: metadata(),
    providers,
    messageContext: MESSAGE_CONTEXT,
  });
}

async function record(admissionId: string) {
  const list = await executeListPartnersCapability({
    authenticated: admin,
    store: store(),
    query: { includeEnded: true },
  });
  const found = list.items.find((item) => item.admission.id === admissionId);
  if (found === undefined) throw new Error('The admission is not listed.');
  return found;
}

async function expectAdminRefusal(
  operation: Promise<unknown>,
  status: number,
): Promise<string> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(AdminCapabilityError);
    expect((error as AdminCapabilityError).status).toBe(status);
    return (error as AdminCapabilityError).message;
  }
  throw new Error(`Expected a ${status} refusal.`);
}

function address(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@agency.example.invalid`;
}

describeWithDatabase('partner administration', () => {
  beforeAll(async () => {
    if (baseTestDatabaseUrl === undefined) throw new Error('no database');
    ownedDatabase = await createDisposableDatabase(
      'psd_eoc_partner_admin',
      baseTestDatabaseUrl,
    );
    const opened = createDatabaseClient({
      driver: 'postgres',
      url: ownedDatabase.url,
      maxConnections: 2,
    });
    if (opened.driver !== 'postgres') throw new Error('PostgreSQL only.');
    connection = opened;
    await migrateDatabase(opened);
    admin = adminSession();
    await persistActor(admin);
  });

  afterAll(async () => {
    await closeAndDropDisposableDatabase(connection?.close, ownedDatabase);
  });

  test('an invitation is pending until the provider and the email both confirm', async () => {
    const email = address('invite');
    const admission = await invite(email);
    expect(admission.invitedByUserId).toBe(
      admin.actor.kind === 'human' ? admin.actor.userId : '',
    );
    const pending = await record(admission.id);
    expect(pending.status).toBe('invited');
    expect(pending.providerPendingStep).toBe('enable');
    expect(pending.invitationSentAt).toBeNull();

    const fake = recordingProviders();
    const done = await reconcile(admission.id, fake.providers);
    expect(done.providerPendingStep).toBeNull();
    expect(done.invitationSentAt).not.toBeNull();
    expect(done.status).toBe('invited');
    expect(fake.calls).toEqual([`enable:${email}`]);
    expect(fake.mail).toHaveLength(1);
    expect(fake.mail[0]?.to).toBe(email);
    expect(fake.mail[0]?.subject).toContain(
      'Synthetic Example School District',
    );
    expect(fake.mail[0]?.textBody).toContain('Synthetic Fire District');
    expect(fake.mail[0]?.textBody).toContain(
      'https://eoc.example.invalid/auth/sign-in',
    );

    // A second reconciliation has nothing left to do.
    const again = recordingProviders();
    await reconcile(admission.id, again.providers);
    expect(again.calls).toEqual([]);
    expect(again.mail).toEqual([]);
  });

  test('a provider failure leaves visible drift that a retry completes', async () => {
    const email = address('drift');
    const admission = await invite(email);
    const fake = recordingProviders();
    fake.state.fail = true;
    await expectAdminRefusal(reconcile(admission.id, fake.providers), 409);
    expect((await record(admission.id)).providerPendingStep).toBe('enable');
    const syncs = await database()
      .select()
      .from(partnerProviderSyncs)
      .where(eq(partnerProviderSyncs.partnerAdmissionId, admission.id));
    expect(syncs).toEqual([]);

    fake.state.fail = false;
    const done = await reconcile(admission.id, fake.providers);
    expect(done.providerPendingStep).toBeNull();
    expect(done.invitationSentAt).not.toBeNull();
  });

  test('resend sends the invitation again and records each send', async () => {
    const email = address('resend');
    const admission = await invite(email);
    const fake = recordingProviders();
    await reconcile(admission.id, fake.providers);
    await reconcile(admission.id, fake.providers, true);
    expect(fake.mail).toHaveLength(2);
    const notices = await database()
      .select()
      .from(partnerNotices)
      .where(eq(partnerNotices.partnerAdmissionId, admission.id));
    expect(notices.map((notice) => notice.kind)).toEqual([
      'invitation',
      'invitation',
    ]);
  });

  test('refuses a second invitation for an address that already has access', async () => {
    const email = address('twice');
    await invite(email);
    expect(await expectAdminRefusal(invite(email), 409)).toBe(
      'That address already has partner access.',
    );
  });

  test('refuses an address a district staff account uses', async () => {
    const [staff] = await database()
      .select({ email: users.email })
      .from(users)
      .where(
        eq(users.id, admin.actor.kind === 'human' ? admin.actor.userId : ''),
      );
    if (staff === undefined) throw new Error('no staff');
    expect(await expectAdminRefusal(invite(staff.email), 409)).toBe(
      'That address belongs to a district staff account.',
    );
  });

  test('a corrected address replaces the admission; the old account is disabled', async () => {
    const typo = address('typo');
    const corrected = address('corrected');
    const first = await invite(typo);
    const fake = recordingProviders();
    await reconcile(first.id, fake.providers);

    const second = await invite(corrected, first.id);
    expect(second.supersedesAdmissionId).toBe(first.id);
    const replaced = await record(first.id);
    expect(replaced.status).toBe('superseded');
    expect(replaced.admission.ending?.reason).toBe('superseded');
    expect(replaced.providerPendingStep).toBe('disable');

    await reconcile(first.id, fake.providers);
    await reconcile(second.id, fake.providers);
    expect(fake.calls).toEqual([
      `enable:${typo}`,
      `disable:${typo}`,
      `enable:${corrected}`,
    ]);
    expect((await record(first.id)).providerPendingStep).toBeNull();
  });

  test('disable ends the admission, cuts the partner out at once, and disables the account', async () => {
    const email = address('disable');
    const admission = await invite(email);
    const fake = recordingProviders();
    await reconcile(admission.id, fake.providers);
    const partner = await issueSyntheticPartnerSession(database(), {
      email,
      displayName: 'Synthetic Responder',
      now: new Date(),
    });
    expect((await record(admission.id)).status).toBe('active');
    const sessionService = new SessionService(
      new DrizzleSessionStore(database()),
    );
    await sessionService.authenticate(partner.credential, 'web');

    // A phone the partner also enrolled, holding a live push registration.
    const [device] = await database()
      .insert(deviceEnrollments)
      .values({
        userId: partner.userId,
        platform: 'ios',
        unlockMethod: 'biometric',
        installationId: `partner-phone-${randomUUID()}`,
      })
      .returning({ id: deviceEnrollments.id });
    if (device === undefined) throw new Error('no device');
    await database()
      .insert(devicePushTokenRegistrations)
      .values({
        deviceEnrollmentId: device.id,
        platform: 'ios',
        token: `partner-token-${randomUUID()}`,
      });
    await database().insert(staffSmsConsents).values({
      userId: partner.userId,
      phoneNumber: '+12535550199',
      disclosureVersion: '2026-08-01',
      source: 'web',
      consentedAt: new Date(),
    });

    const ended = await executeDisablePartnerCapability({
      authenticated: admin,
      store: store(),
      command: { partnerAdmissionId: admission.id },
      metadata: metadata(),
    });
    expect(ended.ending).toMatchObject({
      reason: 'disabled',
      endedByUserId: admin.actor.kind === 'human' ? admin.actor.userId : '',
    });
    const disabled = await record(admission.id);
    expect(disabled.status).toBe('disabled');
    expect(disabled.providerPendingStep).toBe('disable');

    // The partner is refused on the very next request.
    let refusal: unknown;
    try {
      await sessionService.authenticate(partner.credential, 'web');
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SessionAccessError);
    const revocations = await database()
      .select({ reasonCode: sessionRevocations.reasonCode })
      .from(sessionRevocations)
      .where(eq(sessionRevocations.sessionId, partner.sessionId));
    expect(revocations).toEqual([{ reasonCode: 'PARTNER_ADMISSION_DISABLED' }]);
    const liveRegistrations = await database()
      .select({ id: devicePushTokenRegistrations.id })
      .from(devicePushTokenRegistrations)
      .leftJoin(
        devicePushTokenUnregistrations,
        eq(
          devicePushTokenUnregistrations.registrationId,
          devicePushTokenRegistrations.id,
        ),
      )
      .where(
        and(
          eq(devicePushTokenRegistrations.deviceEnrollmentId, device.id),
          isNull(devicePushTokenUnregistrations.id),
        ),
      );
    expect(liveRegistrations).toEqual([]);
    const liveConsents = await database()
      .select({ id: staffSmsConsents.id })
      .from(staffSmsConsents)
      .where(
        and(
          eq(staffSmsConsents.userId, partner.userId),
          isNull(staffSmsConsents.withdrawnAt),
        ),
      );
    expect(liveConsents).toEqual([]);

    await reconcile(admission.id, fake.providers);
    expect(fake.calls).toEqual([`enable:${email}`, `disable:${email}`]);
    expect((await record(admission.id)).providerPendingStep).toBeNull();
    await expectAdminRefusal(
      executeDisablePartnerCapability({
        authenticated: admin,
        store: store(),
        command: { partnerAdmissionId: admission.id },
        metadata: metadata(),
      }),
      409,
    );
  });

  test('re-inviting a disabled partner is a new admission and re-enables the account', async () => {
    const email = address('reinvite');
    const first = await invite(email);
    const fake = recordingProviders();
    await reconcile(first.id, fake.providers);
    await executeDisablePartnerCapability({
      authenticated: admin,
      store: store(),
      command: { partnerAdmissionId: first.id },
      metadata: metadata(),
    });
    await reconcile(first.id, fake.providers);
    const second = await invite(email);
    expect(second.id).not.toBe(first.id);
    expect(second.supersedesAdmissionId).toBeNull();
    await reconcile(second.id, fake.providers);
    expect(fake.calls).toEqual([
      `enable:${email}`,
      `disable:${email}`,
      `enable:${email}`,
    ]);
    expect((await record(first.id)).status).toBe('disabled');
    expect((await record(second.id)).status).toBe('invited');
  });

  test('only an administrator may manage partners', async () => {
    const staff = adminSession();
    (staff as unknown as { roles: string[] }).roles = ['staff'];
    await persistActor(staff);
    await expectAdminRefusal(invite(address('forbidden'), null, staff), 403);
  });

  test('the application role can append and read provider syncs and notices', async () => {
    if (ownedDatabase === undefined) throw new Error('no database');
    const email = address('app-role');
    const admission = await invite(email);
    const roleConnection = createDatabaseClient({
      driver: 'postgres',
      url: ownedDatabase.url,
      maxConnections: 1,
    });
    if (roleConnection.driver !== 'postgres') throw new Error('postgres');
    try {
      await roleConnection.db.execute(sql`set role psd_eoc_app`);
      await roleConnection.db.insert(partnerProviderSyncs).values({
        partnerAdmissionId: admission.id,
        action: 'enabled',
        providerSubject: 'synthetic-subject',
        performedByUserId: null,
      });
      await roleConnection.db.insert(partnerNotices).values({
        partnerAdmissionId: admission.id,
        kind: 'invitation',
        sentByUserId: null,
      });
      expect(
        (await roleConnection.db.select().from(partnerNotices)).length,
      ).toBeGreaterThan(0);
      let refused: unknown;
      try {
        await roleConnection.db.execute(
          sql`update partner_notices set kind = 'invitation' where partner_admission_id = ${admission.id}`,
        );
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeDefined();
    } finally {
      await roleConnection.close();
    }
  });
});
