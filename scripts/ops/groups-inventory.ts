import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { exit as exitProcess } from 'node:process';

import {
  CreateGroupSourceInputSchema,
  CreateNeighborhoodVersionInputSchema,
  FacilityPageSchema,
  FacilitySchema,
  TimestampSchema,
  type CreateGroupSourceInput,
  type CreateNeighborhoodVersionInput,
  type Facility,
} from '@psd-eoc/contracts';

export const CLOUD_IDENTITY_ORIGIN = 'https://cloudidentity.googleapis.com';
export const CLOUD_IDENTITY_SCOPE =
  'https://www.googleapis.com/auth/cloud-identity.groups.readonly';
const PSD_HOSTED_DOMAIN = 'psd401.net';
export const SYNTHETIC_TEST_GROUP_DOMAIN = 'groups.synthetic.invalid';
export const MAX_FACILITY_INPUT_BYTES = 5_000_000;
const MAX_ADC_FILE_BYTES = 64_000;
// A bounded 20,000-group inventory can repeat safe group references in the
// inventory, candidate, staleness, and unassigned sections. Keep draft reads
// and writes aligned at a limit that accommodates that worst-case shape.
export const MAX_DRAFT_FILE_BYTES = 128_000_000;
export const MAX_RESPONSE_BYTES = 8_000_000;
const FILE_READ_CHUNK_BYTES = 64 * 1_024;
const MAX_PAGES = 100;
export const MAX_GROUPS = 20_000;
export const MAX_FACILITIES = 1_000;
export const MAX_GROUPS_PER_PAGE = 500;
export const MAX_NEIGHBORHOOD_FACILITIES = 200;

