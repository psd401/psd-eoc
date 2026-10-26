import {
  PARTNER_AUDIENCE_MAX_RECIPIENTS,
  partnerAlertSettingsMatch,
  previewReachesPartners,
  type EventKind,
  type RosteredPopulation,
  type TemplateMode,
} from '@psd-eoc/contracts';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  activationPreviewPartners,
  eventTypes,
  eventTypeVersions,
  events,
  partnerAdmissionEndings,
  partnerAdmissions,
  threats,
} from '../../db/schema';
import { loadEffectivePartnerAlertSettings } from './alert-settings';

/** What decides whether, and whom, one activation preview alerts. */
export interface PartnerAudienceQuery {
  readonly kind: EventKind;
  readonly templateMode: TemplateMode;
  readonly rosterPopulation: RosteredPopulation;
  /** Read from the facility as it stands now, like staff isolation. */
  readonly facilityIsolated: boolean;
  readonly eventTypeVersionId: string;
  readonly threatId: string | null;
  /** The preview's own time: an admission expiring before it is not active. */
  readonly now: Date;
}

/** Thrown when the admitted partner list exceeds what one preview may pin. */
export class PartnerAudienceBoundError extends Error {
  public constructor() {
    super('The partner audience exceeds its supported bound.');
    this.name = 'PartnerAudienceBoundError';
  }
}

/**
 * The partners one activation would alert, resolved when the preview is
 * planned (#597): every admitted, unexpired, unended partner, when the event
 * is a live incident at a facility that is not isolated and the partner
 * alert settings in effect let its response and threat reach partners.
 * Anything else, including every drill and test, reaches nobody. Partners are
 * never facility-scoped: a partner admission covers every non-isolated site.
 *
 * Returns admission ids in a stable order. The caller pins them with the
 * preview, so what a human confirms is exactly this set.
 */
export async function resolvePartnerAudience(
  database: Pick<Database, 'select'>,
  query: PartnerAudienceQuery,
): Promise<readonly string[]> {
  if (!previewReachesPartners(query) || query.facilityIsolated) return [];
  const [response] = await database
    .select({ familyKey: eventTypes.familyKey })
    .from(eventTypeVersions)
    .innerJoin(eventTypes, eq(eventTypes.id, eventTypeVersions.eventTypeId))
    .where(eq(eventTypeVersions.id, query.eventTypeVersionId))
    .limit(1);
  if (response === undefined) return [];
  let threatKey: string | null = null;
  if (query.threatId !== null) {
    const [threat] = await database
      .select({ key: threats.key })
      .from(threats)
      .where(eq(threats.id, query.threatId))
      .limit(1);
    // A threat the catalog cannot name cannot be checked against the
    // exclusions, so it alerts nobody rather than slipping past them.
    if (threat === undefined) return [];
    threatKey = threat.key;
  }
  const settings = await loadEffectivePartnerAlertSettings(database);
  if (
    !partnerAlertSettingsMatch(settings, {
      responseFamilyKey: response.familyKey,
      threatKey,
    })
  ) {
    return [];
  }
  const rows = await database
    .select({ id: partnerAdmissions.id })
    .from(partnerAdmissions)
    .leftJoin(
      partnerAdmissionEndings,
      eq(partnerAdmissionEndings.partnerAdmissionId, partnerAdmissions.id),
    )
    .where(
      and(
        isNull(partnerAdmissionEndings.id),
        gt(partnerAdmissions.expiresAt, query.now),
      ),
    )
    .orderBy(asc(partnerAdmissions.id))
    .limit(PARTNER_AUDIENCE_MAX_RECIPIENTS + 1);
  if (rows.length > PARTNER_AUDIENCE_MAX_RECIPIENTS) {
    throw new PartnerAudienceBoundError();
  }
  return rows.map((row) => row.id);
}

/** Pins a preview's resolved partners beside it, in the same transaction. */
export async function recordActivationPreviewPartners(
  database: Pick<Database, 'insert'>,
  preview: Readonly<{
    id: string;
    kind: EventKind;
    templateMode: TemplateMode;
    rosterPopulation: RosteredPopulation;
  }>,
  partnerAdmissionIds: readonly string[],
  createdAt: Date,
): Promise<void> {
  if (partnerAdmissionIds.length === 0) return;
  await database.insert(activationPreviewPartners).values(
    partnerAdmissionIds.map((partnerAdmissionId) => ({
      activationPreviewId: preview.id,
      kind: preview.kind,
      templateMode: preview.templateMode,
      rosterPopulation: preview.rosterPopulation,
      partnerAdmissionId,
      createdAt,
    })),
  );
}

/**
 * The partners one event reaches: exactly the set its activation preview
 * resolved, for the activation and again for every all-clear and
 * reactivation. Read through the event's immutable activation authorization,
 * so nothing that changes later (settings, admissions, isolation) widens or
 * narrows it. An event that is not a live incident has none.
 */
export async function loadEventPartnerAudience(
  database: Pick<Database, 'select'>,
  eventId: string,
): Promise<readonly string[]> {
  const rows = await database
    .select({ id: activationPreviewPartners.partnerAdmissionId })
    .from(events)
    .innerJoin(
      activationPreviewPartners,
      eq(
        activationPreviewPartners.activationPreviewId,
        sql`(${events.activationAuthorization} ->> 'activationPreviewId')::uuid`,
      ),
    )
    .where(eq(events.id, eventId))
    .orderBy(asc(activationPreviewPartners.partnerAdmissionId));
  return rows.map((row) => row.id);
}
