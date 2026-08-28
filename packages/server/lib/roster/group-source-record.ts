import { GroupSourceSchema, type GroupSource } from '@psd-eoc/contracts';

/**
 * The columns of one `group_sources` row, whatever query produced it.
 *
 * Timestamps are permitted as strings because the Data API driver returns them
 * that way while the PostgreSQL driver returns `Date`.
 */
export interface GroupSourceRowFields {
  readonly id: string;
  readonly kind: 'google-group' | 'manual' | 'synthetic';
  readonly purpose: 'access' | 'building' | 'others';
  readonly facilityId: string | null;
  readonly displayName: string;
  readonly active: boolean;
  readonly grantedRole: 'staff' | 'admin' | null;
  readonly membersCapturedAt: Date | string | null;
  readonly googleGroupId: string | null;
  readonly email: string | null;
  readonly fixtureKey: string | null;
  readonly createdAt: Date | string;
}

function dateIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Builds the record for one configured group source.
 *
 * Each kind carries a different provider identity, and the schema requires the
 * other kinds' fields to be present and null rather than absent, so that one
 * kind can never be read back as another.
 *
 * This existed as two copies, in the administration capabilities and in the
 * roster synchronisation store, and both branched only on `google-group`. A
 * manual row therefore took the synthetic shape, left `googleGroupId` and
 * `email` undefined, and failed to parse: every manual source inserted and
 * then failed on the way back out. One copy, and a `switch` the compiler can
 * check for exhaustiveness, is what keeps the kinds in step from here.
 *
 * `effectiveActive` lets a caller present a source's configured state rather
 * than its stored flag; it defaults to the stored value.
 */
export function groupSourceRecordFromRow(
  row: GroupSourceRowFields,
  effectiveActive: boolean = row.active,
): GroupSource {
  const common = {
    id: row.id,
    kind: row.kind,
    purpose: row.purpose,
    facilityId: row.facilityId,
    displayName: row.displayName,
    active: effectiveActive,
    // Access sources carry the role they grant; roster purposes never do. The
    // schema rejects either one appearing on the wrong purpose, so a row that
    // drifted from the database check constraint fails here loudly rather than
    // presenting a group whose authority is unclear.
    grantedRole: row.grantedRole,
    membersCapturedAt:
      row.membersCapturedAt === null ? null : dateIso(row.membersCapturedAt),
    createdAt: dateIso(row.createdAt),
  };
  switch (row.kind) {
    case 'google-group':
      return GroupSourceSchema.parse({
        ...common,
        googleGroupId: row.googleGroupId,
        email: row.email,
      });
    case 'manual':
      return GroupSourceSchema.parse({
        ...common,
        googleGroupId: null,
        email: null,
        fixtureKey: null,
      });
    case 'synthetic':
      return GroupSourceSchema.parse({ ...common, fixtureKey: row.fixtureKey });
  }
}
