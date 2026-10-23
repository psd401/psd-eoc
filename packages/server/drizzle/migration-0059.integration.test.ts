import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { sql } from 'drizzle-orm';
import { migrate as migrateWithPostgres } from 'drizzle-orm/postgres-js/migrator';

import {
  createDatabaseClient,
  databaseExecuteRows,
  type PostgresDatabaseConnection,
} from '../db/client';
import {
  groupSources,
  partnerAdmissionEndings,
  partnerAdmissions,
  users,
} from '../db/schema';
import {
  createDisposableDatabase,
  type DisposableDatabase,
} from '../lib/testing/database';
import { migrationsFolder } from './migrate';

/**
 * Proofs for `0059_partner_identity_and_admissions`: issuer + subject identity
 * on `users`, the `partner` role and the rule that it never sits beside a
 * staff role, and the append-only partner admission tables. Each claim runs
 * against a fresh database and, for the backfill, against a database shaped
 * like production before the migration landed.
 */
setDefaultTimeout(120_000);

const MIGRATION_TAG = '0059_partner_identity_and_admissions';
const GOOGLE = 'https://accounts.google.com';
const PARTNER_ISSUER = 'https://cognito-idp.example.invalid/synthetic-pool';
const baseTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  baseTestDatabaseUrl === undefined ? describe.skip : describe;

interface MigrationJournal {
  readonly entries: readonly { readonly idx: number; readonly tag: string }[];
}

function open(url: string, maxConnections = 2): PostgresDatabaseConnection {
  const connection = createDatabaseClient({
    driver: 'postgres',
    url,
    maxConnections,
  });
  if (connection.driver !== 'postgres') {
    throw new Error('This test requires PostgreSQL.');
  }
  return connection;
}

/** The committed chain up to but excluding 0059. */
async function prepareMigrationsBefore0059(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'psd-eoc-migration-0059-'));
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as MigrationJournal;
  const index = journal.entries.findIndex(
    (entry) => entry.tag === MIGRATION_TAG,
  );
  if (index <= 0) throw new Error(`${MIGRATION_TAG} is not in the journal.`);
  const entries = journal.entries.slice(0, index);
  await mkdir(join(directory, 'meta'));
  await writeFile(
    join(directory, 'meta', '_journal.json'),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
    'utf8',
  );
  await Promise.all(
    entries.map((entry) =>
      copyFile(
        join(migrationsFolder, `${entry.tag}.sql`),
        join(directory, `${entry.tag}.sql`),
      ),
    ),
  );
  return directory;
}

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    const code = Reflect.get(Object(current), 'code');
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code)) return code;
    current = Reflect.get(Object(current), 'cause');
  }
  return undefined;
}

async function expectCode(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(postgresCode(caught)).toBe(code);
}

async function insertGoogleUser(
  connection: PostgresDatabaseConnection,
  label: string,
): Promise<string> {
  const id = randomUUID();
  await connection.db.insert(users).values({
    id,
    googleSubject: `google-${label}`,
    identityIssuer: GOOGLE,
    identitySubject: `google-${label}`,
    email: `${label}@district.example.invalid`,
    displayName: `Synthetic ${label}`,
    facilityScopeKind: 'district',
  });
  return id;
}

async function insertPartnerUser(
  connection: PostgresDatabaseConnection,
  label: string,
): Promise<string> {
  const id = randomUUID();
  await connection.db.insert(users).values({
    id,
    googleSubject: null,
    identityIssuer: PARTNER_ISSUER,
    identitySubject: `partner-${label}`,
    email: `${label}@agency.example.invalid`,
    displayName: `Synthetic ${label}`,
    facilityScopeKind: 'district',
  });
  return id;
}

