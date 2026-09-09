import {
  CreateGroupSourceInputSchema,
  TimestampSchema,
  type CreateGroupSourceInput,
  type CreateNeighborhoodVersionInput,
  type Facility,
} from '@psd-eoc/contracts';
export const CLOUD_IDENTITY_ORIGIN = 'https://cloudidentity.googleapis.com';
export const CLOUD_IDENTITY_SCOPE =
  'https://www.googleapis.com/auth/cloud-identity.groups.readonly';
export const MAX_FACILITY_INPUT_BYTES = 5_000_000;
export const MAX_ADC_FILE_BYTES = 64_000;
// A bounded 20,000-group inventory can repeat safe group references in the
// inventory, candidate, staleness, and unassigned sections. Keep draft reads
// and writes aligned at a limit that accommodates that worst-case shape.
export const MAX_DRAFT_FILE_BYTES = 128_000_000;
export const MAX_RESPONSE_BYTES = 8_000_000;
export const FILE_READ_CHUNK_BYTES = 64 * 1_024;
export const MAX_PAGES = 100;
export const MAX_GROUPS = 20_000;
export const MAX_FACILITIES = 1_000;
export const MAX_GROUPS_PER_PAGE = 500;
export const MAX_NEIGHBORHOOD_FACILITIES = 200;

export const NON_STAFF_MARKERS = new Set([
  'alumni',
  'booster',
  'boosters',
  'child',
  'children',
  'class',
  'classroom',
  'classrooms',
  'cohort',
  'cohorts',
  'families',
  'family',
  'grade',
  'grades',
  'guardian',
  'guardians',
  'kindergarten',
  'kinder',
  'kindy',
  'kid',
  'kids',
  'learner',
  'learners',
  'parent',
  'parents',
  'preschool',
  'preschools',
  'prek',
  'prekindergarten',
  'pta',
  'pto',
  'pupil',
  'pupils',
  'scholar',
  'scholars',
  'student',
  'students',
]);

// Common short grade labels need bounded/grammar-aware handling. Keeping them
// separate from NON_STAFF_MARKERS avoids treating short substrings such as
// `kg` as population evidence inside unrelated words.
export const SHORT_GRADE_POPULATION_MARKERS = new Set(['kdg', 'kg', 'tk']);

export const SPELLED_GRADE_CARDINALS = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
] as const;

export const SPELLED_GRADE_ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
] as const;

export const SPELLED_GRADE_ORDINAL_MARKERS = new Set(SPELLED_GRADE_ORDINALS);
export const EXPLICIT_NUMERIC_GRADE_RANGE_PATTERN = new RegExp(
  '(?:^|[^0-9])(?:p[\\s._-]*k|t[\\s._-]*k|k[\\s._-]*d[\\s._-]*g|k[\\s._-]*g|k|(?:1[0-2]|[1-9])(?:st|nd|rd|th)?)(?:[^\\p{L}\\p{N}]|and|to|through|thru)+(?:p[\\s._-]*k|t[\\s._-]*k|k[\\s._-]*d[\\s._-]*g|k[\\s._-]*g|k|(?:1[0-2]|[1-9])(?:st|nd|rd|th)?)(?![0-9])',
  'iu',
);

// These exact phrases are common operational identities, not grade scopes.
// Only the ordinal occurrence inside the complete adjacent/compact phrase is
// protected; any additional ordinal or population marker still fails closed.
export const OPERATIONAL_ORDINAL_SAFE_PHRASES = new Set([
  'eighthstreet',
  'eleventhhour',
  'fifthavenue',
  'firstaid',
  'firstresponse',
  'fourthfloor',
  'secondfloor',
  'secondshift',
  'thirdparty',
  'twelfthnight',
]);

// These audited operational terms contain `k` but do not identify a grade or
// student population. They are used only by exclusion parsing; an additional
// uncovered K (for example `bookkeeperkblue`) still fails closed.
export const OPERATIONAL_K_SAFE_WORDS = new Set([
  'backup',
  'bike',
  'bikes',
  'blackboard',
  'blackboards',
  'bookkeeper',
  'bookkeepers',
  'bookkeeping',
  'breakfast',
  'checkin',
  'clerk',
  'clerks',
  'desk',
  'desks',
  'forklift',
  'forklifts',
  'handbook',
  'helpdesk',
  'keycard',
  'keycards',
  'kindness',
  'kitchen',
  'kitchens',
  'lockdown',
  'makerspace',
  'marketing',
  'network',
  'networking',
  'networks',
  'parking',
  'risk',
  'risks',
  'skyward',
  'taskforce',
  'toolkit',
  'walkie',
  'walkies',
  'workday',
  'workforce',
  'workroom',
  'workrooms',
  'workshop',
  'workshops',
]);

export const POPULATION_DESCRIPTOR_MARKERS = new Set([
  'directory',
  'distribution',
  'mailing',
  'roster',
]);

