import {
  DEFAULT_PARTNER_ALERT_SETTINGS,
  PartnerAlertSettingsSchema,
  PartnerAlertSettingsStateSchema,
  PartnerAlertSettingsVersionSchema,
  type PartnerAlertSettings,
  type PartnerAlertSettingsState,
  type PartnerAlertSettingsVersion,
  type SetPartnerAlertSettingsInput,
} from '@psd-eoc/contracts';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  eventTypes,
  eventTypeVersions,
  partnerAlertSettings,
  threats,
} from '../../db/schema';
import { PartnerAccessError, type PartnerDatabase } from './access';

type SettingsRow = typeof partnerAlertSettings.$inferSelect;

function versionFromRow(row: SettingsRow): PartnerAlertSettingsVersion {
  return PartnerAlertSettingsVersionSchema.parse({
    id: row.id,
    version: row.version,
    responseFamilyKeys: row.responseFamilyKeys,
    excludedThreatKeys: row.excludedThreatKeys,
    supersedesVersionId: row.supersedesVersionId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  });
}

function settingsOf(
  version: PartnerAlertSettingsVersion | null,
): PartnerAlertSettings {
  return version === null
    ? DEFAULT_PARTNER_ALERT_SETTINGS
    : PartnerAlertSettingsSchema.parse({
        responseFamilyKeys: version.responseFamilyKeys,
        excludedThreatKeys: version.excludedThreatKeys,
      });
}

/** The highest saved version, or null when no administrator has saved one. */
export async function loadCurrentPartnerAlertSettingsVersion(
  database: Pick<Database, 'select'>,
): Promise<PartnerAlertSettingsVersion | null> {
  const [row] = await database
    .select()
    .from(partnerAlertSettings)
    .orderBy(desc(partnerAlertSettings.version))
    .limit(1);
  return row === undefined ? null : versionFromRow(row);
}

/** One saved version by id, for an idempotent replay. */
export async function loadPartnerAlertSettingsVersion(
  database: Pick<Database, 'select'>,
  id: string,
): Promise<PartnerAlertSettingsVersion | null> {
  const [row] = await database
    .select()
    .from(partnerAlertSettings)
    .where(eq(partnerAlertSettings.id, id))
    .limit(1);
  return row === undefined ? null : versionFromRow(row);
}

/**
 * The settings in effect: the current version's, or the defaults when none
 * has been saved. This is what partner audience planning reads.
 */
export async function loadEffectivePartnerAlertSettings(
  database: Pick<Database, 'select'>,
): Promise<PartnerAlertSettings> {
  return settingsOf(await loadCurrentPartnerAlertSettingsVersion(database));
}

/**
 * Each response family with a published real version, named by its latest
 * real version, in the order operators choose responses.
 */
async function responseOptions(database: Pick<Database, 'selectDistinctOn'>) {
  const rows = await database
    .selectDistinctOn([eventTypes.familyKey], {
      familyKey: eventTypes.familyKey,
      name: eventTypeVersions.name,
      displayOrder: eventTypes.displayOrder,
    })
    .from(eventTypes)
    .innerJoin(
      eventTypeVersions,
      eq(eventTypeVersions.eventTypeId, eventTypes.id),
    )
    .where(eq(eventTypes.templateMode, 'real'))
    .orderBy(eventTypes.familyKey, desc(eventTypeVersions.version));
  return [...rows]
    .sort(
      (left, right) =>
        left.displayOrder - right.displayOrder ||
        left.familyKey.localeCompare(right.familyKey),
    )
    .map(({ familyKey, name }) => ({ familyKey, name }));
}

async function threatOptions(database: Pick<Database, 'select'>) {
  return database
    .select({ key: threats.key, name: threats.name, active: threats.active })
    .from(threats)
    .orderBy(asc(threats.sortOrder), asc(threats.key));
}

/** Everything the settings page shows, read in one place. */
export async function loadPartnerAlertSettingsState(
  database: Pick<Database, 'select' | 'selectDistinctOn'>,
): Promise<PartnerAlertSettingsState> {
  const current = await loadCurrentPartnerAlertSettingsVersion(database);
  return PartnerAlertSettingsStateSchema.parse({
    current,
    effective: settingsOf(current),
    responseOptions: await responseOptions(database),
    threatOptions: await threatOptions(database),
  });
}

/**
 * Saves a new version on top of `input.baseVersionId`. Refuses a save based
 * on a version that is no longer current, and any response family or threat
 * key this deployment does not have. Lists are stored sorted so equal
 * settings always read back the same way.
 */
export async function savePartnerAlertSettings(
  database: PartnerDatabase & Pick<Database, 'selectDistinctOn'>,
  input: SetPartnerAlertSettingsInput,
  createdByUserId: string,
  now: Date,
): Promise<PartnerAlertSettingsVersion> {
  // One writer at a time, taken before the current version is read, so two
  // saves from the same base cannot both pass the base check.
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('partner-alert-settings', 0))`,
  );
  const current = await loadCurrentPartnerAlertSettingsVersion(database);
  if ((current?.id ?? null) !== input.baseVersionId) {
    throw new PartnerAccessError(
      'CONFLICT',
      'Partner alert settings were changed by someone else. Reload the page and make your change again.',
    );
  }
  const responseFamilyKeys = [...input.responseFamilyKeys].sort();
  const excludedThreatKeys = [...input.excludedThreatKeys].sort();
  if (responseFamilyKeys.length > 0) {
    const known = await database
      .selectDistinctOn([eventTypes.familyKey], {
        familyKey: eventTypes.familyKey,
      })
      .from(eventTypes)
      .where(inArray(eventTypes.familyKey, responseFamilyKeys));
    if (known.length !== responseFamilyKeys.length) {
      throw new PartnerAccessError(
        'VALIDATION_ERROR',
        'A chosen response does not exist.',
      );
    }
  }
  if (excludedThreatKeys.length > 0) {
    const known = await database
      .select({ key: threats.key })
      .from(threats)
      .where(inArray(threats.key, excludedThreatKeys));
    if (known.length !== excludedThreatKeys.length) {
      throw new PartnerAccessError(
        'VALIDATION_ERROR',
        'An excluded threat does not exist.',
      );
    }
  }
  const [row] = await database
    .insert(partnerAlertSettings)
    .values({
      version: (current?.version ?? 0) + 1,
      responseFamilyKeys,
      excludedThreatKeys,
      supersedesVersionId: current?.id ?? null,
      createdByUserId,
      createdAt: now,
    })
    .returning();
  if (row === undefined) {
    throw new PartnerAccessError(
      'CONFLICT',
      'The partner alert settings could not be saved.',
    );
  }
  return versionFromRow(row);
}
