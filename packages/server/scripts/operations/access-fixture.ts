import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';

import { databaseExecuteRows, type Database } from '../../db/client';
import {
  accessMembershipMemberGroups,
  accessMembershipMembers,
  accessMembershipSnapshotGroups,
  accessMembershipSnapshots,
  channelConfigurations,
  groupSources,
  rosterRecipients,
  userFacilityScopes,
  userRoles,
  users,
} from '../../db/schema';
import { ADMIN_AVAILABILITY_LOCK_SQL } from '../../lib/auth/role-state';

export const ACCESS_FIXTURE_IDS = Object.freeze({
  accessGroup: '00000000-0000-4000-8000-000000000163',
  user: '00000000-0000-4000-8000-000000000164',
});

/**
 * Refuses to publish the synthetic fixture onto a stack that already decides
 * access for itself.
 *
 * Publishing the fixture appends an access-membership snapshot whose group set
 * is the single synthetic group. Sign-in validates the latest complete
 * snapshot's group set against the active access groups and denies everyone
 * when they differ, so on a stack with real access groups the fixture revokes
 * all access until the access sync republishes. It cannot self-repair: the
 * sync refuses to run against an invalid baseline.
 *
 * That is not a hypothetical. It happened on 2026-08-18, when a deploy ran the
 * bootstrap unconditionally and locked every administrator out of the live
 * stack. The mode split keeps deploys away from this code; this keeps a
 * deliberate run away from a stack that no longer needs it.
 */
export function assertNoRealAccessGroups(
  activeAccessGroupIds: readonly string[],
): void {
  if (activeAccessGroupIds.length > 0) {
    throw new Error(
      'The access fixture refuses to publish: this stack already has active access groups.',
    );
  }
}

const ACCESS_FIXTURE_CREATED_AT = new Date('2026-08-15T12:00:00.000Z');
const MAX_BOOTSTRAP_SNAPSHOT_AGE_MS = 5 * 60 * 1_000;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const MAX_JAVASCRIPT_DATE_MILLISECONDS = 8_640_000_000_000_000;

export interface AccessFixtureInput {
  readonly googleSubject: string;
  readonly staffEmail: string;
  readonly staffDisplayName: string;
}

export interface AccessFixtureSnapshotIdentity {
  readonly id: string;
  readonly version: number;
  readonly capturedAt: Date;
}

export interface AccessFixture {
  readonly accessGroup: Readonly<{
    id: string;
    kind: 'google-group';
    purpose: 'access';
    facilityId: null;
    displayName: string;
    active: true;
    googleGroupId: string;
    email: string;
    fixtureKey: null;
    createdAt: Date;
  }>;
  readonly user: Readonly<{
    id: string;
    googleSubject: string;
    email: string;
    displayName: string;
    facilityScopeKind: 'district';
    createdAt: Date;
    disabledAt: null;
  }>;
  readonly role: Readonly<{ userId: string; role: 'staff' }>;
  readonly snapshot: Readonly<{
    id: string;
    version: number;
    complete: true;
    syncStartedAt: Date;
    capturedAt: Date;
  }>;
}

export interface AccessFixtureEvidence {
  readonly activeAccessGroups: readonly Readonly<Record<string, unknown>>[];
  readonly users: readonly Readonly<Record<string, unknown>>[];
  readonly roles: readonly Readonly<Record<string, unknown>>[];
  readonly facilityScopes: readonly Readonly<Record<string, unknown>>[];
  readonly snapshots: readonly Readonly<Record<string, unknown>>[];
  readonly snapshotGroups: readonly Readonly<Record<string, unknown>>[];
  readonly members: readonly Readonly<Record<string, unknown>>[];
  readonly memberGroups: readonly Readonly<Record<string, unknown>>[];
  readonly channels: readonly Readonly<Record<string, unknown>>[];
  readonly matchingRosterRecipients: number;
}

export interface AccessFixtureStore {
  publish(
    input: AccessFixtureInput,
    replay: AccessFixture | null,
  ): Promise<AccessFixture>;
  readEvidence(fixture: AccessFixture): Promise<AccessFixtureEvidence>;
}