describeWithDatabase('migration 0059 on a fresh database', () => {
  let owned: DisposableDatabase | undefined;
  let connection: PostgresDatabaseConnection | undefined;
  let adminId = '';

  const db = () => {
    if (connection === undefined) throw new Error('not connected');
    return connection;
  };

  beforeAll(async () => {
    owned = await createDisposableDatabase(
      'psd_eoc_m0059',
      baseTestDatabaseUrl,
    );
    connection = open(owned.url);
    await migrateWithPostgres(connection.db, { migrationsFolder });
    adminId = await insertGoogleUser(connection, 'administrator');
  });

  afterAll(async () => {
    await connection?.close();
    await owned?.drop();
  });

  test('identity is issuer and subject, unique together and immutable', async () => {
    const partnerId = await insertPartnerUser(db(), 'unique-a');
    await expectCode(
      db().db.insert(users).values({
        googleSubject: null,
        identityIssuer: PARTNER_ISSUER,
        identitySubject: 'partner-unique-a',
        email: 'other@agency.example.invalid',
        displayName: 'Synthetic duplicate',
        facilityScopeKind: 'district',
      }),
      '23505',
    );
    await expectCode(
      db().db.execute(
        sql`update users set identity_subject = 'changed' where id = ${partnerId}`,
      ),
      '55000',
    );
  });

  test('a Google subject belongs to a Google identity and matches its subject', async () => {
    await expectCode(
      db().db.insert(users).values({
        googleSubject: 'google-mismatch',
        identityIssuer: GOOGLE,
        identitySubject: 'something-else',
        email: 'mismatch@district.example.invalid',
        displayName: 'Synthetic mismatch',
        facilityScopeKind: 'district',
      }),
      '23514',
    );
    await expectCode(
      db().db.insert(users).values({
        googleSubject: 'google-on-partner',
        identityIssuer: PARTNER_ISSUER,
        identitySubject: 'google-on-partner',
        email: 'wrong@agency.example.invalid',
        displayName: 'Synthetic wrong issuer',
        facilityScopeKind: 'district',
      }),
      '23514',
    );
  });

  test('a writer from the previous release that names only google_subject still works', async () => {
    const [row] = databaseExecuteRows<{
      identity_issuer: string;
      identity_subject: string;
    }>(
      await db().db
        .execute(sql`insert into users (google_subject, email, display_name, facility_scope_kind)
          values ('google-legacy-writer', 'legacy@district.example.invalid',
                  'Synthetic legacy', 'district')
          returning identity_issuer, identity_subject`),
    );
    expect(row).toEqual({
      identity_issuer: GOOGLE,
      identity_subject: 'google-legacy-writer',
    });
  });

  test('partner is never held beside a staff role, nor granted by a group', async () => {
    const partnerId = await insertPartnerUser(db(), 'roles');
    await expectCode(
      db().db.execute(
        sql`insert into user_roles (user_id, role) values (${partnerId}, 'staff')`,
      ),
      '23514',
    );
    await expectCode(
      db().db.execute(
        sql`insert into user_roles (user_id, role) values (${adminId}, 'partner')`,
      ),
      '23514',
    );
    await db().db.execute(
      sql`insert into user_roles (user_id, role) values (${partnerId}, 'partner')`,
    );
    await expectCode(
      db()
        .db.insert(groupSources)
        .values({
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
          displayName: 'Synthetic partner group',
          active: true,
          grantedRole: 'partner' as never,
          googleGroupId: 'synthetic-partner-group',
          email: 'partner-group@example.invalid',
          fixtureKey: null,
        }),
      '23514',
    );
  });

  test('expiry is computed one year after admission and cannot be written', async () => {
    const [admission] = await db()
      .db.insert(partnerAdmissions)
      .values({
        email: 'expiry@agency.example.invalid',
        displayName: 'Synthetic expiry',
        agency: 'Synthetic Fire District',
        invitedByUserId: adminId,
        admittedAt: new Date('2028-02-29T10:00:00.000Z'),
      })
      .returning();
    expect(admission?.expiresAt.toISOString()).toBe('2029-02-28T10:00:00.000Z');
    await expectCode(
      db().db.execute(
        sql`insert into partner_admissions (email, display_name, agency, invited_by_user_id, expires_at)
            values ('forged@agency.example.invalid', 'Forged', 'Agency', ${adminId}, now() + interval '10 years')`,
      ),
      '428C9',
    );
  });

  test('admissions and endings are append-only', async () => {
    const [admission] = await db()
      .db.insert(partnerAdmissions)
      .values({
        email: 'append-only@agency.example.invalid',
        displayName: 'Synthetic append-only',
        agency: 'Synthetic Police Department',
        invitedByUserId: adminId,
      })
      .returning();
    if (admission === undefined) throw new Error('no admission');
    await db().db.insert(partnerAdmissionEndings).values({
      partnerAdmissionId: admission.id,
      reason: 'disabled',
      endedByUserId: adminId,
    });
    await expectCode(
      db().db.execute(
        sql`update partner_admissions set agency = 'Other' where id = ${admission.id}`,
      ),
      '55000',
    );
    await expectCode(
      db().db.execute(
        sql`delete from partner_admissions where id = ${admission.id}`,
      ),
      '55000',
    );
    await expectCode(
      db().db.execute(
        sql`update partner_admission_endings set reason = 'expired', ended_by_user_id = null where partner_admission_id = ${admission.id}`,
      ),
      '55000',
    );
    await expectCode(
      db().db.execute(
        sql`delete from partner_admission_endings where partner_admission_id = ${admission.id}`,
      ),
      '55000',
    );
  });

  test('disabled and expired endings stay distinguishable by their actor', async () => {
    const [admission] = await db()
      .db.insert(partnerAdmissions)
      .values({
        email: 'actor@agency.example.invalid',
        displayName: 'Synthetic actor',
        agency: 'Synthetic Fire District',
        invitedByUserId: adminId,
      })
      .returning();
    if (admission === undefined) throw new Error('no admission');
    await expectCode(
      db().db.insert(partnerAdmissionEndings).values({
        partnerAdmissionId: admission.id,
        reason: 'expired',
        endedByUserId: adminId,
      }),
      '23514',
    );
    await expectCode(
      db().db.insert(partnerAdmissionEndings).values({
        partnerAdmissionId: admission.id,
        reason: 'disabled',
        endedByUserId: null,
      }),
      '23514',
    );
    await db().db.insert(partnerAdmissionEndings).values({
      partnerAdmissionId: admission.id,
      reason: 'expired',
      endedByUserId: null,
    });
    await expectCode(
      db().db.insert(partnerAdmissionEndings).values({
        partnerAdmissionId: admission.id,
        reason: 'disabled',
        endedByUserId: adminId,
      }),
      '23505',
    );
  });

  test('an address has at most one unended admission, checked at commit', async () => {
    const email = 'one-active@agency.example.invalid';
    await db().db.insert(partnerAdmissions).values({
      email,
      displayName: 'Synthetic one',
      agency: 'Synthetic Fire District',
      invitedByUserId: adminId,
    });
    await expectCode(
      db().db.insert(partnerAdmissions).values({
        email,
        displayName: 'Synthetic two',
        agency: 'Synthetic Fire District',
        invitedByUserId: adminId,
      }),
      '23505',
    );
  });

  test('a renewal supersedes the prior admission in one transaction', async () => {
    const email = 'renewal@agency.example.invalid';
    const [first] = await db()
      .db.insert(partnerAdmissions)
      .values({
        email,
        displayName: 'Synthetic renewal',
        agency: 'Synthetic Fire District',
        invitedByUserId: adminId,
      })
      .returning();
    if (first === undefined) throw new Error('no admission');
    // A supersession whose old admission is never ended is refused at commit.
    await expectCode(
      db().db.transaction(async (transaction) => {
        await transaction.insert(partnerAdmissions).values({
          email,
          displayName: 'Synthetic renewal',
          agency: 'Synthetic Fire District',
          invitedByUserId: adminId,
          supersedesAdmissionId: first.id,
        });
      }),
      '23514',
    );
    // A `superseded` ending with no superseding admission is refused too.
    await expectCode(
      db().db.insert(partnerAdmissionEndings).values({
        partnerAdmissionId: first.id,
        reason: 'superseded',
        endedByUserId: adminId,
      }),
      '23514',
    );
    await db().db.transaction(async (transaction) => {
      await transaction.insert(partnerAdmissions).values({
        email,
        displayName: 'Synthetic renewal',
        agency: 'Synthetic Fire District',
        invitedByUserId: adminId,
        supersedesAdmissionId: first.id,
      });
      await transaction.insert(partnerAdmissionEndings).values({
        partnerAdmissionId: first.id,
        reason: 'superseded',
        endedByUserId: adminId,
      });
    });
    const rows = databaseExecuteRows<{ ended: boolean }>(
      await db().db
        .execute(sql`select exists (select 1 from partner_admission_endings e where e.partner_admission_id = a.id) as ended
          from partner_admissions a where a.email = ${email} order by a.admitted_at, a.id`),
    );
    expect(rows.filter((row) => !row.ended)).toHaveLength(1);
  });

  test('the application role can append and read admissions and endings, and nothing more', async () => {
    if (owned === undefined) throw new Error('no database');
    const roleConnection = open(owned.url, 1);
    try {
      await roleConnection.db.execute(sql`set role psd_eoc_app`);
      const [admission] = await roleConnection.db
        .insert(partnerAdmissions)
        .values({
          email: 'app-role@agency.example.invalid',
          displayName: 'Synthetic app role',
          agency: 'Synthetic Fire District',
          invitedByUserId: adminId,
        })
        .returning();
      if (admission === undefined) throw new Error('no admission');
      const [ending] = await roleConnection.db
        .insert(partnerAdmissionEndings)
        .values({
          partnerAdmissionId: admission.id,
          reason: 'disabled',
          endedByUserId: adminId,
        })
        .returning();
      expect(ending?.reason).toBe('disabled');
      expect(
        (await roleConnection.db.select().from(partnerAdmissions)).length,
      ).toBeGreaterThan(0);
      await expectCode(
        roleConnection.db.execute(
          sql`update partner_admissions set agency = 'x' where id = ${admission.id}`,
        ),
        '42501',
      );
      await expectCode(
        roleConnection.db.execute(
          sql`delete from partner_admission_endings where id = ${ending?.id ?? ''}`,
        ),
        '42501',
      );
      // A partner user is written by the application role too.
      await roleConnection.db.insert(users).values({
        googleSubject: null,
        identityIssuer: PARTNER_ISSUER,
        identitySubject: 'partner-app-role',
        email: 'app-role-user@agency.example.invalid',
        displayName: 'Synthetic app role user',
        facilityScopeKind: 'district',
      });
    } finally {
      await roleConnection.close();
    }
  });
});