export const STAFF_MARKERS = new Set(['employee', 'employees', 'staff']);

export const NARROW_ROLE_MARKERS = new Set([
  'admin',
  'admins',
  'administration',
  'administrative',
  'administrator',
  'administrators',
  'assistant',
  'certificated',
  'classified',
  'coach',
  'coaches',
  'committee',
  'counselor',
  'counselors',
  'custodial',
  'custodian',
  'custodians',
  'faculty',
  'itinerant',
  'itinerants',
  'janitor',
  'janitors',
  'leadership',
  'nurse',
  'nurses',
  'office',
  'para',
  'paraprofessional',
  'paraprofessionals',
  'paras',
  'paraeducator',
  'paraeducators',
  'principal',
  'principals',
  'secretaries',
  'secretary',
  'sub',
  'subs',
  'substitute',
  'substitutes',
  'teacher',
  'teachers',
]);

export const STALE_MARKERS = new Set([
  'archive',
  'archived',
  'closed',
  'deprecated',
  'inactive',
  'legacy',
  'obsolete',
  'old',
]);

export const FACILITY_GENERIC_MARKERS = new Set([
  'academy',
  'bldg',
  'building',
  'campus',
  'center',
  'centre',
  'district',
  'education',
  'educational',
  'elementary',
  'employee',
  'employees',
  'faculty',
  'high',
  'k12',
  'learning',
  'middle',
  'school',
  'staff',
  'teacher',
  'teachers',
  'the',
]);

// Organization-wide, department, and catch-all labels are never sufficient
// evidence for an automatic building mapping. A false negative is safe here:
// the draft remains available for explicit human review.
export const AGGREGATE_FACILITY_NAME_MARKERS = new Set([
  'all',
  'admin',
  'admins',
  'administration',
  'administrative',
  'bldgs',
  'buildings',
  'campuses',
  'campuswide',
  'central',
  'department',
  'departmental',
  'departments',
  'departmentwide',
  'dept',
  'depts',
  'dist',
  'district',
  'districts',
  'districtwide',
  'division',
  'divisions',
  'divisionwide',
  'enterprise',
  'facilities',
  'facility',
  'facilitywide',
  'global',
  'headquarters',
  'hq',
  'location',
  'locations',
  'locationwide',
  'network',
  'office',
  'offices',
  'officewide',
  'operation',
  'operations',
  'ops',
  'organisation',
  'organisations',
  'organisationwide',
  'organization',
  'organizations',
  'organizationwide',
  'other',
  'others',
  'people',
  'personnel',
  'schools',
  'schoolwide',
  'service',
  'services',
  'servicewide',
  'site',
  'sites',
  'sitewide',
  'system',
  'systems',
  'systemwide',
  'svcs',
  'user',
  'users',
  'workforce',
]);

export const DISQUALIFYING_AGGREGATE_FACILITY_NAME_MARKERS = new Set(
  [...AGGREGATE_FACILITY_NAME_MARKERS].filter((marker) => marker !== 'central'),
);

export const GENERIC_AUTOMATIC_FACILITY_CODE_ALIASES = new Set([
  'adm',
  'dis',
  'ops',
  'oth',
]);

export const WEAK_NEIGHBORHOOD_STEMS = new Set([
  'central',
  'east',
  'north',
  'south',
  'west',
]);

// Automatic building proposals require an explicit physical school/site type,
// not merely a distinctive organizational function such as Human Resources.
// Facilities outside this conservative grammar remain available for a human
// mapping decision in the draft.
export const AUTOMATIC_PHYSICAL_SITE_TYPE_MARKERS = new Set([
  'academy',
  'bldg',
  'building',
  'campus',
  'center',
  'centre',
  'elementary',
  'high',
  'middle',
  'school',
]);

export type JsonObject = Record<string, unknown>;
export interface GroupsInventoryConfiguration {
  readonly hostedDomain: string;
  readonly academicTimeZone: string;
  readonly organizationPrefixes: readonly string[];
}
/**
 * A building source the inventory proposes from a group Google already holds,
 * so its Google Group ID is always known. A source registered in the
 * application before Google holds its group is "waiting" and carries no ID;
 * the inventory never proposes one of those.
 */
export type GoogleBuildingGroupSource = Extract<
  CreateGroupSourceInput,
  { readonly kind: 'google-group'; readonly purpose: 'building' }
> &
  Readonly<{ googleGroupId: string }>;
export type ReviewDecision =
  | 'pending'
  | 'confirmed'
  | 'rejected'
  | 'intentionally-unmapped';
export type MatchOutcome = 'strong-candidate' | 'uncertain' | 'missing';

export interface CloudGroup {
  readonly googleGroupId: string;
  readonly email: string;
  readonly displayName: string | null;
}

export interface DraftGroupRef {
  readonly googleGroupId: string;
  readonly email: string;
  readonly displayName: string | null;
}