export interface AccessFixtureSummary {
  readonly accessGroups: 1;
  readonly users: 1;
  readonly staffRoles: 1;
  readonly accessSnapshots: 1;
  readonly notificationChannelsEnabled: 0;
  readonly matchingRosterRecipients: 0;
}

export interface SeededAccessFixture {
  readonly fixture: AccessFixture;
  readonly summary: AccessFixtureSummary;
}

interface ExplorationAccessSnapshotAllocation {
  readonly capturedAt: Date;
  readonly latestVersion: number;
}

/** Decodes the scalar shape returned by a raw native postgres-js query. */
export function parseAccessFixtureSnapshotAllocation(
  rows: readonly Readonly<Record<string, unknown>>[],
): ExplorationAccessSnapshotAllocation {
  const allocation = rows[0];
  const capturedAtMilliseconds = allocation?.capturedAtMilliseconds;
  const latestVersion = allocation?.latestVersion;
  if (
    rows.length !== 1 ||
    typeof capturedAtMilliseconds !== 'number' ||
    !Number.isSafeInteger(capturedAtMilliseconds) ||
    capturedAtMilliseconds <= 0 ||
    capturedAtMilliseconds > MAX_JAVASCRIPT_DATE_MILLISECONDS ||
    typeof latestVersion !== 'number' ||
    !Number.isSafeInteger(latestVersion) ||
    latestVersion < 0 ||
    latestVersion >= MAX_POSTGRES_INTEGER
  ) {
    throw new Error('The access snapshot could not be allocated.');
  }
  const capturedAt = new Date(capturedAtMilliseconds);
  if (Number.isNaN(capturedAt.getTime())) {
    throw new Error('The access snapshot could not be allocated.');
  }
  return Object.freeze({ capturedAt, latestVersion });
}

/** Creates one access-only graph around an already allocated snapshot. */
export function createAccessFixture(
  input: AccessFixtureInput,
  snapshotIdentity: AccessFixtureSnapshotIdentity,
): AccessFixture {
  if (
    !Number.isSafeInteger(snapshotIdentity.version) ||
    snapshotIdentity.version < 1 ||
    snapshotIdentity.version > MAX_POSTGRES_INTEGER ||
    Number.isNaN(snapshotIdentity.capturedAt.getTime())
  ) {
    throw new Error('The access snapshot identity was invalid.');
  }
  const identityCreatedAt = new Date(ACCESS_FIXTURE_CREATED_AT.getTime());
  const capturedAt = new Date(snapshotIdentity.capturedAt.getTime());
  return Object.freeze({
    accessGroup: Object.freeze({
      id: ACCESS_FIXTURE_IDS.accessGroup,
      kind: 'google-group' as const,
      purpose: 'access' as const,
      facilityId: null,
      displayName: 'Initial approved access fixture',
      active: true as const,
      googleGroupId: 'exploration-smoke-approved-access.invalid',
      email: 'exploration-smoke-access@example.invalid',
      fixtureKey: null,
      createdAt: identityCreatedAt,
    }),
    user: Object.freeze({
      id: ACCESS_FIXTURE_IDS.user,
      googleSubject: input.googleSubject,
      email: input.staffEmail,
      displayName: input.staffDisplayName,
      facilityScopeKind: 'district' as const,
      createdAt: identityCreatedAt,
      disabledAt: null,
    }),
    role: Object.freeze({
      userId: ACCESS_FIXTURE_IDS.user,
      role: 'staff' as const,
    }),
    snapshot: Object.freeze({
      id: snapshotIdentity.id,
      version: snapshotIdentity.version,
      complete: true as const,
      syncStartedAt: capturedAt,
      capturedAt,
    }),
  });
}