describeWithDatabase('migration 0059 on a production-shaped database', () => {
  let migrationsBefore: string | undefined;

  beforeAll(async () => {
    migrationsBefore = await prepareMigrationsBefore0059();
  });

  afterAll(async () => {
    if (migrationsBefore !== undefined) {
      await rm(migrationsBefore, { recursive: true, force: true });
    }
  });

  test('backfills every existing user as a Google identity and changes nothing else', async () => {
    if (migrationsBefore === undefined) throw new Error('not prepared');
    const owned = await createDisposableDatabase(
      'psd_eoc_m0059_prod',
      baseTestDatabaseUrl,
    );
    const connection = open(owned.url);
    try {
      await migrateWithPostgres(connection.db, {
        migrationsFolder: migrationsBefore,
      });
      await connection.db.execute(sql`
        insert into users (id, google_subject, email, display_name, facility_scope_kind, created_at, disabled_at)
        values
          ('00000000-0000-4000-8000-000000059101', 'google-existing-1', 'existing-1@district.example.invalid', 'Synthetic Existing One', 'district', '2026-08-01T16:00:00Z', null),
          ('00000000-0000-4000-8000-000000059102', 'google-existing-2', 'existing-2@district.example.invalid', 'Synthetic Existing Two', 'facilities', '2026-08-02T16:00:00Z', '2026-09-01T16:00:00Z')
      `);
      const before = databaseExecuteRows<Record<string, unknown>>(
        await connection.db.execute(
          sql`select id, google_subject, email, display_name, facility_scope_kind, created_at, disabled_at from users order by id`,
        ),
      );

      await migrateWithPostgres(connection.db, { migrationsFolder });

      const after = databaseExecuteRows<Record<string, unknown>>(
        await connection.db.execute(
          sql`select id, google_subject, email, display_name, facility_scope_kind, created_at, disabled_at from users order by id`,
        ),
      );
      expect(after).toEqual(before);
      const identities = databaseExecuteRows<{
        google_subject: string;
        identity_issuer: string;
        identity_subject: string;
      }>(
        await connection.db.execute(
          sql`select google_subject, identity_issuer, identity_subject from users order by id`,
        ),
      );
      expect(identities).toEqual([
        {
          google_subject: 'google-existing-1',
          identity_issuer: GOOGLE,
          identity_subject: 'google-existing-1',
        },
        {
          google_subject: 'google-existing-2',
          identity_issuer: GOOGLE,
          identity_subject: 'google-existing-2',
        },
      ]);
      const [nullable] = databaseExecuteRows<{
        issuer_nullable: string;
        subject_nullable: string;
      }>(
        await connection.db.execute(sql`select
              max(case when column_name = 'identity_issuer' then is_nullable end) as issuer_nullable,
              max(case when column_name = 'identity_subject' then is_nullable end) as subject_nullable
            from information_schema.columns
            where table_schema = 'public' and table_name = 'users'`),
      );
      expect(nullable).toEqual({
        issuer_nullable: 'NO',
        subject_nullable: 'NO',
      });
    } finally {
      await connection.close();
      await owned.drop();
    }
  });
});
