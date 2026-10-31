#!/usr/bin/env bun

/**
 * The world the native partner journey runs against (issue #598).
 *
 * The mobile Maestro harness drives a real device against a real server, so
 * unlike the in-process synthetic fixtures it needs a database with rows in
 * it. This script owns those rows and nothing else: the mobile runner spawns
 * it, reads one JSON line from its output, and spawns it again with `drop` to
 * take the database away afterwards. The runner therefore never imports
 * anything from the server package.
 *
 * What it creates is the smallest world the journey needs:
 *
 * - the seeded synthetic district, with its one non-isolated test school;
 * - a district administrator, because starting an event is staff work and a
 *   partner must arrive at an event somebody else started;
 * - one active synthetic drill at that school, for the partner to join; and
 * - a partner admission with no account and no session, which is the state
 *   partner sign-in starts from. The sign-in under test creates the rest, so
 *   pre-seeding a partner session would test nothing.
 *
 * The code the partner types is derived from the address by the synthetic
 * pool, so it is printed here rather than emailed anywhere. Nothing in this
 * script can reach a real pool, a real roster, or a real provider.
 */

import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { createDatabaseClient } from '../db/client';
import { groupMembers, groupSources } from '../db/schema';
import { seedDatabase } from '../db/seed';
import { migrateDatabase } from '../drizzle/migrate';
import { syntheticPartnerOtpCode } from '../lib/auth/partner-otp';
import {
  createDisposableDatabase,
  requireSyntheticTestDatabaseUrl,
} from '../lib/testing/database';
import {
  accessGroup,
  admitPartner,
  createSyntheticDrill,
  issueIdentity,
} from './synthetic-fixture';

/** The seeded non-isolated school the drill is started at. */
const FACILITY_NAME = 'Synthetic Test School';
const PARTNER_EMAIL = 'mobile-responder@agency.example.invalid';
const PARTNER_DISPLAY_NAME = 'Synthetic Mobile Responder';
const ADMINISTRATOR_EMAIL = 'mobile-district-admin@example.invalid';

export interface MobilePartnerFixture {
  readonly databaseUrl: string;
  readonly partnerEmail: string;
  /** What the synthetic pool would have emailed; never a real code. */
  readonly partnerCode: string;
  readonly facilityName: string;
  readonly eventId: string;
}

async function create(): Promise<MobilePartnerFixture> {
  const disposable = await createDisposableDatabase('mobile_partner');
  const connection = createDatabaseClient({
    driver: 'postgres',
    url: disposable.url,
  });
  if (connection.driver !== 'postgres') {
    await connection.close();
    await disposable.drop();
    throw new Error('The native partner journey requires PostgreSQL.');
  }
  try {
    await migrateDatabase(connection);
    await seedDatabase(connection.db);
    const now = new Date();
    const adminGroupId = randomUUID();
    await connection.db
      .insert(groupSources)
      .values([accessGroup(adminGroupId, 'admin', now)]);
    await connection.db.insert(groupMembers).values({
      groupSourceId: adminGroupId,
      email: ADMINISTRATOR_EMAIL,
      capturedAt: now,
    });
    const administrator = await issueIdentity(connection, {
      email: ADMINISTRATOR_EMAIL,
      displayName: 'Synthetic Mobile District Administrator',
      groupSourceIds: [adminGroupId],
      now,
    });
    await admitPartner(connection, {
      email: PARTNER_EMAIL,
      displayName: PARTNER_DISPLAY_NAME,
      invitedByUserId: administrator.userId,
      admittedAt: now,
    });
    const eventId = await createSyntheticDrill(connection, administrator);
    return Object.freeze({
      databaseUrl: disposable.url,
      partnerEmail: PARTNER_EMAIL,
      partnerCode: syntheticPartnerOtpCode(PARTNER_EMAIL),
      facilityName: FACILITY_NAME,
      eventId,
    });
  } catch (error) {
    await disposable.drop();
    throw error;
  } finally {
    await connection.close();
  }
}

async function drop(databaseUrl: string): Promise<void> {
  // Both URLs are checked: the one being dropped and the one the maintenance
  // connection is made on. Only a database this script created can be named,
  // so a mistyped argument cannot take away a developer's test database.
  const verified = requireSyntheticTestDatabaseUrl(databaseUrl);
  const name = new URL(verified).pathname.slice(1);
  if (!/^mobile_partner_[0-9a-f]{32}_test$/u.test(name)) {
    throw new Error('Only a native partner fixture database may be dropped.');
  }
  const maintenance = new URL(verified);
  maintenance.pathname = new URL(
    requireSyntheticTestDatabaseUrl(process.env.TEST_DATABASE_URL),
  ).pathname;
  const sql = postgres(maintenance.toString(), {
    max: 1,
    onnotice: () => {},
  });
  try {
    await sql.unsafe(`drop database if exists "${name}" (force)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const [command, argument] = Bun.argv.slice(2);
  if (command === 'create') {
    console.info(JSON.stringify(await create()));
  } else if (command === 'drop' && argument !== undefined) {
    await drop(argument);
  } else {
    throw new Error(
      'Usage: bun packages/server/e2e/mobile-partner-fixture.ts create | drop <url>',
    );
  }
}