/** Production persistence adapter; every write is conflict-safe and append-only. */
export function createDrizzleAccessFixtureStore(
  database: Database,
): AccessFixtureStore {
  return Object.freeze({
    async publish(
      input: AccessFixtureInput,
      replay: AccessFixture | null,
    ): Promise<AccessFixture> {
      return database.transaction(async (transaction) => {
        await transaction.execute(ADMIN_AVAILABILITY_LOCK_SQL);
        // Inside the lock, so a concurrent access sync cannot activate a real
        // group between the check and the writes below.
        assertNoRealAccessGroups(
          (
            await transaction
              .select({ id: groupSources.id })
              .from(groupSources)
              .where(
                and(
                  eq(groupSources.purpose, 'access'),
                  eq(groupSources.active, true),
                  ne(groupSources.id, ACCESS_FIXTURE_IDS.accessGroup),
                ),
              )
          ).map((group) => group.id),
        );
        let fixture = replay;
        if (fixture === null) {
          const allocationRows = databaseExecuteRows<{
            capturedAtMilliseconds: number;
            latestVersion: number;
          }>(
            await transaction.execute(sql<{
              capturedAtMilliseconds: number;
              latestVersion: number;
            }>`
              select
                floor(extract(epoch from clock_timestamp()) * 1000)
                  ::double precision as "capturedAtMilliseconds",
                coalesce(max(${accessMembershipSnapshots.version}), 0)::integer
                  as "latestVersion"
              from ${accessMembershipSnapshots}
            `),
          );
          const allocation =
            parseAccessFixtureSnapshotAllocation(allocationRows);
          fixture = createAccessFixture(input, {
            id: randomUUID(),
            version: allocation.latestVersion + 1,
            capturedAt: allocation.capturedAt,
          });
        }
        await transaction
          .insert(groupSources)
          .values(fixture.accessGroup)
          .onConflictDoNothing();
        await transaction
          .insert(users)
          .values(fixture.user)
          .onConflictDoNothing();
        await transaction
          .insert(userRoles)
          .values(fixture.role)
          .onConflictDoNothing();
        await transaction
          .insert(accessMembershipSnapshots)
          .values(fixture.snapshot)
          .onConflictDoNothing();
        await transaction
          .insert(accessMembershipSnapshotGroups)
          .values([
            {
              snapshotId: fixture.snapshot.id,
              groupSourceId: fixture.accessGroup.id,
              groupSourceKind: fixture.accessGroup.kind,
              groupPurpose: fixture.accessGroup.purpose,
              completionKind: 'expected' as const,
            },
            {
              snapshotId: fixture.snapshot.id,
              groupSourceId: fixture.accessGroup.id,
              groupSourceKind: fixture.accessGroup.kind,
              groupPurpose: fixture.accessGroup.purpose,
              completionKind: 'completed' as const,
            },
          ])
          .onConflictDoNothing();
        await transaction
          .insert(accessMembershipMembers)
          .values({
            snapshotId: fixture.snapshot.id,
            userId: fixture.user.id,
            googleSubject: fixture.user.googleSubject,
            facilityScopeKind: fixture.user.facilityScopeKind,
          })
          .onConflictDoNothing();
        await transaction
          .insert(accessMembershipMemberGroups)
          .values({
            snapshotId: fixture.snapshot.id,
            userId: fixture.user.id,
            groupSourceId: fixture.accessGroup.id,
            groupSourceKind: fixture.accessGroup.kind,
            groupPurpose: fixture.accessGroup.purpose,
          })
          .onConflictDoNothing();
        return fixture;
      });
    },

    async readEvidence(fixture: AccessFixture): Promise<AccessFixtureEvidence> {
      const [
        activeAccessGroups,
        userRows,
        roleRows,
        facilityScopeRows,
        snapshotRows,
        snapshotGroupRows,
        memberRows,
        memberGroupRows,
        channelRows,
        matchingRecipients,
      ] = await Promise.all([
        database
          .select({
            id: groupSources.id,
            kind: groupSources.kind,
            purpose: groupSources.purpose,
            active: groupSources.active,
            googleGroupId: groupSources.googleGroupId,
            email: groupSources.email,
            fixtureKey: groupSources.fixtureKey,
          })
          .from(groupSources)
          .where(
            and(
              eq(groupSources.id, fixture.accessGroup.id),
              eq(groupSources.active, true),
              eq(groupSources.kind, 'google-group'),
              eq(groupSources.purpose, 'access'),
            ),
          )
          .orderBy(asc(groupSources.id)),
        database.select().from(users).where(eq(users.id, fixture.user.id)),
        database
          .select({ role: userRoles.role })
          .from(userRoles)
          .where(
            and(
              eq(userRoles.userId, fixture.user.id),
              eq(userRoles.role, 'staff'),
            ),
          )
          .orderBy(asc(userRoles.role)),
        database
          .select({ facilityId: userFacilityScopes.facilityId })
          .from(userFacilityScopes)
          .where(eq(userFacilityScopes.userId, fixture.user.id)),
        database
          .select()
          .from(accessMembershipSnapshots)
          .where(eq(accessMembershipSnapshots.id, fixture.snapshot.id)),
        database
          .select({
            groupSourceId: accessMembershipSnapshotGroups.groupSourceId,
            groupSourceKind: accessMembershipSnapshotGroups.groupSourceKind,
            groupPurpose: accessMembershipSnapshotGroups.groupPurpose,
            completionKind: accessMembershipSnapshotGroups.completionKind,
          })
          .from(accessMembershipSnapshotGroups)
          .where(
            eq(accessMembershipSnapshotGroups.snapshotId, fixture.snapshot.id),
          )
          // PostgreSQL enum order is expected before completed, while the
          // evidence contract deliberately presents completed proof first.
          .orderBy(desc(accessMembershipSnapshotGroups.completionKind)),
        database
          .select()
          .from(accessMembershipMembers)
          .where(
            and(
              eq(accessMembershipMembers.snapshotId, fixture.snapshot.id),
              eq(accessMembershipMembers.userId, fixture.user.id),
            ),
          ),
        database
          .select({
            groupSourceId: accessMembershipMemberGroups.groupSourceId,
            groupSourceKind: accessMembershipMemberGroups.groupSourceKind,
            groupPurpose: accessMembershipMemberGroups.groupPurpose,
          })
          .from(accessMembershipMemberGroups)
          .where(
            and(
              eq(accessMembershipMemberGroups.snapshotId, fixture.snapshot.id),
              eq(accessMembershipMemberGroups.userId, fixture.user.id),
            ),
          ),
        database
          .select({
            integrationId: channelConfigurations.integrationId,
            enabled: channelConfigurations.enabled,
            statusLabel: channelConfigurations.statusLabel,
          })
          .from(channelConfigurations)
          .orderBy(asc(channelConfigurations.integrationId)),
        database
          .select({ id: rosterRecipients.id })
          .from(rosterRecipients)
          .where(
            eq(rosterRecipients.googleSubject, fixture.user.googleSubject),
          ),
      ]);

      return Object.freeze({
        activeAccessGroups,
        users: userRows,
        roles: roleRows,
        facilityScopes: facilityScopeRows,
        snapshots: snapshotRows,
        snapshotGroups: snapshotGroupRows,
        members: memberRows,
        memberGroups: memberGroupRows,
        channels: channelRows,
        matchingRosterRecipients: matchingRecipients.length,
      });
    },
  });
}