const NON_STAFF_MARKERS = new Set([
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
const EXPLICIT_NUMERIC_GRADE_RANGE_PATTERN = new RegExp(
  '(?:^|[^0-9])(?:p[\\s._-]*k|t[\\s._-]*k|k[\\s._-]*d[\\s._-]*g|k[\\s._-]*g|k|(?:1[0-2]|[1-9])(?:st|nd|rd|th)?)(?:[^\\p{L}\\p{N}]|and|to|through|thru)+(?:p[\\s._-]*k|t[\\s._-]*k|k[\\s._-]*d[\\s._-]*g|k[\\s._-]*g|k|(?:1[0-2]|[1-9])(?:st|nd|rd|th)?)(?![0-9])',
  'iu',
);

// These exact phrases are common operational identities, not grade scopes.
// Only the ordinal occurrence inside the complete adjacent/compact phrase is
// protected; any additional ordinal or population marker still fails closed.
const OPERATIONAL_ORDINAL_SAFE_PHRASES = new Set([
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

const POPULATION_DESCRIPTOR_MARKERS = new Set([
  'directory',
  'distribution',
  'mailing',
  'roster',
]);

const STAFF_MARKERS = new Set(['employee', 'employees', 'staff']);

const NARROW_ROLE_MARKERS = new Set([
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

const STALE_MARKERS = new Set([
  'archive',
  'archived',
  'closed',
  'deprecated',
  'inactive',
  'legacy',
  'obsolete',
  'old',
]);

const FACILITY_GENERIC_MARKERS = new Set([
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
  'psd',
  'school',
  'staff',
  'teacher',
  'teachers',
  'the',
]);

// Organization-wide, department, and catch-all labels are never sufficient
// evidence for an automatic building mapping. A false negative is safe here:
// the draft remains available for explicit human review.
const AGGREGATE_FACILITY_NAME_MARKERS = new Set([
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

const DISQUALIFYING_AGGREGATE_FACILITY_NAME_MARKERS = new Set(
  [...AGGREGATE_FACILITY_NAME_MARKERS].filter((marker) => marker !== 'central'),
);

const GENERIC_AUTOMATIC_FACILITY_CODE_ALIASES = new Set([
  'adm',
  'dis',
  'ops',
  'oth',
]);

const WEAK_NEIGHBORHOOD_STEMS = new Set([
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
const AUTOMATIC_PHYSICAL_SITE_TYPE_MARKERS = new Set([
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
type GoogleBuildingGroupSource = Extract<
  CreateGroupSourceInput,
  { readonly kind: 'google-group'; readonly purpose: 'building' }
>;
type ReviewDecision =
  | 'pending'
  | 'confirmed'
  | 'rejected'
  | 'intentionally-unmapped';
type MatchOutcome = 'strong-candidate' | 'uncertain' | 'missing';

export interface CloudGroup {
  readonly googleGroupId: string;
  readonly email: string;
  readonly displayName: string | null;
}

interface GroupPage {
  readonly groups: readonly CloudGroup[];
  readonly nextPageToken: string | null;
}

interface InventoryResult {
  readonly groups: readonly CloudGroup[];
  readonly pageCount: number;
}

export interface DraftGroupRef {
  readonly googleGroupId: string;
  readonly email: string;
  readonly displayName: string | null;
}

interface MatchCandidate extends DraftGroupRef {
  readonly heuristicScore: number;
  readonly reasonCodes: readonly string[];
}

interface BuildingMapping {
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

interface SkippedNeighborhoodHint {
  readonly facilityIds: readonly string[];
  readonly reasonCodes: readonly string[];
}

interface PotentiallyStaleGroup extends DraftGroupRef {
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

interface InventoryCli {
  readonly command: 'inventory';
  readonly customerId: string;
  readonly facilitiesPath: string;
  readonly outputPath?: string;
  readonly quotaProject: string;
  readonly serviceAccount: string;
}

interface ValidateCli {
  readonly command: 'validate';
  readonly draftPath: string;
}

type CliOptions = InventoryCli | ValidateCli;
type PageFetcher = (pageToken: string | null) => Promise<unknown>;
type HttpFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireString = (
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

const requireAbsoluteTimestamp = (value: unknown, label: string): string => {
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

const hasUnsafeDisplayControl = (value: string): boolean =>
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

const sortedUnique = (values: readonly string[]): string[] =>
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

export const hasUnsupportedIdentityContent = (value: string): boolean => {
  if ([...value].some((character) => /\p{M}/u.test(character))) return true;
  const withoutDecomposedDiacritics = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '');
  return [...withoutDecomposedDiacritics].some(
    (character) =>
      (character.codePointAt(0) ?? 0) > 0x7f &&
      /[\p{L}\p{M}\p{N}\p{S}\p{C}]/u.test(character),
  );
};

const tokensOf = (value: string): readonly string[] => {
  const normalized = normalizeText(value);
  return normalized === '' ? [] : normalized.split(' ');
};

const hasAnyToken = (
  tokens: readonly string[],
  choices: ReadonlySet<string>,
): boolean => tokens.some((token) => choices.has(token));

const COMPACT_NON_STAFF_MARKERS = [...NON_STAFF_MARKERS];

const COMPACT_WORD_BOUNDARIES = [
  'all',
  'and',
  'directory',
  'distribution',
  'employee',
  'employees',
  'group',
  'groups',
  'list',
  'lists',
  'mailing',
  'member',
  'members',
  'of',
  'or',
  'roster',
  'staff',
  'team',
  'teams',
  'through',
  'to',
] as const;

const COMPACT_ORGANIZATION_PREFIXES = ['district', 'psd', 'psd401'] as const;
const COMPACT_POPULATION_NEUTRAL_ROLE_MARKERS = [...NARROW_ROLE_MARKERS].filter(
  (marker) => marker !== 'sub',
);
const COMPACT_NEUTRAL_MARKERS = [
  ...COMPACT_WORD_BOUNDARIES,
  ...FACILITY_GENERIC_MARKERS,
  ...COMPACT_POPULATION_NEUTRAL_ROLE_MARKERS,
  ...STALE_MARKERS,
] as const;

const compactMarkerCandidates = (
  token: string,
  compactPrefixes: ReadonlySet<string>,
): readonly string[] => {
  const removablePrefixes = new Set([
    ...compactPrefixes,
    ...COMPACT_NEUTRAL_MARKERS,
  ]);
  const candidates = new Set([token]);
  const reachableOffsets = [0];
  for (let index = 0; index < reachableOffsets.length; index += 1) {
    const offset = reachableOffsets[index]!;
    for (const prefix of removablePrefixes) {
      if (prefix !== '' && token.startsWith(prefix, offset)) {
        const nextOffset = offset + prefix.length;
        if (!reachableOffsets.includes(nextOffset)) {
          reachableOffsets.push(nextOffset);
          candidates.add(token.slice(nextOffset));
        }
      }
    }
  }
  return [...candidates];
};

const COMPACT_NUMBERED_POPULATION_PATTERN =
  /^(?:(?:class|classroom|cohort|grade)[0-9]{1,2}(?![0-9])|[0-9]{1,2}(?:st|nd|rd|th)?grade|(?:[1-9]|1[0-2])(?:st|nd|rd|th)|gradek|kgrade|k[0-9]{1,2}(?![0-9]))/u;
const COMPACT_NEUTRAL_NUMBER_PATTERN = /^[0-9]{1,4}(?![0-9])/u;

const isCompactPopulationToken = (
  token: string,
  compactPrefixes: ReadonlySet<string>,
): boolean => {
  const neutralMarkers = new Set([
    ...COMPACT_NEUTRAL_MARKERS,
    ...compactPrefixes,
  ]);
  const withoutPopulation = new Set([0]);
  const withPopulation = new Set<number>();
  for (let offset = 0; offset < token.length; offset += 1) {
    const neutralReachable = withoutPopulation.has(offset);
    const populationReachable = withPopulation.has(offset);
    if (!neutralReachable && !populationReachable) continue;
    for (const boundary of neutralMarkers) {
      if (token.startsWith(boundary, offset)) {
        const nextOffset = offset + boundary.length;
        if (neutralReachable) withoutPopulation.add(nextOffset);
        if (populationReachable) withPopulation.add(nextOffset);
      }
    }
    const neutralNumber = COMPACT_NEUTRAL_NUMBER_PATTERN.exec(
      token.slice(offset),
    );
    if (neutralNumber !== null) {
      const nextOffset = offset + neutralNumber[0].length;
      if (neutralReachable) withoutPopulation.add(nextOffset);
      if (populationReachable) withPopulation.add(nextOffset);
    }
    for (const marker of [
      ...COMPACT_NON_STAFF_MARKERS,
      ...SHORT_GRADE_POPULATION_MARKERS,
      'k',
      'pk',
    ]) {
      if (token.startsWith(marker, offset)) {
        withPopulation.add(offset + marker.length);
      }
    }
    const numbered = COMPACT_NUMBERED_POPULATION_PATTERN.exec(
      token.slice(offset),
    );
    if (numbered !== null) {
      withPopulation.add(offset + numbered[0].length);
    }
  }
  return withPopulation.has(token.length);
};

const isCompactNamedMarkerToken = (
  token: string,
  compactPrefixes: ReadonlySet<string>,
  targetMarkers: ReadonlySet<string>,
  additionalNeutralMarkers: ReadonlySet<string>,
): boolean => {
  const neutralMarkers = new Set([
    ...COMPACT_WORD_BOUNDARIES,
    ...FACILITY_GENERIC_MARKERS,
    ...additionalNeutralMarkers,
    ...compactPrefixes,
  ]);
  const withoutTarget = new Set([0]);
  const withTarget = new Set<number>();
  for (let offset = 0; offset < token.length; offset += 1) {
    const neutralReachable = withoutTarget.has(offset);
    const targetReachable = withTarget.has(offset);
    if (!neutralReachable && !targetReachable) continue;
    for (const marker of neutralMarkers) {
      if (token.startsWith(marker, offset)) {
        const nextOffset = offset + marker.length;
        if (neutralReachable) withoutTarget.add(nextOffset);
        if (targetReachable) withTarget.add(nextOffset);
      }
    }
    const neutralNumber = COMPACT_NEUTRAL_NUMBER_PATTERN.exec(
      token.slice(offset),
    );
    if (neutralNumber !== null) {
      const nextOffset = offset + neutralNumber[0].length;
      if (neutralReachable) withoutTarget.add(nextOffset);
      if (targetReachable) withTarget.add(nextOffset);
    }
    for (const marker of targetMarkers) {
      if (token.startsWith(marker, offset)) {
        withTarget.add(offset + marker.length);
      }
    }
  }
  return withTarget.has(token.length);
};

const hasNonStaffPopulationMarker = (
  tokens: readonly string[],
  compactPrefixes: ReadonlySet<string>,
): boolean => {
  const candidatesByToken = tokens.map((token) =>
    compactMarkerCandidates(token, compactPrefixes),
  );
  return (
    candidatesByToken.some((candidates) =>
      candidates.some((candidate) =>
        isCompactPopulationToken(candidate, compactPrefixes),
      ),
    ) ||
    candidatesByToken.some((candidates, index) => {
      const nextCandidates = candidatesByToken[index + 1] ?? [];
      return candidates.some(
        (token) =>
          (token === 'pre' &&
            nextCandidates.some(
              (next) => next === 'k' || next === 'kindergarten',
            )) ||
          (token === 'k' &&
            nextCandidates.some(
              (next) => next === 'grade' || /^[0-9]{1,2}$/u.test(next),
            )) ||
          ((token === 'grade' || token === 'class' || token === 'cohort') &&
            nextCandidates.some(
              (next) => next === 'k' || /^[0-9]{1,2}$/u.test(next),
            )) ||
          (/^[0-9]{1,2}$/u.test(token) && nextCandidates.includes('grade')),
      );
    })
  );
};

const containsSequence = (
  haystack: readonly string[],
  needle: readonly string[],
): boolean => {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) {
      return true;
    }
  }
  return false;
};

const facilityStemTokens = (facility: Facility): readonly string[] =>
  tokensOf(facility.name).filter(
    (token) => !FACILITY_GENERIC_MARKERS.has(token),
  );

export const groupTokenFields = (
  group: CloudGroup,
): {
  readonly combined: readonly string[];
  readonly displayName: readonly string[];
  readonly localPart: readonly string[];
} => {
  const localPart = group.email.slice(0, group.email.lastIndexOf('@'));
  const displayNameTokens = tokensOf(group.displayName ?? '');
  const localPartTokens = tokensOf(localPart);
  return {
    combined: [...displayNameTokens, ...localPartTokens],
    displayName: displayNameTokens,
    localPart: localPartTokens,
  };
};

const hasDistinctiveStem = (tokens: readonly string[]): boolean =>
  tokens.length >= 2 ||
  (tokens.length === 1 &&
    (tokens[0]?.length ?? 0) >= 6 &&
    !WEAK_NEIGHBORHOOD_STEMS.has(tokens[0] ?? ''));

interface CompactFacilityPrefixContext {
  readonly aliases: ReadonlySet<string>;
  readonly automaticAliases: ReadonlySet<string>;
  readonly automaticEvidenceTokenSequences: readonly (readonly string[])[];
  readonly evidenceTokenSequences: readonly (readonly string[])[];
  readonly facility: Facility;
  readonly identityBit: bigint;
}

export const MAX_FACILITY_CONTEXTS_PER_IDENTITY_FIELD = 64;

interface FacilityAliasIndexEntry {
  readonly contexts: readonly CompactFacilityPrefixContext[];
  readonly facilityBits: bigint;
  readonly hasInactiveContext: boolean;
  readonly overflow: boolean;
}

interface AutomaticBoundaryEvidenceIndexEntry {
  readonly alias: string;
  readonly facilityBits: bigint;
}

interface MarkerTrieNode {
  readonly children: Map<string, MarkerTrieNode>;
  terminal: boolean;
}

interface CompactPopulationPrefixContext {
  readonly approvedKAtomTrie: MarkerTrieNode;
  readonly automaticAliasIndex: ReadonlyMap<string, FacilityAliasIndexEntry>;
  readonly automaticAliasLengths: readonly number[];
  readonly automaticBoundaryEvidenceIndex: ReadonlyMap<
    string,
    AutomaticBoundaryEvidenceIndexEntry
  >;
  readonly distinctiveAliasIndex: ReadonlyMap<string, FacilityAliasIndexEntry>;
  readonly distinctiveAliasLengths: readonly number[];
  readonly evidenceSequenceIndex: ReadonlyMap<string, FacilityAliasIndexEntry>;
  readonly exactAliasIndex: ReadonlyMap<string, FacilityAliasIndexEntry>;
  readonly facilities: readonly CompactFacilityPrefixContext[];
  readonly facilityAliasTrie: MarkerTrieNode;
  readonly global: ReadonlySet<string>;
  readonly maximumAutomaticEvidenceTokenCount: number;
  readonly maximumEvidenceTokenCount: number;
  readonly populationNeutralTrie: MarkerTrieNode;
  readonly derivationMetrics?: DraftDerivationMetrics;
}

type PopulationGroupClassification = 'ambiguous' | 'definite' | 'none';

const buildMarkerTrie = (markers: Iterable<string>): MarkerTrieNode => {
  const root: MarkerTrieNode = { children: new Map(), terminal: false };
  for (const marker of markers) {
    if (marker === '') continue;
    let node = root;
    for (const character of marker) {
      let child = node.children.get(character);
      if (child === undefined) {
        child = { children: new Map(), terminal: false };
        node.children.set(character, child);
      }
      node = child;
    }
    node.terminal = true;
  }
  return root;
};

const markerEndOffsets = (
  trie: MarkerTrieNode,
  value: string,
  offset: number,
): readonly number[] => {
  const ends: number[] = [];
  let node = trie;
  for (let index = offset; index < value.length; index += 1) {
    const child = node.children.get(value[index]!);
    if (child === undefined) break;
    node = child;
    if (node.terminal) ends.push(index + 1);
  }
  return ends;
};

const indexFacilityAliases = (
  facilities: readonly CompactFacilityPrefixContext[],
  aliasesFor: (facility: CompactFacilityPrefixContext) => Iterable<string>,
): ReadonlyMap<string, FacilityAliasIndexEntry> => {
  const mutable = new Map<
    string,
    {
      contexts: CompactFacilityPrefixContext[];
      facilityBits: bigint;
      hasInactiveContext: boolean;
      overflow: boolean;
    }
  >();
  for (const facility of facilities) {
    for (const alias of new Set(aliasesFor(facility))) {
      const entry = mutable.get(alias) ?? {
        contexts: [],
        facilityBits: 0n,
        hasInactiveContext: false,
        overflow: false,
      };
      entry.facilityBits |= facility.identityBit;
      entry.hasInactiveContext ||= !facility.facility.active;
      if (entry.contexts.length < MAX_FACILITY_CONTEXTS_PER_IDENTITY_FIELD) {
        entry.contexts.push(facility);
      } else {
        entry.overflow = true;
      }
      mutable.set(alias, entry);
    }
  }
  return mutable;
};

const automaticAliasEvidenceKey = (alias: string): string =>
  `alias\u0001${alias}`;

const automaticSequenceEvidenceKey = (sequenceKey: string): string =>
  `sequence\u0001${sequenceKey}`;

export const compactPopulationPrefixes = (
  facilities: readonly Facility[],
  derivationMetrics?: DraftDerivationMetrics,
): CompactPopulationPrefixContext => {
  const global = new Set<string>(COMPACT_ORGANIZATION_PREFIXES);
  const compactFacilities: CompactFacilityPrefixContext[] = [];
  for (const facility of facilities) {
    const codeTokens = tokensOf(facility.code);
    const stemTokens = facilityStemTokens(facility);
    const fullNameTokens = tokensOf(facility.name);
    const automaticAliases = new Set(compactFacilityAliases(facility));
    const automaticEvidenceTokenSequences = [
      codeTokens,
      siteSpecificFacilityNameTokens(facility),
      fullNameTokens,
    ].filter(
      (tokens) => tokens.length > 0 && automaticAliases.has(tokens.join('')),
    );
    const uniqueAutomaticEvidenceTokenSequences = [
      ...new Map(
        automaticEvidenceTokenSequences.map((tokens) => [
          tokens.join('\u0000'),
          tokens,
        ]),
      ).values(),
    ];
    const aliases = new Set(
      [codeTokens, stemTokens, fullNameTokens]
        .map((tokens) => tokens.join(''))
        .filter((alias) => alias !== ''),
    );
    const evidenceTokenSequences = [
      codeTokens,
      stemTokens,
      fullNameTokens,
      ...[...aliases].map((alias) => [alias]),
    ].filter((tokens) => tokens.length > 0);
    const uniqueEvidenceTokenSequences = [
      ...new Map(
        evidenceTokenSequences.map((tokens) => [tokens.join('\u0000'), tokens]),
      ).values(),
    ];
    if (aliases.size > 0 && uniqueEvidenceTokenSequences.length > 0) {
      compactFacilities.push({
        aliases,
        automaticAliases,
        automaticEvidenceTokenSequences: uniqueAutomaticEvidenceTokenSequences,
        evidenceTokenSequences: uniqueEvidenceTokenSequences,
        facility,
        identityBit: 1n << BigInt(compactFacilities.length),
      });
    }
  }
  const exactAliasIndex = indexFacilityAliases(
    compactFacilities,
    ({ aliases }) => aliases,
  );
  const evidenceSequenceIndex = indexFacilityAliases(
    compactFacilities,
    ({ evidenceTokenSequences }) =>
      evidenceTokenSequences.map((tokens) => tokens.join('\u0000')),
  );
  const distinctiveAliasIndex = indexFacilityAliases(
    compactFacilities,
    ({ aliases }) =>
      [...aliases].filter(
        (alias) =>
          alias.length >= 3 && isDistinctiveAutomaticFacilityAlias(alias),
      ),
  );
  const automaticAliasIndex = indexFacilityAliases(
    compactFacilities,
    ({ automaticAliases }) => automaticAliases,
  );
  const mutableAutomaticBoundaryEvidenceIndex = new Map<
    string,
    AutomaticBoundaryEvidenceIndexEntry
  >();
  const addAutomaticBoundaryEvidence = (
    key: string,
    alias: string,
    identityBit: bigint,
  ): void => {
    const previous = mutableAutomaticBoundaryEvidenceIndex.get(key);
    if (previous !== undefined && previous.alias !== alias) {
      throw new Error('Automatic facility evidence index is inconsistent.');
    }
    mutableAutomaticBoundaryEvidenceIndex.set(key, {
      alias,
      facilityBits: (previous?.facilityBits ?? 0n) | identityBit,
    });
  };
  for (const facility of compactFacilities) {
    for (const alias of facility.automaticAliases) {
      addAutomaticBoundaryEvidence(
        automaticAliasEvidenceKey(alias),
        alias,
        facility.identityBit,
      );
    }
    for (const tokens of facility.automaticEvidenceTokenSequences) {
      const sequenceKey = tokens.join('\u0000');
      addAutomaticBoundaryEvidence(
        automaticSequenceEvidenceKey(sequenceKey),
        tokens.join(''),
        facility.identityBit,
      );
    }
  }
  const populationNeutralMarkers = new Set([
    ...POPULATION_ONLY_CONNECTORS,
    ...POPULATION_ONLY_GENERIC_FACILITY_MARKERS,
    ...global,
    ...compactFacilities.flatMap(({ aliases }) =>
      [...aliases].filter((alias) =>
        isDistinctiveAutomaticFacilityAlias(alias),
      ),
    ),
  ]);
  return {
    approvedKAtomTrie: buildMarkerTrie([
      ...[...INCIDENTAL_POPULATION_WORDS].filter((word) => word.includes('k')),
      ...[...exactAliasIndex.keys()].filter(
        (alias) => alias.length >= 3 && alias.includes('k'),
      ),
    ]),
    automaticAliasIndex,
    automaticAliasLengths: [
      ...new Set([...automaticAliasIndex.keys()].map(({ length }) => length)),
    ].sort((left, right) => left - right),
    automaticBoundaryEvidenceIndex: mutableAutomaticBoundaryEvidenceIndex,
    ...(derivationMetrics === undefined ? {} : { derivationMetrics }),
    distinctiveAliasIndex,
    distinctiveAliasLengths: [
      ...new Set([...distinctiveAliasIndex.keys()].map(({ length }) => length)),
    ].sort((left, right) => left - right),
    evidenceSequenceIndex,
    exactAliasIndex,
    facilities: compactFacilities,
    facilityAliasTrie: buildMarkerTrie(exactAliasIndex.keys()),
    global,
    maximumAutomaticEvidenceTokenCount: Math.max(
      1,
      ...compactFacilities.flatMap(({ automaticEvidenceTokenSequences }) =>
        automaticEvidenceTokenSequences.map(({ length }) => length),
      ),
    ),
    maximumEvidenceTokenCount: Math.max(
      1,
      ...compactFacilities.flatMap(({ evidenceTokenSequences }) =>
        evidenceTokenSequences.map(({ length }) => length),
      ),
    ),
    populationNeutralTrie: buildMarkerTrie(populationNeutralMarkers),
  };
};

interface FacilityContextMatches {
  readonly contexts: ReadonlySet<CompactFacilityPrefixContext>;
  readonly evidenceAliases: ReadonlySet<string>;
  readonly evidenceFacilityBitsByAlias: ReadonlyMap<string, bigint>;
  readonly facilityBits: bigint;
  readonly overflow: boolean;
}

export const facilityContextsForTokens = (
  context: CompactPopulationPrefixContext,
  tokens: readonly string[],
): FacilityContextMatches => {
  const matches = new Set<CompactFacilityPrefixContext>();
  const evidenceAliases = new Set<string>();
  const evidenceFacilityBitsByAlias = new Map<string, bigint>();
  let facilityBits = 0n;
  let overflow = false;
  const addMatches = (
    index: ReadonlyMap<string, FacilityAliasIndexEntry>,
    alias: string,
  ): void => {
    const entry = index.get(alias);
    if (entry === undefined) return;
    const compactAlias = alias.replaceAll('\u0000', '');
    evidenceAliases.add(compactAlias);
    evidenceFacilityBitsByAlias.set(
      compactAlias,
      (evidenceFacilityBitsByAlias.get(compactAlias) ?? 0n) |
        entry.facilityBits,
    );
    facilityBits |= entry.facilityBits;
    overflow ||= entry.overflow;
    for (const facility of entry.contexts) {
      if (matches.has(facility)) continue;
      if (matches.size >= MAX_FACILITY_CONTEXTS_PER_IDENTITY_FIELD) {
        overflow = true;
        continue;
      }
      matches.add(facility);
    }
  };
  for (let start = 0; start < tokens.length; start += 1) {
    let sequenceKey = '';
    const endLimit = Math.min(
      tokens.length,
      start + context.maximumEvidenceTokenCount,
    );
    for (let end = start; end < endLimit; end += 1) {
      sequenceKey += `${end === start ? '' : '\u0000'}${tokens[end]!}`;
      addMatches(context.evidenceSequenceIndex, sequenceKey);
    }
  }
  for (const token of tokens) {
    for (const length of context.distinctiveAliasLengths) {
      if (length > token.length) break;
      addMatches(context.distinctiveAliasIndex, token.slice(0, length));
    }
  }
  return {
    contexts: matches,
    evidenceAliases,
    evidenceFacilityBitsByAlias,
    facilityBits,
    overflow,
  };
};

interface AutomaticFacilityContextMatches {
  readonly contexts: ReadonlySet<CompactFacilityPrefixContext>;
  readonly hasInactiveContext: boolean;
  readonly overflow: boolean;
}

const automaticFacilityContextsForGroup = (
  context: CompactPopulationPrefixContext,
  group: CloudGroup,
): AutomaticFacilityContextMatches => {
  const fields = groupTokenFields(group);
  const matches = new Set<CompactFacilityPrefixContext>();
  let hasInactiveContext = false;
  let overflow = false;
  for (const tokens of [fields.displayName, fields.localPart]) {
    const compact = tokens.join('');
    for (let offset = 0; offset < compact.length; offset += 1) {
      for (const length of context.automaticAliasLengths) {
        if (offset + length > compact.length) break;
        const entry = context.automaticAliasIndex.get(
          compact.slice(offset, offset + length),
        );
        if (entry === undefined) continue;
        hasInactiveContext ||= entry.hasInactiveContext;
        overflow ||= entry.overflow;
        for (const facility of entry.contexts) {
          if (matches.has(facility)) continue;
          if (matches.size >= MAX_FACILITY_CONTEXTS_PER_IDENTITY_FIELD) {
            overflow = true;
            continue;
          }
          matches.add(facility);
        }
      }
    }
  }
  return {
    contexts: matches,
    hasInactiveContext,
    overflow,
  };
};

const automaticBoundaryEvidenceForTokens = (
  context: CompactPopulationPrefixContext,
  tokens: readonly string[],
): readonly AutomaticBoundaryEvidenceIndexEntry[] => {
  const matches = new Map<string, AutomaticBoundaryEvidenceIndexEntry>();
  const addMatch = (key: string): void => {
    const entry = context.automaticBoundaryEvidenceIndex.get(key);
    if (entry !== undefined) matches.set(key, entry);
  };
  for (const token of tokens) {
    for (let offset = 0; offset < token.length; offset += 1) {
      for (const length of context.automaticAliasLengths) {
        if (offset + length > token.length) break;
        addMatch(
          automaticAliasEvidenceKey(token.slice(offset, offset + length)),
        );
      }
    }
  }
  for (let start = 0; start < tokens.length; start += 1) {
    let sequenceKey = '';
    const endLimit = Math.min(
      tokens.length,
      start + context.maximumAutomaticEvidenceTokenCount,
    );
    for (let end = start; end < endLimit; end += 1) {
      sequenceKey += `${end === start ? '' : '\u0000'}${tokens[end]!}`;
      addMatch(automaticSequenceEvidenceKey(sequenceKey));
    }
  }
  return [...matches.values()];
};

interface ExactWholeBuildingFieldBits {
  readonly valid: bigint;
  readonly workforce: bigint;
}

const exactWholeBuildingFieldBits = (
  context: CompactPopulationPrefixContext,
  tokens: readonly string[],
  academicStartYear: number,
): ExactWholeBuildingFieldBits => {
  const stateByAlias = new Map<string, WholeBuildingFieldState>();
  let valid = 0n;
  let workforce = 0n;
  for (const evidence of automaticBoundaryEvidenceForTokens(context, tokens)) {
    let state = stateByAlias.get(evidence.alias);
    if (state === undefined) {
      state = wholeBuildingFieldStateForAliases(
        tokens,
        [evidence.alias],
        academicStartYear,
      );
      stateByAlias.set(evidence.alias, state);
    }
    if (state === 'invalid') continue;
    valid |= evidence.facilityBits;
    if (state === 'facility-workforce') {
      workforce |= evidence.facilityBits;
    }
  }
  return { valid, workforce };
};

export const hasIndexedExactWholeBuildingIdentity = (
  context: CompactPopulationPrefixContext,
  group: CloudGroup,
  academicStartYear: number,
): boolean => {
  if (
    group.displayName === null ||
    hasUnsupportedIdentityContent(group.displayName)
  ) {
    return false;
  }
  const localPart = group.email.slice(0, group.email.lastIndexOf('@'));
  if (hasUnsupportedIdentityContent(localPart)) return false;
  const fields = groupTokenFields(group);
  const displayName = exactWholeBuildingFieldBits(
    context,
    fields.displayName,
    academicStartYear,
  );
  const local = exactWholeBuildingFieldBits(
    context,
    fields.localPart,
    academicStartYear,
  );
  return (
    (displayName.valid &
      local.valid &
      (displayName.workforce | local.workforce)) !==
    0n
  );
};

const prefixesCorroboratedBy = (
  context: CompactPopulationPrefixContext,
  otherFieldTokens: readonly string[],
  targetFieldTokens: readonly string[],
): ReadonlySet<string> => {
  const targetCompact = targetFieldTokens.join('');
  const matches = facilityContextsForTokens(context, otherFieldTokens);
  const candidateAliases = new Set<string>();
  if (matches.overflow) {
    for (let offset = 0; offset < targetCompact.length; offset += 1) {
      for (const length of context.distinctiveAliasLengths) {
        if (offset + length > targetCompact.length) break;
        const alias = targetCompact.slice(offset, offset + length);
        const entry = context.distinctiveAliasIndex.get(alias);
        if (
          entry !== undefined &&
          (entry.facilityBits & matches.facilityBits) !== 0n
        ) {
          candidateAliases.add(alias);
        }
      }
    }
  } else {
    for (const { aliases } of matches.contexts) {
      for (const alias of aliases) candidateAliases.add(alias);
    }
  }
  return new Set([
    ...context.global,
    ...[...candidateAliases].filter(
      (alias) =>
        isDistinctiveAutomaticFacilityAlias(alias) &&
        targetCompact.includes(alias),
    ),
  ]);
};

const compactSuffixesAfterFacilityAlias = (
  facility: CompactFacilityPrefixContext,
  tokens: readonly string[],
): readonly string[] =>
  tokens.flatMap((token) => {
    const matchingAliases = [...facility.aliases]
      .filter(
        (alias) =>
          alias.length >= 3 &&
          isDistinctiveAutomaticFacilityAlias(alias) &&
          token.startsWith(alias),
      )
      .sort((left, right) => right.length - left.length);
    const longest = matchingAliases[0];
    return longest === undefined ? [] : [token.slice(longest.length)];
  });

const facilityBitsWithTerminalMarker = (
  matches: FacilityContextMatches,
  tokens: readonly string[],
  targetMarkers: ReadonlySet<string>,
  suffixMarkers: ReadonlySet<string>,
): bigint => {
  let facilityBits = 0n;
  const aliases = [...matches.evidenceFacilityBitsByAlias]
    .filter(
      ([alias]) =>
        alias.length >= 3 && isDistinctiveAutomaticFacilityAlias(alias),
    )
    .sort(
      ([left], [right]) =>
        right.length - left.length || compareText(left, right),
    );
  for (const token of tokens) {
    let coveredFacilityBits = 0n;
    for (const [alias, aliasFacilityBits] of aliases) {
      if (!token.startsWith(alias)) continue;
      const uncoveredFacilityBits = aliasFacilityBits & ~coveredFacilityBits;
      coveredFacilityBits |= aliasFacilityBits;
      if (
        uncoveredFacilityBits !== 0n &&
        hasTerminalMarkerSubstring(
          [token.slice(alias.length)],
          targetMarkers,
          suffixMarkers,
        )
      ) {
        facilityBits |= uncoveredFacilityBits;
      }
    }
  }
  return facilityBits;
};

const commonFacilityBitsFromFullyConsumedExactTokens = (
  matches: FacilityContextMatches,
  tokens: readonly string[],
): bigint => {
  if (tokens.length === 0) return 0n;
  let commonFacilityBits: bigint | null = null;
  for (const token of tokens) {
    const exactTokenBits = matches.evidenceFacilityBitsByAlias.get(token);
    if (exactTokenBits === undefined) return 0n;
    commonFacilityBits =
      commonFacilityBits === null
        ? exactTokenBits
        : commonFacilityBits & exactTokenBits;
    if (commonFacilityBits === 0n) return 0n;
  }
  return commonFacilityBits ?? 0n;
};

const hasSameFacilityTerminalMarker = (
  context: CompactPopulationPrefixContext,
  displayNameTokens: readonly string[],
  localPartTokens: readonly string[],
  targetMarkers: ReadonlySet<string>,
  suffixMarkers: ReadonlySet<string>,
): boolean => {
  const displayFacilities = facilityContextsForTokens(
    context,
    displayNameTokens,
  );
  const localPartFacilities = facilityContextsForTokens(
    context,
    localPartTokens,
  );
  const displayHasFacilityEvidence =
    displayFacilities.contexts.size > 0 ||
    displayFacilities.evidenceAliases.size > 0;
  const localPartHasFacilityEvidence =
    localPartFacilities.contexts.size > 0 ||
    localPartFacilities.evidenceAliases.size > 0;
  if (displayFacilities.overflow || localPartFacilities.overflow) {
    const displayTerminalFacilityBits = facilityBitsWithTerminalMarker(
      displayFacilities,
      displayNameTokens,
      targetMarkers,
      suffixMarkers,
    );
    const localPartTerminalFacilityBits = facilityBitsWithTerminalMarker(
      localPartFacilities,
      localPartTokens,
      targetMarkers,
      suffixMarkers,
    );
    const displayHasTerminalMarker = hasTerminalMarkerSubstring(
      displayNameTokens,
      targetMarkers,
      suffixMarkers,
    );
    const localPartHasTerminalMarker = hasTerminalMarkerSubstring(
      localPartTokens,
      targetMarkers,
      suffixMarkers,
    );
    return (
      (displayTerminalFacilityBits & localPartFacilities.facilityBits) !== 0n ||
      (localPartTerminalFacilityBits & displayFacilities.facilityBits) !== 0n ||
      (displayHasFacilityEvidence &&
        !localPartHasFacilityEvidence &&
        localPartHasTerminalMarker) ||
      (localPartHasFacilityEvidence &&
        !displayHasFacilityEvidence &&
        displayHasTerminalMarker)
    );
  }
  for (const facility of displayFacilities.contexts) {
    if (context.derivationMetrics !== undefined) {
      context.derivationMetrics.facilityTerminalContextEvaluations += 1;
    }
    if (
      localPartFacilities.contexts.has(facility) &&
      (hasTerminalMarkerSubstring(
        compactSuffixesAfterFacilityAlias(facility, displayNameTokens),
        targetMarkers,
        suffixMarkers,
      ) ||
        hasTerminalMarkerSubstring(
          compactSuffixesAfterFacilityAlias(facility, localPartTokens),
          targetMarkers,
          suffixMarkers,
        ))
    ) {
      return true;
    }
  }
  if (displayHasFacilityEvidence && !localPartHasFacilityEvidence) {
    return hasTerminalMarkerSubstring(
      localPartTokens,
      targetMarkers,
      suffixMarkers,
    );
  }
  if (localPartHasFacilityEvidence && !displayHasFacilityEvidence) {
    return hasTerminalMarkerSubstring(
      displayNameTokens,
      targetMarkers,
      suffixMarkers,
    );
  }
  return false;
};

const suffixIsFullyConsumedBy = (
  suffix: string,
  neutralMarkers: ReadonlySet<string>,
): boolean => {
  if (suffix === '') return true;
  const reachable = new Set([0]);
  for (let offset = 0; offset < suffix.length; offset += 1) {
    if (!reachable.has(offset)) continue;
    for (const marker of neutralMarkers) {
      if (marker !== '' && suffix.startsWith(marker, offset)) {
        reachable.add(offset + marker.length);
      }
    }
    const numeric = /^[0-9]{1,4}/u.exec(suffix.slice(offset));
    if (numeric !== null) reachable.add(offset + numeric[0].length);
  }
  return reachable.has(suffix.length);
};

const hasTerminalMarkerSubstring = (
  tokens: readonly string[],
  targetMarkers: ReadonlySet<string>,
  suffixMarkers: ReadonlySet<string>,
): boolean =>
  tokens.some((token) =>
    [...targetMarkers].some((marker) => {
      let offset = token.indexOf(marker);
      while (offset >= 0) {
        if (
          suffixIsFullyConsumedBy(
            token.slice(offset + marker.length),
            suffixMarkers,
          )
        ) {
          return true;
        }
        offset = token.indexOf(marker, offset + 1);
      }
      return false;
    }),
  );

const STAFF_IDENTITY_MARKERS = new Set([
  ...STAFF_MARKERS,
  ...NARROW_ROLE_MARKERS,
]);

// `sub` is meaningful only as an exact bounded word. In compact parsing it is
// too short to distinguish a substitute role from ordinary words such as
// subgroup, subteam, or subschool.
const COMPACT_STAFF_IDENTITY_MARKERS = new Set(
  [...STAFF_IDENTITY_MARKERS].filter((marker) => marker !== 'sub'),
);

const COMPACT_STAFF_NEUTRAL_MARKERS = new Set([
  ...NON_STAFF_MARKERS,
  ...POPULATION_DESCRIPTOR_MARKERS,
  ...STALE_MARKERS,
  'classlink',
  'gradebook',
  'sy',
]);

const POPULATION_TERMINAL_SUFFIX_MARKERS = new Set([
  ...COMPACT_WORD_BOUNDARIES,
  ...POPULATION_DESCRIPTOR_MARKERS,
  ...STAFF_IDENTITY_MARKERS,
  ...STALE_MARKERS,
]);

const HIGH_CONFIDENCE_TERMINAL_POPULATION_MARKERS = new Set(
  [...NON_STAFF_MARKERS].filter(
    (marker) =>
      ![
        'class',
        'classroom',
        'classrooms',
        'cohort',
        'cohorts',
        'grade',
        'grades',
      ].includes(marker),
  ),
);

const HIGH_CONFIDENCE_LEADING_POPULATION_MARKERS = new Set([
  'alumni',
  'boosters',
  'child',
  'children',
  'classrooms',
  'cohorts',
  'families',
  'grades',
  'guardian',
  'guardians',
  'kid',
  'kids',
  'learner',
  'learners',
  'parent',
  'parents',
  'preschool',
  'preschools',
  'pupil',
  'pupils',
  'student',
  'students',
]);

// Once an identity is compacted, an explicit population word can be surrounded
// by arbitrary untrusted text. Treat every population marker as exclusionary;
// requiring a known suffix here would recreate `CohortBlueStaff`-style
// bypasses. Written ordinals are checked per original token below so ordinary
// boundaries such as `Fir Staff` cannot manufacture `first`.
export const HIGH_CONFIDENCE_EMBEDDED_POPULATION_MARKERS = new Set([
  ...NON_STAFF_MARKERS,
]);

export const INCIDENTAL_POPULATION_WORDS = new Set([
  ...OPERATIONAL_K_SAFE_WORDS,
  'captains',
  'classlink',
  'classified',
  'gradebook',
  'laptop',
  'masterclass',
  'kidney',
  'parenting',
  'scholarship',
  'skidmore',
  'subclass',
  'subfamily',
  'subgrade',
  'transparent',
  'upgrade',
]);

const INCIDENTAL_SHADOW_POPULATION_MARKERS = new Set([
  ...HIGH_CONFIDENCE_EMBEDDED_POPULATION_MARKERS,
  ...SHORT_GRADE_POPULATION_MARKERS,
  ...SPELLED_GRADE_ORDINAL_MARKERS,
  'k',
  'pk',
]);

const INCIDENTAL_SHADOW_BOUNDARIES_BY_WORD = new Map(
  [...INCIDENTAL_POPULATION_WORDS].map((word) => [
    word,
    [...INCIDENTAL_SHADOW_POPULATION_MARKERS].flatMap((marker) =>
      marker.length < word.length && word.startsWith(marker)
        ? [...INCIDENTAL_POPULATION_WORDS].map((nextWord) => ({
            markerLength: marker.length,
            nextWord,
          }))
        : [],
    ),
  ]),
);

const populationEvidenceTokens = (
  tokens: readonly string[],
): readonly string[] =>
  tokens.filter((token) => !INCIDENTAL_POPULATION_WORDS.has(token));

interface TextSpan {
  readonly end: number;
  readonly start: number;
}

const spansCoverRange = (
  spans: readonly TextSpan[],
  start: number,
  end: number,
): boolean => {
  let coveredThrough = start;
  while (coveredThrough < end) {
    let nextCoveredThrough = coveredThrough;
    for (const span of spans) {
      if (span.start <= coveredThrough && span.end > nextCoveredThrough) {
        nextCoveredThrough = span.end;
      }
    }
    if (nextCoveredThrough === coveredThrough) return false;
    coveredThrough = nextCoveredThrough;
  }
  return true;
};

const incidentalPopulationWordSpans = (
  token: string,
  compactPrefixes: ReadonlySet<string>,
): readonly TextSpan[] => {
  const spans: TextSpan[] = [];
  const reachable = new Set([0]);
  const neutralAtoms = new Set([
    ...compactPrefixes,
    ...COMPACT_NEUTRAL_MARKERS,
  ]);
  for (let offset = 0; offset < token.length; offset += 1) {
    if (!reachable.has(offset)) continue;
    for (const atom of neutralAtoms) {
      if (atom !== '' && token.startsWith(atom, offset)) {
        reachable.add(offset + atom.length);
      }
    }
    const numeric = COMPACT_NEUTRAL_NUMBER_PATTERN.exec(token.slice(offset));
    if (numeric !== null) reachable.add(offset + numeric[0].length);
    for (const word of INCIDENTAL_POPULATION_WORDS) {
      if (token.startsWith(word, offset)) {
        const hidesMarkerBeforeIncidentalAtom = (
          INCIDENTAL_SHADOW_BOUNDARIES_BY_WORD.get(word) ?? []
        ).some(({ markerLength, nextWord }) =>
          token.startsWith(nextWord, offset + markerLength),
        );
        if (hidesMarkerBeforeIncidentalAtom) continue;
        const end = offset + word.length;
        spans.push({ end, start: offset });
        reachable.add(end);
      }
    }
  }
  return spans.sort(
    (left, right) =>
      left.start - right.start ||
      right.end - right.start - (left.end - left.start),
  );
};

const mergedTextSpans = (spans: readonly TextSpan[]): readonly TextSpan[] => {
  const merged: TextSpan[] = [];
  for (const span of [...spans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )) {
    const previous = merged.at(-1);
    if (previous === undefined || span.start > previous.end) {
      merged.push(span);
      continue;
    }
    if (span.end > previous.end) {
      merged[merged.length - 1] = { end: span.end, start: previous.start };
    }
  }
  return merged;
};

const maskTextSpans = (token: string, spans: readonly TextSpan[]): string => {
  let masked = '';
  let offset = 0;
  for (const span of mergedTextSpans(spans)) {
    masked += token.slice(offset, span.start);
    masked += '~'.repeat(span.end - span.start);
    offset = span.end;
  }
  return `${masked}${token.slice(offset)}`;
};

const withoutIncidentalPopulationWords = (
  token: string,
  compactPrefixes: ReadonlySet<string>,
): string =>
  maskTextSpans(token, incidentalPopulationWordSpans(token, compactPrefixes));

interface PopulationSearchEvidence {
  readonly incidentalSpans: readonly TextSpan[];
  readonly token: string;
}

const populationSearchEvidenceTokens = (
  tokens: readonly string[],
  compactPrefixes: ReadonlySet<string>,
  includeJoinedTokens = false,
): readonly PopulationSearchEvidence[] => {
  const variants = [
    ...tokens.map((_, index) => [index]),
    ...(includeJoinedTokens ? [tokens.map((_, index) => index)] : []),
    ...(tokens.includes('and')
      ? [tokens.flatMap((token, index) => (token === 'and' ? [] : [index]))]
      : []),
  ];
  const evidence = new Map<string, PopulationSearchEvidence>();
  for (const indexes of variants) {
    let token = '';
    const incidentalSpans: TextSpan[] = [];
    for (const index of indexes) {
      const fieldToken = tokens[index]!;
      const tokenOffset = token.length;
      token += fieldToken;
      incidentalSpans.push(
        ...incidentalPopulationWordSpans(fieldToken, compactPrefixes).map(
          (span) => ({
            end: span.end + tokenOffset,
            start: span.start + tokenOffset,
          }),
        ),
      );
    }
    if (token !== '') {
      const key = `${token}\u0000${incidentalSpans
        .map(({ end, start }) => `${start}:${end}`)
        .join(',')}`;
      evidence.set(key, { incidentalSpans, token });
    }
  }
  return [...evidence.values()];
};

const markerOccursOutsideIncidentalWord = (
  token: string,
  marker: string,
  incidentalSpans: readonly TextSpan[],
): boolean => {
  let start = token.indexOf(marker);
  while (start >= 0) {
    const end = start + marker.length;
    const singularEnd = marker.endsWith('s') ? end - 1 : end;
    const manufacturedPluralAtStaffBoundary =
      marker.endsWith('s') &&
      token.startsWith('staff', singularEnd) &&
      spansCoverRange(incidentalSpans, start, singularEnd);
    if (
      !manufacturedPluralAtStaffBoundary &&
      !spansCoverRange(incidentalSpans, start, end)
    ) {
      return true;
    }
    start = token.indexOf(marker, start + 1);
  }
  return false;
};

const populationTerminalEvidenceTokens = (
  tokens: readonly string[],
  compactPrefixes: ReadonlySet<string>,
): readonly string[] =>
  populationEvidenceTokens(tokens)
    .map((token) => withoutIncidentalPopulationWords(token, compactPrefixes))
    .filter((token) => token !== '');

const isCompactStaffEvidenceToken = (
  token: string,
  compactPrefixes: ReadonlySet<string>,
): boolean => {
  const states = new Map<number, Set<number>>([[0, new Set([0])]]);
  const addState = (offset: number, state: number): void => {
    const current = states.get(offset) ?? new Set<number>();
    current.add(state);
    states.set(offset, current);
  };
  const neutralMarkers = new Set([
    ...COMPACT_WORD_BOUNDARIES,
    ...FACILITY_GENERIC_MARKERS,
    ...COMPACT_STAFF_NEUTRAL_MARKERS,
  ]);
  for (let offset = 0; offset < token.length; offset += 1) {
    for (const state of states.get(offset) ?? []) {
      const prefixSeen = (state & 1) !== 0;
      for (const prefix of compactPrefixes) {
        if (prefix !== '' && token.startsWith(prefix, offset)) {
          addState(offset + prefix.length, state | 1);
        }
      }
      for (const marker of neutralMarkers) {
        if (marker !== '' && token.startsWith(marker, offset)) {
          addState(offset + marker.length, state);
        }
      }
      if (prefixSeen) {
        for (const word of INCIDENTAL_POPULATION_WORDS) {
          if (token.startsWith(word, offset)) {
            addState(offset + word.length, state);
          }
        }
      }
      for (const marker of COMPACT_STAFF_IDENTITY_MARKERS) {
        if (token.startsWith(marker, offset)) {
          addState(offset + marker.length, state | 2);
        }
      }
      const numeric = COMPACT_NEUTRAL_NUMBER_PATTERN.exec(token.slice(offset));
      if (numeric !== null) addState(offset + numeric[0].length, state);
    }
  }
  return [...(states.get(token.length) ?? [])].some(
    (state) => (state & 3) === 3,
  );
};

const hasLeadingPopulationMarker = (
  tokens: readonly string[],
  compactPrefixes: ReadonlySet<string>,
): boolean =>
  populationTerminalEvidenceTokens(tokens, compactPrefixes).some((token) =>
    compactMarkerCandidates(token, compactPrefixes).some((candidate) =>
      [...HIGH_CONFIDENCE_LEADING_POPULATION_MARKERS].some((marker) =>
        candidate.startsWith(marker),
      ),
    ),
  );

const hasEmbeddedNumberedPopulationMarker = (
  tokens: readonly string[],
  context: CompactPopulationPrefixContext,
  compactPrefixes: ReadonlySet<string>,
): boolean => {
  const ordinalSuffixes = new Map<number, string>([
    [1, 'st'],
    [2, 'nd'],
    [3, 'rd'],
    ...Array.from({ length: 9 }, (_, index) => [index + 4, 'th'] as const),
  ]);
  const ordinalCollisionWords = ['staff', 'stale', 'stem', 'the', 'through'];
  const isInsideFacilityAlias = (
    value: string,
    start: number,
    end: number,
  ): boolean => {
    for (let aliasStart = 0; aliasStart <= start; aliasStart += 1) {
      if (
        markerEndOffsets(context.facilityAliasTrie, value, aliasStart).some(
          (aliasEnd) => aliasEnd >= end,
        )
      ) {
        return true;
      }
    }
    return false;
  };
  const candidates = populationSearchEvidenceTokens(
    tokens,
    compactPrefixes,
    true,
  );
  const numberedDescriptor =
    /(?:(?:classrooms?|class|cohorts?|grades?)(?:of)?(?:alpha|k|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[0-9]{1,4}(?:st|nd|rd|th)?)|(?:pk|k)(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[0-9]{1,2}(?:st|nd|rd|th)?))/u;
  return candidates.some(({ incidentalSpans, token }) => {
    const maskedToken = maskTextSpans(token, incidentalSpans);
    if (numberedDescriptor.test(maskedToken)) {
      return true;
    }
    for (const match of maskedToken.matchAll(/[0-9]+/gu)) {
      const start = match.index;
      const digits = match[0];
      const grade = Number(digits);
      const suffix = ordinalSuffixes.get(grade);
      if (suffix === undefined) continue;
      const suffixStart = start + digits.length;
      const end = suffixStart + suffix.length;
      if (token.slice(suffixStart, end) !== suffix) continue;
      if (
        ordinalCollisionWords.some((word) =>
          token.startsWith(word, suffixStart),
        ) ||
        isInsideFacilityAlias(token, start, end)
      ) {
        continue;
      }
      return true;
    }
    return false;
  });
};

const hasHighConfidenceEmbeddedPopulationMarker = (
  tokens: readonly string[],
  compactPrefixes: ReadonlySet<string>,
): boolean => {
  const markers = [...HIGH_CONFIDENCE_EMBEDDED_POPULATION_MARKERS];
  const withinTokenEvidence = tokens.some((token) => {
    const incidentalSpans = incidentalPopulationWordSpans(
      token,
      compactPrefixes,
    );
    return markers.some((marker) =>
      markerOccursOutsideIncidentalWord(token, marker, incidentalSpans),
    );
  });
  if (withinTokenEvidence) return true;
  return populationSearchEvidenceTokens(tokens, compactPrefixes, true).some(
    ({ incidentalSpans, token }) => {
      const masked = maskTextSpans(token, incidentalSpans);
      return markers.some((marker) => masked.includes(marker));
    },
  );
};

type WrittenGradeEndpointKind = 'cardinal' | 'ordinal';

interface WrittenGradeEndpointMatch extends TextSpan {
  readonly kind: WrittenGradeEndpointKind;
  readonly marker: string;
  readonly usedInternalSeparator: boolean;
}

interface WrittenGradeScan {
  readonly matches: readonly WrittenGradeEndpointMatch[];
  readonly overflow: boolean;
}

interface CompactIdentityProjection {
  readonly sourceEnds: readonly number[];
  readonly sourceStarts: readonly number[];
  readonly value: string;
}

const MAX_WRITTEN_GRADE_MATCHES_PER_FIELD = 128;
const WRITTEN_GRADE_ENDPOINTS_BY_INITIAL = new Map<
  string,
  readonly {
    readonly kind: WrittenGradeEndpointKind;
    readonly marker: string;
  }[]
>();
for (const [kind, markers] of [
  ['cardinal', SPELLED_GRADE_CARDINALS],
  ['ordinal', SPELLED_GRADE_ORDINALS],
] as const) {
  for (const marker of markers) {
    const initial = marker[0]!;
    WRITTEN_GRADE_ENDPOINTS_BY_INITIAL.set(initial, [
      ...(WRITTEN_GRADE_ENDPOINTS_BY_INITIAL.get(initial) ?? []),
      { kind, marker },
    ]);
  }
}

const compactIdentityProjection = (
  field: string,
): CompactIdentityProjection => {
  let value = '';
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  for (let sourceIndex = 0; sourceIndex < field.length; sourceIndex += 1) {
    const folded = field[sourceIndex]!.normalize('NFD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLocaleLowerCase('en-US');
    for (const character of folded) {
      if (!/^[a-z0-9]$/u.test(character)) continue;
      value += character;
      sourceStarts.push(sourceIndex);
      sourceEnds.push(sourceIndex + 1);
    }
  }
  return { sourceEnds, sourceStarts, value };
};

const compactWordSpans = (
  projection: CompactIdentityProjection,
  words: Iterable<string>,
): readonly TextSpan[] => {
  const spans: TextSpan[] = [];
  for (const word of words) {
    let compactStart = projection.value.indexOf(word);
    while (compactStart >= 0) {
      const compactEnd = compactStart + word.length;
      spans.push({
        end: projection.sourceEnds[compactEnd - 1]!,
        start: projection.sourceStarts[compactStart]!,
      });
      compactStart = projection.value.indexOf(word, compactStart + 1);
    }
  }
  return spans;
};

const spansOverlap = (left: TextSpan, right: TextSpan): boolean =>
  left.start < right.end && right.start < left.end;

export const scanWrittenGradeEndpoints = (field: string): WrittenGradeScan => {
  const projection = compactIdentityProjection(field);
  const matches: WrittenGradeEndpointMatch[] = [];
  for (
    let compactStart = 0;
    compactStart < projection.value.length;
    compactStart += 1
  ) {
    const candidates = WRITTEN_GRADE_ENDPOINTS_BY_INITIAL.get(
      projection.value[compactStart]!,
    );
    if (candidates === undefined) continue;
    for (const { kind, marker } of candidates) {
      let usedInternalSeparator = false;
      let matched = true;
      for (let markerIndex = 0; markerIndex < marker.length; markerIndex += 1) {
        const compactIndex = compactStart + markerIndex;
        if (projection.value[compactIndex] !== marker[markerIndex]) {
          matched = false;
          break;
        }
        if (markerIndex > 0) {
          const previousEnd = projection.sourceEnds[compactIndex - 1]!;
          const currentStart = projection.sourceStarts[compactIndex]!;
          const gap =
            currentStart > previousEnd
              ? field.slice(previousEnd, currentStart)
              : '';
          if (/[\p{L}\p{N}]/u.test(gap)) {
            matched = false;
            break;
          }
          if (gap !== '') usedInternalSeparator = true;
        }
      }
      if (!matched) continue;
      const compactEnd = compactStart + marker.length - 1;
      matches.push({
        end: projection.sourceEnds[compactEnd]!,
        kind,
        marker,
        start: projection.sourceStarts[compactStart]!,
        usedInternalSeparator,
      });
      if (matches.length > MAX_WRITTEN_GRADE_MATCHES_PER_FIELD) {
        return { matches: [], overflow: true };
      }
    }
  }
  const unique = new Map<string, WrittenGradeEndpointMatch>();
  for (const match of matches) {
    unique.set(
      `${match.start}:${match.end}:${match.kind}:${match.marker}`,
      match,
    );
  }
  return {
    matches: [...unique.values()].sort(
      (left, right) =>
        left.start - right.start ||
        right.end - left.end ||
        compareText(left.marker, right.marker),
    ),
    overflow: false,
  };
};

const writtenGradeStructuralSpans = (field: string): readonly TextSpan[] => {
  const projection = compactIdentityProjection(field);
  return compactWordSpans(projection, STAFF_IDENTITY_MARKERS);
};

const isWrittenGradeRangeGap = (gap: string): boolean => {
  if (gap === '') return false;
  if (/^[^\p{L}\p{N}]+$/u.test(gap)) return true;
  const connectors = tokensOf(gap);
  return (
    connectors.length > 0 &&
    connectors.every((token) =>
      ['and', 'through', 'thru', 'to'].includes(token),
    )
  );
};

export const writtenGradeEvidenceForField = (
  field: string,
): { readonly hasOrdinal: boolean; readonly hasRange: boolean } => {
  const scan = scanWrittenGradeEndpoints(field);
  if (scan.overflow) return { hasOrdinal: true, hasRange: true };
  const structuralSpans = writtenGradeStructuralSpans(field);
  const operationalSpans = compactWordSpans(
    compactIdentityProjection(field),
    OPERATIONAL_ORDINAL_SAFE_PHRASES,
  );
  const matches = scan.matches.filter(
    (match) =>
      !structuralSpans.some((span) => spansOverlap(match, span)) &&
      !(
        match.kind === 'ordinal' &&
        !match.usedInternalSeparator &&
        operationalSpans.some(
          (span) => span.start <= match.start && span.end >= match.end,
        )
      ),
  );
  const hasRange = matches.some((left, leftIndex) =>
    matches
      .slice(leftIndex + 1)
      .some(
        (right) =>
          right.start >= left.end &&
          isWrittenGradeRangeGap(field.slice(left.end, right.start)),
      ),
  );
  return {
    hasOrdinal: matches.some(({ kind }) => kind === 'ordinal'),
    hasRange,
  };
};

const writtenGradeEvidence = (
  group: CloudGroup,
): { readonly hasOrdinal: boolean; readonly hasRange: boolean } => {
  const localPart = group.email.slice(0, group.email.lastIndexOf('@'));
  const evidence = [
    writtenGradeEvidenceForField(group.displayName ?? ''),
    writtenGradeEvidenceForField(localPart),
  ];
  return {
    hasOrdinal: evidence.some(({ hasOrdinal }) => hasOrdinal),
    hasRange: evidence.some(({ hasRange }) => hasRange),
  };
};

const hasUntrustedEmbeddedShortGradeMarker = (
  context: CompactPopulationPrefixContext,
  displayNameTokens: readonly string[],
  localPartTokens: readonly string[],
  displayPrefixes: ReadonlySet<string>,
  localPartPrefixes: ReadonlySet<string>,
): boolean => {
  const hasUnexplainedK = (
    tokens: readonly string[],
    compactPrefixes: ReadonlySet<string>,
  ): boolean => {
    const evidenceTokens = populationEvidenceTokens(tokens);
    let compact = '';
    const incidentalSpans: TextSpan[] = [];
    for (const token of evidenceTokens) {
      const tokenOffset = compact.length;
      compact += token;
      incidentalSpans.push(
        ...incidentalPopulationWordSpans(token, compactPrefixes).map(
          (span) => ({
            end: span.end + tokenOffset,
            start: span.start + tokenOffset,
          }),
        ),
      );
    }
    if (!compact.includes('k')) return false;
    const isCoveredBySingleApprovedAtom = (
      start: number,
      end: number,
    ): boolean => {
      for (let atomStart = 0; atomStart <= start; atomStart += 1) {
        if (
          markerEndOffsets(context.approvedKAtomTrie, compact, atomStart).some(
            (atomEnd) => atomEnd >= end,
          )
        ) {
          return true;
        }
      }
      return false;
    };
    for (const marker of ['kdg', 'kg', 'pk', 'tk']) {
      let start = compact.indexOf(marker);
      while (start >= 0) {
        const end = start + marker.length;
        if (
          !isCoveredBySingleApprovedAtom(start, end) &&
          !spansCoverRange(incidentalSpans, start, end)
        ) {
          return true;
        }
        start = compact.indexOf(marker, start + 1);
      }
    }
    const reachable = new Set([0]);
    for (let offset = 0; offset < compact.length; offset += 1) {
      if (!reachable.has(offset)) continue;
      if (compact[offset] !== 'k') reachable.add(offset + 1);
      for (const end of markerEndOffsets(
        context.approvedKAtomTrie,
        compact,
        offset,
      )) {
        reachable.add(end);
      }
    }
    return !reachable.has(compact.length);
  };
  return (
    hasUnexplainedK(displayNameTokens, displayPrefixes) ||
    hasUnexplainedK(localPartTokens, localPartPrefixes)
  );
};

const FACILITY_CONTEXT_POPULATION_MARKERS = new Set([
  ...HIGH_CONFIDENCE_TERMINAL_POPULATION_MARKERS,
  ...SHORT_GRADE_POPULATION_MARKERS,
  'k',
  'pk',
]);

export const hasStaffIdentityEvidence = (
  group: CloudGroup,
  prefixContext: CompactPopulationPrefixContext,
): boolean => {
  const tokenFields = groupTokenFields(group);
  const displayPrefixes = prefixesCorroboratedBy(
    prefixContext,
    tokenFields.localPart,
    tokenFields.displayName,
  );
  const localPartPrefixes = prefixesCorroboratedBy(
    prefixContext,
    tokenFields.displayName,
    tokenFields.localPart,
  );
  const fieldHasStaffEvidence = (
    tokens: readonly string[],
    compactPrefixes: ReadonlySet<string>,
  ): boolean =>
    hasAnyToken(tokens, STAFF_IDENTITY_MARKERS) ||
    tokens.some(
      (token) =>
        isCompactStaffEvidenceToken(token, compactPrefixes) ||
        isCompactNamedMarkerToken(
          token,
          compactPrefixes,
          COMPACT_STAFF_IDENTITY_MARKERS,
          COMPACT_STAFF_NEUTRAL_MARKERS,
        ),
    );
  const localPartHasEvidence = fieldHasStaffEvidence(
    tokenFields.localPart,
    localPartPrefixes,
  );
  if (group.displayName === null) return localPartHasEvidence;
  const displayNameHasEvidence = fieldHasStaffEvidence(
    tokenFields.displayName,
    displayPrefixes,
  );
  if (displayNameHasEvidence && localPartHasEvidence) return true;
  const displayFacilities = facilityContextsForTokens(
    prefixContext,
    tokenFields.displayName,
  );
  const localPartFacilities = facilityContextsForTokens(
    prefixContext,
    tokenFields.localPart,
  );
  const displayCompact = tokenFields.displayName.join('');
  const localPartCompact = tokenFields.localPart.join('');
  const displayCorroboratingFacilityBits =
    (displayFacilities.evidenceFacilityBitsByAlias.get(displayCompact) ?? 0n) |
    commonFacilityBitsFromFullyConsumedExactTokens(
      displayFacilities,
      tokenFields.displayName,
    );
  const localPartCorroboratingFacilityBits =
    (localPartFacilities.evidenceFacilityBitsByAlias.get(localPartCompact) ??
      0n) |
    commonFacilityBitsFromFullyConsumedExactTokens(
      localPartFacilities,
      tokenFields.localPart,
    );
  return (
    (displayNameHasEvidence &&
      (displayFacilities.facilityBits & localPartCorroboratingFacilityBits) !==
        0n) ||
    (localPartHasEvidence &&
      (localPartFacilities.facilityBits & displayCorroboratingFacilityBits) !==
        0n)
  );
};

const hasSerializableStaffIdentity = (
  group: CloudGroup,
  prefixContext: CompactPopulationPrefixContext,
): boolean => {
  const localPart = group.email.slice(0, group.email.lastIndexOf('@'));
  return (
    (group.displayName === null ||
      !hasUnsupportedIdentityContent(group.displayName)) &&
    !hasUnsupportedIdentityContent(localPart) &&
    hasStaffIdentityEvidence(group, prefixContext)
  );
};

const POPULATION_ONLY_CONNECTORS = [
  'all',
  'and',
  'directory',
  'distribution',
  'group',
  'groups',
  'list',
  'lists',
  'mailing',
  'member',
  'members',
  'or',
  'roster',
] as const;
const POPULATION_ONLY_GENERIC_FACILITY_MARKERS = [
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
  'high',
  'k12',
  'learning',
  'middle',
  'psd',
  'school',
  'the',
] as const;

const isExactPopulationOnlyField = (
  tokens: readonly string[],
  prefixContext: CompactPopulationPrefixContext,
): boolean => {
  const compact = tokens.join('');
  if (compact === '') return false;
  const withoutPopulation = new Set([0]);
  const withPopulation = new Set<number>();
  for (let offset = 0; offset < compact.length; offset += 1) {
    const neutralReachable = withoutPopulation.has(offset);
    const populationReachable = withPopulation.has(offset);
    if (!neutralReachable && !populationReachable) continue;
    for (const nextOffset of markerEndOffsets(
      prefixContext.populationNeutralTrie,
      compact,
      offset,
    )) {
      if (neutralReachable) withoutPopulation.add(nextOffset);
      if (populationReachable) withPopulation.add(nextOffset);
    }
    for (const marker of [
      ...NON_STAFF_MARKERS,
      ...SHORT_GRADE_POPULATION_MARKERS,
      'k',
      'pk',
    ]) {
      if (compact.startsWith(marker, offset)) {
        withPopulation.add(offset + marker.length);
      }
    }
    const ordinal = /^(?:[0-9]|1[0-2])(?:st|nd|rd|th)/u.exec(
      compact.slice(offset),
    );
    if (ordinal !== null) {
      withPopulation.add(offset + ordinal[0].length);
    }
    const number = /^(?:[0-9]|1[0-2])(?![0-9])/u.exec(compact.slice(offset));
    if (number !== null) {
      const nextOffset = offset + number[0].length;
      if (neutralReachable) withoutPopulation.add(nextOffset);
      if (populationReachable) withPopulation.add(nextOffset);
    }
  }
  return withPopulation.has(compact.length);
};

const isExactPopulationOnlyIdentity = (
  group: CloudGroup,
  prefixContext: CompactPopulationPrefixContext,
): boolean => {
  if (
    group.displayName === null ||
    hasUnsupportedIdentityContent(group.displayName)
  ) {
    return false;
  }
  const localPart = group.email.slice(0, group.email.lastIndexOf('@'));
  if (hasUnsupportedIdentityContent(localPart)) return false;
  const fields = groupTokenFields(group);
  return (
    isExactPopulationOnlyField(fields.displayName, prefixContext) &&
    isExactPopulationOnlyField(fields.localPart, prefixContext)
  );
};

const hasExplicitNumericGradeRange = (group: CloudGroup): boolean => {
  const localPart = group.email.slice(0, group.email.lastIndexOf('@'));
  if (
    [group.displayName ?? '', localPart].some((field) =>
      EXPLICIT_NUMERIC_GRADE_RANGE_PATTERN.test(field),
    )
  ) {
    return true;
  }
  const isGradeEndpoint = (token: string): boolean =>
    /^(?:kdg|kg|tk|pk|k|[1-9]|1[0-2])$/u.test(token);
  const hasNormalizedBand = (tokens: readonly string[]): boolean =>
    tokens.some((token, index) => {
      if (!isGradeEndpoint(token)) return false;
      const next = tokens[index + 1];
      if (next !== undefined && isGradeEndpoint(next)) return true;
      return (
        (next === 'and' || next === 'through' || next === 'to') &&
        isGradeEndpoint(tokens[index + 2] ?? '')
      );
    });
  const fields = groupTokenFields(group);
  return (
    hasNormalizedBand(fields.displayName) || hasNormalizedBand(fields.localPart)
  );
};

export const classifyPopulationGroup = (
  group: CloudGroup,
  prefixContext: CompactPopulationPrefixContext,
  academicStartYear: number,
): PopulationGroupClassification => {
  const tokenFields = groupTokenFields(group);
  if (isExactPopulationOnlyIdentity(group, prefixContext)) return 'definite';
  const displayPrefixes = prefixesCorroboratedBy(
    prefixContext,
    tokenFields.localPart,
    tokenFields.displayName,
  );
  const localPartPrefixes = prefixesCorroboratedBy(
    prefixContext,
    tokenFields.displayName,
    tokenFields.localPart,
  );
  const writtenGrade = writtenGradeEvidence(group);
  const exactWholeBuildingIdentity =
    writtenGrade.hasOrdinal &&
    hasIndexedExactWholeBuildingIdentity(
      prefixContext,
      group,
      academicStartYear,
    );
  if (exactWholeBuildingIdentity) return 'none';
  const hasDirectPopulationEvidence =
    hasExplicitNumericGradeRange(group) ||
    writtenGrade.hasRange ||
    (!exactWholeBuildingIdentity && writtenGrade.hasOrdinal) ||
    hasUntrustedEmbeddedShortGradeMarker(
      prefixContext,
      tokenFields.displayName,
      tokenFields.localPart,
      displayPrefixes,
      localPartPrefixes,
    ) ||
    hasNonStaffPopulationMarker(
      populationTerminalEvidenceTokens(
        tokenFields.displayName,
        displayPrefixes,
      ),
      displayPrefixes,
    ) ||
    hasNonStaffPopulationMarker(
      populationTerminalEvidenceTokens(
        tokenFields.localPart,
        localPartPrefixes,
      ),
      localPartPrefixes,
    ) ||
    hasTerminalMarkerSubstring(
      populationTerminalEvidenceTokens(
        tokenFields.displayName,
        displayPrefixes,
      ),
      HIGH_CONFIDENCE_TERMINAL_POPULATION_MARKERS,
      POPULATION_TERMINAL_SUFFIX_MARKERS,
    ) ||
    hasTerminalMarkerSubstring(
      populationTerminalEvidenceTokens(
        tokenFields.localPart,
        localPartPrefixes,
      ),
      HIGH_CONFIDENCE_TERMINAL_POPULATION_MARKERS,
      POPULATION_TERMINAL_SUFFIX_MARKERS,
    ) ||
    hasLeadingPopulationMarker(tokenFields.displayName, displayPrefixes) ||
    hasLeadingPopulationMarker(tokenFields.localPart, localPartPrefixes) ||
    hasHighConfidenceEmbeddedPopulationMarker(
      tokenFields.displayName,
      displayPrefixes,
    ) ||
    hasHighConfidenceEmbeddedPopulationMarker(
      tokenFields.localPart,
      localPartPrefixes,
    ) ||
    hasEmbeddedNumberedPopulationMarker(
      tokenFields.displayName,
      prefixContext,
      displayPrefixes,
    ) ||
    hasEmbeddedNumberedPopulationMarker(
      tokenFields.localPart,
      prefixContext,
      localPartPrefixes,
    );
  const hasCorroboratedPopulationEvidence =
    hasNonStaffPopulationMarker(
      populationTerminalEvidenceTokens(
        tokenFields.displayName,
        displayPrefixes,
      ),
      displayPrefixes,
    ) ||
    hasNonStaffPopulationMarker(
      populationTerminalEvidenceTokens(
        tokenFields.localPart,
        localPartPrefixes,
      ),
      localPartPrefixes,
    ) ||
    hasLeadingPopulationMarker(tokenFields.displayName, displayPrefixes) ||
    hasLeadingPopulationMarker(tokenFields.localPart, localPartPrefixes) ||
    hasSameFacilityTerminalMarker(
      prefixContext,
      populationTerminalEvidenceTokens(
        tokenFields.displayName,
        displayPrefixes,
      ),
      populationTerminalEvidenceTokens(
        tokenFields.localPart,
        localPartPrefixes,
      ),
      FACILITY_CONTEXT_POPULATION_MARKERS,
      POPULATION_TERMINAL_SUFFIX_MARKERS,
    );
  if (!hasDirectPopulationEvidence && !hasCorroboratedPopulationEvidence) {
    return 'none';
  }
  return hasStaffIdentityEvidence(group, prefixContext)
    ? 'ambiguous'
    : 'definite';
};

const COMPACT_ROLE_NEUTRAL_MARKERS = new Set([
  ...NON_STAFF_MARKERS,
  ...STALE_MARKERS,
]);
const COMPACT_NARROW_ROLE_MARKERS = new Set(
  [...NARROW_ROLE_MARKERS].filter((marker) => marker !== 'sub'),
);
const COMPACT_STALE_NEUTRAL_MARKERS = new Set([
  ...NON_STAFF_MARKERS,
  ...NARROW_ROLE_MARKERS,
]);

const hasBoundedGroupMarker = (
  group: CloudGroup,
  prefixContext: CompactPopulationPrefixContext,
  targetMarkers: ReadonlySet<string>,
  additionalNeutralMarkers: ReadonlySet<string>,
  compactTargetMarkers: ReadonlySet<string> = targetMarkers,
): boolean => {
  const tokenFields = groupTokenFields(group);
  if (hasAnyToken(tokenFields.combined, targetMarkers)) return true;
  const displayPrefixes = prefixesCorroboratedBy(
    prefixContext,
    tokenFields.localPart,
    tokenFields.displayName,
  );
  const localPartPrefixes = prefixesCorroboratedBy(
    prefixContext,
    tokenFields.displayName,
    tokenFields.localPart,
  );
  const boundedMarker =
    tokenFields.displayName.some((token) =>
      isCompactNamedMarkerToken(
        token,
        displayPrefixes,
        compactTargetMarkers,
        additionalNeutralMarkers,
      ),
    ) ||
    tokenFields.localPart.some((token) =>
      isCompactNamedMarkerToken(
        token,
        localPartPrefixes,
        compactTargetMarkers,
        additionalNeutralMarkers,
      ),
    );
  const terminalSuffixMarkers = new Set([
    ...COMPACT_WORD_BOUNDARIES,
    ...FACILITY_GENERIC_MARKERS,
    ...additionalNeutralMarkers,
  ]);
  return (
    boundedMarker ||
    hasSameFacilityTerminalMarker(
      prefixContext,
      tokenFields.displayName,
      tokenFields.localPart,
      compactTargetMarkers,
      terminalSuffixMarkers,
    )
  );
};

const hasRestrictedRoleGroupMarker = (
  group: CloudGroup,
  prefixContext: CompactPopulationPrefixContext,
): boolean =>
  hasBoundedGroupMarker(
    group,
    prefixContext,
    NARROW_ROLE_MARKERS,
    COMPACT_ROLE_NEUTRAL_MARKERS,
    COMPACT_NARROW_ROLE_MARKERS,
  );

const hasStaleGroupMarker = (
  group: CloudGroup,
  prefixContext: CompactPopulationPrefixContext,
): boolean =>
  hasBoundedGroupMarker(
    group,
    prefixContext,
    STALE_MARKERS,
    COMPACT_STALE_NEUTRAL_MARKERS,
  );

const shortYearValue = (
  token: string,
  referenceYear: number,
): number | null => {
  const match = /^(?:sy)?([0-9]{2})$/u.exec(token);
  if (match === null) return null;
  const shortYear = Number(match[1]);
  if (!token.startsWith('sy') && shortYear <= 12) return null;
  const referenceCentury = Math.floor(referenceYear / 100) * 100;
  let year = referenceCentury + shortYear;
  if (year > referenceYear + 50) year -= 100;
  return year;
};

const PSD_ACADEMIC_TIME_ZONE = 'America/Los_Angeles';
const PSD_ACADEMIC_DATE_FORMAT = new Intl.DateTimeFormat(
  'en-US-u-ca-gregory-nu-latn',
  {
    month: 'numeric',
    timeZone: PSD_ACADEMIC_TIME_ZONE,
    year: 'numeric',
  },
);

// PSD's operational school year turns over at July 1 in the district's local
// time zone. A UTC boundary would mark the new year seven or eight hours too
// early and could misclassify a just-ended academic-year group as current.
export const academicStartYearAt = (timestamp: Date): number => {
  const parts = PSD_ACADEMIC_DATE_FORMAT.formatToParts(timestamp);
  const year = Number(parts.find(({ type }) => type === 'year')?.value);
  const month = Number(parts.find(({ type }) => type === 'month')?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    throw new Error('Could not determine the PSD academic year.');
  }
  return month >= 7 ? year : year - 1;
};

const academicYearAliases = (
  academicStartYear: number,
): ReadonlySet<string> => {
  const academicEndYear = academicStartYear + 1;
  const start = String(academicStartYear);
  const end = String(academicEndYear);
  const shortStart = start.slice(-2);
  const shortEnd = end.slice(-2);
  const aliases = new Set([
    start,
    shortStart,
    `${start}${end}`,
    `${start}${shortEnd}`,
    `${shortStart}${shortEnd}`,
    `${start}to${end}`,
    `${shortStart}to${shortEnd}`,
    `${start}through${end}`,
    `${shortStart}through${shortEnd}`,
  ]);
  return new Set([...aliases, ...[...aliases].map((alias) => `sy${alias}`)]);
};

const parseAcademicYearDigits = (
  marker: string,
  referenceYear: number,
): number | null => {
  const explicitSchoolYear = marker.startsWith('sy');
  const digits = explicitSchoolYear ? marker.slice(2) : marker;
  if (digits.length === 2) {
    return shortYearValue(
      `${explicitSchoolYear ? 'sy' : ''}${digits}`,
      referenceYear,
    );
  }
  if (digits.length === 4 && /^(?:19|20)/u.test(digits)) {
    return Number(digits);
  }
  let first: number | null = null;
  let second: number | null = null;
  if (digits.length === 4) {
    first = shortYearValue(`sy${digits.slice(0, 2)}`, referenceYear);
    second = shortYearValue(`sy${digits.slice(2)}`, referenceYear);
  } else if (digits.length === 6 && /^(?:19|20)/u.test(digits)) {
    first = Number(digits.slice(0, 4));
    second = shortYearValue(`sy${digits.slice(4)}`, referenceYear);
  } else if (digits.length === 8 && /^(?:19|20)/u.test(digits)) {
    first = Number(digits.slice(0, 4));
    second = Number(digits.slice(4));
  }
  if (first === null || second === null) return null;
  if (second < first && first - second > 50) second += 100;
  return second === first + 1 ? first : null;
};

const academicYearStartMarkers = (
  group: CloudGroup,
  referenceYear: number,
): readonly number[] => {
  const markers = new Set<number>();
  const fields = groupTokenFields(group);
  for (const tokens of [fields.displayName, fields.localPart]) {
    for (const token of [...tokens, tokens.join('')]) {
      for (const match of token.matchAll(
        /(?:^|[^0-9])((?:sy)?(?:[0-9]{4}|[0-9]{2})(?:to|through)(?:[0-9]{4}|[0-9]{2}))(?![0-9])/gu,
      )) {
        const canonical = match[1]!.replace(/to|through/u, '');
        const value = parseAcademicYearDigits(canonical, referenceYear);
        if (value !== null) markers.add(value);
      }
      for (const match of token.matchAll(
        /(?:^|[^0-9])((?:sy)?(?:[0-9]{8}|[0-9]{6}|[0-9]{4}|[0-9]{2}))(?![0-9])/gu,
      )) {
        const value = parseAcademicYearDigits(match[1]!, referenceYear);
        if (value !== null) markers.add(value);
      }
    }
  }
  return [...markers].sort((left, right) => left - right);
};

const staleSignalReasons = (
  group: CloudGroup,
  prefixContext: CompactPopulationPrefixContext,
  referenceYear: number,
  academicStartYear: number,
  staffIdentityVerified = false,
): readonly string[] => {
  const reasons: string[] = [];
  if (hasStaleGroupMarker(group, prefixContext)) {
    reasons.push('GROUP_HAS_STALE_NAME_MARKER');
  }
  const academicYearStarts = academicYearStartMarkers(group, referenceYear);
  if (
    (staffIdentityVerified || hasStaffIdentityEvidence(group, prefixContext)) &&
    academicYearStarts.some((year) => year < academicStartYear)
  ) {
    reasons.push('GROUP_HAS_PRIOR_YEAR_MARKER');
  }
  return sortedUnique(reasons);
};

export const groupRef = (group: CloudGroup): DraftGroupRef => ({
  displayName: group.displayName,
  email: group.email,
  googleGroupId: group.googleGroupId,
});

export const parseCloudGroupForDomain = (
  value: unknown,
  expectedParent: string,
  hostedDomain = PSD_HOSTED_DOMAIN,
): CloudGroup => {
  if (!isRecord(value)) throw new Error('Google returned a malformed group.');
  const name = requireString(value.name, 'Google group resource name', 255);
  if (!/^groups\/[A-Za-z0-9_-]{1,248}$/u.test(name)) {
    throw new Error('Google returned an invalid group resource name.');
  }
  if (value.parent !== expectedParent) {
    throw new Error('Google returned a group from an unexpected customer.');
  }
  if (!isRecord(value.groupKey)) {
    throw new Error('Google returned a group without a valid primary key.');
  }
  const email = requireString(
    value.groupKey.id,
    'Google group email',
    320,
  ).toLocaleLowerCase('en-US');
  if (!isHostedGroupEmail(email, hostedDomain)) {
    throw new Error('Google returned a group outside the PSD hosted domain.');
  }
  const displayName =
    value.displayName === undefined ||
    value.displayName === null ||
    value.displayName === ''
      ? null
      : requireString(value.displayName, 'Google group display name', 160);
  if (displayName !== null && hasUnsafeDisplayControl(displayName)) {
    throw new Error('Google returned an unsafe group display name.');
  }
  return {
    displayName,
    email,
    googleGroupId: name,
  };
};

export const parseGroupPage = (
  value: unknown,
  expectedParent: string,
  hostedDomain = PSD_HOSTED_DOMAIN,
): GroupPage => {
  if (!isRecord(value)) {
    throw new Error('Google returned a malformed groups page.');
  }
  const rawGroups = value.groups === undefined ? [] : value.groups;
  if (!Array.isArray(rawGroups) || rawGroups.length > MAX_GROUPS_PER_PAGE) {
    throw new Error('Google returned a malformed groups page.');
  }
  const groups = rawGroups.map((group) =>
    parseCloudGroupForDomain(group, expectedParent, hostedDomain),
  );
  const rawToken = value.nextPageToken;
  const nextPageToken =
    rawToken === undefined || rawToken === null || rawToken === ''
      ? null
      : requireString(rawToken, 'Google next-page token', 2_048);
  return { groups, nextPageToken };
};

export const inventoryAllGroups = async (
  fetchPage: PageFetcher,
  customerId: string,
  hostedDomain = PSD_HOSTED_DOMAIN,
): Promise<InventoryResult> => {
  const groups: CloudGroup[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | null = null;
  let pageCount = 0;

  while (true) {
    if (pageCount >= MAX_PAGES) {
      throw new Error('Google Groups pagination exceeded its page limit.');
    }
    const page = parseGroupPage(
      await fetchPage(pageToken),
      `customers/${customerId}`,
      hostedDomain,
    );
    pageCount += 1;
    groups.push(...page.groups);
    if (groups.length > MAX_GROUPS) {
      throw new Error('Google returned more groups than the safety limit.');
    }
    if (page.nextPageToken === null) break;
    if (seenTokens.has(page.nextPageToken)) {
      throw new Error('Google Groups pagination repeated a page token.');
    }
    seenTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }

  const ids = new Set<string>();
  const emails = new Set<string>();
  for (const group of groups) {
    if (ids.has(group.googleGroupId) || emails.has(group.email)) {
      throw new Error('Google returned duplicate group identity metadata.');
    }
    ids.add(group.googleGroupId);
    emails.add(group.email);
  }
  return {
    groups: [...groups].sort((left, right) =>
      compareText(left.email, right.email),
    ),
    pageCount,
  };
};

export const readBoundedStream = async (
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  label: string,
): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the fixed, sanitized size-limit failure.
        }
        throw new Error(`${label} exceeded its size limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
};

const cancelResponseBodySafely = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup diagnostics are untrusted and must not replace fixed errors.
  }
};

export const readBoundedResponseJson = async (
  response: Response,
): Promise<unknown> => {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await cancelResponseBodySafely(response);
    throw new Error('Google response exceeded its size limit.');
  }
  if (response.body === null)
    throw new Error('Google returned an empty response.');
  const text = await readBoundedStream(
    response.body,
    MAX_RESPONSE_BYTES,
    'Google response',
  );
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error('Google returned invalid JSON.', { cause: error });
  }
};

export const createCloudIdentityFetcher =
  (
    accessToken: string,
    customerId: string,
    quotaProject: string,
    fetchImplementation: HttpFetch = fetch,
  ): PageFetcher =>
  async (pageToken) => {
    const url = new URL('/v1/groups:search', CLOUD_IDENTITY_ORIGIN);
    url.searchParams.set('query', `parent == 'customers/${customerId}'`);
    url.searchParams.set('view', 'FULL');
    url.searchParams.set(
      'fields',
      'groups(name,parent,groupKey(id),displayName),nextPageToken',
    );
    url.searchParams.set('pageSize', '500');
    if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
    if (url.origin !== CLOUD_IDENTITY_ORIGIN) {
      throw new Error(
        'Refusing to send Google credentials to an unexpected URL.',
      );
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImplementation(url, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'X-Goog-User-Project': quotaProject,
          },
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (attempt === 3) {
          throw new Error('The read-only Google Groups request failed.', {
            cause: error,
          });
        }
        await Bun.sleep(attempt * 500);
        continue;
      }
      if (response.ok) {
        try {
          return await readBoundedResponseJson(response);
        } catch (error) {
          if (attempt === 3) {
            throw new Error(
              'Google repeatedly returned an unreadable groups response.',
              { cause: error },
            );
          }
          await Bun.sleep(attempt * 500);
          continue;
        }
      }
      const retryable =
        (response.status === 429 || response.status >= 500) && attempt < 3;
      if (retryable) {
        await cancelResponseBodySafely(response);
        await Bun.sleep(attempt * 500);
        continue;
      }
      await cancelResponseBodySafely(response);
      throw new Error(
        `The read-only Google Groups request failed with HTTP ${response.status}.`,
      );
    }
    throw new Error(
      'The read-only Google Groups request exhausted its retries.',
    );
  };

export const gcloudTokenArguments = (
  gcloudExecutable: string,
  serviceAccount: string,
): string[] => [
  gcloudExecutable,
  'auth',
  'application-default',
  'print-access-token',
  `--impersonate-service-account=${serviceAccount}`,
  `--scopes=${CLOUD_IDENTITY_SCOPE}`,
  '--lifetime=900s',
  '--quiet',
];

export const UNSAFE_AUTH_ENVIRONMENT_KEYS = new Set([
  'ALL_PROXY',
  'BUN_OPTIONS',
  'BUN_CONFIG_CA',
  'BUN_CONFIG_CAFILE',
  'CURL_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NO_PROXY',
  'SSLKEYLOGFILE',
  'VIRTUAL_ENV',
  'XDG_CONFIG_HOME',
]);

const UNSAFE_AUTH_ENVIRONMENT_PREFIXES = [
  'CLOUDSDK_',
  'CURL_',
  'DYLD_',
  'GCE_',
  'GCLOUD_',
  'GOOGLE_',
  'GRPC_',
  'LD_',
  'OPENSSL_',
  'PYTHON',
  'REQUESTS_',
  'SSL_',
] as const;

export const assertSafeAuthenticationEnvironment = (
  source: Readonly<Record<string, string | undefined>>,
): void => {
  for (const [key, value] of Object.entries(source)) {
    if ((value ?? '').trim() === '') continue;
    const normalizedKey = key.toUpperCase();
    if (
      UNSAFE_AUTH_ENVIRONMENT_KEYS.has(normalizedKey) ||
      UNSAFE_AUTH_ENVIRONMENT_PREFIXES.some((prefix) =>
        normalizedKey.startsWith(prefix),
      )
    ) {
      throw new Error(
        `Refusing ${key}; authentication and TLS execution settings may not be overridden.`,
      );
    }
  }
};

export const createHumanAdcEnvironment = (
  source: Readonly<Record<string, string | undefined>>,
  verifiedAdcPath: string,
  isolatedGcloudConfigPath: string,
  gcloudExecutable: string,
  operatingSystemHome: string,
): Record<string, string> => {
  assertSafeAuthenticationEnvironment(source);
  if (
    !verifiedAdcPath.startsWith('/') ||
    !isolatedGcloudConfigPath.startsWith('/') ||
    !gcloudExecutable.startsWith('/') ||
    !operatingSystemHome.startsWith('/')
  ) {
    throw new Error(
      'Credential, configuration, and gcloud paths must be absolute.',
    );
  }
  return {
    CLOUDSDK_API_ENDPOINT_OVERRIDES_IAMCREDENTIALS:
      'https://iamcredentials.googleapis.com/',
    CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: verifiedAdcPath,
    CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION: 'false',
    CLOUDSDK_AUTH_MTLS_TOKEN_HOST: 'https://oauth2.mtls.googleapis.com/token',
    CLOUDSDK_AUTH_TOKEN_HOST: 'https://oauth2.googleapis.com/token',
    CLOUDSDK_CONFIG: isolatedGcloudConfigPath,
    CLOUDSDK_CONTEXT_AWARE_USE_CLIENT_CERTIFICATE: 'false',
    CLOUDSDK_CORE_UNIVERSE_DOMAIN: 'googleapis.com',
    GOOGLE_APPLICATION_CREDENTIALS: verifiedAdcPath,
    GOOGLE_CLOUD_UNIVERSE_DOMAIN: 'googleapis.com',
    HOME: operatingSystemHome,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: sortedUnique([
      dirname(gcloudExecutable),
      '/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/usr/local/bin',
      '/usr/sbin',
      '/sbin',
    ]).join(':'),
    TERM: 'dumb',
    TMPDIR: isolatedGcloudConfigPath,
  };
};

export const parseInteractiveUserAdc = (value: unknown): void => {
  if (!isRecord(value) || value.type !== 'authorized_user') {
    throw new Error(
      'Application Default Credentials must come from an interactive user login.',
    );
  }
  for (const key of ['client_id', 'client_secret', 'refresh_token'] as const) {
    requireString(value[key], 'Interactive user ADC field', 16_384);
  }
  if (
    'service_account_impersonation_url' in value ||
    'credential_source' in value ||
    'subject_token_type' in value ||
    (value.token_uri !== undefined &&
      value.token_uri !== 'https://oauth2.googleapis.com/token') ||
    (value.universe_domain !== undefined &&
      value.universe_domain !== 'googleapis.com')
  ) {
    throw new Error(
      'Application Default Credentials may not embed non-user credential provenance.',
    );
  }
};

const verifyInteractiveUserAdc = async (
  operatingSystemHome: string,
): Promise<string> => {
  const adcPath = await requirePathOutsideGitRepository(
    join(
      operatingSystemHome,
      '.config',
      'gcloud',
      'application_default_credentials.json',
    ),
    'Interactive Application Default Credentials',
  );
  parseInteractiveUserAdc(
    await readPrivateJson(
      adcPath,
      'Interactive Application Default Credentials',
      MAX_ADC_FILE_BYTES,
    ),
  );
  return adcPath;
};

export interface GcloudPathMetadata {
  readonly mode: number;
  readonly uid: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

const hasTrustedGcloudOwner = (
  metadata: GcloudPathMetadata,
  currentUid: number,
): boolean => metadata.uid === 0 || metadata.uid === currentUid;

export const isTrustedGcloudExecutableMetadata = (
  metadata: GcloudPathMetadata,
  currentUid: number,
): boolean =>
  metadata.isFile() &&
  hasTrustedGcloudOwner(metadata, currentUid) &&
  (metadata.mode & 0o111) !== 0 &&
  (metadata.mode & 0o022) === 0;

export const isTrustedGcloudAncestorMetadata = (
  metadata: GcloudPathMetadata,
  currentUid: number,
): boolean =>
  metadata.isDirectory() &&
  hasTrustedGcloudOwner(metadata, currentUid) &&
  (metadata.mode & 0o022) === 0;

const isTrustedGcloudExecutablePath = async (
  actualPath: string,
): Promise<boolean> => {
  const currentUid = userInfo().uid;
  const executableMetadata = await lstat(actualPath);
  if (!isTrustedGcloudExecutableMetadata(executableMetadata, currentUid)) {
    return false;
  }

  let ancestor = dirname(actualPath);
  while (true) {
    const metadata = await lstat(ancestor);
    if (!isTrustedGcloudAncestorMetadata(metadata, currentUid)) return false;
    const parent = dirname(ancestor);
    if (parent === ancestor) return true;
    ancestor = parent;
  }
};

const resolveGcloudExecutable = async (
  operatingSystemHome: string,
): Promise<string> => {
  const approvedInstallLocations = [
    '/opt/homebrew/bin/gcloud',
    '/snap/bin/gcloud',
    '/usr/bin/gcloud',
    '/usr/local/bin/gcloud',
    join(operatingSystemHome, 'google-cloud-sdk', 'bin', 'gcloud'),
    join(operatingSystemHome, 'Library', 'google-cloud-sdk', 'bin', 'gcloud'),
  ];
  for (const candidate of approvedInstallLocations) {
    if ((await statIfPresent(candidate)) === null) continue;
    const actualPath = await requirePathOutsideGitRepository(
      candidate,
      'gcloud executable',
    );
    if (await isTrustedGcloudExecutablePath(actualPath)) {
      return actualPath;
    }
  }
  throw new Error(
    'gcloud was not found in an approved installation location or its ownership and permission chain was not trusted.',
  );
};

const obtainImpersonatedToken = async (
  serviceAccount: string,
): Promise<string> => {
  assertSafeAuthenticationEnvironment(process.env);
  const operatingSystemHome = userInfo().homedir;
  const adcPath = await verifyInteractiveUserAdc(operatingSystemHome);
  const isolatedGcloudConfigPath = await createIsolatedGcloudConfigPath();
  try {
    // Resolve and verify immediately before the synchronous spawn call. Bun
    // cannot execute an already-open file descriptor on every supported OS;
    // the trusted, non-writable ownership chain prevents an untrusted actor
    // from replacing the resolved executable in this remaining interval.
    const gcloudExecutable = await resolveGcloudExecutable(operatingSystemHome);
    const environment = createHumanAdcEnvironment(
      process.env,
      adcPath,
      isolatedGcloudConfigPath,
      gcloudExecutable,
      operatingSystemHome,
    );
    const subprocess = Bun.spawn(
      gcloudTokenArguments(gcloudExecutable, serviceAccount),
      {
        env: environment,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    );
    const stdout = readBoundedStream(
      subprocess.stdout,
      16_000,
      'gcloud token output',
    );
    const stderr = readBoundedStream(
      subprocess.stderr,
      64_000,
      'gcloud diagnostic output',
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
      timeout = setTimeout(() => {
        try {
          subprocess.kill(9);
        } catch {
          // A process that exited on the timeout boundary needs no signal.
        }
        resolve({ kind: 'timeout' });
      }, 30_000);
    });
    const completion = await Promise.race([
      subprocess.exited.then((exitCode) => ({
        exitCode,
        kind: 'exited' as const,
      })),
      timedOut,
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (completion.kind === 'timeout') {
      await Promise.race([
        Promise.allSettled([stdout, stderr, subprocess.exited]),
        Bun.sleep(2_000),
      ]);
      throw new Error('gcloud token generation timed out.');
    }
    const [tokenOutput] = await Promise.all([stdout, stderr]);
    if (completion.exitCode !== 0) {
      throw new Error(
        'gcloud could not issue the impersonated read-only token. Complete the documented human ADC login and IAM grants.',
      );
    }
    const token = tokenOutput.trim();
    if (!/^[\x21-\x7E]{20,8192}$/u.test(token)) {
      throw new Error('gcloud returned a malformed access token.');
    }
    return token;
  } finally {
    await rm(isolatedGcloudConfigPath, { force: true, recursive: true });
  }
};

interface ScoredGroup {
  readonly group: CloudGroup;
  readonly score: number;
  readonly reasonCodes: readonly string[];
  readonly strongEligible: boolean;
}

export interface DraftDerivationMetrics {
  facilityGroupScoreEvaluations: number;
  facilityTerminalContextEvaluations: number;
}

const WHOLE_BUILDING_MARKERS = [
  'all',
  'and',
  'bldg',
  'building',
  'campus',
  'employee',
  'employees',
  'group',
  'groups',
  'list',
  'lists',
  'member',
  'members',
  'or',
  'school',
  'staff',
  'team',
  'teams',
] as const;

const WHOLE_BUILDING_WORKFORCE_MARKERS = new Set([
  'employee',
  'employees',
  'staff',
]);

type WholeBuildingFieldState = 'facility' | 'facility-workforce' | 'invalid';

const NON_DISTINCTIVE_AUTOMATIC_FACILITY_ALIASES = new Set([
  ...WHOLE_BUILDING_MARKERS,
  ...FACILITY_GENERIC_MARKERS,
  ...AGGREGATE_FACILITY_NAME_MARKERS,
  ...GENERIC_AUTOMATIC_FACILITY_CODE_ALIASES,
  ...COMPACT_ORGANIZATION_PREFIXES,
  ...WEAK_NEIGHBORHOOD_STEMS,
  ...STAFF_IDENTITY_MARKERS,
  ...NON_STAFF_MARKERS,
  ...STALE_MARKERS,
  'academies',
  'allusers',
  'campuses',
  'community',
  'department',
  'departments',
  'dist',
  'districts',
  'division',
  'divisions',
  'enterprise',
  'everybody',
  'everyone',
  'facilities',
  'facility',
  'global',
  'network',
  'office',
  'offices',
  'organization',
  'organizations',
  'organisation',
  'organisations',
  'other',
  'others',
  'people',
  'personnel',
  'psd401',
  'site',
  'sites',
  'system',
  'systems',
  'user',
  'users',
  'wide',
  'workforce',
]);

const isFullyNonDistinctiveAutomaticAlias = (alias: string): boolean => {
  const reachable = new Set([0]);
  for (let offset = 0; offset < alias.length; offset += 1) {
    if (!reachable.has(offset)) continue;
    for (const marker of NON_DISTINCTIVE_AUTOMATIC_FACILITY_ALIASES) {
      if (marker !== '' && alias.startsWith(marker, offset)) {
        reachable.add(offset + marker.length);
      }
    }
    const numeric = /^[0-9]+/u.exec(alias.slice(offset));
    if (numeric !== null) reachable.add(offset + numeric[0].length);
  }
  return reachable.has(alias.length);
};

const isDistinctiveAutomaticFacilityAlias = (value: string): boolean => {
  const alias = tokensOf(value).join('');
  return alias.length >= 3 && !isFullyNonDistinctiveAutomaticAlias(alias);
};

export const siteSpecificFacilityNameTokens = (
  facility: Facility,
): readonly string[] =>
  tokensOf(facility.name).filter(
    (token) =>
      !FACILITY_GENERIC_MARKERS.has(token) &&
      !AGGREGATE_FACILITY_NAME_MARKERS.has(token),
  );

const hasSiteSpecificAutomaticFacilityIdentity = (
  facility: Facility,
): boolean => {
  const nameTokens = tokensOf(facility.name);
  if (
    nameTokens.some((token) =>
      DISQUALIFYING_AGGREGATE_FACILITY_NAME_MARKERS.has(token),
    )
  ) {
    return false;
  }
  if (
    !nameTokens.some((token) => AUTOMATIC_PHYSICAL_SITE_TYPE_MARKERS.has(token))
  ) {
    return false;
  }
  const siteSpecificTokens = [
    ...new Set(siteSpecificFacilityNameTokens(facility)),
  ];
  const hasDistinctiveToken = siteSpecificTokens.some(
    (token) =>
      !WEAK_NEIGHBORHOOD_STEMS.has(token) &&
      isDistinctiveAutomaticFacilityAlias(token),
  );
  if (!hasDistinctiveToken) return false;
  return siteSpecificTokens.length > 0;
};

const isFacilitySpecificCodeAlias = (facility: Facility): boolean => {
  if (!hasSiteSpecificAutomaticFacilityIdentity(facility)) return false;
  const codeTokens = tokensOf(facility.code);
  const alias = codeTokens.join('');
  if (!isDistinctiveAutomaticFacilityAlias(alias)) return false;
  const nameTokens = tokensOf(facility.name);
  const siteSpecificTokens = siteSpecificFacilityNameTokens(facility);
  const initialisms = new Set([
    nameTokens.map((token) => token[0] ?? '').join(''),
    siteSpecificTokens.map((token) => token[0] ?? '').join(''),
  ]);
  if (initialisms.has(alias)) return true;
  if (
    codeTokens.length === 1 &&
    siteSpecificTokens.some(
      (token) => token === alias || token.startsWith(alias),
    )
  ) {
    return true;
  }
  return false;
};

const compactFacilityAliases = (facility: Facility): readonly string[] => {
  if (!hasSiteSpecificAutomaticFacilityIdentity(facility)) return [];
  const codeAlias = tokensOf(facility.code).join('');
  const stemTokens = siteSpecificFacilityNameTokens(facility);
  const stemAlias = stemTokens.join('');
  const fullNameTokens = tokensOf(facility.name);
  const fullNameAlias = fullNameTokens.join('');
  return sortedUnique([
    ...(isFacilitySpecificCodeAlias(facility) ? [codeAlias] : []),
    ...(isDistinctiveAutomaticFacilityAlias(stemAlias) ? [stemAlias] : []),
    ...(isDistinctiveAutomaticFacilityAlias(fullNameAlias)
      ? [fullNameAlias]
      : []),
  ]);
};

const hasBoundaryPreservingAutomaticFacilityEvidence = (
  tokens: readonly string[],
  facility: Facility,
  aliases: readonly string[],
): boolean => {
  if (aliases.some((alias) => tokens.some((token) => token.includes(alias)))) {
    return true;
  }
  return [
    tokensOf(facility.code),
    siteSpecificFacilityNameTokens(facility),
    tokensOf(facility.name),
  ].some(
    (sequence) =>
      aliases.includes(sequence.join('')) && containsSequence(tokens, sequence),
  );
};

const wholeBuildingFieldStateForAliases = (
  tokens: readonly string[],
  aliases: readonly string[],
  academicStartYear: number,
): WholeBuildingFieldState => {
  const compact = tokens.join('');
  if (compact === '') return 'invalid';
  const currentAcademicYearAliases = academicYearAliases(academicStartYear);
  const states = new Map<
    number,
    Set<'none' | 'facility' | 'workforce' | 'facility-workforce'>
  >([[0, new Set(['none'])]]);
  const addState = (
    offset: number,
    facilitySeen: boolean,
    workforceSeen: boolean,
  ): void => {
    const key = facilitySeen
      ? workforceSeen
        ? 'facility-workforce'
        : 'facility'
      : workforceSeen
        ? 'workforce'
        : 'none';
    const current = states.get(offset) ?? new Set();
    current.add(key);
    states.set(offset, current);
  };
  for (let offset = 0; offset < compact.length; offset += 1) {
    for (const state of states.get(offset) ?? []) {
      const facilitySeen = state.includes('facility');
      const workforceSeen = state.includes('workforce');
      if (!facilitySeen) {
        for (const alias of aliases) {
          if (compact.startsWith(alias, offset)) {
            addState(offset + alias.length, true, workforceSeen);
          }
        }
      }
      for (const marker of WHOLE_BUILDING_MARKERS) {
        if (compact.startsWith(marker, offset)) {
          addState(
            offset + marker.length,
            facilitySeen,
            workforceSeen || WHOLE_BUILDING_WORKFORCE_MARKERS.has(marker),
          );
        }
      }
      for (const academicYearAlias of currentAcademicYearAliases) {
        if (compact.startsWith(academicYearAlias, offset)) {
          addState(
            offset + academicYearAlias.length,
            facilitySeen,
            workforceSeen,
          );
        }
      }
    }
  }
  const finalStates = states.get(compact.length);
  if (finalStates?.has('facility-workforce') === true) {
    return 'facility-workforce';
  }
  return finalStates?.has('facility') === true ? 'facility' : 'invalid';
};

const wholeBuildingFieldState = (
  tokens: readonly string[],
  facility: Facility,
  academicStartYear: number,
): WholeBuildingFieldState => {
  const aliases = compactFacilityAliases(facility);
  if (
    !hasBoundaryPreservingAutomaticFacilityEvidence(tokens, facility, aliases)
  ) {
    return 'invalid';
  }
  return wholeBuildingFieldStateForAliases(tokens, aliases, academicStartYear);
};

export const isExactWholeBuildingIdentity = (
  facility: Facility,
  group: CloudGroup,
  academicStartYear: number,
): boolean => {
  if (
    group.displayName === null ||
    hasUnsupportedIdentityContent(group.displayName)
  ) {
    return false;
  }
  const localPart = group.email.slice(0, group.email.lastIndexOf('@'));
  if (hasUnsupportedIdentityContent(localPart)) return false;
  const fields = groupTokenFields(group);
  const displayNameState = wholeBuildingFieldState(
    fields.displayName,
    facility,
    academicStartYear,
  );
  const localPartState = wholeBuildingFieldState(
    fields.localPart,
    facility,
    academicStartYear,
  );
  return (
    displayNameState !== 'invalid' &&
    localPartState !== 'invalid' &&
    (displayNameState === 'facility-workforce' ||
      localPartState === 'facility-workforce')
  );
};

const hasAmbiguousStaffScope = (
  group: CloudGroup,
  academicStartYear: number,
  automaticContexts: ReadonlySet<CompactFacilityPrefixContext>,
): boolean => {
  for (const { facility } of automaticContexts) {
    if (!isExactWholeBuildingIdentity(facility, group, academicStartYear)) {
      return true;
    }
  }
  return false;
};

const scoreGroupForFacility = (
  facility: Facility,
  group: CloudGroup,
  academicStartYear: number,
): ScoredGroup => {
  const tokenFields = groupTokenFields(group);
  const tokens = tokenFields.combined;
  const codeTokens = tokensOf(facility.code);
  const stemTokens = siteSpecificFacilityNameTokens(facility);
  const codeIsDistinctive = isFacilitySpecificCodeAlias(facility);
  const exactCode =
    codeIsDistinctive &&
    (containsSequence(tokenFields.displayName, codeTokens) ||
      containsSequence(tokenFields.localPart, codeTokens));
  const exactStem =
    hasSiteSpecificAutomaticFacilityIdentity(facility) &&
    isDistinctiveAutomaticFacilityAlias(stemTokens.join('')) &&
    (containsSequence(tokenFields.displayName, stemTokens) ||
      containsSequence(tokenFields.localPart, stemTokens));
  const exactWholeBuildingIdentity = isExactWholeBuildingIdentity(
    facility,
    group,
    academicStartYear,
  );
  const broadStaff =
    hasAnyToken(tokens, STAFF_MARKERS) || exactWholeBuildingIdentity;
  const narrowRole = hasAnyToken(tokens, NARROW_ROLE_MARKERS);
  const staleMarker = hasAnyToken(tokens, STALE_MARKERS);
  const reasonCodes: string[] = [];
  let score = 0;
  if (exactCode) {
    score += 100;
    reasonCodes.push('EXACT_FACILITY_CODE');
  }
  if (exactStem) {
    score += 90;
    reasonCodes.push('EXACT_DISTINCTIVE_NAME_STEM');
  }
  if (exactWholeBuildingIdentity && !exactCode && !exactStem) {
    score += 100;
    reasonCodes.push('EXACT_FULLY_CONSUMED_FACILITY_IDENTITY');
  }
  if (broadStaff) {
    score += 20;
    reasonCodes.push('BROAD_STAFF_MARKER');
  }
  if (narrowRole) reasonCodes.push('NARROW_ROLE_MARKER');
  if (staleMarker) reasonCodes.push('STALE_NAME_MARKER');
  if (group.displayName === null) {
    reasonCodes.push('MISSING_GROUP_DISPLAY_NAME');
  }
  return {
    group,
    reasonCodes: sortedUnique(reasonCodes),
    score,
    strongEligible:
      broadStaff &&
      !narrowRole &&
      !staleMarker &&
      group.displayName !== null &&
      exactWholeBuildingIdentity,
  };
};

const compareScoredGroups = (left: ScoredGroup, right: ScoredGroup): number =>
  right.score - left.score ||
  compareText(left.group.email, right.group.email) ||
  compareText(left.group.googleGroupId, right.group.googleGroupId);

interface ScoredFacility {
  readonly facility: Facility;
  readonly scored: ScoredGroup;
}

const compareScoredFacilities = (
  left: ScoredFacility,
  right: ScoredFacility,
): number =>
  right.scored.score - left.scored.score ||
  compareText(left.facility.id, right.facility.id);

export const retainBest = <Value>(
  values: Value[],
  value: Value,
  compare: (left: Value, right: Value) => number,
  limit: number,
): void => {
  const insertionIndex = values.findIndex(
    (existing) => compare(value, existing) < 0,
  );
  if (insertionIndex < 0) {
    if (values.length < limit) values.push(value);
    return;
  }
  values.splice(insertionIndex, 0, value);
  if (values.length > limit) values.pop();
};

const candidateFromScore = (score: ScoredGroup): MatchCandidate => ({
  ...groupRef(score.group),
  heuristicScore: score.score,
  reasonCodes: score.reasonCodes,
});

const hasClearLead = (
  best: ScoredGroup,
  runnerUp: ScoredGroup | undefined,
): boolean => runnerUp === undefined || best.score - runnerUp.score >= 30;

const createNeighborhoodProposals = (
  facilities: readonly Facility[],
): {
  readonly proposals: readonly NeighborhoodProposal[];
  readonly skippedFindings: readonly SkippedNeighborhoodHint[];
  readonly warnings: readonly string[];
} => {
  const byStem = new Map<string, Facility[]>();
  for (const facility of facilities) {
    if (!facility.active) continue;
    const stemTokens = facilityStemTokens(facility);
    if (!hasDistinctiveStem(stemTokens)) continue;
    const stem = stemTokens.join(' ');
    const current = byStem.get(stem) ?? [];
    current.push(facility);
    byStem.set(stem, current);
  }
  const proposals: NeighborhoodProposal[] = [];
  const skippedFindings: SkippedNeighborhoodHint[] = [];
  const warnings = new Set<string>();
  for (const [stem, members] of [...byStem.entries()].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    if (members.length < 2) continue;
    const name = `${stem
      .split(' ')
      .map((token) => `${token.slice(0, 1).toUpperCase()}${token.slice(1)}`)
      .join(' ')} neighborhood`;
    const proposedInput = {
      facilityIds: members.map(({ id }) => id).sort(compareText),
      name,
      neighborhoodId: null,
    };
    let parsedInput =
      CreateNeighborhoodVersionInputSchema.safeParse(proposedInput);
    let usedFallbackName = false;
    if (!parsedInput.success) {
      parsedInput = CreateNeighborhoodVersionInputSchema.safeParse({
        ...proposedInput,
        name: `Proposed neighborhood ${
          [...members].sort((left, right) =>
            compareText(left.code, right.code),
          )[0]!.code
        }`,
      });
      usedFallbackName = parsedInput.success;
    }
    if (!parsedInput.success) {
      warnings.add('NEIGHBORHOOD_HINT_SKIPPED_CONTRACT_LIMIT');
      skippedFindings.push({
        facilityIds: members.map(({ id }) => id).sort(compareText),
        reasonCodes: ['NEIGHBORHOOD_HINT_SKIPPED_CONTRACT_LIMIT'],
      });
      continue;
    }
    const createNeighborhoodVersion = parsedInput.data;
    const generatedHint = {
      createNeighborhoodVersion,
      heuristicStrength: 'low' as const,
      reasonCodes: [
        'NAME_ONLY_HINT',
        'NO_GEOGRAPHY_EVIDENCE',
        'SHARED_EXACT_NAME_STEM',
        ...(usedFallbackName ? ['CONTRACT_SAFE_FALLBACK_NAME'] : []),
      ],
    };
    proposals.push({
      createNeighborhoodVersion,
      generatedHint,
      reviewDecision: 'pending',
      reviewNote: null,
    });
  }
  return {
    proposals,
    skippedFindings: skippedFindings.sort((left, right) =>
      compareText(left.facilityIds.join(','), right.facilityIds.join(',')),
    ),
    warnings: [...warnings].sort(compareText),
  };
};

export const buildDraft = (
  facilitiesInput: readonly Facility[],
  groupsInput: readonly CloudGroup[],
  pageCount: number,
  generatedAt: string,
  derivationMetrics?: DraftDerivationMetrics,
): MappingDraft => {
  const validatedGeneratedAt = requireAbsoluteTimestamp(
    generatedAt,
    'Draft generation time',
  );
  const referenceDate = new Date(validatedGeneratedAt);
  const referenceYear = referenceDate.getUTCFullYear();
  const academicStartYear = academicStartYearAt(referenceDate);
  const facilities = [...facilitiesInput].sort(
    (left, right) =>
      compareText(left.code, right.code) || compareText(left.id, right.id),
  );
  const groups = [...groupsInput].sort(
    (left, right) =>
      compareText(left.email, right.email) ||
      compareText(left.googleGroupId, right.googleGroupId),
  );
  const allowedCompactPrefixes = compactPopulationPrefixes(
    facilities,
    derivationMetrics,
  );
  const populationClassifications = new Map(
    groups.map((group) => [
      group.googleGroupId,
      classifyPopulationGroup(group, allowedCompactPrefixes, academicStartYear),
    ]),
  );
  const excluded = new Set(
    groups
      .filter(
        (group) =>
          populationClassifications.get(group.googleGroupId) !== 'none' ||
          !hasSerializableStaffIdentity(group, allowedCompactPrefixes),
      )
      .map(({ googleGroupId }) => googleGroupId),
  );
  const eligibleGroups = groups.filter(
    ({ googleGroupId }) => !excluded.has(googleGroupId),
  );
  const restrictedRoles = new Set(
    eligibleGroups
      .filter((group) =>
        hasRestrictedRoleGroupMarker(group, allowedCompactPrefixes),
      )
      .map(({ googleGroupId }) => googleGroupId),
  );
  const staleReasonsByGroup = new Map(
    eligibleGroups.map((group) => [
      group.googleGroupId,
      staleSignalReasons(
        group,
        allowedCompactPrefixes,
        referenceYear,
        academicStartYear,
        true,
      ),
    ]),
  );
  const staleGroups = new Set(
    [...staleReasonsByGroup]
      .filter(([, reasons]) => reasons.length > 0)
      .map(([googleGroupId]) => googleGroupId),
  );
  const ambiguousStaffScopes = new Set<string>();
  const groupsMatchingInactiveFacility = new Set<string>();
  const mutableScoresByFacility = new Map(
    facilities.map((facility) => [facility.id, [] as ScoredGroup[]]),
  );
  const scoresByGroup = new Map<string, ScoredFacility[]>();
  for (const group of eligibleGroups) {
    const automaticMatches = automaticFacilityContextsForGroup(
      allowedCompactPrefixes,
      group,
    );
    const isRestricted = restrictedRoles.has(group.googleGroupId);
    const isStale = staleGroups.has(group.googleGroupId);
    const hasAmbiguousScope =
      !isRestricted &&
      !isStale &&
      (automaticMatches.overflow ||
        hasAmbiguousStaffScope(
          group,
          academicStartYear,
          automaticMatches.contexts,
        ));
    if (hasAmbiguousScope) ambiguousStaffScopes.add(group.googleGroupId);
    const isMatchable = !isRestricted && !isStale && !hasAmbiguousScope;

    if (!isMatchable) {
      if (automaticMatches.overflow && automaticMatches.hasInactiveContext) {
        groupsMatchingInactiveFacility.add(group.googleGroupId);
      }
      for (const { facility } of automaticMatches.contexts) {
        if (facility.active) continue;
        if (derivationMetrics !== undefined) {
          derivationMetrics.facilityGroupScoreEvaluations += 1;
        }
        if (
          scoreGroupForFacility(facility, group, academicStartYear).score >= 90
        ) {
          groupsMatchingInactiveFacility.add(group.googleGroupId);
          break;
        }
      }
      continue;
    }

    const groupScores: ScoredFacility[] = [];
    for (const { facility } of automaticMatches.contexts) {
      if (derivationMetrics !== undefined) {
        derivationMetrics.facilityGroupScoreEvaluations += 1;
      }
      const scored = scoreGroupForFacility(facility, group, academicStartYear);
      if (scored.score < 90) continue;
      if (!facility.active) {
        groupsMatchingInactiveFacility.add(group.googleGroupId);
      }
      retainBest(groupScores, { facility, scored }, compareScoredFacilities, 2);
      const facilityScores = mutableScoresByFacility.get(facility.id);
      if (facilityScores !== undefined) {
        retainBest(facilityScores, scored, compareScoredGroups, 3);
      }
    }
    scoresByGroup.set(group.googleGroupId, groupScores);
  }
  const scoresByFacility = mutableScoresByFacility;

  const mappings: BuildingMapping[] = [];
  for (const facility of facilities) {
    const ranked = scoresByFacility.get(facility.id) ?? [];
    const best = ranked[0];
    const candidateScores = ranked.slice(0, 3);
    const candidates = candidateScores.map(candidateFromScore);
    const assessmentReasons: string[] = [];
    let outcome: MatchOutcome =
      candidates.length === 0 ? 'missing' : 'uncertain';
    let createGroupSource: GoogleBuildingGroupSource | null = null;

    if (!facility.active) {
      assessmentReasons.push('INACTIVE_FACILITY');
    } else if (
      best !== undefined &&
      best.score >= 110 &&
      best.strongEligible &&
      hasClearLead(best, ranked[1])
    ) {
      const reverseScores = scoresByGroup.get(best.group.googleGroupId) ?? [];
      const reverseBest = reverseScores[0];
      const reverseRunnerUp = reverseScores[1];
      const reverseUnique =
        reverseBest?.facility.id === facility.id &&
        (reverseRunnerUp === undefined ||
          reverseBest.scored.score - reverseRunnerUp.scored.score >= 30);
      if (reverseUnique) {
        createGroupSource = parseGroupSourceFromDraft({
          active: true,
          displayName: facility.name,
          email: best.group.email,
          facilityId: facility.id,
          googleGroupId: best.group.googleGroupId,
          kind: 'google-group',
          purpose: 'building',
        });
        outcome = 'strong-candidate';
        assessmentReasons.push('BIDIRECTIONALLY_UNIQUE_MATCH');
      } else {
        assessmentReasons.push('GROUP_MATCHES_MULTIPLE_FACILITIES');
      }
    } else if (best !== undefined) {
      if (!best.strongEligible) {
        assessmentReasons.push('NO_SAFE_BROAD_STAFF_MATCH');
      }
      if (best.group.displayName === null) {
        assessmentReasons.push('MISSING_GROUP_DISPLAY_NAME');
      }
      if (!hasClearLead(best, ranked[1])) {
        assessmentReasons.push('CLOSE_OR_TIED_CANDIDATES');
      }
      if (best.score < 110)
        assessmentReasons.push('INSUFFICIENT_EXACT_EVIDENCE');
    }

    mappings.push({
      assessment: {
        bestHeuristicScore: best?.score ?? 0,
        candidates,
        outcome,
        reasonCodes: sortedUnique(assessmentReasons),
      },
      createGroupSource,
      facility,
      reviewDecision: 'pending',
      reviewNote: null,
    });
  }

  const proposedByGroup = new Map<string, BuildingMapping[]>();
  for (const mapping of mappings) {
    if (mapping.createGroupSource === null) continue;
    const current =
      proposedByGroup.get(mapping.createGroupSource.googleGroupId) ?? [];
    current.push(mapping);
    proposedByGroup.set(mapping.createGroupSource.googleGroupId, current);
  }
  const duplicateGroupProposals: MappingDraft['report']['duplicateGroupProposals'][number][] =
    [];
  for (const [googleGroupId, collisions] of proposedByGroup) {
    if (collisions.length < 2) continue;
    const group = eligibleGroups.find(
      (candidate) => candidate.googleGroupId === googleGroupId,
    );
    if (group === undefined) {
      throw new Error('Draft matching lost a selected Google group.');
    }
    duplicateGroupProposals.push({
      facilityIds: collisions
        .map(({ facility }) => facility.id)
        .sort(compareText),
      group: groupRef(group),
    });
    for (const mapping of collisions) {
      mapping.createGroupSource = null;
      mapping.assessment.outcome = 'uncertain';
      mapping.assessment.reasonCodes = sortedUnique([
        ...mapping.assessment.reasonCodes,
        'DUPLICATE_GROUP_PROPOSAL',
      ]);
    }
  }

  const selectedGroupIds = new Set(
    mappings.flatMap(({ createGroupSource }) =>
      createGroupSource === null ? [] : [createGroupSource.googleGroupId],
    ),
  );
  const potentiallyStale = new Map<string, PotentiallyStaleGroup>();
  for (const group of eligibleGroups) {
    const reasons = [...(staleReasonsByGroup.get(group.googleGroupId) ?? [])];
    const inactiveExactMatch = groupsMatchingInactiveFacility.has(
      group.googleGroupId,
    );
    if (inactiveExactMatch) reasons.push('GROUP_MATCHES_INACTIVE_FACILITY');
    if (reasons.length > 0) {
      potentiallyStale.set(group.googleGroupId, {
        ...groupRef(group),
        reasonCodes: sortedUnique([
          ...reasons,
          'HEURISTIC_NOT_STALENESS_PROOF',
        ]),
      });
    }
  }

  const unassignedBuildingLikeGroups = eligibleGroups
    .filter((group) => !selectedGroupIds.has(group.googleGroupId))
    .map(groupRef)
    .sort((left, right) => compareText(left.email, right.email));
  const missingFacilityIds = mappings
    .filter(
      ({ assessment, facility }) =>
        facility.active && assessment.outcome === 'missing',
    )
    .map(({ facility }) => facility.id)
    .sort(compareText);
  const uncertainFacilityIds = mappings
    .filter(({ assessment }) => assessment.outcome === 'uncertain')
    .map(({ facility }) => facility.id)
    .sort(compareText);
  const neighborhoodHeuristics = createNeighborhoodProposals(facilities);

  return {
    buildingMappings: mappings,
    generatedAt: validatedGeneratedAt,
    importAuthorized: false,
    inventoryGroups: eligibleGroups.map(groupRef),
    kind: 'psd-eoc.google-groups-mapping-draft',
    neighborhoodProposals: neighborhoodHeuristics.proposals,
    report: {
      ambiguousStaffScopeGroups: eligibleGroups
        .filter(({ googleGroupId }) => ambiguousStaffScopes.has(googleGroupId))
        .map(groupRef),
      duplicateGroupProposals: duplicateGroupProposals.sort((left, right) =>
        compareText(left.group.email, right.group.email),
      ),
      missingFacilityIds,
      omittedUnverifiedGroupIdentityCount: excluded.size,
      potentiallyStaleGroups: [...potentiallyStale.values()].sort(
        (left, right) => compareText(left.email, right.email),
      ),
      restrictedRoleGroups: eligibleGroups
        .filter(({ googleGroupId }) => restrictedRoles.has(googleGroupId))
        .map(groupRef),
      skippedNeighborhoodHints: neighborhoodHeuristics.skippedFindings,
      unassignedBuildingLikeGroups,
      uncertainFacilityIds,
      warnings: [
        ...(ambiguousStaffScopes.size > 0
          ? ['AMBIGUOUS_STAFF_SCOPE_GROUPS_REQUIRE_HUMAN_RESOLUTION']
          : []),
        ...(restrictedRoles.size > 0
          ? ['RESTRICTED_ROLE_GROUPS_REQUIRE_HUMAN_RESOLUTION']
          : []),
        ...neighborhoodHeuristics.warnings,
        'AUTHORIZATION_COVERAGE_NOT_VERIFIED',
        'GROUP_MEMBERSHIP_AND_STAFF_POPULATION_NOT_FETCHED',
        'NO_GEOGRAPHY_HINTS_AVAILABLE',
      ],
    },
    schemaVersion: 1,
    source: {
      api: 'cloud-identity-v1',
      authorizationCoverage: 'not-verified',
      eligibleGroupCount: eligibleGroups.length,
      facilityCount: facilities.length,
      groupCount: groups.length,
      membershipDataFetched: false,
      pageCount,
      paginationComplete: true,
      readOnly: true,
      staffPopulationVerified: false,
    },
    status: 'human-review-required',
  };
};

const isNodeErrorWithCode = (
  error: unknown,
): error is Error & { readonly code: string } =>
  error instanceof Error &&
  'code' in error &&
  typeof (error as { readonly code?: unknown }).code === 'string';

const statIfPresent = async (
  path: string,
): Promise<Awaited<ReturnType<typeof stat>> | null> => {
  try {
    return await stat(path);
  } catch (error) {
    if (
      isNodeErrorWithCode(error) &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return null;
    }
    throw error;
  }
};

const isInsideGitRepository = async (path: string): Promise<boolean> => {
  const metadata = await stat(path);
  let current = metadata.isDirectory() ? path : dirname(path);
  while (true) {
    if ((await statIfPresent(join(current, '.git'))) !== null) return true;
    const [head, objects, refs] = await Promise.all([
      statIfPresent(join(current, 'HEAD')),
      statIfPresent(join(current, 'objects')),
      statIfPresent(join(current, 'refs')),
    ]);
    if (head?.isFile() && objects?.isDirectory() && refs?.isDirectory()) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
};

const requirePathOutsideGitRepository = async (
  path: string,
  label: string,
): Promise<string> => {
  const actualPath = await realpath(resolve(path));
  if (await isInsideGitRepository(actualPath)) {
    throw new Error(`${label} must be stored outside every Git repository.`);
  }
  return actualPath;
};

const validateSafeTemporaryRoot = async (
  path: string,
  label: string,
): Promise<string> => {
  const safeRoot = await requirePathOutsideGitRepository(path, label);
  const metadata = await stat(safeRoot);
  const currentUid = userInfo().uid;
  const writableByAnotherPrincipal = (metadata.mode & 0o022) !== 0;
  if (
    !metadata.isDirectory() ||
    (metadata.uid !== 0 && metadata.uid !== currentUid) ||
    (writableByAnotherPrincipal && (metadata.mode & 0o1000) === 0)
  ) {
    throw new Error(
      `${label} must be an owned private directory or a root-owned sticky temporary directory.`,
    );
  }
  return safeRoot;
};

const resolveOperatingSystemTemporaryRoot = async (): Promise<string> => {
  for (const candidate of ['/private/tmp', '/tmp'] as const) {
    if ((await statIfPresent(candidate)) === null) continue;
    return validateSafeTemporaryRoot(
      candidate,
      'Operating-system temporary directory',
    );
  }
  throw new Error('No fixed safe operating-system temporary directory exists.');
};

const createPrivateTemporaryDirectory = async (
  prefix: string,
  temporaryRoot?: string,
): Promise<string> => {
  const safeRoot = await validateSafeTemporaryRoot(
    temporaryRoot ?? (await resolveOperatingSystemTemporaryRoot()),
    'Temporary directory',
  );
  const isolatedPath = await mkdtemp(join(safeRoot, prefix));
  await chmod(isolatedPath, 0o700);
  const actualPath = await requirePathOutsideGitRepository(
    isolatedPath,
    'Private temporary directory',
  );
  const metadata = await stat(actualPath);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== userInfo().uid ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error('Private temporary directory was not safely created.');
  }
  return actualPath;
};

export const createIsolatedGcloudConfigPath = async (
  temporaryRoot?: string,
): Promise<string> =>
  createPrivateTemporaryDirectory('psd-eoc-gcloud-config-', temporaryRoot);

export const readPrivateJson = async (
  path: string,
  label: string,
  maximumBytes: number,
): Promise<unknown> => {
  const requestedPath = resolve(path);
  const initialMetadata = await lstat(requestedPath);
  if (!initialMetadata.isFile() || initialMetadata.size > maximumBytes) {
    throw new Error(`${label} must be a regular file within its size limit.`);
  }
  if ((initialMetadata.mode & 0o077) !== 0) {
    throw new Error(
      `${label} permissions must not allow group or other access.`,
    );
  }
  if (await isInsideGitRepository(requestedPath)) {
    throw new Error(`${label} must be stored outside every Git repository.`);
  }
  const actualParent = await realpath(dirname(requestedPath));
  if (await isInsideGitRepository(actualParent)) {
    throw new Error(`${label} must be stored outside every Git repository.`);
  }
  const safePath = join(actualParent, basename(requestedPath));
  const resolvedMetadata = await lstat(safePath);
  if (
    !resolvedMetadata.isFile() ||
    resolvedMetadata.dev !== initialMetadata.dev ||
    resolvedMetadata.ino !== initialMetadata.ino
  ) {
    throw new Error(`${label} changed while being opened.`);
  }
  const handle = await open(
    safePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let text: string;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size > maximumBytes ||
      metadata.dev !== resolvedMetadata.dev ||
      metadata.ino !== resolvedMetadata.ino
    ) {
      throw new Error(`${label} must be a regular file within its size limit.`);
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(
        `${label} permissions must not allow group or other access.`,
      );
    }
    const chunks: Buffer[] = [];
    let totalBytesRead = 0;
    while (totalBytesRead <= maximumBytes) {
      const bytes = Buffer.allocUnsafe(
        Math.min(FILE_READ_CHUNK_BYTES, maximumBytes + 1 - totalBytesRead),
      );
      const result = await handle.read(bytes, 0, bytes.length, totalBytesRead);
      if (result.bytesRead === 0) break;
      chunks.push(bytes.subarray(0, result.bytesRead));
      totalBytesRead += result.bytesRead;
    }
    if (totalBytesRead > maximumBytes) {
      throw new Error(`${label} exceeded its size limit while being read.`);
    }
    text = Buffer.concat(chunks, totalBytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
};

export const parseFacilities = (value: unknown): readonly Facility[] => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_FACILITIES
  ) {
    throw new Error('Facility input must be a bounded canonical FacilityPage.');
  }
  let page: ReturnType<typeof FacilityPageSchema.parse>;
  try {
    page = FacilityPageSchema.parse(value);
  } catch (error) {
    throw new Error(
      'Facility input must be one complete canonical FacilityPage.',
      { cause: error },
    );
  }
  if (page.pageInfo.hasMore || page.pageInfo.nextCursor !== null) {
    throw new Error('Facility input is partial; export every facility first.');
  }
  if (page.items.length > MAX_FACILITIES) {
    throw new Error('Facility input exceeds its safety limit.');
  }
  const ids = new Set<string>();
  const codes = new Set<string>();
  const names = new Set<string>();
  for (const facility of page.items) {
    const normalizedName = normalizeText(facility.name);
    if (
      hasUnsafeDisplayControl(facility.name) ||
      ids.has(facility.id) ||
      codes.has(facility.code) ||
      names.has(normalizedName)
    ) {
      throw new Error('Facility input contains ambiguous duplicate identity.');
    }
    ids.add(facility.id);
    codes.add(facility.code);
    names.add(normalizedName);
  }
  return [...page.items].sort(
    (left, right) =>
      compareText(left.code, right.code) || compareText(left.id, right.id),
  );
};

const resolveOutputPath = async (path: string): Promise<string> => {
  const actualParent = await requirePathOutsideGitRepository(
    dirname(resolve(path)),
    'Draft output directory',
  );
  const filename = basename(path);
  if (filename === '' || filename === '.' || filename === '..') {
    throw new Error('Draft output needs a filename.');
  }
  const parentMetadata = await stat(actualParent);
  if (!parentMetadata.isDirectory() || (parentMetadata.mode & 0o077) !== 0) {
    throw new Error(
      'Draft output directory must be private and inaccessible to group or other users.',
    );
  }
  return join(actualParent, filename);
};

const createDefaultOutputPath = async (): Promise<string> => {
  const directory = await createPrivateTemporaryDirectory('psd-eoc-groups-');
  return join(directory, 'groups-mapping.draft.json');
};

export const serializeDraft = (
  draft: MappingDraft,
  maximumBytes = MAX_DRAFT_FILE_BYTES,
): string => {
  const serialized = `${JSON.stringify(draft, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new Error('Draft output exceeds its bounded file-size limit.');
  }
  return serialized;
};

export const writePrivateDraft = async (
  path: string,
  draft: MappingDraft,
): Promise<void> => {
  const serialized = serializeDraft(draft);
  const destination = await resolveOutputPath(path);
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, 'wx', 0o600);
  let temporaryExists = true;
  let published = false;
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    await link(temporary, destination);
    published = true;
    await unlink(temporary);
    temporaryExists = false;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (published) await unlink(destination).catch(() => undefined);
    if (temporaryExists) await unlink(temporary).catch(() => undefined);
    if (isNodeErrorWithCode(error) && error.code === 'EEXIST') {
      throw new Error('Draft output already exists; refusing to overwrite it.');
    }
    throw error;
  }
};

const assertExactKeys = (
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void => {
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has an unsupported shape.`);
  }
};

const requireInteger = (
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new Error(`${label} must be a bounded non-negative integer.`);
  }
  return value;
};

const parseReviewDecision = (value: unknown): ReviewDecision => {
  if (
    value !== 'pending' &&
    value !== 'confirmed' &&
    value !== 'rejected' &&
    value !== 'intentionally-unmapped'
  ) {
    throw new Error('Draft review decision is invalid.');
  }
  return value;
};

const parseReviewNote = (value: unknown): string | null => {
  if (value === null) return null;
  const note = requireString(value, 'Draft review note', 2_000);
  if (hasUnsafeDisplayControl(note)) {
    throw new Error('Draft review note contains unsafe control characters.');
  }
  return note;
};

const parseReasonCodes = (value: unknown, label: string): readonly string[] => {
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error(`${label} must be a bounded reason-code array.`);
  }
  const reasons = value.map((reason) => {
    const parsed = requireString(reason, label, 100);
    if (!/^[A-Z0-9_]+$/u.test(parsed)) {
      throw new Error(`${label} contains an invalid reason code.`);
    }
    return parsed;
  });
  if (new Set(reasons).size !== reasons.length) {
    throw new Error(`${label} contains duplicate reason codes.`);
  }
  return reasons;
};

export const parseDraftGroupRef = (
  value: unknown,
  label: string,
  hostedDomain = PSD_HOSTED_DOMAIN,
): DraftGroupRef => {
  if (!isRecord(value)) throw new Error(`${label} must be a group reference.`);
  assertExactKeys(value, ['displayName', 'email', 'googleGroupId'], label);
  const googleGroupId = requireString(value.googleGroupId, label, 255);
  const email = requireString(value.email, label, 320).toLocaleLowerCase(
    'en-US',
  );
  if (
    !/^groups\/[A-Za-z0-9_-]{1,248}$/u.test(googleGroupId) ||
    !isHostedGroupEmail(email, hostedDomain)
  ) {
    throw new Error(`${label} has invalid group identity metadata.`);
  }
  const displayName =
    value.displayName === null
      ? null
      : requireString(value.displayName, label, 160);
  if (displayName !== null && hasUnsafeDisplayControl(displayName)) {
    throw new Error(`${label} has an unsafe display name.`);
  }
  return {
    displayName,
    email,
    googleGroupId,
  };
};

const parseCandidate = (
  value: unknown,
  hostedDomain = PSD_HOSTED_DOMAIN,
): MatchCandidate => {
  if (!isRecord(value)) throw new Error('Draft candidate is malformed.');
  assertExactKeys(
    value,
    ['displayName', 'email', 'googleGroupId', 'heuristicScore', 'reasonCodes'],
    'Draft candidate',
  );
  const reference = parseDraftGroupRef(
    {
      displayName: value.displayName,
      email: value.email,
      googleGroupId: value.googleGroupId,
    },
    'Draft candidate',
    hostedDomain,
  );
  const heuristicScore = requireInteger(
    value.heuristicScore,
    'Draft candidate heuristic score',
    210,
  );
  if (heuristicScore < 90) {
    throw new Error('Draft candidate heuristic score is below the threshold.');
  }
  return {
    ...reference,
    heuristicScore,
    reasonCodes: parseReasonCodes(value.reasonCodes, 'Draft candidate reasons'),
  };
};

const parseAssessment = (
  value: unknown,
  hostedDomain = PSD_HOSTED_DOMAIN,
): BuildingMapping['assessment'] => {
  if (!isRecord(value)) throw new Error('Draft assessment is malformed.');
  assertExactKeys(
    value,
    ['bestHeuristicScore', 'candidates', 'outcome', 'reasonCodes'],
    'Draft assessment',
  );
  if (
    value.outcome !== 'strong-candidate' &&
    value.outcome !== 'uncertain' &&
    value.outcome !== 'missing'
  ) {
    throw new Error('Draft assessment outcome is invalid.');
  }
  const bestHeuristicScore = requireInteger(
    value.bestHeuristicScore,
    'Draft best heuristic score',
    210,
  );
  if (!Array.isArray(value.candidates) || value.candidates.length > 3) {
    throw new Error('Draft assessment candidates are invalid.');
  }
  const candidates = value.candidates.map((candidate) =>
    parseCandidate(candidate, hostedDomain),
  );
  if (
    new Set(candidates.map(({ googleGroupId }) => googleGroupId)).size !==
    candidates.length
  ) {
    throw new Error('Draft assessment repeats a candidate group.');
  }
  if (
    bestHeuristicScore !== (candidates[0]?.heuristicScore ?? 0) ||
    candidates.some(
      (candidate, index) =>
        index > 0 &&
        candidate.heuristicScore >
          (candidates[index - 1]?.heuristicScore ?? Number.MAX_SAFE_INTEGER),
    ) ||
    (value.outcome === 'missing' && candidates.length !== 0) ||
    (value.outcome === 'strong-candidate' &&
      (bestHeuristicScore < 110 || candidates.length === 0))
  ) {
    throw new Error('Draft assessment heuristic evidence is inconsistent.');
  }
  return {
    bestHeuristicScore,
    candidates,
    outcome: value.outcome,
    reasonCodes: [
      ...parseReasonCodes(value.reasonCodes, 'Draft assessment reasons'),
    ],
  };
};

const sameGroupRef = (left: DraftGroupRef, right: DraftGroupRef): boolean =>
  left.googleGroupId === right.googleGroupId &&
  left.email === right.email &&
  left.displayName === right.displayName;

const parseFacilityFromDraft = (value: unknown): Facility => {
  try {
    const facility = FacilitySchema.parse(value);
    if (hasUnsafeDisplayControl(facility.name)) {
      throw new Error('Draft facility has an unsafe display name.');
    }
    return facility;
  } catch (error) {
    throw new Error('Draft facility does not satisfy the canonical contract.', {
      cause: error,
    });
  }
};

export const parseGroupSourceFromDraft = (
  value: unknown,
): GoogleBuildingGroupSource => {
  try {
    const source = CreateGroupSourceInputSchema.parse(value);
    if (source.kind !== 'google-group' || source.purpose !== 'building') {
      throw new Error('Draft group source is not a Google building source.');
    }
    return source;
  } catch (error) {
    throw new Error(
      'Draft group source does not satisfy the canonical building contract.',
      { cause: error },
    );
  }
};

export const parseNeighborhoodFromDraft = (
  value: unknown,
): CreateNeighborhoodVersionInput => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.facilityIds) ||
    value.facilityIds.length > MAX_NEIGHBORHOOD_FACILITIES
  ) {
    throw new Error(
      'Draft neighborhood must have a bounded facility-ID array.',
    );
  }
  try {
    const neighborhood = CreateNeighborhoodVersionInputSchema.parse(value);
    if (neighborhood.neighborhoodId !== null) {
      throw new Error('Inventory drafts may only propose new neighborhoods.');
    }
    if (hasUnsafeDisplayControl(neighborhood.name)) {
      throw new Error('Draft neighborhood has an unsafe display name.');
    }
    return neighborhood;
  } catch (error) {
    throw new Error(
      'Draft neighborhood does not satisfy the canonical create contract.',
      { cause: error },
    );
  }
};

const parseFacilityIdList = (
  value: unknown,
  knownFacilityIds: ReadonlySet<string>,
  label: string,
): readonly string[] => {
  if (!Array.isArray(value) || value.length > MAX_FACILITIES) {
    throw new Error(`${label} must be a bounded facility-ID array.`);
  }
  const ids = value.map((id) => requireString(id, label, 255));
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !knownFacilityIds.has(id))
  ) {
    throw new Error(`${label} contains duplicate or unknown facilities.`);
  }
  return ids;
};

function requireBoundedDraftArray(
  value: unknown,
  maximum: number,
  label: string,
): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be a bounded array.`);
  }
}

const assertDraftCollectionBounds = (value: JsonObject): void => {
  requireBoundedDraftArray(
    value.inventoryGroups,
    MAX_GROUPS,
    'Draft group inventory',
  );
  requireBoundedDraftArray(
    value.buildingMappings,
    MAX_FACILITIES,
    'Draft building mappings',
  );
  requireBoundedDraftArray(
    value.neighborhoodProposals,
    MAX_FACILITIES,
    'Draft neighborhood proposals',
  );
  if (!isRecord(value.report)) throw new Error('Draft report is malformed.');
  for (const [key, maximum] of [
    ['ambiguousStaffScopeGroups', MAX_GROUPS],
    ['duplicateGroupProposals', MAX_GROUPS],
    ['missingFacilityIds', MAX_FACILITIES],
    ['potentiallyStaleGroups', MAX_GROUPS],
    ['restrictedRoleGroups', MAX_GROUPS],
    ['skippedNeighborhoodHints', MAX_FACILITIES],
    ['unassignedBuildingLikeGroups', MAX_GROUPS],
    ['uncertainFacilityIds', MAX_FACILITIES],
    ['warnings', 50],
  ] as const) {
    requireBoundedDraftArray(value.report[key], maximum, `Draft report ${key}`);
  }
};

export const validateDraftForDomain = (
  value: unknown,
  hostedDomain = PSD_HOSTED_DOMAIN,
): ValidationSummary => {
  if (!isRecord(value)) throw new Error('Mapping draft must be a JSON object.');
  assertExactKeys(
    value,
    [
      'buildingMappings',
      'generatedAt',
      'importAuthorized',
      'inventoryGroups',
      'kind',
      'neighborhoodProposals',
      'report',
      'schemaVersion',
      'source',
      'status',
    ],
    'Mapping draft',
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'psd-eoc.google-groups-mapping-draft' ||
    value.status !== 'human-review-required' ||
    value.importAuthorized !== false
  ) {
    throw new Error('Mapping draft safety envelope is invalid.');
  }
  assertDraftCollectionBounds(value);
  const validatedGeneratedAt = requireAbsoluteTimestamp(
    value.generatedAt,
    'Draft generation time',
  );
  if (!isRecord(value.source)) throw new Error('Draft source is malformed.');
  assertExactKeys(
    value.source,
    [
      'api',
      'authorizationCoverage',
      'eligibleGroupCount',
      'facilityCount',
      'groupCount',
      'membershipDataFetched',
      'pageCount',
      'paginationComplete',
      'readOnly',
      'staffPopulationVerified',
    ],
    'Draft source',
  );
  if (
    value.source.api !== 'cloud-identity-v1' ||
    value.source.authorizationCoverage !== 'not-verified' ||
    value.source.membershipDataFetched !== false ||
    value.source.paginationComplete !== true ||
    value.source.readOnly !== true ||
    value.source.staffPopulationVerified !== false
  ) {
    throw new Error('Draft source overstates Google inventory evidence.');
  }
  const sourceFacilityCount = requireInteger(
    value.source.facilityCount,
    'Draft facility count',
    MAX_FACILITIES,
  );
  const sourceGroupCount = requireInteger(
    value.source.groupCount,
    'Draft group count',
    MAX_GROUPS,
  );
  const sourceEligibleGroupCount = requireInteger(
    value.source.eligibleGroupCount,
    'Draft eligible-group count',
    MAX_GROUPS,
  );
  const sourcePageCount = requireInteger(
    value.source.pageCount,
    'Draft page count',
    MAX_PAGES,
  );
  if (sourcePageCount < 1)
    throw new Error('Draft page count must be positive.');
  if (sourceGroupCount > sourcePageCount * MAX_GROUPS_PER_PAGE) {
    throw new Error('Draft group count exceeds its pagination evidence.');
  }

  if (!Array.isArray(value.inventoryGroups)) {
    throw new Error('Draft group inventory is malformed.');
  }
  const inventoryGroups = value.inventoryGroups.map((group) =>
    parseDraftGroupRef(group, 'Draft inventory group', hostedDomain),
  );
  const inventoryById = new Map<string, DraftGroupRef>();
  const inventoryEmails = new Set<string>();
  for (const group of inventoryGroups) {
    if (
      inventoryById.has(group.googleGroupId) ||
      inventoryEmails.has(group.email)
    ) {
      throw new Error('Draft inventory contains duplicate group identity.');
    }
    inventoryById.set(group.googleGroupId, group);
    inventoryEmails.add(group.email);
  }
  if (inventoryGroups.length !== sourceEligibleGroupCount) {
    throw new Error('Draft eligible-group count does not match its inventory.');
  }

  if (
    !Array.isArray(value.buildingMappings) ||
    value.buildingMappings.length > MAX_FACILITIES
  ) {
    throw new Error('Draft building mappings are malformed.');
  }
  const mappings: BuildingMapping[] = [];
  const facilityIds = new Set<string>();
  const facilityCodes = new Set<string>();
  const facilityNames = new Set<string>();
  const selectedGroupIds = new Set<string>();
  const selectedGroupEmails = new Set<string>();
  for (const rawMapping of value.buildingMappings) {
    if (!isRecord(rawMapping)) throw new Error('Draft mapping is malformed.');
    assertExactKeys(
      rawMapping,
      [
        'assessment',
        'createGroupSource',
        'facility',
        'reviewDecision',
        'reviewNote',
      ],
      'Draft mapping',
    );
    const facility = parseFacilityFromDraft(rawMapping.facility);
    const normalizedFacilityName = normalizeText(facility.name);
    if (
      facilityIds.has(facility.id) ||
      facilityCodes.has(facility.code) ||
      facilityNames.has(normalizedFacilityName)
    ) {
      throw new Error('Draft repeats a facility identity.');
    }
    facilityIds.add(facility.id);
    facilityCodes.add(facility.code);
    facilityNames.add(normalizedFacilityName);
    const decision = parseReviewDecision(rawMapping.reviewDecision);
    const reviewNote = parseReviewNote(rawMapping.reviewNote);
    const assessment = parseAssessment(rawMapping.assessment, hostedDomain);
    const createGroupSource =
      rawMapping.createGroupSource === null
        ? null
        : parseGroupSourceFromDraft(rawMapping.createGroupSource);
    if (
      (decision === 'confirmed' && createGroupSource === null) ||
      ((decision === 'rejected' || decision === 'intentionally-unmapped') &&
        createGroupSource !== null) ||
      (decision !== 'pending' && reviewNote === null) ||
      (decision === 'pending' &&
        (assessment.outcome === 'strong-candidate') !==
          (createGroupSource !== null))
    ) {
      throw new Error('Draft mapping decision and proposal are inconsistent.');
    }
    if (createGroupSource !== null) {
      const inventoryGroup = inventoryById.get(createGroupSource.googleGroupId);
      const topCandidate = assessment.candidates[0];
      if (
        !facility.active ||
        createGroupSource.facilityId !== facility.id ||
        createGroupSource.active !== true ||
        createGroupSource.displayName !== facility.name ||
        inventoryGroup === undefined ||
        inventoryGroup.email !== createGroupSource.email ||
        selectedGroupIds.has(createGroupSource.googleGroupId) ||
        selectedGroupEmails.has(createGroupSource.email)
      ) {
        throw new Error('Draft mapping references an invalid or reused group.');
      }
      if (
        decision === 'pending' &&
        (topCandidate === undefined ||
          topCandidate.googleGroupId !== createGroupSource.googleGroupId ||
          topCandidate.email !== createGroupSource.email)
      ) {
        throw new Error(
          'A pending mapping must retain its generated top candidate.',
        );
      }
      selectedGroupIds.add(createGroupSource.googleGroupId);
      selectedGroupEmails.add(createGroupSource.email);
    }
    for (const candidate of assessment.candidates) {
      const inventoryGroup = inventoryById.get(candidate.googleGroupId);
      if (
        inventoryGroup === undefined ||
        !sameGroupRef(candidate, inventoryGroup)
      ) {
        throw new Error(
          'Draft mapping candidate is absent from the inventory.',
        );
      }
    }
    mappings.push({
      assessment,
      createGroupSource,
      facility,
      reviewDecision: decision,
      reviewNote,
    });
  }
  if (mappings.length !== sourceFacilityCount) {
    throw new Error('Draft facility count does not match its mappings.');
  }
  const draftFacilities = mappings.map(({ facility }) => facility);
  const regeneratedDraft = buildDraft(
    draftFacilities,
    inventoryGroups,
    sourcePageCount,
    validatedGeneratedAt,
  );
  const regeneratedInventoryById = new Map(
    regeneratedDraft.inventoryGroups.map((group) => [
      group.googleGroupId,
      group,
    ]),
  );
  if (
    regeneratedDraft.inventoryGroups.length !== inventoryGroups.length ||
    inventoryGroups.some((group) => {
      const regenerated = regeneratedInventoryById.get(group.googleGroupId);
      return regenerated === undefined || !sameGroupRef(group, regenerated);
    })
  ) {
    throw new Error('Draft inventory contains a non-staff or excluded group.');
  }
  const restrictedRoleGroupIds = new Set(
    regeneratedDraft.report.restrictedRoleGroups.map(
      ({ googleGroupId }) => googleGroupId,
    ),
  );
  const regeneratedStaleReasonsByGroup = new Map(
    regeneratedDraft.report.potentiallyStaleGroups.map(
      ({ googleGroupId, reasonCodes }) => [googleGroupId, reasonCodes],
    ),
  );
  const staleSignalGroupIds = new Set(
    [...regeneratedStaleReasonsByGroup]
      .filter(([, reasons]) =>
        reasons.some(
          (reason) =>
            reason === 'GROUP_HAS_PRIOR_YEAR_MARKER' ||
            reason === 'GROUP_HAS_STALE_NAME_MARKER',
        ),
      )
      .map(([googleGroupId]) => googleGroupId),
  );
  const ambiguousStaffScopeGroupIds = new Set(
    regeneratedDraft.report.ambiguousStaffScopeGroups.map(
      ({ googleGroupId }) => googleGroupId,
    ),
  );
  const regeneratedMappings = new Map(
    regeneratedDraft.buildingMappings.map((mapping) => [
      mapping.facility.id,
      mapping,
    ]),
  );
  for (const mapping of mappings) {
    const regenerated = regeneratedMappings.get(mapping.facility.id);
    if (
      regenerated === undefined ||
      JSON.stringify(mapping.assessment) !==
        JSON.stringify(regenerated.assessment)
    ) {
      throw new Error(
        'Mapping assessment evidence does not match the regenerated inventory.',
      );
    }
    if (
      mapping.reviewDecision === 'pending' &&
      JSON.stringify(mapping.createGroupSource) !==
        JSON.stringify(regenerated.createGroupSource)
    ) {
      throw new Error(
        'A pending mapping source does not match the regenerated proposal.',
      );
    }
  }
  const humanReviewRequiredProposalGroupIds = new Set([
    ...restrictedRoleGroupIds,
    ...staleSignalGroupIds,
    ...ambiguousStaffScopeGroupIds,
  ]);
  if (
    mappings.some(
      ({ assessment, createGroupSource, reviewDecision }) =>
        (createGroupSource !== null &&
          humanReviewRequiredProposalGroupIds.has(
            createGroupSource.googleGroupId,
          ) &&
          reviewDecision !== 'confirmed') ||
        assessment.candidates.some(({ googleGroupId }) =>
          humanReviewRequiredProposalGroupIds.has(googleGroupId),
        ),
    )
  ) {
    throw new Error('Draft mapping references a quarantined group.');
  }

  if (
    !Array.isArray(value.neighborhoodProposals) ||
    value.neighborhoodProposals.length > MAX_FACILITIES
  ) {
    throw new Error('Draft neighborhood proposals are malformed.');
  }
  const neighborhoods: NeighborhoodProposal[] = [];
  const neighborhoodPayloads = new Set<string>();
  for (const rawProposal of value.neighborhoodProposals) {
    if (!isRecord(rawProposal)) {
      throw new Error('Draft neighborhood proposal is malformed.');
    }
    assertExactKeys(
      rawProposal,
      [
        'createNeighborhoodVersion',
        'generatedHint',
        'reviewDecision',
        'reviewNote',
      ],
      'Draft neighborhood proposal',
    );
    const createNeighborhoodVersion = parseNeighborhoodFromDraft(
      rawProposal.createNeighborhoodVersion,
    );
    if (
      createNeighborhoodVersion.facilityIds.some(
        (facilityId) => !facilityIds.has(facilityId),
      )
    ) {
      throw new Error('Draft neighborhood references an unknown facility.');
    }
    const decision = parseReviewDecision(rawProposal.reviewDecision);
    if (decision === 'intentionally-unmapped') {
      throw new Error('Neighborhoods do not support intentionally-unmapped.');
    }
    const reviewNote = parseReviewNote(rawProposal.reviewNote);
    if (decision !== 'pending' && reviewNote === null) {
      throw new Error(
        'A resolved neighborhood proposal requires a review note.',
      );
    }
    const payloadKey = JSON.stringify({
      facilityIds: [...createNeighborhoodVersion.facilityIds].sort(compareText),
      name: createNeighborhoodVersion.name,
      neighborhoodId: createNeighborhoodVersion.neighborhoodId,
    });
    if (neighborhoodPayloads.has(payloadKey)) {
      throw new Error('Draft repeats a neighborhood proposal.');
    }
    neighborhoodPayloads.add(payloadKey);
    let generatedHint: NeighborhoodProposal['generatedHint'] = null;
    if (rawProposal.generatedHint !== null) {
      if (!isRecord(rawProposal.generatedHint)) {
        throw new Error('Draft generated neighborhood hint is malformed.');
      }
      assertExactKeys(
        rawProposal.generatedHint,
        ['createNeighborhoodVersion', 'heuristicStrength', 'reasonCodes'],
        'Draft generated neighborhood hint',
      );
      const generatedCreateNeighborhoodVersion = parseNeighborhoodFromDraft(
        rawProposal.generatedHint.createNeighborhoodVersion,
      );
      if (
        generatedCreateNeighborhoodVersion.facilityIds.some(
          (facilityId) => !facilityIds.has(facilityId),
        ) ||
        rawProposal.generatedHint.heuristicStrength !== 'low'
      ) {
        throw new Error('Draft generated neighborhood hint is invalid.');
      }
      generatedHint = {
        createNeighborhoodVersion: generatedCreateNeighborhoodVersion,
        heuristicStrength: 'low',
        reasonCodes: parseReasonCodes(
          rawProposal.generatedHint.reasonCodes,
          'Draft generated neighborhood reasons',
        ),
      };
      if (
        decision !== 'confirmed' &&
        JSON.stringify(createNeighborhoodVersion) !==
          JSON.stringify(generatedCreateNeighborhoodVersion)
      ) {
        throw new Error(
          'Only a confirmed neighborhood may correct a generated hint.',
        );
      }
    } else if (reviewNote === null) {
      throw new Error(
        'A human-added neighborhood requires an explicit review note.',
      );
    }
    neighborhoods.push({
      createNeighborhoodVersion,
      generatedHint,
      reviewDecision: decision,
      reviewNote,
    });
  }

  const generatedNeighborhoodCount =
    regeneratedDraft.neighborhoodProposals.length;
  if (
    neighborhoods.length < generatedNeighborhoodCount ||
    regeneratedDraft.neighborhoodProposals.some(
      (regenerated, index) =>
        JSON.stringify(neighborhoods[index]?.generatedHint) !==
        JSON.stringify(regenerated.generatedHint),
    ) ||
    neighborhoods
      .slice(generatedNeighborhoodCount)
      .some(({ generatedHint }) => generatedHint !== null)
  ) {
    throw new Error(
      'Neighborhood heuristic evidence is not bound to its generated proposal.',
    );
  }

  if (!isRecord(value.report)) throw new Error('Draft report is malformed.');
  assertExactKeys(
    value.report,
    [
      'ambiguousStaffScopeGroups',
      'duplicateGroupProposals',
      'missingFacilityIds',
      'omittedUnverifiedGroupIdentityCount',
      'potentiallyStaleGroups',
      'restrictedRoleGroups',
      'skippedNeighborhoodHints',
      'unassignedBuildingLikeGroups',
      'uncertainFacilityIds',
      'warnings',
    ],
    'Draft report',
  );
  const missingFacilityIds = parseFacilityIdList(
    value.report.missingFacilityIds,
    facilityIds,
    'Draft missing facilities',
  );
  const uncertainFacilityIds = parseFacilityIdList(
    value.report.uncertainFacilityIds,
    facilityIds,
    'Draft uncertain facilities',
  );
  const expectedMissing = mappings
    .filter(
      ({ assessment, facility }) =>
        facility.active && assessment.outcome === 'missing',
    )
    .map(({ facility }) => facility.id)
    .sort(compareText);
  const expectedUncertain = mappings
    .filter(({ assessment }) => assessment.outcome === 'uncertain')
    .map(({ facility }) => facility.id)
    .sort(compareText);
  if (
    JSON.stringify([...missingFacilityIds].sort(compareText)) !==
      JSON.stringify(expectedMissing) ||
    JSON.stringify([...uncertainFacilityIds].sort(compareText)) !==
      JSON.stringify(expectedUncertain)
  ) {
    throw new Error('Draft report does not match mapping assessments.');
  }

  const parseReportGroupList = (
    raw: unknown,
    label: string,
  ): readonly DraftGroupRef[] => {
    if (!Array.isArray(raw) || raw.length > MAX_GROUPS) {
      throw new Error(`${label} is malformed.`);
    }
    const groups = raw.map((group) =>
      parseDraftGroupRef(group, label, hostedDomain),
    );
    if (
      new Set(groups.map(({ googleGroupId }) => googleGroupId)).size !==
      groups.length
    ) {
      throw new Error(`${label} repeats a group.`);
    }
    for (const group of groups) {
      const inventoryGroup = inventoryById.get(group.googleGroupId);
      if (
        inventoryGroup === undefined ||
        !sameGroupRef(group, inventoryGroup)
      ) {
        throw new Error(`${label} references a group outside the inventory.`);
      }
    }
    return groups;
  };
  const unassigned = parseReportGroupList(
    value.report.unassignedBuildingLikeGroups,
    'Draft unassigned groups',
  );
  const expectedUnassignedGroupIds = inventoryGroups
    .filter((group) => !selectedGroupIds.has(group.googleGroupId))
    .map(({ googleGroupId }) => googleGroupId)
    .sort(compareText);
  if (
    JSON.stringify(
      unassigned.map(({ googleGroupId }) => googleGroupId).sort(compareText),
    ) !== JSON.stringify(expectedUnassignedGroupIds)
  ) {
    throw new Error('Draft unassigned-group report does not match inventory.');
  }
  const reportedAmbiguousStaffScopeGroups = parseReportGroupList(
    value.report.ambiguousStaffScopeGroups,
    'Draft ambiguous staff-scope groups',
  );
  if (
    JSON.stringify(
      reportedAmbiguousStaffScopeGroups
        .map(({ googleGroupId }) => googleGroupId)
        .sort(compareText),
    ) !== JSON.stringify([...ambiguousStaffScopeGroupIds].sort(compareText))
  ) {
    throw new Error(
      'Draft ambiguous staff-scope report does not match its inventory.',
    );
  }
  const reportedRestrictedRoleGroups = parseReportGroupList(
    value.report.restrictedRoleGroups,
    'Draft restricted-role groups',
  );
  if (
    JSON.stringify(
      reportedRestrictedRoleGroups
        .map(({ googleGroupId }) => googleGroupId)
        .sort(compareText),
    ) !== JSON.stringify([...restrictedRoleGroupIds].sort(compareText))
  ) {
    throw new Error(
      'Draft restricted-role report does not match its inventory.',
    );
  }
  if (!Array.isArray(value.report.potentiallyStaleGroups)) {
    throw new Error('Draft potential-staleness report is malformed.');
  }
  const expectedPotentialStaleReasons = regeneratedStaleReasonsByGroup;
  const staleIds = new Set<string>();
  for (const rawStale of value.report.potentiallyStaleGroups) {
    if (!isRecord(rawStale)) {
      throw new Error('Draft potential-staleness entry is malformed.');
    }
    assertExactKeys(
      rawStale,
      ['displayName', 'email', 'googleGroupId', 'reasonCodes'],
      'Draft potential-staleness entry',
    );
    const staleGroup = parseDraftGroupRef(
      {
        displayName: rawStale.displayName,
        email: rawStale.email,
        googleGroupId: rawStale.googleGroupId,
      },
      'Draft potential-staleness entry',
      hostedDomain,
    );
    const inventoryGroup = inventoryById.get(staleGroup.googleGroupId);
    const reasons = parseReasonCodes(
      rawStale.reasonCodes,
      'Draft potential-staleness reasons',
    );
    const expectedReasons = expectedPotentialStaleReasons.get(
      staleGroup.googleGroupId,
    );
    if (
      inventoryGroup === undefined ||
      !sameGroupRef(staleGroup, inventoryGroup) ||
      staleIds.has(staleGroup.googleGroupId) ||
      expectedReasons === undefined ||
      JSON.stringify([...reasons].sort(compareText)) !==
        JSON.stringify([...expectedReasons].sort(compareText))
    ) {
      throw new Error('Draft potential-staleness entry overstates evidence.');
    }
    staleIds.add(staleGroup.googleGroupId);
  }
  if (
    [...expectedPotentialStaleReasons].some(
      ([googleGroupId]) => !staleIds.has(googleGroupId),
    )
  ) {
    throw new Error('Draft staleness report omits derived evidence.');
  }
  if (
    !Array.isArray(value.report.skippedNeighborhoodHints) ||
    value.report.skippedNeighborhoodHints.length > MAX_FACILITIES
  ) {
    throw new Error('Draft skipped-neighborhood report is malformed.');
  }
  const skippedNeighborhoodHints = value.report.skippedNeighborhoodHints.map(
    (rawSkipped): SkippedNeighborhoodHint => {
      if (!isRecord(rawSkipped)) {
        throw new Error('Draft skipped-neighborhood entry is malformed.');
      }
      assertExactKeys(
        rawSkipped,
        ['facilityIds', 'reasonCodes'],
        'Draft skipped-neighborhood entry',
      );
      const skippedFacilityIds = parseFacilityIdList(
        rawSkipped.facilityIds,
        facilityIds,
        'Draft skipped-neighborhood facilities',
      );
      const reasonCodes = parseReasonCodes(
        rawSkipped.reasonCodes,
        'Draft skipped-neighborhood reasons',
      );
      if (
        skippedFacilityIds.length < 2 ||
        JSON.stringify(reasonCodes) !==
          JSON.stringify(['NEIGHBORHOOD_HINT_SKIPPED_CONTRACT_LIMIT'])
      ) {
        throw new Error(
          'Draft skipped-neighborhood entry overstates derived evidence.',
        );
      }
      return {
        facilityIds: [...skippedFacilityIds].sort(compareText),
        reasonCodes,
      };
    },
  );
  const sortSkippedNeighborhoodHints = (
    hints: readonly SkippedNeighborhoodHint[],
  ): readonly SkippedNeighborhoodHint[] =>
    [...hints].sort((left, right) =>
      compareText(left.facilityIds.join(','), right.facilityIds.join(',')),
    );
  if (
    JSON.stringify(sortSkippedNeighborhoodHints(skippedNeighborhoodHints)) !==
    JSON.stringify(
      sortSkippedNeighborhoodHints(
        regeneratedDraft.report.skippedNeighborhoodHints,
      ),
    )
  ) {
    throw new Error(
      'Draft skipped-neighborhood report does not match regenerated evidence.',
    );
  }
  if (!Array.isArray(value.report.duplicateGroupProposals)) {
    throw new Error('Draft duplicate-group report is malformed.');
  }
  const duplicateGroupIds = new Set<string>();
  const parsedDuplicateProposals: {
    readonly facilityIds: readonly string[];
    readonly group: DraftGroupRef;
  }[] = [];
  for (const rawDuplicate of value.report.duplicateGroupProposals) {
    if (!isRecord(rawDuplicate)) {
      throw new Error('Draft duplicate-group entry is malformed.');
    }
    assertExactKeys(
      rawDuplicate,
      ['facilityIds', 'group'],
      'Draft duplicate-group entry',
    );
    const group = parseDraftGroupRef(
      rawDuplicate.group,
      'Draft duplicate-group entry',
      hostedDomain,
    );
    const inventoryGroup = inventoryById.get(group.googleGroupId);
    if (inventoryGroup === undefined || !sameGroupRef(group, inventoryGroup)) {
      throw new Error('Draft duplicate-group entry is outside the inventory.');
    }
    duplicateGroupIds.add(group.googleGroupId);
    const duplicateFacilityIds = parseFacilityIdList(
      rawDuplicate.facilityIds,
      facilityIds,
      'Draft duplicate-group facilities',
    );
    if (duplicateFacilityIds.length < 2) {
      throw new Error('Draft duplicate-group entry needs multiple facilities.');
    }
    parsedDuplicateProposals.push({
      facilityIds: [...duplicateFacilityIds].sort(compareText),
      group,
    });
  }
  const sortDuplicateProposals = (
    proposals: readonly {
      readonly facilityIds: readonly string[];
      readonly group: DraftGroupRef;
    }[],
  ) =>
    [...proposals].sort((left, right) =>
      compareText(left.group.googleGroupId, right.group.googleGroupId),
    );
  if (
    JSON.stringify(sortDuplicateProposals(parsedDuplicateProposals)) !==
    JSON.stringify(
      sortDuplicateProposals(
        regeneratedDraft.report.duplicateGroupProposals.map((proposal) => ({
          facilityIds: [...proposal.facilityIds].sort(compareText),
          group: proposal.group,
        })),
      ),
    )
  ) {
    throw new Error(
      'Draft duplicate-group report does not match regenerated evidence.',
    );
  }
  const omittedUnverifiedGroupIdentityCount = requireInteger(
    value.report.omittedUnverifiedGroupIdentityCount,
    'Draft omitted unverified-group-identity count',
    MAX_GROUPS,
  );
  if (
    sourceGroupCount !==
    inventoryGroups.length + omittedUnverifiedGroupIdentityCount
  ) {
    throw new Error('Draft total group count is internally inconsistent.');
  }
  const warnings = parseReasonCodes(value.report.warnings, 'Draft warnings');
  if (
    JSON.stringify([...warnings].sort(compareText)) !==
    JSON.stringify([...regeneratedDraft.report.warnings].sort(compareText))
  ) {
    throw new Error('Draft warnings do not match regenerated evidence.');
  }
  for (const requiredWarning of [
    'AUTHORIZATION_COVERAGE_NOT_VERIFIED',
    'GROUP_MEMBERSHIP_AND_STAFF_POPULATION_NOT_FETCHED',
    'NO_GEOGRAPHY_HINTS_AVAILABLE',
  ]) {
    if (!warnings.includes(requiredWarning)) {
      throw new Error('Draft omits a required evidence warning.');
    }
  }
  const ambiguousStaffScopeWarning =
    'AMBIGUOUS_STAFF_SCOPE_GROUPS_REQUIRE_HUMAN_RESOLUTION';
  if (
    warnings.includes(ambiguousStaffScopeWarning) !==
    ambiguousStaffScopeGroupIds.size > 0
  ) {
    throw new Error(
      'Draft ambiguous staff-scope warning does not match its inventory.',
    );
  }
  const restrictedRoleWarning =
    'RESTRICTED_ROLE_GROUPS_REQUIRE_HUMAN_RESOLUTION';
  if (
    warnings.includes(restrictedRoleWarning) !==
    restrictedRoleGroupIds.size > 0
  ) {
    throw new Error(
      'Draft restricted-role warning does not match its inventory.',
    );
  }
  const neighborhoodLimitWarning = 'NEIGHBORHOOD_HINT_SKIPPED_CONTRACT_LIMIT';
  const expectedNeighborhoodWarnings =
    createNeighborhoodProposals(draftFacilities).warnings;
  if (
    warnings.includes(neighborhoodLimitWarning) !==
    expectedNeighborhoodWarnings.includes(neighborhoodLimitWarning)
  ) {
    throw new Error(
      'Draft neighborhood-limit warning does not match its facilities.',
    );
  }

  const confirmedMappingCount = mappings.filter(
    ({ reviewDecision }) => reviewDecision === 'confirmed',
  ).length;
  const pendingMappingCount = mappings.filter(
    ({ reviewDecision }) => reviewDecision === 'pending',
  ).length;
  const confirmedNeighborhoodCount = neighborhoods.filter(
    ({ reviewDecision }) => reviewDecision === 'confirmed',
  ).length;
  const pendingNeighborhoodCount = neighborhoods.filter(
    ({ reviewDecision }) => reviewDecision === 'pending',
  ).length;
  const allReviewFieldsStructurallyResolved =
    mappings.every(({ reviewDecision }) =>
      ['confirmed', 'intentionally-unmapped'].includes(reviewDecision),
    ) &&
    neighborhoods.every(({ reviewDecision }) =>
      ['confirmed', 'rejected'].includes(reviewDecision),
    );
  const unresolvedGroupIds = new Set([
    ...ambiguousStaffScopeGroupIds,
    ...restrictedRoleGroupIds,
    ...unassigned.map(({ googleGroupId }) => googleGroupId),
    ...staleIds,
    ...duplicateGroupIds,
  ]);
  const unresolvedFindingCount =
    unresolvedGroupIds.size +
    omittedUnverifiedGroupIdentityCount +
    missingFacilityIds.length +
    uncertainFacilityIds.length +
    skippedNeighborhoodHints.length;
  return {
    allReviewFieldsStructurallyResolved,
    canonicalSourcesReverified: false,
    confirmedMappingCount,
    confirmedNeighborhoodCount,
    importAuthorized: false,
    mappingCount: mappings.length,
    neighborhoodCount: neighborhoods.length,
    pendingMappingCount,
    pendingNeighborhoodCount,
    structuralValidationPassed: true,
    unresolvedFindingCount,
  };
};

const validateDraft = (value: unknown): ValidationSummary =>
  validateDraftForDomain(value, PSD_HOSTED_DOMAIN);

const usage = `Usage:
  bun scripts/ops/groups-inventory.ts inventory \\
    --facilities /private/facilities.page.json \\
    --customer-id C01234567 \\
    --service-account groups-reader@PROJECT.iam.gserviceaccount.com \\
    --quota-project PROJECT \\
    [--output /private/groups-mapping.draft.json]

  bun scripts/ops/groups-inventory.ts validate \\
    --draft /private/groups-mapping.draft.json

Safety and authentication:
  - Inventory performs fixed-origin Cloud Identity GET requests only. It never
    fetches memberships and has no apply/import command.
  - Identities without bounded staff/role evidence and identities with
    population evidence are counted but not serialized. An authorized human
    must inspect Google Groups separately to resolve those omitted identities;
    membership was not fetched.
  - Automatic source proposals require a physical school/site type and fully
    consumed facility + whole-staff identities; organizational departments,
    grades, dates, or other scope qualifiers cannot become candidates.
  - generatedHint preserves immutable name-only neighborhood evidence. A human
    may confirm a corrected payload or add a D-029 neighborhood with
    generatedHint=null and an explicit review note. Human-added neighborhoods
    must be appended after every generated proposal; validation never treats
    either edit as generated evidence or import authorization.
  - Inputs and output must be outside Git and private (0600). Output never
    overwrites an existing file. Omitting --output creates a private random
    temporary directory.
  - A human must first run gcloud auth application-default login and receive
    Service Account Token Creator on the read-only service account.
  - The standard private gcloud ADC file must contain authorized_user
    credentials. Credential, execution, proxy, and TLS override environment
    variables are refused before token generation. gcloud receives only fixed
    safe variables and stores its isolated configuration beneath a verified
    fixed OS temporary root (never a caller-selected TMPDIR); service-account
    or external-account ADC cannot replace the human login.
  - That service account also needs roles/serviceusage.serviceUsageConsumer on
    --quota-project so Google may charge this read-only request to the project.
  - The service account must separately have a customer-scoped Google
    Workspace Groups Read admin role. Impersonation is not domain-wide
    delegation and this script never bypasses interactive login or admin grants.
  - --facilities is one terminal canonical FacilityPage (hasMore=false).
  - validate performs structural checks only. It neither proves who edited the
    file nor re-verifies canonical facilities, Google groups, or report findings.
  - A future authenticated human admin capability owns import and must re-read
    canonical facilities and Google groups before accepting a confirmed file.`;

const parseOptionPairs = (
  arguments_: readonly string[],
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, string> => {
  const parsed = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !name.startsWith('--') ||
      value.startsWith('--') ||
      !allowed.has(name) ||
      parsed.has(name)
    ) {
      throw new Error(usage);
    }
    parsed.set(name, value);
  }
  return parsed;
};

const requireOption = (
  options: ReadonlyMap<string, string>,
  name: string,
): string => {
  const value = options.get(name);
  if (value === undefined) throw new Error(`Missing ${name}.\n\n${usage}`);
  return requireString(value, name, 4_096);
};

export const parseCli = (arguments_: readonly string[]): CliOptions => {
  const command = arguments_[0];
  if (command === 'validate') {
    const options = parseOptionPairs(arguments_.slice(1), new Set(['--draft']));
    return {
      command,
      draftPath: requireOption(options, '--draft'),
    };
  }
  if (command !== 'inventory') throw new Error(usage);
  const options = parseOptionPairs(
    arguments_.slice(1),
    new Set([
      '--customer-id',
      '--facilities',
      '--output',
      '--quota-project',
      '--service-account',
    ]),
  );
  const customerId = requireOption(options, '--customer-id');
  const serviceAccount = requireOption(options, '--service-account');
  const quotaProject = requireOption(options, '--quota-project');
  if (!/^C[A-Za-z0-9]{5,30}$/u.test(customerId)) {
    throw new Error('--customer-id must be a Google customer ID beginning C.');
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{1,126}@[A-Za-z0-9-]+\.iam\.gserviceaccount\.com$/u.test(
      serviceAccount,
    )
  ) {
    throw new Error(
      '--service-account must be a Google service-account email.',
    );
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(quotaProject)) {
    throw new Error('--quota-project must be a canonical Google project ID.');
  }
  const outputPath = options.get('--output');
  return {
    command,
    customerId,
    facilitiesPath: requireOption(options, '--facilities'),
    quotaProject,
    serviceAccount,
    ...(outputPath === undefined
      ? {}
      : { outputPath: requireString(outputPath, '--output', 4_096) }),
  };
};

const main = async (arguments_: readonly string[]): Promise<void> => {
  if (arguments_.includes('--help')) {
    console.log(usage);
    return;
  }
  const options = parseCli(arguments_);
  if (options.command === 'validate') {
    const draft = await readPrivateJson(
      options.draftPath,
      'Mapping draft',
      MAX_DRAFT_FILE_BYTES,
    );
    console.log(JSON.stringify(validateDraft(draft), null, 2));
    return;
  }

  const facilities = parseFacilities(
    await readPrivateJson(
      options.facilitiesPath,
      'Facility input',
      MAX_FACILITY_INPUT_BYTES,
    ),
  );
  const accessToken = await obtainImpersonatedToken(options.serviceAccount);
  const inventory = await inventoryAllGroups(
    createCloudIdentityFetcher(
      accessToken,
      options.customerId,
      options.quotaProject,
    ),
    options.customerId,
  );
  const draft = buildDraft(
    facilities,
    inventory.groups,
    inventory.pageCount,
    new Date().toISOString(),
  );
  validateDraft(draft);
  const outputPath =
    options.outputPath === undefined
      ? await createDefaultOutputPath()
      : options.outputPath;
  await writePrivateDraft(outputPath, draft);
  console.log(
    JSON.stringify(
      {
        ambiguousStaffScopeGroupCount:
          draft.report.ambiguousStaffScopeGroups.length,
        buildingMappingCount: draft.buildingMappings.length,
        groupCount: draft.source.groupCount,
        missingFacilityCount: draft.report.missingFacilityIds.length,
        neighborhoodProposalCount: draft.neighborhoodProposals.length,
        omittedUnverifiedGroupIdentityCount:
          draft.report.omittedUnverifiedGroupIdentityCount,
        outputPath: resolve(outputPath),
        potentiallyStaleGroupCount: draft.report.potentiallyStaleGroups.length,
        uncertainFacilityCount: draft.report.uncertainFacilityIds.length,
      },
      null,
      2,
    ),
  );
};

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : 'Google Groups inventory failed safely.',
    );
    exitProcess(1);
  }
}
