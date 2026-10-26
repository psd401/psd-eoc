import {
  GOOGLE_IDENTITY_ISSUER,
  PartnerAdmissionSchema,
  partnerAdmissionStatus,
  type FacilityScope,
  type PartnerAdmission,
  type PartnerAdmissionEndingReason,
} from '@psd-eoc/contracts';
import { asc, desc, eq } from 'drizzle-orm';

import type { Database } from '../../db/client';
import {
  facilities,
  partnerAdmissionEndings,
  partnerAdmissions,
} from '../../db/schema';
import type { AccessDecision } from './trusted-group-access';

/** The minimal read surface shared by PostgreSQL and Aurora Data API. */
type PartnerAdmissionDatabase = Pick<Database, 'select'>;

export type PartnerAccessRefusal =
  | 'NO_PARTNER_ADMISSION'
  | 'PARTNER_ADMISSION_ENDED'
  | 'PARTNER_ADMISSION_EXPIRED';

export type PartnerAccessDecision =
  | Readonly<{ granted: true; admission: PartnerAdmission }>
  | Readonly<{
      granted: false;
      refusal: PartnerAccessRefusal;
      /** The latest admission for the address, when there has ever been one. */
      admission: PartnerAdmission | null;
    }>;

/** True when an identity comes from an issuer other than district Google. */
export function isPartnerIdentityIssuer(issuer: string): boolean {
  return issuer !== GOOGLE_IDENTITY_ISSUER;
}

const admissionColumns = {
  id: partnerAdmissions.id,
  email: partnerAdmissions.email,
  displayName: partnerAdmissions.displayName,
  agency: partnerAdmissions.agency,
  invitedByUserId: partnerAdmissions.invitedByUserId,
  admittedAt: partnerAdmissions.admittedAt,
  expiresAt: partnerAdmissions.expiresAt,
  supersedesAdmissionId: partnerAdmissions.supersedesAdmissionId,
  endingReason: partnerAdmissionEndings.reason,
  endedByUserId: partnerAdmissionEndings.endedByUserId,
  endedAt: partnerAdmissionEndings.endedAt,
} as const;

type AdmissionRow = Readonly<{
  id: string;
  email: string;
  displayName: string;
  agency: string;
  invitedByUserId: string;
  admittedAt: Date;
  expiresAt: Date;
  supersedesAdmissionId: string | null;
  endingReason: PartnerAdmissionEndingReason | null;
  endedByUserId: string | null;
  endedAt: Date | null;
}>;

/** Maps one joined admission row to its contract shape. */
export function partnerAdmissionFromRow(row: AdmissionRow): PartnerAdmission {
  return PartnerAdmissionSchema.parse({
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    agency: row.agency,
    invitedByUserId: row.invitedByUserId,
    admittedAt: row.admittedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    supersedesAdmissionId: row.supersedesAdmissionId,
    ending:
      row.endingReason === null || row.endedAt === null
        ? null
        : {
            reason: row.endingReason,
            endedByUserId: row.endedByUserId,
            endedAt: row.endedAt.toISOString(),
          },
  });
}

/** Every admission for one address, newest first, with how each ended. */
export async function loadPartnerAdmissionsForEmail(
  database: PartnerAdmissionDatabase,
  email: string,
): Promise<readonly PartnerAdmission[]> {
  const rows = await database
    .select(admissionColumns)
    .from(partnerAdmissions)
    .leftJoin(
      partnerAdmissionEndings,
      eq(partnerAdmissionEndings.partnerAdmissionId, partnerAdmissions.id),
    )
    .where(eq(partnerAdmissions.email, email.toLowerCase()))
    .orderBy(desc(partnerAdmissions.admittedAt), desc(partnerAdmissions.id));
  return Object.freeze(rows.map(partnerAdmissionFromRow));
}

/**
 * Decides whether one partner may use the app right now.
 *
 * This is the partner counterpart of `decideAccess`, asked on every session
 * read and rotation. It never consults Google groups, and a group can never
 * answer it: only an admission that has not ended and has not reached its
 * expiry admits a partner. An admission past its expiry is refused at once,
 * before the daily sweep records the ending.
 */
export async function decidePartnerAccess(
  database: PartnerAdmissionDatabase,
  input: Readonly<{ email: string; checkedAt: Date }>,
): Promise<PartnerAccessDecision> {
  const admissions = await loadPartnerAdmissionsForEmail(database, input.email);
  // At most one admission per address is unended (a commit-time database
  // check), so the unended one, if any, is the current one.
  const current = admissions.find((admission) => admission.ending === null);
  if (current === undefined) {
    const latest = admissions[0] ?? null;
    return Object.freeze({
      granted: false as const,
      refusal:
        latest === null
          ? ('NO_PARTNER_ADMISSION' as const)
          : ('PARTNER_ADMISSION_ENDED' as const),
      admission: latest,
    });
  }
  if (partnerAdmissionStatus(current, input.checkedAt) !== 'active') {
    return Object.freeze({
      granted: false as const,
      refusal: 'PARTNER_ADMISSION_EXPIRED' as const,
      admission: current,
    });
  }
  return Object.freeze({ granted: true as const, admission: current });
}

/**
 * Where a partner acts: the limit stored on their account (district-wide
 * unless an administrator narrowed it), less every isolated facility. An
 * isolated facility (the store reviewer's, for one) keeps its events to its
 * own building, so no outside responder sees or joins them. Read on every
 * session read, so a facility created or isolated later is followed at once.
 * Null when nothing is left, which admits no partner.
 */
export async function partnerFacilityScope(
  database: PartnerAdmissionDatabase,
  stored: FacilityScope,
): Promise<FacilityScope | null> {
  const rows = await database
    .select({ id: facilities.id })
    .from(facilities)
    .where(eq(facilities.isolated, false))
    .orderBy(asc(facilities.id));
  const allowed =
    stored.kind === 'district'
      ? rows.map((row) => row.id)
      : rows
          .map((row) => row.id)
          .filter((id) => stored.facilityIds.includes(id));
  return allowed.length === 0
    ? null
    : Object.freeze({
        kind: 'facilities' as const,
        facilityIds: Object.freeze(allowed),
      });
}

/**
 * Restates a partner decision in the shape session reads and rotations use
 * for a staff decision. A partner holds `partner` and nothing else, never
 * through a group, and acts at `partnerFacilityScope`, never at the limit
 * stored on the account row.
 */
export function partnerAccessAsAccessDecision(
  decision: PartnerAccessDecision,
  checkedAt: Date,
  facilityScope: FacilityScope | null,
):
  | Extract<AccessDecision, { granted: true }>
  | Readonly<{
      granted: false;
      refusal: PartnerAccessRefusal | 'NO_PARTNER_FACILITIES';
    }> {
  if (!decision.granted) {
    return Object.freeze({
      granted: false as const,
      refusal: decision.refusal,
    });
  }
  if (facilityScope === null) {
    return Object.freeze({
      granted: false as const,
      refusal: 'NO_PARTNER_FACILITIES' as const,
    });
  }
  return Object.freeze({
    granted: true as const,
    roles: Object.freeze(['partner'] as const),
    groupSourceIds: Object.freeze([]),
    admittedAccountId: null,
    facilityScope,
    // The admission was read in this request; it is as fresh as the read.
    capturedAt: checkedAt,
  });
}