function sameRecord(
  value: Readonly<Record<string, unknown>> | undefined,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  if (value === undefined) return false;
  return Object.entries(expected).every(([key, expectedValue]) => {
    const received = value[key];
    if (expectedValue instanceof Date) {
      return (
        received instanceof Date &&
        received.getTime() === expectedValue.getTime()
      );
    }
    return received === expectedValue;
  });
}

/** Proves the just-published snapshot is safely inside the session TTL. */
export function assertAccessFixtureSnapshotCurrent(
  fixture: AccessFixture,
  checkedAt: Date,
): void {
  const checkedAtMilliseconds = checkedAt.getTime();
  const capturedAtMilliseconds = fixture.snapshot.capturedAt.getTime();
  const ageMilliseconds = checkedAtMilliseconds - capturedAtMilliseconds;
  if (
    Number.isNaN(checkedAtMilliseconds) ||
    Number.isNaN(capturedAtMilliseconds) ||
    ageMilliseconds < 0 ||
    ageMilliseconds > MAX_BOOTSTRAP_SNAPSHOT_AGE_MS
  ) {
    throw new Error('The access snapshot is not current.');
  }
}

/** Validates the exact fixture graph and zero enabled notification channels. */
export function assertAccessFixtureEvidence(
  fixture: AccessFixture,
  evidence: AccessFixtureEvidence,
): AccessFixtureSummary {
  const fixtureAccessGroups = evidence.activeAccessGroups.filter((group) =>
    sameRecord(group, { id: fixture.accessGroup.id }),
  );
  const fixtureStaffRoles = evidence.roles.filter((role) =>
    sameRecord(role, { role: 'staff' }),
  );
  if (
    fixtureAccessGroups.length !== 1 ||
    !sameRecord(fixtureAccessGroups[0], {
      id: fixture.accessGroup.id,
      kind: fixture.accessGroup.kind,
      purpose: fixture.accessGroup.purpose,
      active: true,
      googleGroupId: fixture.accessGroup.googleGroupId,
      email: fixture.accessGroup.email,
      fixtureKey: null,
    }) ||
    evidence.users.length !== 1 ||
    !sameRecord(evidence.users[0], fixture.user) ||
    fixtureStaffRoles.length !== 1 ||
    !sameRecord(fixtureStaffRoles[0], { role: 'staff' }) ||
    evidence.facilityScopes.length !== 0 ||
    evidence.snapshots.length !== 1 ||
    !sameRecord(evidence.snapshots[0], fixture.snapshot) ||
    evidence.snapshotGroups.length !== 2 ||
    !sameRecord(evidence.snapshotGroups[0], {
      groupSourceId: fixture.accessGroup.id,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
      completionKind: 'completed',
    }) ||
    !sameRecord(evidence.snapshotGroups[1], {
      groupSourceId: fixture.accessGroup.id,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
      completionKind: 'expected',
    }) ||
    evidence.members.length !== 1 ||
    !sameRecord(evidence.members[0], {
      snapshotId: fixture.snapshot.id,
      userId: fixture.user.id,
      googleSubject: fixture.user.googleSubject,
      facilityScopeKind: 'district',
    }) ||
    evidence.memberGroups.length !== 1 ||
    !sameRecord(evidence.memberGroups[0], {
      groupSourceId: fixture.accessGroup.id,
      groupSourceKind: 'google-group',
      groupPurpose: 'access',
    }) ||
    evidence.matchingRosterRecipients !== 0
  ) {
    throw new Error('The access fixture did not verify exactly.');
  }
  const expectedChannels = [
    ['aws-eum-sms', 'blocked'],
    ['expo-push', 'mocked'],
    ['ses-email', 'mocked'],
  ] as const;
  if (
    evidence.channels.length !== expectedChannels.length ||
    expectedChannels.some(
      ([integrationId, statusLabel], index) =>
        !sameRecord(evidence.channels[index], {
          integrationId,
          enabled: false,
          statusLabel,
        }),
    )
  ) {
    throw new Error('A notification channel was enabled or mislabelled.');
  }
  return Object.freeze({
    accessGroups: 1,
    users: 1,
    staffRoles: 1,
    accessSnapshots: 1,
    notificationChannelsEnabled: 0,
    matchingRosterRecipients: 0,
  });
}

/** Publishes or replays one exact snapshot, then proves freshness and shape. */
export async function seedAccessFixture(input: {
  readonly identity: AccessFixtureInput;
  readonly replay: AccessFixture | null;
  readonly store: AccessFixtureStore;
  readonly now?: () => Date;
}): Promise<SeededAccessFixture> {
  const fixture = await input.store.publish(input.identity, input.replay);
  assertAccessFixtureSnapshotCurrent(
    fixture,
    (input.now ?? (() => new Date()))(),
  );
  const summary = assertAccessFixtureEvidence(
    fixture,
    await input.store.readEvidence(fixture),
  );
  return Object.freeze({ fixture, summary });
}