export interface MatchCandidate extends DraftGroupRef {
  readonly heuristicScore: number;
  readonly reasonCodes: readonly string[];
}

export interface BuildingMapping {
  readonly facility: Facility;
  createGroupSource: GoogleBuildingGroupSource | null;
  reviewDecision: ReviewDecision;
  reviewNote: string | null;
  assessment: {
    outcome: MatchOutcome;
    bestHeuristicScore: number;
    reasonCodes: string[];
    readonly candidates: readonly MatchCandidate[];
  };
}

export interface NeighborhoodProposal {
  readonly createNeighborhoodVersion: CreateNeighborhoodVersionInput;
  readonly generatedHint: {
    readonly createNeighborhoodVersion: CreateNeighborhoodVersionInput;
    readonly heuristicStrength: 'low';
    readonly reasonCodes: readonly string[];
  } | null;
  reviewDecision: ReviewDecision;
  reviewNote: string | null;
}

export interface SkippedNeighborhoodHint {
  readonly facilityIds: readonly string[];
  readonly reasonCodes: readonly string[];
}

export interface PotentiallyStaleGroup extends DraftGroupRef {
  readonly reasonCodes: readonly string[];
}

export interface MappingDraft {
  readonly schemaVersion: 1;
  readonly kind: 'psd-eoc.google-groups-mapping-draft';
  readonly status: 'human-review-required';
  readonly importAuthorized: false;
  readonly generatedAt: string;
  readonly source: {
    readonly api: 'cloud-identity-v1';
    readonly paginationComplete: true;
    readonly authorizationCoverage: 'not-verified';
    readonly readOnly: true;
    readonly membershipDataFetched: false;
    readonly staffPopulationVerified: false;
    readonly facilityCount: number;
    readonly groupCount: number;
    readonly eligibleGroupCount: number;
    readonly pageCount: number;
  };
  readonly inventoryGroups: readonly DraftGroupRef[];
  readonly buildingMappings: readonly BuildingMapping[];
  readonly neighborhoodProposals: readonly NeighborhoodProposal[];
  readonly report: {
    readonly ambiguousStaffScopeGroups: readonly DraftGroupRef[];
    readonly missingFacilityIds: readonly string[];
    readonly uncertainFacilityIds: readonly string[];
    readonly potentiallyStaleGroups: readonly PotentiallyStaleGroup[];
    readonly restrictedRoleGroups: readonly DraftGroupRef[];
    readonly skippedNeighborhoodHints: readonly SkippedNeighborhoodHint[];
    readonly duplicateGroupProposals: readonly {
      readonly group: DraftGroupRef;
      readonly facilityIds: readonly string[];
    }[];
    readonly unassignedBuildingLikeGroups: readonly DraftGroupRef[];
    readonly omittedUnverifiedGroupIdentityCount: number;
    readonly warnings: readonly string[];
  };
}

export interface ValidationSummary {
  readonly structuralValidationPassed: true;
  readonly canonicalSourcesReverified: false;
  readonly importAuthorized: false;
  readonly allReviewFieldsStructurallyResolved: boolean;
  readonly mappingCount: number;
  readonly confirmedMappingCount: number;
  readonly pendingMappingCount: number;
  readonly neighborhoodCount: number;
  readonly confirmedNeighborhoodCount: number;
  readonly pendingNeighborhoodCount: number;
  readonly unresolvedFindingCount: number;
}

export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const requireString = (
  value: unknown,
  label: string,
  maximumLength: number,
): string => {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw new Error(`${label} must be a non-empty bounded string.`);
  }
  return value.trim();
};

export const requireAbsoluteTimestamp = (
  value: unknown,
  label: string,
): string => {
  const parsed = TimestampSchema.safeParse(requireString(value, label, 64));
  if (!parsed.success) {
    throw new Error(`${label} must be an absolute timestamp.`);
  }
  return parsed.data;
};

export const isHostedGroupEmail = (
  value: string,
  hostedDomain: string,
): boolean => {
  const separator = value.lastIndexOf('@');
  const localPart = value.slice(0, separator);
  return (
    separator > 0 &&
    value.slice(separator + 1) === hostedDomain &&
    localPart.length <= 64 &&
    /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(localPart) &&
    CreateGroupSourceInputSchema.safeParse({
      active: true,
      displayName: 'Synthetic contract email probe',
      email: value,
      facilityId: '00000000-0000-4000-8000-000000000001',
      googleGroupId: 'groups/synthetic-contract-email-probe',
      kind: 'google-group',
      purpose: 'building',
    }).success
  );
};

export const hasUnsafeDisplayControl = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      /\p{Cf}/u.test(character)
    );
  });

export const compareText = (left: string, right: string): number =>
  left.localeCompare(right, 'en-US');

export const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareText);

export const normalizeText = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/&/gu, ' and ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
