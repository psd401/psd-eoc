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
import { tmpdir, userInfo } from 'node:os';
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

const CLOUD_IDENTITY_ORIGIN = 'https://cloudidentity.googleapis.com';
const CLOUD_IDENTITY_SCOPE =
  'https://www.googleapis.com/auth/cloud-identity.groups.readonly';
const PSD_HOSTED_DOMAIN = 'psd401.net';
const SYNTHETIC_TEST_GROUP_DOMAIN = 'groups.synthetic.invalid';
const MAX_FACILITY_INPUT_BYTES = 5_000_000;
const MAX_ADC_FILE_BYTES = 64_000;
// A bounded 20,000-group inventory can repeat safe group references in the
// inventory, candidate, staleness, and unassigned sections. Keep draft reads
// and writes aligned at a limit that accommodates that worst-case shape.
const MAX_DRAFT_FILE_BYTES = 128_000_000;
const MAX_RESPONSE_BYTES = 8_000_000;
const FILE_READ_CHUNK_BYTES = 64 * 1_024;
const MAX_PAGES = 100;
const MAX_GROUPS = 20_000;
const MAX_FACILITIES = 1_000;
const MAX_GROUPS_PER_PAGE = 500;
const MAX_NEIGHBORHOOD_FACILITIES = 200;

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
const SHORT_GRADE_POPULATION_MARKERS = new Set(['kdg', 'kg', 'tk']);

const SPELLED_GRADE_CARDINALS = [
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

const SPELLED_GRADE_ORDINALS = [
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

const SPELLED_GRADE_ORDINAL_MARKERS = new Set(SPELLED_GRADE_ORDINALS);
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
const OPERATIONAL_K_SAFE_WORDS = new Set([
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

type JsonObject = Record<string, unknown>;
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

interface CloudGroup {
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

interface DraftGroupRef {
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

interface NeighborhoodProposal {
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

interface MappingDraft {
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

interface ValidationSummary {
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

type CliOptions =
  | InventoryCli
  | ValidateCli
  | { readonly command: 'self-test' };
type PageFetcher = (pageToken: string | null) => Promise<unknown>;
type HttpFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

const isRecord = (value: unknown): value is JsonObject =>
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

const isHostedGroupEmail = (value: string, hostedDomain: string): boolean => {
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

const compareText = (left: string, right: string): number =>
  left.localeCompare(right, 'en-US');

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareText);

const normalizeText = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/&/gu, ' and ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');

const hasUnsupportedIdentityContent = (value: string): boolean => {
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

const groupTokenFields = (
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

const MAX_FACILITY_CONTEXTS_PER_IDENTITY_FIELD = 64;

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

const compactPopulationPrefixes = (
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

const facilityContextsForTokens = (
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

const hasIndexedExactWholeBuildingIdentity = (
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
const HIGH_CONFIDENCE_EMBEDDED_POPULATION_MARKERS = new Set([
  ...NON_STAFF_MARKERS,
]);

const INCIDENTAL_POPULATION_WORDS = new Set([
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

const scanWrittenGradeEndpoints = (field: string): WrittenGradeScan => {
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

const writtenGradeEvidenceForField = (
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

const hasStaffIdentityEvidence = (
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

const classifyPopulationGroup = (
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
const academicStartYearAt = (timestamp: Date): number => {
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

const groupRef = (group: CloudGroup): DraftGroupRef => ({
  displayName: group.displayName,
  email: group.email,
  googleGroupId: group.googleGroupId,
});

const parseCloudGroupForDomain = (
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

const parseGroupPage = (
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

const inventoryAllGroups = async (
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

const readBoundedStream = async (
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

const readBoundedResponseJson = async (
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

const createCloudIdentityFetcher =
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

const gcloudTokenArguments = (
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

const UNSAFE_AUTH_ENVIRONMENT_KEYS = new Set([
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

const assertSafeAuthenticationEnvironment = (
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

const createHumanAdcEnvironment = (
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

const parseInteractiveUserAdc = (value: unknown): void => {
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

interface GcloudPathMetadata {
  readonly mode: number;
  readonly uid: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

const hasTrustedGcloudOwner = (
  metadata: GcloudPathMetadata,
  currentUid: number,
): boolean => metadata.uid === 0 || metadata.uid === currentUid;

const isTrustedGcloudExecutableMetadata = (
  metadata: GcloudPathMetadata,
  currentUid: number,
): boolean =>
  metadata.isFile() &&
  hasTrustedGcloudOwner(metadata, currentUid) &&
  (metadata.mode & 0o111) !== 0 &&
  (metadata.mode & 0o022) === 0;

const isTrustedGcloudAncestorMetadata = (
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

interface DraftDerivationMetrics {
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

const siteSpecificFacilityNameTokens = (
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

const isExactWholeBuildingIdentity = (
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

const retainBest = <Value>(
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

const buildDraft = (
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

const createIsolatedGcloudConfigPath = async (
  temporaryRoot?: string,
): Promise<string> =>
  createPrivateTemporaryDirectory('psd-eoc-gcloud-config-', temporaryRoot);

const readPrivateJson = async (
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

const parseFacilities = (value: unknown): readonly Facility[] => {
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

const serializeDraft = (
  draft: MappingDraft,
  maximumBytes = MAX_DRAFT_FILE_BYTES,
): string => {
  const serialized = `${JSON.stringify(draft, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new Error('Draft output exceeds its bounded file-size limit.');
  }
  return serialized;
};

const writePrivateDraft = async (
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

const parseDraftGroupRef = (
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

const parseGroupSourceFromDraft = (
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

const parseNeighborhoodFromDraft = (
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

const validateDraftForDomain = (
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

  bun scripts/ops/groups-inventory.ts self-test

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

const parseCli = (arguments_: readonly string[]): CliOptions => {
  const command = arguments_[0];
  if (command === 'self-test') {
    if (arguments_.length !== 1) throw new Error(usage);
    return { command };
  }
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

const assertSelfTest: (
  condition: unknown,
  message: string,
) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Self-test failed: ${message}.`);
};

const expectSelfTestThrow = (
  operation: () => unknown,
  message: string,
): void => {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(`Self-test failed: ${message}.`);
};

const expectSelfTestReject = async (
  operation: () => Promise<unknown>,
  message: string,
): Promise<void> => {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(`Self-test failed: ${message}.`);
};

const runSelfTest = async (): Promise<void> => {
  const generatedAt = '2026-08-08T12:00:00.000Z';
  const parent = 'customers/C1234567';
  assertSelfTest(
    academicStartYearAt(new Date('2026-07-01T06:59:59.999Z')) === 2025 &&
      academicStartYearAt(new Date('2026-07-01T07:00:00.000Z')) === 2026,
    'the academic year turns over at local midnight between June 30 and July 1 in America/Los_Angeles',
  );
  const parseCloudGroup = (
    value: unknown,
    expectedParent: string,
  ): CloudGroup =>
    parseCloudGroupForDomain(
      value,
      expectedParent,
      SYNTHETIC_TEST_GROUP_DOMAIN,
    );
  const validateDraft = (value: unknown): ValidationSummary =>
    validateDraftForDomain(value, SYNTHETIC_TEST_GROUP_DOMAIN);
  const facilities: Facility[] = [
    {
      active: true,
      code: 'NBE',
      createdAt: generatedAt,
      id: '00000000-0000-4000-8000-000000000001',
      name: 'North Bay Elementary',
    },
    {
      active: true,
      code: 'NBM',
      createdAt: generatedAt,
      id: '00000000-0000-4000-8000-000000000002',
      name: 'North Bay Middle',
    },
    {
      active: true,
      code: 'SFE',
      createdAt: generatedAt,
      id: '00000000-0000-4000-8000-000000000003',
      name: 'Synthetic Fir Elementary',
    },
    {
      active: true,
      code: 'MIS',
      createdAt: generatedAt,
      id: '00000000-0000-4000-8000-000000000004',
      name: 'Missing Academy',
    },
    {
      active: false,
      code: 'LEG',
      createdAt: generatedAt,
      id: '00000000-0000-4000-8000-000000000005',
      name: 'Legacy Learning Center',
    },
  ].map((facility) => FacilitySchema.parse(facility));
  const rawGroup = (
    id: string,
    email: string,
    displayName: string,
  ): JsonObject => ({
    displayName,
    groupKey: { id: email },
    name: `groups/${id}`,
    parent,
  });
  const rawGroups = [
    rawGroup(
      'synthetic-nbe',
      'nbe.staff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    rawGroup(
      'synthetic-nbm',
      'nbm.staff@groups.synthetic.invalid',
      'NBM Staff',
    ),
    rawGroup(
      'synthetic-fir-a',
      'synthetic-fir.staff@groups.synthetic.invalid',
      'Synthetic Fir Staff',
    ),
    rawGroup(
      'synthetic-fir-b',
      'synthetic-fir.employees@groups.synthetic.invalid',
      'Synthetic Fir Employees',
    ),
    rawGroup(
      'synthetic-legacy',
      'synthetic.legacy.staff@groups.synthetic.invalid',
      'Legacy Staff Archived',
    ),
    rawGroup(
      'synthetic-operations',
      'synthetic.operations.staff@groups.synthetic.invalid',
      'Operations Staff',
    ),
    rawGroup(
      'synthetic-excluded-population',
      'nbe.students@groups.synthetic.invalid',
      'NBE Students',
    ),
  ];
  const groups = rawGroups.map((group) => parseCloudGroup(group, parent));

  let pageCalls = 0;
  const paginated = await inventoryAllGroups(
    async (pageToken) => {
      pageCalls += 1;
      if (pageToken === null) {
        return { groups: [rawGroups[0]], nextPageToken: 'page-two' };
      }
      assertSelfTest(
        pageToken === 'page-two',
        'pagination passed the exact token',
      );
      return { groups: [rawGroups[1]] };
    },
    'C1234567',
    SYNTHETIC_TEST_GROUP_DOMAIN,
  );
  assertSelfTest(
    paginated.pageCount === 2 &&
      paginated.groups.length === 2 &&
      pageCalls === 2,
    'all group pages are read',
  );
  const emptyInventory = await inventoryAllGroups(
    async () => ({}),
    'C1234567',
    SYNTHETIC_TEST_GROUP_DOMAIN,
  );
  assertSelfTest(
    emptyInventory.groups.length === 0 && emptyInventory.pageCount === 1,
    'an omitted empty repeated field is a complete empty inventory',
  );
  await expectSelfTestReject(
    () =>
      inventoryAllGroups(
        async () => ({ groups: [], nextPageToken: 'repeat' }),
        'C1234567',
        SYNTHETIC_TEST_GROUP_DOMAIN,
      ),
    'repeated page tokens fail closed',
  );
  await expectSelfTestReject(
    () =>
      inventoryAllGroups(
        async () => ({
          groups: [{ ...rawGroups[0], parent: 'customers/COTHER' }],
        }),
        'C1234567',
        SYNTHETIC_TEST_GROUP_DOMAIN,
      ),
    'cross-customer groups fail closed',
  );
  await expectSelfTestReject(
    () =>
      inventoryAllGroups(
        async () => ({ groups: [rawGroups[0], rawGroups[0]] }),
        'C1234567',
        SYNTHETIC_TEST_GROUP_DOMAIN,
      ),
    'duplicate provider identity fails closed',
  );
  const contractCompatibleSyntheticEmail =
    'nbe_ops-1.staff@groups.synthetic.invalid';
  assertSelfTest(
    isHostedGroupEmail(
      contractCompatibleSyntheticEmail,
      SYNTHETIC_TEST_GROUP_DOMAIN,
    ) &&
      CreateGroupSourceInputSchema.safeParse({
        active: true,
        displayName: 'Synthetic contract email control',
        email: contractCompatibleSyntheticEmail,
        facilityId: facilities[0]!.id,
        googleGroupId: 'groups/synthetic-contract-email-control',
        kind: 'google-group',
        purpose: 'building',
      }).success,
    'provider email acceptance remains aligned with the canonical group-source contract',
  );
  const consecutiveDotEmail = 'nbe..staff@groups.synthetic.invalid';
  assertSelfTest(
    !isHostedGroupEmail(consecutiveDotEmail, SYNTHETIC_TEST_GROUP_DOMAIN),
    'a consecutive-dot local part is rejected at the provider boundary',
  );
  expectSelfTestThrow(
    () =>
      parseCloudGroup(
        rawGroup(
          'synthetic-consecutive-dot-provider-email',
          consecutiveDotEmail,
          'NBE Staff',
        ),
        parent,
      ),
    'a contract-incompatible provider email fails before derivation',
  );
  expectSelfTestThrow(
    () =>
      parseDraftGroupRef(
        {
          displayName: 'NBE Staff',
          email: consecutiveDotEmail,
          googleGroupId: 'groups/synthetic-consecutive-dot-draft-email',
        },
        'Synthetic draft group',
        SYNTHETIC_TEST_GROUP_DOMAIN,
      ),
    'draft validation rejects the same contract-incompatible email',
  );

  let requestAttempts = 0;
  let requestShapeVerified = false;
  const requestPage = createCloudIdentityFetcher(
    'synthetic-access-token-that-is-never-sent',
    'C1234567',
    'synthetic-quota-project',
    async (input, init) => {
      requestAttempts += 1;
      const requestUrl = new URL(
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input,
      );
      const headers = new Headers(init?.headers);
      requestShapeVerified =
        requestUrl.origin === CLOUD_IDENTITY_ORIGIN &&
        requestUrl.pathname === '/v1/groups:search' &&
        requestUrl.searchParams.get('query') ===
          "parent == 'customers/C1234567'" &&
        requestUrl.searchParams.get('view') === 'FULL' &&
        requestUrl.searchParams.get('fields') ===
          'groups(name,parent,groupKey(id),displayName),nextPageToken' &&
        requestUrl.searchParams.get('pageSize') === '500' &&
        requestUrl.searchParams.get('pageToken') === 'synthetic-next-page' &&
        init?.method === 'GET' &&
        init.redirect === 'error' &&
        headers.get('authorization') ===
          'Bearer synthetic-access-token-that-is-never-sent' &&
        headers.get('x-goog-user-project') === 'synthetic-quota-project';
      return requestAttempts === 1
        ? new Response('{', { status: 200 })
        : new Response('{}', { status: 200 });
    },
  );
  const retriedPage = await requestPage('synthetic-next-page');
  assertSelfTest(
    requestAttempts === 2 &&
      requestShapeVerified &&
      isRecord(retriedPage) &&
      Object.keys(retriedPage).length === 0,
    'fixed-origin read-only request shape and response-read retries are enforced',
  );

  let oversizedResponseCancelCount = 0;
  const oversizedResponse = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        oversizedResponseCancelCount += 1;
      },
    }),
    {
      headers: {
        'content-length': String(MAX_RESPONSE_BYTES + 1),
      },
      status: 200,
    },
  );
  let oversizedResponseMessage = '';
  try {
    await readBoundedResponseJson(oversizedResponse);
  } catch (error) {
    oversizedResponseMessage =
      error instanceof Error ? error.message : 'unexpected error';
  }
  assertSelfTest(
    oversizedResponseCancelCount === 1 &&
      oversizedResponseMessage === 'Google response exceeded its size limit.',
    'a declared oversized successful response is canceled before its fixed size-limit failure',
  );

  const rejectingCancelResponse = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error('synthetic-provider-secret');
      },
    }),
    { status: 400 },
  );
  const rejectingCancelPage = createCloudIdentityFetcher(
    'synthetic-access-token-that-is-never-sent',
    'C1234567',
    'synthetic-quota-project',
    async () => rejectingCancelResponse,
  );
  let rejectingCancelMessage = '';
  try {
    await rejectingCancelPage(null);
  } catch (error) {
    rejectingCancelMessage =
      error instanceof Error ? error.message : 'unexpected error';
  }
  assertSelfTest(
    rejectingCancelMessage ===
      'The read-only Google Groups request failed with HTTP 400.' &&
      !rejectingCancelMessage.includes('synthetic-provider-secret'),
    'untrusted response-cancellation diagnostics cannot replace the fixed HTTP error',
  );
  const tokenArguments = gcloudTokenArguments(
    '/approved/synthetic/gcloud',
    'synthetic-reader@synthetic-project.iam.gserviceaccount.com',
  );
  assertSelfTest(
    tokenArguments
      .join(' ')
      .includes('auth application-default print-access-token') &&
      tokenArguments.includes(
        '--impersonate-service-account=synthetic-reader@synthetic-project.iam.gserviceaccount.com',
      ) &&
      tokenArguments.includes(`--scopes=${CLOUD_IDENTITY_SCOPE}`) &&
      tokenArguments.includes('--lifetime=900s') &&
      tokenArguments[0] === '/approved/synthetic/gcloud' &&
      !tokenArguments.some((argument) => argument.includes('delegat')),
    'gcloud uses short-lived read-only impersonation without delegation',
  );
  const currentUid = userInfo().uid;
  const syntheticMetadata = (
    kind: 'directory' | 'file',
    uid: number,
    mode: number,
  ): GcloudPathMetadata => ({
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    mode,
    uid,
  });
  assertSelfTest(
    isTrustedGcloudExecutableMetadata(
      syntheticMetadata('file', currentUid, 0o100755),
      currentUid,
    ) &&
      isTrustedGcloudExecutableMetadata(
        syntheticMetadata('file', 0, 0o100755),
        currentUid,
      ) &&
      !isTrustedGcloudExecutableMetadata(
        syntheticMetadata('file', currentUid + 1, 0o100755),
        currentUid,
      ) &&
      !isTrustedGcloudExecutableMetadata(
        syntheticMetadata('file', currentUid, 0o100775),
        currentUid,
      ) &&
      !isTrustedGcloudExecutableMetadata(
        syntheticMetadata('file', currentUid, 0o100644),
        currentUid,
      ),
    'gcloud must be executable, non-writable by other principals, and owned by root or the current user',
  );
  assertSelfTest(
    isTrustedGcloudAncestorMetadata(
      syntheticMetadata('directory', currentUid, 0o040755),
      currentUid,
    ) &&
      isTrustedGcloudAncestorMetadata(
        syntheticMetadata('directory', 0, 0o040755),
        currentUid,
      ) &&
      !isTrustedGcloudAncestorMetadata(
        syntheticMetadata('directory', currentUid + 1, 0o040755),
        currentUid,
      ) &&
      !isTrustedGcloudAncestorMetadata(
        syntheticMetadata('directory', currentUid, 0o040777),
        currentUid,
      ),
    'every gcloud ancestor must be non-writable by other principals and owned by root or the current user',
  );
  parseInteractiveUserAdc({
    client_id: 'synthetic-interactive-client',
    client_secret: 'synthetic-interactive-secret',
    refresh_token: 'synthetic-interactive-refresh-token',
    type: 'authorized_user',
  });
  expectSelfTestThrow(
    () =>
      parseInteractiveUserAdc({
        client_email:
          'synthetic-reader@synthetic-project.iam.gserviceaccount.com',
        private_key: 'synthetic-never-a-real-key',
        type: 'service_account',
      }),
    'non-user ADC provenance fails closed',
  );
  for (const unsafeAdc of [
    {
      client_id: 'synthetic-interactive-client',
      client_secret: 'synthetic-interactive-secret',
      refresh_token: 'synthetic-interactive-refresh-token',
      token_uri: 'https://credential-sink.invalid/token',
      type: 'authorized_user',
    },
    {
      client_id: 'synthetic-interactive-client',
      client_secret: 'synthetic-interactive-secret',
      refresh_token: 'synthetic-interactive-refresh-token',
      type: 'authorized_user',
      universe_domain: 'credential-sink.invalid',
    },
  ]) {
    expectSelfTestThrow(
      () => parseInteractiveUserAdc(unsafeAdc),
      'interactive ADC cannot redirect OAuth or IAM endpoints',
    );
  }
  for (const key of [
    ...UNSAFE_AUTH_ENVIRONMENT_KEYS,
    'CLOUDSDK_SYNTHETIC_FUTURE_OVERRIDE',
    'DYLD_LIBRARY_PATH',
    'GCE_METADATA_HOST',
    'GCLOUD_SYNTHETIC_FUTURE_OVERRIDE',
    'GOOGLE_SYNTHETIC_FUTURE_CREDENTIAL',
    'GRPC_DEFAULT_SSL_ROOTS_FILE_PATH',
    'LD_LIBRARY_PATH',
    'OPENSSL_CONF',
    'PYTHONUSERBASE',
    'REQUESTS_CA_BUNDLE',
    'SSL_CERT_DIR',
  ]) {
    expectSelfTestThrow(
      () =>
        assertSafeAuthenticationEnvironment({ [key]: 'synthetic-override' }),
      `${key} cannot alter authentication, execution, or TLS`,
    );
  }
  const syntheticHumanAdcEnvironment = createHumanAdcEnvironment(
    {
      HOME: '/hostile/synthetic-home',
      LANG: 'hostile-locale',
      PATH: '/hostile/synthetic-bin',
      SYNTHETIC_UNKNOWN_EXECUTION_OVERRIDE: '/hostile/synthetic-helper',
      TERM: 'hostile-terminal',
      TMPDIR: '/hostile/synthetic-temporary-root',
    },
    '/private/synthetic-adc.json',
    '/private/synthetic-gcloud-config',
    '/approved/synthetic/gcloud',
    '/private/synthetic-home',
  );
  const expectedGcloudEnvironmentKeys = [
    'CLOUDSDK_API_ENDPOINT_OVERRIDES_IAMCREDENTIALS',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
    'CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION',
    'CLOUDSDK_AUTH_MTLS_TOKEN_HOST',
    'CLOUDSDK_AUTH_TOKEN_HOST',
    'CLOUDSDK_CONFIG',
    'CLOUDSDK_CONTEXT_AWARE_USE_CLIENT_CERTIFICATE',
    'CLOUDSDK_CORE_UNIVERSE_DOMAIN',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_UNIVERSE_DOMAIN',
    'HOME',
    'LANG',
    'LC_ALL',
    'PATH',
    'TERM',
    'TMPDIR',
  ].sort(compareText);
  assertSelfTest(
    JSON.stringify(
      Object.keys(syntheticHumanAdcEnvironment).sort(compareText),
    ) === JSON.stringify(expectedGcloudEnvironmentKeys) &&
      syntheticHumanAdcEnvironment.HOME === '/private/synthetic-home' &&
      !(syntheticHumanAdcEnvironment.PATH ?? '').includes('/hostile') &&
      syntheticHumanAdcEnvironment.LANG === 'C' &&
      syntheticHumanAdcEnvironment.LC_ALL === 'C' &&
      syntheticHumanAdcEnvironment.TERM === 'dumb' &&
      syntheticHumanAdcEnvironment.TMPDIR ===
        '/private/synthetic-gcloud-config' &&
      !(
        'SYNTHETIC_UNKNOWN_EXECUTION_OVERRIDE' in syntheticHumanAdcEnvironment
      ) &&
      syntheticHumanAdcEnvironment.CLOUDSDK_CONFIG ===
        '/private/synthetic-gcloud-config' &&
      syntheticHumanAdcEnvironment.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE ===
        '/private/synthetic-adc.json' &&
      syntheticHumanAdcEnvironment.GOOGLE_APPLICATION_CREDENTIALS ===
        '/private/synthetic-adc.json' &&
      syntheticHumanAdcEnvironment.CLOUDSDK_AUTH_TOKEN_HOST ===
        'https://oauth2.googleapis.com/token' &&
      syntheticHumanAdcEnvironment.CLOUDSDK_CORE_UNIVERSE_DOMAIN ===
        'googleapis.com' &&
      syntheticHumanAdcEnvironment.CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION ===
        'false',
    'the gcloud subprocess receives only fixed credentials, endpoints, paths, locale, terminal, and temporary state',
  );
  expectSelfTestThrow(
    () =>
      parseCloudGroup(
        rawGroup(
          'synthetic-format-control',
          'synthetic.nbe.staff@groups.synthetic.invalid',
          'NBE Stu\u200bdents Staff',
        ),
        parent,
      ),
    'Unicode format controls in group names fail closed',
  );
  assertSelfTest(
    [
      'ＮＢＥ Staff',
      'ⓃⒷⒺ Staff',
      '𝐍𝐁𝐄 Staff',
      'N\u0338BE Staff',
      'N\u034FBE Staff',
      'N\u036FBE Staff',
    ].every(hasUnsupportedIdentityContent) &&
      !hasUnsupportedIdentityContent('Caf\u00e9 Staff'),
    'compatibility characters, overlays, and invisible combining marks fail matching before supported diacritics are folded',
  );

  const facilityPage = {
    items: facilities,
    pageInfo: { hasMore: false, nextCursor: null },
  };
  assertSelfTest(
    parseFacilities(facilityPage).length === facilities.length,
    'complete canonical facility pages parse',
  );
  expectSelfTestThrow(
    () =>
      parseFacilities({
        ...facilityPage,
        pageInfo: { hasMore: true, nextCursor: 'more' },
      }),
    'partial facility pages fail closed',
  );
  for (const [label, maximum, operation] of [
    [
      'provider group page',
      MAX_GROUPS_PER_PAGE,
      (oversized: unknown[]) =>
        parseGroupPage(
          { groups: oversized },
          parent,
          SYNTHETIC_TEST_GROUP_DOMAIN,
        ),
    ],
    [
      'canonical facility page',
      MAX_FACILITIES,
      (oversized: unknown[]) =>
        parseFacilities({
          items: oversized,
          pageInfo: { hasMore: false, nextCursor: null },
        }),
    ],
    [
      'neighborhood facility IDs',
      MAX_NEIGHBORHOOD_FACILITIES,
      (oversized: unknown[]) =>
        parseNeighborhoodFromDraft({
          facilityIds: oversized,
          name: 'Synthetic oversized neighborhood',
          neighborhoodId: null,
        }),
    ],
  ] as const) {
    let limitElementVisited = false;
    const oversized = new Proxy(new Array(maximum + 1), {
      get(target, property, receiver) {
        if (property === String(maximum)) limitElementVisited = true;
        return Reflect.get(target, property, receiver);
      },
    });
    expectSelfTestThrow(
      () => operation(oversized),
      `${label} cardinality fails closed`,
    );
    assertSelfTest(
      !limitElementVisited,
      `${label} is bounded before entries are visited`,
    );
  }

  const draft = buildDraft(facilities, groups, 2, generatedAt);
  expectSelfTestThrow(
    () => buildDraft(facilities, groups, 2, '2026-02-31T12:00:00.000Z'),
    'impossible calendar dates fail the canonical timestamp contract',
  );
  assertSelfTest(
    draft.importAuthorized === false,
    'draft cannot authorize import',
  );
  assertSelfTest(
    draft.source.membershipDataFetched === false &&
      draft.source.authorizationCoverage === 'not-verified',
    'source evidence stays truthful',
  );
  assertSelfTest(
    draft.report.omittedUnverifiedGroupIdentityCount === 1,
    'student-marked groups are hard excluded',
  );
  const serialized = JSON.stringify(draft);
  assertSelfTest(
    !serialized.includes('synthetic-excluded-population') &&
      !serialized.includes('nbe.students@groups.synthetic.invalid'),
    'excluded group identity is omitted',
  );
  const northBayMappings = draft.buildingMappings.filter(({ facility }) =>
    ['NBE', 'NBM'].includes(facility.code),
  );
  assertSelfTest(
    northBayMappings.every(
      ({ assessment, createGroupSource, reviewDecision }) =>
        assessment.outcome === 'strong-candidate' &&
        createGroupSource !== null &&
        reviewDecision === 'pending',
    ),
    'exact code plus broad staff marker produces pending proposals',
  );
  const syntheticFir = draft.buildingMappings.find(
    ({ facility }) => facility.code === 'SFE',
  );
  assertSelfTest(
    syntheticFir?.assessment.outcome === 'uncertain' &&
      syntheticFir.createGroupSource === null &&
      syntheticFir.assessment.reasonCodes.includes('CLOSE_OR_TIED_CANDIDATES'),
    'tied groups stay uncertain',
  );
  assertSelfTest(
    draft.report.missingFacilityIds.includes(
      '00000000-0000-4000-8000-000000000004',
    ),
    'missing active facilities are reported',
  );
  assertSelfTest(
    draft.report.potentiallyStaleGroups.some(({ reasonCodes }) =>
      reasonCodes.includes('HEURISTIC_NOT_STALENESS_PROOF'),
    ),
    'potential staleness is explicitly heuristic',
  );
  assertSelfTest(
    draft.neighborhoodProposals.length === 1 &&
      draft.neighborhoodProposals[0]?.generatedHint?.reasonCodes.includes(
        'NO_GEOGRAPHY_EVIDENCE',
      ) === true,
    'shared exact stems only produce name-only neighborhood hints',
  );
  const longNeighborhoodStem = 'A'.repeat(148);
  const longNeighborhoodFacilities = [1, 2].map((index) =>
    FacilitySchema.parse({
      active: true,
      code: `LONG${index}`,
      createdAt: generatedAt,
      id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
      name: `${longNeighborhoodStem} ${index === 1 ? 'Elementary' : 'Middle'}`,
    }),
  );
  const parsedLongNeighborhoodFacilities = parseFacilities({
    items: longNeighborhoodFacilities,
    pageInfo: { hasMore: false, nextCursor: null },
  });
  const longNeighborhoodDraft = buildDraft(
    parsedLongNeighborhoodFacilities,
    [],
    1,
    generatedAt,
  );
  assertSelfTest(
    longNeighborhoodDraft.neighborhoodProposals.length === 1 &&
      longNeighborhoodDraft.neighborhoodProposals[0]?.createNeighborhoodVersion
        .name === 'Proposed neighborhood LONG1' &&
      longNeighborhoodDraft.neighborhoodProposals[0]?.generatedHint?.reasonCodes.includes(
        'CONTRACT_SAFE_FALLBACK_NAME',
      ) === true,
    'overlong neighborhood hints use a deterministic contract-safe name',
  );
  const genericFacilityNameTokens = [
    'Academy',
    'Campus',
    'Center',
    'Education',
    'Elementary',
    'High',
    'Middle',
    'School',
  ] as const;
  const oversizedNeighborhoodFacilities = Array.from(
    { length: 201 },
    (_, index) => {
      const genericSuffix = genericFacilityNameTokens.filter(
        (_, bit) => (index & (1 << bit)) !== 0,
      );
      return FacilitySchema.parse({
        active: true,
        code: `OC${index + 1}`,
        createdAt: generatedAt,
        id: `00000000-0000-4000-8000-${String(1_000 + index).padStart(12, '0')}`,
        name: ['Oversized Cluster', ...genericSuffix].join(' '),
      });
    },
  );
  const parsedOversizedNeighborhoodFacilities = parseFacilities({
    items: oversizedNeighborhoodFacilities,
    pageInfo: { hasMore: false, nextCursor: null },
  });
  const oversizedNeighborhoodDraft = buildDraft(
    parsedOversizedNeighborhoodFacilities,
    [],
    1,
    generatedAt,
  );
  assertSelfTest(
    oversizedNeighborhoodDraft.neighborhoodProposals.length === 0 &&
      oversizedNeighborhoodDraft.report.skippedNeighborhoodHints.length === 1 &&
      oversizedNeighborhoodDraft.report.warnings.includes(
        'NEIGHBORHOOD_HINT_SKIPPED_CONTRACT_LIMIT',
      ),
    'oversized neighborhood clusters are warned and skipped without aborting inventory',
  );
  const oversizedNeighborhoodValidation = validateDraft(
    oversizedNeighborhoodDraft,
  );
  assertSelfTest(
    oversizedNeighborhoodValidation.unresolvedFindingCount ===
      oversizedNeighborhoodFacilities.length + 1,
    'a skipped neighborhood hint contributes an unresolved finding beyond the missing mappings',
  );
  const splitOversizedNeighborhoodProposals: NeighborhoodProposal[] = [];
  for (const [index, members] of [
    oversizedNeighborhoodFacilities.slice(0, 100),
    oversizedNeighborhoodFacilities.slice(100),
  ].entries()) {
    splitOversizedNeighborhoodProposals.push({
      createNeighborhoodVersion: parseNeighborhoodFromDraft({
        facilityIds: members.map(({ id }) => id),
        name: `Human-reviewed oversized split ${index + 1}`,
        neighborhoodId: null,
      }),
      generatedHint: null,
      reviewDecision: 'confirmed',
      reviewNote: 'Synthetic human split of a contract-limited generated hint.',
    });
  }
  const splitOversizedNeighborhoodDraft = {
    ...oversizedNeighborhoodDraft,
    neighborhoodProposals: splitOversizedNeighborhoodProposals,
  };
  assertSelfTest(
    validateDraft(splitOversizedNeighborhoodDraft)
      .confirmedNeighborhoodCount === 2,
    'human review may split an oversized skipped hint into contract-valid neighborhoods',
  );
  const secondOversizedNeighborhoodFacilities = Array.from(
    { length: 201 },
    (_, index) => {
      const genericSuffix = genericFacilityNameTokens.filter(
        (_, bit) => (index & (1 << bit)) !== 0,
      );
      return FacilitySchema.parse({
        active: true,
        code: `SC${index + 1}`,
        createdAt: generatedAt,
        id: `00000000-0000-4000-8000-${String(2_000 + index).padStart(12, '0')}`,
        name: ['Second Oversized Cluster', ...genericSuffix].join(' '),
      });
    },
  );
  const multipleOversizedNeighborhoodDraft = buildDraft(
    parseFacilities({
      items: [
        ...oversizedNeighborhoodFacilities,
        ...secondOversizedNeighborhoodFacilities,
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    }),
    [],
    1,
    generatedAt,
  );
  assertSelfTest(
    multipleOversizedNeighborhoodDraft.neighborhoodProposals.length === 0 &&
      multipleOversizedNeighborhoodDraft.report.skippedNeighborhoodHints
        .length === 2 &&
      validateDraft(multipleOversizedNeighborhoodDraft)
        .unresolvedFindingCount === 404,
    'each oversized neighborhood cluster retains a distinct unresolved finding',
  );
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...oversizedNeighborhoodDraft,
        report: {
          ...oversizedNeighborhoodDraft.report,
          skippedNeighborhoodHints: [],
        },
      }),
    'validation rejects removal of a structured skipped-neighborhood finding',
  );
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...oversizedNeighborhoodDraft,
        report: {
          ...oversizedNeighborhoodDraft.report,
          warnings: oversizedNeighborhoodDraft.report.warnings.filter(
            (warning) => warning !== 'NEIGHBORHOOD_HINT_SKIPPED_CONTRACT_LIMIT',
          ),
        },
      }),
    'validation rejects removal of a facilities-derived neighborhood-limit warning',
  );
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...draft,
        report: {
          ...draft.report,
          warnings: [
            ...draft.report.warnings,
            'NEIGHBORHOOD_HINT_SKIPPED_CONTRACT_LIMIT',
          ],
        },
      }),
    'validation rejects an invented neighborhood-limit warning',
  );
  assertSelfTest(
    JSON.stringify(draft) ===
      JSON.stringify(
        buildDraft(
          [...facilities].reverse(),
          [...groups].reverse(),
          2,
          generatedAt,
        ),
      ),
    'shuffled inputs produce byte-identical drafts',
  );
  const validation = validateDraft(draft);
  assertSelfTest(
    validation.structuralValidationPassed &&
      !validation.allReviewFieldsStructurallyResolved &&
      !validation.canonicalSourcesReverified &&
      !validation.importAuthorized,
    'structural validation cannot imply source verification or import authority',
  );
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...draft,
        report: {
          ...draft.report,
          omittedUnverifiedGroupIdentityCount:
            MAX_GROUPS_PER_PAGE + 1 - draft.inventoryGroups.length,
        },
        source: {
          ...draft.source,
          groupCount: MAX_GROUPS_PER_PAGE + 1,
          pageCount: 1,
        },
      }),
    'draft group counts cannot exceed their bounded pagination evidence',
  );
  const duplicateFacilityNameDraft = buildDraft(
    [
      facilities[0]!,
      FacilitySchema.parse({
        ...facilities[2]!,
        name: facilities[0]!.name,
      }),
    ],
    [],
    1,
    generatedAt,
  );
  expectSelfTestThrow(
    () => validateDraft(duplicateFacilityNameDraft),
    'draft validation rejects duplicate normalized facility names',
  );
  for (const [label, mutate] of [
    [
      'inventory',
      (candidate: MappingDraft, oversized: unknown[]) => ({
        ...candidate,
        inventoryGroups: oversized,
      }),
    ],
    [
      'staleness report',
      (candidate: MappingDraft, oversized: unknown[]) => ({
        ...candidate,
        report: { ...candidate.report, potentiallyStaleGroups: oversized },
      }),
    ],
    [
      'duplicate report',
      (candidate: MappingDraft, oversized: unknown[]) => ({
        ...candidate,
        report: { ...candidate.report, duplicateGroupProposals: oversized },
      }),
    ],
  ] as const) {
    let oversizedElementVisited = false;
    const oversized = new Proxy(new Array(MAX_GROUPS + 1), {
      get(target, property, receiver) {
        if (property === String(MAX_GROUPS)) oversizedElementVisited = true;
        return Reflect.get(target, property, receiver);
      },
    });
    expectSelfTestThrow(
      () => validateDraft(mutate(draft, oversized)),
      `${label} cardinality fails closed`,
    );
    assertSelfTest(
      !oversizedElementVisited,
      `${label} bounds are checked before entries are processed`,
    );
  }
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...draft,
        report: {
          ...draft.report,
          unassignedBuildingLikeGroups:
            draft.report.unassignedBuildingLikeGroups.slice(1),
        },
      }),
    'validation rejects removal of a derived unassigned group finding',
  );
  const selectedDraftGroup = draft.inventoryGroups.find(({ googleGroupId }) =>
    draft.buildingMappings.some(
      ({ createGroupSource }) =>
        createGroupSource?.googleGroupId === googleGroupId,
    ),
  );
  if (selectedDraftGroup === undefined) {
    throw new Error('Self-test fixture did not produce a selected group.');
  }
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...draft,
        report: {
          ...draft.report,
          unassignedBuildingLikeGroups: [
            ...draft.report.unassignedBuildingLikeGroups,
            selectedDraftGroup,
          ],
        },
      }),
    'validation rejects an invented unassigned group finding',
  );
  const inventedPendingDraft = structuredClone(draft);
  const inventedPendingMapping = inventedPendingDraft.buildingMappings.find(
    ({ facility }) => facility.code === 'NBE',
  );
  const unrelatedOperationsGroup = inventedPendingDraft.inventoryGroups.find(
    ({ email }) =>
      email === 'synthetic.operations.staff@groups.synthetic.invalid',
  );
  if (
    inventedPendingMapping === undefined ||
    unrelatedOperationsGroup === undefined
  ) {
    throw new Error('Self-test fixture did not produce pending edit inputs.');
  }
  inventedPendingMapping.assessment = {
    bestHeuristicScore: 120,
    candidates: [
      {
        ...unrelatedOperationsGroup,
        heuristicScore: 120,
        reasonCodes: ['EDITED_EXACT_FACILITY_CODE', 'EDITED_STAFF_MARKER'],
      },
    ],
    outcome: 'strong-candidate',
    reasonCodes: ['BIDIRECTIONALLY_UNIQUE'],
  };
  inventedPendingMapping.createGroupSource = parseGroupSourceFromDraft({
    active: true,
    displayName: inventedPendingMapping.facility.name,
    email: unrelatedOperationsGroup.email,
    facilityId: inventedPendingMapping.facility.id,
    googleGroupId: unrelatedOperationsGroup.googleGroupId,
    kind: 'google-group',
    purpose: 'building',
  });
  expectSelfTestThrow(
    () => validateDraft(inventedPendingDraft),
    'validation regenerates pending proposals instead of trusting edited scores and reasons',
  );
  const confirmedEvidenceDraft = structuredClone(draft);
  const confirmedEvidenceMapping = confirmedEvidenceDraft.buildingMappings.find(
    ({ facility }) => facility.code === 'NBE',
  );
  if (
    confirmedEvidenceMapping === undefined ||
    confirmedEvidenceMapping.createGroupSource === null
  ) {
    throw new Error('Self-test fixture did not produce confirmable evidence.');
  }
  confirmedEvidenceMapping.reviewDecision = 'confirmed';
  confirmedEvidenceMapping.reviewNote = 'Synthetic human confirmation.';
  confirmedEvidenceMapping.assessment.reasonCodes.push(
    'EDITED_AFTER_CONFIRMATION',
  );
  expectSelfTestThrow(
    () => validateDraft(confirmedEvidenceDraft),
    'human confirmation cannot rewrite generated assessment evidence',
  );
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...draft,
        neighborhoodProposals: [],
      }),
    'a generated neighborhood hint requires an explicit retained review decision',
  );
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...draft,
        neighborhoodProposals: draft.neighborhoodProposals.map(
          (proposal, index) =>
            index === 0
              ? {
                  ...proposal,
                  generatedHint:
                    proposal.generatedHint === null
                      ? null
                      : {
                          ...proposal.generatedHint,
                          reasonCodes: [
                            ...proposal.generatedHint.reasonCodes,
                            'EDITED_NEIGHBORHOOD_EVIDENCE',
                          ],
                        },
                }
              : proposal,
        ),
      }),
    'neighborhood review cannot rewrite generated heuristic evidence',
  );
  const boundedNeighborhoodProposal = draft.neighborhoodProposals[0];
  if (boundedNeighborhoodProposal?.generatedHint === null) {
    throw new Error('Self-test fixture did not produce generated evidence.');
  }
  if (boundedNeighborhoodProposal !== undefined) {
    let generatedHintLimitElementVisited = false;
    const oversizedGeneratedHintFacilityIds = new Proxy(
      new Array(MAX_NEIGHBORHOOD_FACILITIES + 1),
      {
        get(target, property, receiver) {
          if (property === String(MAX_NEIGHBORHOOD_FACILITIES)) {
            generatedHintLimitElementVisited = true;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ) as unknown as readonly string[];
    expectSelfTestThrow(
      () =>
        validateDraft({
          ...draft,
          neighborhoodProposals: [
            {
              ...boundedNeighborhoodProposal,
              generatedHint:
                boundedNeighborhoodProposal.generatedHint === null
                  ? null
                  : {
                      ...boundedNeighborhoodProposal.generatedHint,
                      createNeighborhoodVersion: {
                        ...boundedNeighborhoodProposal.generatedHint
                          .createNeighborhoodVersion,
                        facilityIds: oversizedGeneratedHintFacilityIds,
                      },
                    },
            },
          ],
        }),
      'nested generated neighborhood IDs fail their cardinality bound',
    );
    assertSelfTest(
      !generatedHintLimitElementVisited,
      'nested generated neighborhood IDs are bounded before entries are visited',
    );
  }
  const correctedNeighborhood = draft.neighborhoodProposals[0];
  if (correctedNeighborhood === undefined) {
    throw new Error('Self-test fixture did not produce a neighborhood hint.');
  }
  const correctedNeighborhoodDraft = {
    ...draft,
    neighborhoodProposals: draft.neighborhoodProposals.map(
      (proposal, index): NeighborhoodProposal =>
        index === 0
          ? {
              ...proposal,
              createNeighborhoodVersion: parseNeighborhoodFromDraft({
                facilityIds: [facilities[0]!.id, facilities[2]!.id],
                name: 'Human-reviewed synthetic neighborhood',
                neighborhoodId: null,
              }),
              reviewDecision: 'confirmed',
              reviewNote:
                'Synthetic correction of the generated name-only hint.',
            }
          : proposal,
    ),
  };
  const correctedNeighborhoodValidation = validateDraft(
    correctedNeighborhoodDraft,
  );
  assertSelfTest(
    correctedNeighborhoodValidation.confirmedNeighborhoodCount === 1 &&
      correctedNeighborhoodDraft.neighborhoodProposals[0]?.generatedHint
        ?.createNeighborhoodVersion.facilityIds.length === 2,
    'human confirmation may correct a neighborhood payload while retaining immutable generated evidence',
  );
  const humanAddedNeighborhoodDraft = {
    ...draft,
    neighborhoodProposals: [
      ...draft.neighborhoodProposals,
      {
        createNeighborhoodVersion: parseNeighborhoodFromDraft({
          facilityIds: [facilities[2]!.id, facilities[3]!.id],
          name: 'Human-added synthetic neighborhood',
          neighborhoodId: null,
        }),
        generatedHint: null,
        reviewDecision: 'confirmed' as const,
        reviewNote:
          'Synthetic D-029 grouping absent from generated name hints.',
      },
    ],
  };
  assertSelfTest(
    validateDraft(humanAddedNeighborhoodDraft).confirmedNeighborhoodCount === 1,
    'human review may add a documented D-029 neighborhood without retyping it elsewhere',
  );
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...draft,
        neighborhoodProposals: [
          ...draft.neighborhoodProposals,
          {
            createNeighborhoodVersion: parseNeighborhoodFromDraft({
              ...correctedNeighborhood.createNeighborhoodVersion,
              facilityIds: [
                ...correctedNeighborhood.createNeighborhoodVersion.facilityIds,
              ].reverse(),
            }),
            generatedHint: null,
            reviewDecision: 'confirmed',
            reviewNote:
              'Synthetic attempt to duplicate a neighborhood in reverse order.',
          },
        ],
      }),
    'semantic duplicate neighborhoods are rejected regardless of facility-ID order',
  );
  const overlappingNeighborhoodDraft = {
    ...draft,
    neighborhoodProposals: [
      ...draft.neighborhoodProposals,
      {
        createNeighborhoodVersion: parseNeighborhoodFromDraft({
          facilityIds: [facilities[0]!.id, facilities[2]!.id],
          name: 'Synthetic overlapping neighborhood one',
          neighborhoodId: null,
        }),
        generatedHint: null,
        reviewDecision: 'confirmed' as const,
        reviewNote: 'Synthetic D-029 overlap confirmed by a human.',
      },
      {
        createNeighborhoodVersion: parseNeighborhoodFromDraft({
          facilityIds: [facilities[0]!.id, facilities[3]!.id],
          name: 'Synthetic overlapping neighborhood two',
          neighborhoodId: null,
        }),
        generatedHint: null,
        reviewDecision: 'confirmed' as const,
        reviewNote: 'Synthetic D-029 overlap confirmed by a human.',
      },
    ],
  };
  assertSelfTest(
    validateDraft(overlappingNeighborhoodDraft).confirmedNeighborhoodCount ===
      2,
    'D-029 permits a human to confirm overlapping neighborhood memberships',
  );
  const twoHintFacilities = [
    ['AR-E', 'Alpha Ridge Elementary'],
    ['AR-M', 'Alpha Ridge Middle'],
    ['BR-E', 'Beta Ridge Elementary'],
    ['BR-M', 'Beta Ridge Middle'],
  ].map(([code, name], index) =>
    FacilitySchema.parse({
      active: true,
      code,
      createdAt: generatedAt,
      id: `00000000-0000-4000-8000-${String(8_000 + index).padStart(12, '0')}`,
      name,
    }),
  );
  const twoHintDraft = buildDraft(twoHintFacilities, [], 1, generatedAt);
  const firstHint = twoHintDraft.neighborhoodProposals[0]?.generatedHint;
  const secondHint = twoHintDraft.neighborhoodProposals[1]?.generatedHint;
  if (firstHint === undefined || secondHint === undefined) {
    throw new Error(
      'Self-test fixture did not produce two neighborhood hints.',
    );
  }
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...twoHintDraft,
        neighborhoodProposals: twoHintDraft.neighborhoodProposals.map(
          (proposal, index) => ({
            ...proposal,
            generatedHint: index === 0 ? secondHint : firstHint,
          }),
        ),
      }),
    'generated neighborhood evidence cannot be swapped between proposals',
  );
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...draft,
        neighborhoodProposals: [
          ...draft.neighborhoodProposals,
          {
            createNeighborhoodVersion: {
              facilityIds: [facilities[2]!.id, facilities[3]!.id],
              name: 'Undocumented synthetic neighborhood',
              neighborhoodId: null,
            },
            generatedHint: null,
            reviewDecision: 'pending',
            reviewNote: null,
          },
        ],
      }),
    'human-added neighborhoods require explicit provenance notes',
  );
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...draft,
        report: {
          ...draft.report,
          duplicateGroupProposals: [
            ...draft.report.duplicateGroupProposals,
            {
              facilityIds: draft.buildingMappings
                .slice(0, 2)
                .map(({ facility }) => facility.id),
              group: selectedDraftGroup,
            },
          ],
        },
      }),
    'validation rejects an invented duplicate-group finding',
  );
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...draft,
        report: {
          ...draft.report,
          warnings: [...draft.report.warnings, 'FABRICATED_WARNING'],
        },
      }),
    'validation rejects warning codes that are not regenerated evidence',
  );
  const serializedDraft = serializeDraft(draft);
  const serializedDraftBytes = Buffer.byteLength(serializedDraft, 'utf8');
  assertSelfTest(
    serializedDraftBytes <= MAX_DRAFT_FILE_BYTES,
    'generated drafts fit the aligned read and write bound',
  );
  expectSelfTestThrow(
    () => serializeDraft(draft, serializedDraftBytes - 1),
    'oversized drafts fail before a file is opened or published',
  );

  const studentStaff = parseCloudGroup(
    rawGroup(
      'synthetic-mixed-population',
      'synthetic.missing.staff.students@groups.synthetic.invalid',
      'MIS Staff Students',
    ),
    parent,
  );
  const mixedDraft = buildDraft(facilities, [studentStaff], 1, generatedAt);
  const serializedMixedDraft = JSON.stringify(mixedDraft);
  assertSelfTest(
    mixedDraft.inventoryGroups.length === 0 &&
      mixedDraft.report.omittedUnverifiedGroupIdentityCount === 1 &&
      !serializedMixedDraft.includes(studentStaff.googleGroupId) &&
      !serializedMixedDraft.includes(studentStaff.email) &&
      mixedDraft.buildingMappings.every(
        ({ assessment, createGroupSource }) =>
          assessment.candidates.length === 0 && createGroupSource === null,
      ),
    'staff-qualified population identities are counted without being serialized',
  );
  const directMixedMarkerDraft = buildDraft(
    [],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-students-admins',
          'synthetic.studentsadmins@groups.synthetic.invalid',
          'Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-parents-faculty',
          'synthetic.parentsfaculty@groups.synthetic.invalid',
          'Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-students-old',
          'synthetic.studentsold@groups.synthetic.invalid',
          'Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  const serializedDirectMixedMarkerDraft = JSON.stringify(
    directMixedMarkerDraft,
  );
  assertSelfTest(
    directMixedMarkerDraft.inventoryGroups.length === 0 &&
      directMixedMarkerDraft.report.omittedUnverifiedGroupIdentityCount === 3 &&
      !serializedDirectMixedMarkerDraft.includes('synthetic-students-admins') &&
      !serializedDirectMixedMarkerDraft.includes('synthetic-parents-faculty') &&
      !serializedDirectMixedMarkerDraft.includes('synthetic-students-old'),
    'direct mixed staff/population identities are omitted without retaining identity metadata',
  );

  const earlyGradeGroups = [
    rawGroup(
      'synthetic-exact-preschool-staff',
      'synthetic.nbe.preschool.staff@groups.synthetic.invalid',
      'NBE Preschool Staff',
    ),
    rawGroup(
      'synthetic-compact-preschool-staff',
      'synthetic.nbepreschoolstaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    rawGroup(
      'synthetic-exact-pk-staff',
      'synthetic.nbe.pk.staff@groups.synthetic.invalid',
      'NBE PK Staff',
    ),
    rawGroup(
      'synthetic-compact-pk-staff',
      'synthetic.nbepkstaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    rawGroup(
      'synthetic-exact-k-staff',
      'synthetic.nbe.k.staff@groups.synthetic.invalid',
      'NBE K Staff',
    ),
    rawGroup(
      'synthetic-compact-k-staff',
      'synthetic.nbekstaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    rawGroup(
      'synthetic-exact-kindy-staff',
      'synthetic.nbe.kindy.staff@groups.synthetic.invalid',
      'NBE Kindy Staff',
    ),
    rawGroup(
      'synthetic-compact-kindy-staff',
      'synthetic.nbekindystaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    rawGroup(
      'synthetic-exact-kinder-staff',
      'synthetic.nbe.kinder.staff@groups.synthetic.invalid',
      'NBE Kinder Staff',
    ),
    rawGroup(
      'synthetic-compact-kinder-staff',
      'synthetic.nbekinderstaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
  ].map((group) => parseCloudGroup(group, parent));
  const earlyGradeDraft = buildDraft(
    [facilities[0]!],
    earlyGradeGroups,
    1,
    generatedAt,
  );
  const serializedEarlyGradeDraft = JSON.stringify(earlyGradeDraft);
  assertSelfTest(
    earlyGradeDraft.source.groupCount === 10 &&
      earlyGradeDraft.inventoryGroups.length === 0 &&
      earlyGradeDraft.report.omittedUnverifiedGroupIdentityCount === 10 &&
      earlyGradeDraft.buildingMappings[0]?.assessment.candidates.length === 0 &&
      earlyGradeDraft.buildingMappings[0]?.createGroupSource === null &&
      !serializedEarlyGradeDraft.includes('synthetic-exact-preschool-staff') &&
      !serializedEarlyGradeDraft.includes('synthetic-exact-kindy-staff') &&
      !serializedEarlyGradeDraft.includes('synthetic-exact-kinder-staff'),
    'staff-qualified early-grade identities are omitted in exact and compact forms',
  );

  const wholeBuildingScopeDraft = buildDraft(
    [facilities[0]!],
    [
      rawGroup(
        'synthetic-arbitrary-k-scope',
        'nbeprogramkrosterstaff@groups.synthetic.invalid',
        'NBE Staff',
      ),
      rawGroup(
        'synthetic-arbitrary-pk-scope',
        'nbepkrosterstaff@groups.synthetic.invalid',
        'NBE Staff',
      ),
      rawGroup(
        'synthetic-ordinal-grade-scope',
        'nbe.5th.staff@groups.synthetic.invalid',
        'NBE 5th Staff',
      ),
      rawGroup(
        'synthetic-grade-range-scope',
        'nbe.6-8.staff@groups.synthetic.invalid',
        'NBE 6-8 Staff',
      ),
      rawGroup(
        'synthetic-preschool-scope',
        'nbe.preschool.staff@groups.synthetic.invalid',
        'NBE Preschool Staff',
      ),
      rawGroup(
        'synthetic-kindergarten-scope',
        'nbe.kindergarten.staff@groups.synthetic.invalid',
        'NBE Kindergarten Staff',
      ),
      rawGroup(
        'synthetic-grade-five-scope',
        'nbe.grade.5.staff@groups.synthetic.invalid',
        'NBE Grade 5 Staff',
      ),
      rawGroup(
        'synthetic-cafeteria-scope',
        'nbe.staff@groups.synthetic.invalid',
        'NBE Cafeteria Staff',
      ),
      rawGroup(
        'synthetic-maintenance-scope',
        'nbe.maintenance.staff@groups.synthetic.invalid',
        'NBE Staff',
      ),
      rawGroup(
        'synthetic-security-scope',
        'nbe.security.staff@groups.synthetic.invalid',
        'NBE Security Staff',
      ),
      rawGroup(
        'synthetic-prior-year-scope',
        'nbe.2023-2024.staff@groups.synthetic.invalid',
        'NBE 2023-2024 Staff',
      ),
      rawGroup(
        'synthetic-future-year-scope',
        'nbe.2027.staff@groups.synthetic.invalid',
        'NBE 2027 Staff',
      ),
      rawGroup(
        'synthetic-mixed-year-scope',
        'nbe.2025-2026.staff@groups.synthetic.invalid',
        'NBE 2025-2026 Staff',
      ),
    ].map((group) => parseCloudGroup(group, parent)),
    1,
    generatedAt,
  );
  assertSelfTest(
    wholeBuildingScopeDraft.inventoryGroups.length === 6 &&
      wholeBuildingScopeDraft.report.omittedUnverifiedGroupIdentityCount ===
        7 &&
      wholeBuildingScopeDraft.report.ambiguousStaffScopeGroups.length === 4 &&
      wholeBuildingScopeDraft.report.potentiallyStaleGroups.length === 2 &&
      wholeBuildingScopeDraft.report.potentiallyStaleGroups.every(
        ({ reasonCodes }) =>
          reasonCodes.includes('GROUP_HAS_PRIOR_YEAR_MARKER'),
      ) &&
      wholeBuildingScopeDraft.buildingMappings[0]?.assessment.candidates
        .length === 0 &&
      wholeBuildingScopeDraft.buildingMappings[0]?.createGroupSource === null,
    'only a fully consumed whole-building identity can become an automatic source',
  );
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...wholeBuildingScopeDraft,
        report: {
          ...wholeBuildingScopeDraft.report,
          ambiguousStaffScopeGroups:
            wholeBuildingScopeDraft.report.ambiguousStaffScopeGroups.slice(1),
        },
      }),
    'validation rejects removal of a derived staff-scope quarantine',
  );
  const scopeCandidateDraft = structuredClone(wholeBuildingScopeDraft);
  const scopeCandidateGroup =
    scopeCandidateDraft.report.ambiguousStaffScopeGroups[0];
  const scopeCandidateMapping = scopeCandidateDraft.buildingMappings[0];
  if (
    scopeCandidateGroup === undefined ||
    scopeCandidateMapping === undefined
  ) {
    throw new Error('Self-test scope fixture did not produce a quarantine.');
  }
  scopeCandidateMapping.assessment = {
    bestHeuristicScore: 100,
    candidates: [
      {
        ...scopeCandidateGroup,
        heuristicScore: 100,
        reasonCodes: ['HUMAN_EDITED_CANDIDATE'],
      },
    ],
    outcome: 'uncertain',
    reasonCodes: ['HUMAN_EDITED_ASSESSMENT'],
  };
  expectSelfTestThrow(
    () => validateDraft(scopeCandidateDraft),
    'edited drafts cannot reintroduce a quarantined staff scope as a candidate',
  );

  const currentYearWholeBuildingDraft = buildDraft(
    [facilities[0]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-current-year-whole-building',
          'nbe2026staff@groups.synthetic.invalid',
          'NBE 2026 Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    currentYearWholeBuildingDraft.report.ambiguousStaffScopeGroups.length ===
      0 &&
      currentYearWholeBuildingDraft.report.potentiallyStaleGroups.length ===
        0 &&
      currentYearWholeBuildingDraft.buildingMappings[0]?.createGroupSource !==
        null,
    'the exact current UTC year remains valid in a whole-building identity',
  );

  const populationOnlyDraft = buildDraft(
    [facilities[0]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-population-only-students',
          'nbe.students@groups.synthetic.invalid',
          'NBE Students',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-population-only-parents',
          'nbe.parents@groups.synthetic.invalid',
          'NBE Parents',
        ),
        parent,
      ),
      ...[
        ['group', 'NBE Students Group'],
        ['list', 'NBE Students List'],
        ['members', 'NBE Students Members'],
      ].map(([suffix, displayName]) =>
        parseCloudGroup(
          rawGroup(
            `synthetic-population-only-${suffix}`,
            `nbe.students.${suffix}@groups.synthetic.invalid`,
            displayName!,
          ),
          parent,
        ),
      ),
    ],
    1,
    generatedAt,
  );
  const serializedPopulationOnlyDraft = JSON.stringify(populationOnlyDraft);
  assertSelfTest(
    populationOnlyDraft.source.groupCount === 5 &&
      populationOnlyDraft.inventoryGroups.length === 0 &&
      populationOnlyDraft.report.omittedUnverifiedGroupIdentityCount === 5 &&
      !serializedPopulationOnlyDraft.includes(
        'synthetic-population-only-students',
      ) &&
      !serializedPopulationOnlyDraft.includes(
        'synthetic-population-only-parents',
      ),
    'population-only identities are counted but not serialized into the staff mapping artifact',
  );
  const personalPopulationGroups = [
    rawGroup(
      'synthetic-smith-family',
      'smith.family@groups.synthetic.invalid',
      'Smith Family',
    ),
    rawGroup(
      'synthetic-jane-doe-grade-five',
      'jane.doe.grade.5@groups.synthetic.invalid',
      'Jane Doe Grade 5',
    ),
    rawGroup(
      'synthetic-all-schools-students',
      'all.schools.students@groups.synthetic.invalid',
      'All Schools Students',
    ),
    rawGroup(
      'synthetic-compact-program-students',
      'nbeprogramstudents@groups.synthetic.invalid',
      'NBEProgramStudents',
    ),
    rawGroup(
      'synthetic-students-mailing-list',
      'students.mailing.list@groups.synthetic.invalid',
      'Students Mailing List',
    ),
    rawGroup(
      'synthetic-parents-distribution-roster',
      'parents.distribution.roster@groups.synthetic.invalid',
      'Parents Distribution Roster',
    ),
  ].map((group) => parseCloudGroup(group, parent));
  const personalPopulationDraft = buildDraft(
    [facilities[0]!],
    personalPopulationGroups,
    1,
    generatedAt,
  );
  const serializedPersonalPopulationDraft = JSON.stringify(
    personalPopulationDraft,
  );
  assertSelfTest(
    personalPopulationDraft.inventoryGroups.length === 0 &&
      personalPopulationDraft.report.omittedUnverifiedGroupIdentityCount ===
        personalPopulationGroups.length &&
      personalPopulationGroups.every(
        ({ displayName, email, googleGroupId }) =>
          !serializedPersonalPopulationDraft.includes(googleGroupId) &&
          !serializedPersonalPopulationDraft.includes(email) &&
          (displayName === null ||
            !serializedPersonalPopulationDraft.includes(displayName)),
      ),
    'personal, family, grade, roster, and compact population identities never enter the artifact',
  );

  const staffQualifiedPopulationTeamDraft = buildDraft(
    [facilities[0]!],
    [
      ['student-services', 'NBE Student Services Team'],
      ['grade-5-team', 'NBE Grade 5 Team'],
      ['preschool-team', 'NBE Preschool Team'],
      ['parent-liaison', 'NBE Parent Liaison Team'],
      ['child-nutrition', 'NBE Child Nutrition Team'],
    ].map(([slug, displayName]) =>
      parseCloudGroup(
        rawGroup(
          `synthetic-${slug}`,
          `nbe.${slug}@groups.synthetic.invalid`,
          displayName!,
        ),
        parent,
      ),
    ),
    1,
    generatedAt,
  );
  assertSelfTest(
    staffQualifiedPopulationTeamDraft.inventoryGroups.length === 0 &&
      staffQualifiedPopulationTeamDraft.report
        .omittedUnverifiedGroupIdentityCount === 5 &&
      staffQualifiedPopulationTeamDraft.buildingMappings[0]?.assessment
        .candidates.length === 0 &&
      staffQualifiedPopulationTeamDraft.buildingMappings[0]
        ?.createGroupSource === null,
    'population words with unexplained team scope are omitted without identity metadata',
  );

  const unicodeScopeDraft = buildDraft(
    [facilities[0]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-non-latin-scope',
          'nbe.staff@groups.synthetic.invalid',
          'NBE 学生 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-symbol-scope',
          'nbe.employees@groups.synthetic.invalid',
          'NBE 🧒 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-private-use-scope',
          'nbe.team@groups.synthetic.invalid',
          'NBE \uE000 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-surrogate-scope',
          'nbe.members@groups.synthetic.invalid',
          'NBE \uD800 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-extended-combining-scope',
          'nbestaff@groups.synthetic.invalid',
          'NBE\u1AB0Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-fullwidth-students-scope',
          'nbe.fullwidth.staff@groups.synthetic.invalid',
          'NBE Ｓｔｕｄｅｎｔｓ Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-unverified-personal-scope',
          'jane.doe@groups.synthetic.invalid',
          'Jane Doe',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-prefixed-compact-grade-scope',
          'janedoegrade5.staff@groups.synthetic.invalid',
          'JaneDoeGrade5 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-compact-student-program-scope',
          'studentprogramstaff@groups.synthetic.invalid',
          'StudentProgramStaff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-compact-parent-liaison-scope',
          'parentliaisonstaff@groups.synthetic.invalid',
          'ParentLiaisonStaff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-compact-child-nutrition-scope',
          'childnutritionstaff@groups.synthetic.invalid',
          'ChildNutritionStaff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  const serializedUnicodeScopeDraft = JSON.stringify(unicodeScopeDraft);
  assertSelfTest(
    unicodeScopeDraft.inventoryGroups.length === 0 &&
      unicodeScopeDraft.report.omittedUnverifiedGroupIdentityCount === 11 &&
      unicodeScopeDraft.buildingMappings[0]?.assessment.candidates.length ===
        0 &&
      unicodeScopeDraft.buildingMappings[0]?.createGroupSource === null &&
      !serializedUnicodeScopeDraft.includes('groups/synthetic-'),
    'only positively established staff identities enter the draft; unverified, Unicode-obscured, and compact population identities are omitted without metadata',
  );

  const compactWholeBuildingDraft = buildDraft(
    [facilities[0]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-compact-whole-building',
          'nbestaff@groups.synthetic.invalid',
          'NBEStaff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    compactWholeBuildingDraft.buildingMappings[0]?.createGroupSource !== null &&
      compactWholeBuildingDraft.buildingMappings[0]?.assessment.reasonCodes.includes(
        'BIDIRECTIONALLY_UNIQUE_MATCH',
      ) === true &&
      compactWholeBuildingDraft.buildingMappings[0]?.assessment.candidates[0]?.reasonCodes.includes(
        'EXACT_FULLY_CONSUMED_FACILITY_IDENTITY',
      ) === true,
    'fully compact identities use the same exact whole-building scoring path',
  );

  for (const pairedIdentityGroup of [
    parseCloudGroup(
      rawGroup(
        'synthetic-display-staff-local-facility',
        'nbe@groups.synthetic.invalid',
        'NBE Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-display-facility-local-staff',
        'nbe.staff@groups.synthetic.invalid',
        'North Bay Elementary',
      ),
      parent,
    ),
  ]) {
    const pairedIdentityDraft = buildDraft(
      [facilities[0]!],
      [pairedIdentityGroup],
      1,
      generatedAt,
    );
    assertSelfTest(
      pairedIdentityDraft.inventoryGroups.length === 1 &&
        pairedIdentityDraft.report.omittedUnverifiedGroupIdentityCount === 0 &&
        pairedIdentityDraft.report.ambiguousStaffScopeGroups.length === 0 &&
        pairedIdentityDraft.buildingMappings[0]?.assessment.outcome ===
          'strong-candidate' &&
        pairedIdentityDraft.buildingMappings[0]?.createGroupSource
          ?.googleGroupId === pairedIdentityGroup.googleGroupId,
      'one-sided staff evidence is accepted only when the other field is the exact alias for the same facility',
    );
  }
  const uncorroboratedOneSidedStaffDraft = buildDraft(
    [facilities[0]!, facilities[2]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-one-sided-unknown-identity',
          'synthetic.program@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-one-sided-cross-facility-identity',
          'sfe@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    uncorroboratedOneSidedStaffDraft.inventoryGroups.length === 0 &&
      uncorroboratedOneSidedStaffDraft.report
        .omittedUnverifiedGroupIdentityCount === 2 &&
      uncorroboratedOneSidedStaffDraft.buildingMappings.every(
        ({ assessment, createGroupSource }) =>
          assessment.candidates.length === 0 && createGroupSource === null,
      ),
    'one-sided staff evidence stays omitted when the other field is unknown or belongs to a different facility',
  );

  const punctuationSplitAliasGroups = [
    parseCloudGroup(
      rawGroup(
        'synthetic-split-code-one-sided',
        'n.be@groups.synthetic.invalid',
        'NBEStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-split-stem-one-sided',
        'nort.hbay@groups.synthetic.invalid',
        'NorthBayStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-fully-split-code',
        'n.b.e.staff@groups.synthetic.invalid',
        'N.B.E Staff',
      ),
      parent,
    ),
  ];
  const punctuationSplitAliasDraft = buildDraft(
    [facilities[0]!],
    punctuationSplitAliasGroups,
    1,
    generatedAt,
  );
  const serializedPunctuationSplitAliasDraft = JSON.stringify(
    punctuationSplitAliasDraft,
  );
  assertSelfTest(
    punctuationSplitAliasDraft.inventoryGroups.length === 1 &&
      punctuationSplitAliasDraft.inventoryGroups[0]?.googleGroupId ===
        'groups/synthetic-fully-split-code' &&
      punctuationSplitAliasDraft.report.omittedUnverifiedGroupIdentityCount ===
        2 &&
      punctuationSplitAliasDraft.buildingMappings[0]?.assessment.candidates
        .length === 0 &&
      punctuationSplitAliasDraft.buildingMappings[0]?.createGroupSource ===
        null &&
      !serializedPunctuationSplitAliasDraft.includes(
        'groups/synthetic-split-code-one-sided',
      ) &&
      !serializedPunctuationSplitAliasDraft.includes(
        'groups/synthetic-split-stem-one-sided',
      ),
    'arbitrary punctuation cannot resegment a facility code or stem into exact evidence',
  );
  for (const canonicalAliasGroup of [
    parseCloudGroup(
      rawGroup(
        'synthetic-canonical-compact-code',
        'nbe@groups.synthetic.invalid',
        'NBEStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-canonical-tokenized-stem',
        'north.bay@groups.synthetic.invalid',
        'NorthBayStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-canonical-compact-stem',
        'northbay@groups.synthetic.invalid',
        'North Bay Staff',
      ),
      parent,
    ),
  ]) {
    const canonicalAliasDraft = buildDraft(
      [facilities[0]!],
      [canonicalAliasGroup],
      1,
      generatedAt,
    );
    assertSelfTest(
      canonicalAliasDraft.inventoryGroups.length === 1 &&
        canonicalAliasDraft.report.omittedUnverifiedGroupIdentityCount === 0 &&
        canonicalAliasDraft.buildingMappings[0]?.assessment.outcome ===
          'strong-candidate' &&
        canonicalAliasDraft.buildingMappings[0]?.createGroupSource
          ?.googleGroupId === canonicalAliasGroup.googleGroupId,
      'canonical tokenized and compact facility aliases remain exact evidence',
    );
  }

  for (const [slug, qualifier] of [
    ['campus', 'Campus'],
    ['bldg', 'Bldg'],
  ] as const) {
    const singularSiteQualifierGroup = parseCloudGroup(
      rawGroup(
        `synthetic-singular-${slug}-staff`,
        `nbe.${slug}.staff@groups.synthetic.invalid`,
        `NBE ${qualifier} Staff`,
      ),
      parent,
    );
    const singularSiteQualifierDraft = buildDraft(
      [facilities[0]!],
      [singularSiteQualifierGroup],
      1,
      generatedAt,
    );
    assertSelfTest(
      singularSiteQualifierDraft.buildingMappings[0]?.assessment.outcome ===
        'strong-candidate' &&
        singularSiteQualifierDraft.buildingMappings[0]?.createGroupSource
          ?.googleGroupId === singularSiteQualifierGroup.googleGroupId,
      'singular campus and bldg qualifiers remain fully consumed whole-site identities',
    );
  }

  const pluralSiteQualifierDraft = buildDraft(
    [facilities[0]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-plural-campuses-staff',
          'nbe.campuses.staff@groups.synthetic.invalid',
          'NBE Campuses Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-plural-bldgs-staff',
          'nbe.bldgs.staff@groups.synthetic.invalid',
          'NBE Bldgs Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-plural-buildings-staff',
          'nbe.buildings.staff@groups.synthetic.invalid',
          'NBE Buildings Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-plural-schools-staff',
          'nbe.schools.staff@groups.synthetic.invalid',
          'NBE Schools Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    pluralSiteQualifierDraft.report.ambiguousStaffScopeGroups.length === 4 &&
      pluralSiteQualifierDraft.buildingMappings[0]?.assessment.candidates
        .length === 0 &&
      pluralSiteQualifierDraft.buildingMappings[0]?.createGroupSource === null,
    'plural aggregate site qualifiers stay quarantined for human review',
  );

  const genericAliasFacilities = [
    ['ALL', 'North Harbor Elementary'],
    ['PSD', 'Peninsula School District'],
    ['GROUP', 'East Harbor Elementary'],
    ['TEAM', 'West Harbor Elementary'],
    ['SCHOOL', 'Central Harbor Elementary'],
    ['PSD-ALL', 'Crescent Harbor Elementary'],
    ['ALL-STAFF', 'Hidden Harbor Elementary'],
    ['DISTRICT-STAFF', 'Quiet Harbor Elementary'],
    ['2026', 'Sunrise Harbor Elementary'],
    ['NORTH', 'Moonrise Harbor Elementary'],
    ['ALL-FACILITIES', 'All Facilities School'],
    ['ALL-SITES', 'All Sites School'],
    ['ALL-CAMPUSES', 'All Campuses School'],
    ['ALL-DIST', 'All District School'],
    ['EVERYONE', 'Everyone School'],
    ['OTHERS', 'Others School'],
    ['ALLUSERS', 'All Users School'],
    ['GLOBAL', 'Global School'],
    ['SYSTEM', 'System School'],
    ['PERSONNEL', 'Personnel School'],
    ['WORKFORCE', 'Workforce School'],
    ['ALS', 'All Locations School'],
    ['ALL-LOCATIONS', 'All Locations School'],
    ['ELEM', 'Synthetic Elementary'],
    ['MID', 'Synthetic Middle'],
    ['SCH', 'Synthetic School'],
    ['DIS', 'Discovery Harbor Elementary'],
    ['ADM', 'Admiral Harbor Elementary'],
    ['OTH', 'Othello Harbor Elementary'],
    ['OPS', 'Opsahl Harbor Elementary'],
    ['ANHL', 'All North Harbor Locations'],
    ['NHS', 'North Harbor Sites'],
    ['NHS2', 'North Harbor Schools'],
    ['NHB', 'North Harbor Buildings'],
    ['ITD', 'IT Dept'],
    ['ITSV', 'Information Technology Svcs'],
    ['HR', 'Human Resources'],
    ['HRD', 'HR Dept'],
    ['DSD', 'District Safety Dept'],
    ['BLDG', 'Building'],
    ['BLD', 'Bldg'],
  ].map(([code, name], index) =>
    FacilitySchema.parse({
      active: true,
      code,
      createdAt: generatedAt,
      id: `00000000-0000-4000-8000-${String(30 + index).padStart(12, '0')}`,
      name,
    }),
  );
  const genericAliasDraft = buildDraft(
    genericAliasFacilities,
    genericAliasFacilities.map((facility, index) =>
      parseCloudGroup(
        rawGroup(
          `synthetic-generic-alias-${index}`,
          `${facility.code.toLocaleLowerCase('en-US')}.staff@groups.synthetic.invalid`,
          `${facility.code} Staff`,
        ),
        parent,
      ),
    ),
    1,
    generatedAt,
  );
  assertSelfTest(
    genericAliasDraft.buildingMappings.every(
      ({ assessment, createGroupSource }) =>
        assessment.candidates.length === 0 && createGroupSource === null,
    ) &&
      genericAliasDraft.report.unassignedBuildingLikeGroups.length ===
        genericAliasFacilities.length,
    'generic, aggregate, numeric, workforce, organization, and weak facility aliases cannot bind districtwide staff groups to buildings',
  );
  for (const aggregateCode of [
    'ANHL',
    'PSD',
    'NHS',
    'NHS2',
    'NHB',
    'ITD',
    'ITSV',
    'HR',
    'HRD',
    'DSD',
  ]) {
    const aggregateFacility = genericAliasFacilities.find(
      ({ code }) => code === aggregateCode,
    );
    if (aggregateFacility === undefined) {
      throw new Error('Self-test aggregate facility fixture is missing.');
    }
    const aggregateIdentityDraft = buildDraft(
      [aggregateFacility],
      [
        parseCloudGroup(
          rawGroup(
            `synthetic-aggregate-identity-${aggregateCode.toLocaleLowerCase('en-US')}`,
            `${normalizeText(aggregateFacility.name).replaceAll(' ', '.')}.staff@groups.synthetic.invalid`,
            `${aggregateFacility.name} Staff`,
          ),
          parent,
        ),
      ],
      1,
      generatedAt,
    );
    assertSelfTest(
      aggregateIdentityDraft.buildingMappings[0]?.assessment.candidates
        .length === 0 &&
        aggregateIdentityDraft.buildingMappings[0]?.createGroupSource === null,
      'an aggregate facility name cannot become an automatic building identity',
    );
  }

  const weakStemFacility = FacilitySchema.parse({
    active: true,
    code: 'NS',
    createdAt: generatedAt,
    id: '00000000-0000-4000-8000-000000000050',
    name: 'North School',
  });
  const weakStemDraft = buildDraft(
    [weakStemFacility],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-weak-north-staff',
          'north.staff@groups.synthetic.invalid',
          'North Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-full-north-school-staff',
          'north.school.staff@groups.synthetic.invalid',
          'North School Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    weakStemDraft.buildingMappings[0]?.createGroupSource === null &&
      weakStemDraft.buildingMappings[0]?.assessment.candidates.length === 0 &&
      weakStemDraft.report.unassignedBuildingLikeGroups.length === 2,
    'a weak one-token site name cannot anchor an automatic building mapping',
  );

  const genericSingletonFacility = FacilitySchema.parse({
    active: true,
    code: 'ES',
    createdAt: generatedAt,
    id: '00000000-0000-4000-8000-000000000053',
    name: 'Elementary School',
  });
  const genericSingletonDraft = buildDraft(
    [genericSingletonFacility],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-generic-singleton-code-staff',
          'es.staff@groups.synthetic.invalid',
          'ES Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-generic-singleton-name-staff',
          'elementary.school.staff@groups.synthetic.invalid',
          'Elementary School Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    genericSingletonDraft.buildingMappings[0]?.createGroupSource === null &&
      genericSingletonDraft.buildingMappings[0]?.assessment.candidates
        .length === 0,
    'removing the singleton length threshold does not enable generic facility identities',
  );

  const shortSingletonSiteFacility = FacilitySchema.parse({
    active: true,
    code: 'PUR',
    createdAt: generatedAt,
    id: '00000000-0000-4000-8000-000000000054',
    name: 'Purdy Elementary',
  });
  for (const shortSingletonGroup of [
    parseCloudGroup(
      rawGroup(
        'synthetic-purdy-code-staff',
        'pur.staff@groups.synthetic.invalid',
        'PUR Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-purdy-name-staff',
        'purdy.elementary.staff@groups.synthetic.invalid',
        'Purdy Elementary Staff',
      ),
      parent,
    ),
  ]) {
    const shortSingletonSiteDraft = buildDraft(
      [shortSingletonSiteFacility],
      [shortSingletonGroup],
      1,
      generatedAt,
    );
    assertSelfTest(
      shortSingletonSiteDraft.buildingMappings[0]?.assessment.outcome ===
        'strong-candidate' &&
        shortSingletonSiteDraft.buildingMappings[0]?.createGroupSource
          ?.googleGroupId === shortSingletonGroup.googleGroupId,
      'an exact distinctive short singleton site identity supports an automatic building match',
    );
  }

  const singletonSiteFacility = FacilitySchema.parse({
    active: true,
    code: 'UPL',
    createdAt: generatedAt,
    id: '00000000-0000-4000-8000-000000000052',
    name: 'Uplands Academy',
  });
  for (const singletonGroup of [
    parseCloudGroup(
      rawGroup(
        'synthetic-uplands-code-staff',
        'upl.staff@groups.synthetic.invalid',
        'UPL Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-uplands-name-staff',
        'uplands.academy.staff@groups.synthetic.invalid',
        'Uplands Academy Staff',
      ),
      parent,
    ),
  ]) {
    const singletonSiteDraft = buildDraft(
      [singletonSiteFacility],
      [singletonGroup],
      1,
      generatedAt,
    );
    assertSelfTest(
      singletonSiteDraft.buildingMappings[0]?.assessment.outcome ===
        'strong-candidate' &&
        singletonSiteDraft.buildingMappings[0]?.createGroupSource
          ?.googleGroupId === singletonGroup.googleGroupId,
      'a long distinctive singleton site stem supports an exact building match',
    );
  }

  const physicalSiteFacilities = (
    [
      [0, 'HCP', 'Harbor Campus'],
      [1, 'HBL', 'Harbor Building'],
      [2, 'HBG', 'Harbor Bldg'],
    ] as const
  ).map(([index, code, name]) =>
    FacilitySchema.parse({
      active: true,
      code,
      createdAt: generatedAt,
      id: `00000000-0000-4000-8000-${String(60 + index).padStart(12, '0')}`,
      name,
    }),
  );
  for (const [
    index,
    physicalSiteFacility,
  ] of physicalSiteFacilities.entries()) {
    for (const [variant, email, displayName] of [
      [
        'full',
        `${normalizeText(physicalSiteFacility.name).replaceAll(' ', '.')}.staff@groups.synthetic.invalid`,
        `${physicalSiteFacility.name} Staff`,
      ],
      ['stem', 'harbor.staff@groups.synthetic.invalid', 'Harbor Staff'],
    ] as const) {
      const physicalSiteGroup = parseCloudGroup(
        rawGroup(
          `synthetic-physical-site-${index}-${variant}`,
          email,
          displayName,
        ),
        parent,
      );
      const physicalSiteDraft = buildDraft(
        [physicalSiteFacility],
        [physicalSiteGroup],
        1,
        generatedAt,
      );
      assertSelfTest(
        physicalSiteDraft.buildingMappings[0]?.assessment.outcome ===
          'strong-candidate' &&
          physicalSiteDraft.buildingMappings[0]?.createGroupSource
            ?.googleGroupId === physicalSiteGroup.googleGroupId,
        'singular campus, building, and bldg site types support full-name and distinctive-stem matches',
      );
    }
  }
  const physicalSiteNeighborhoodDraft = buildDraft(
    physicalSiteFacilities.slice(0, 2),
    [],
    1,
    generatedAt,
  );
  assertSelfTest(
    physicalSiteNeighborhoodDraft.neighborhoodProposals.length === 1 &&
      physicalSiteNeighborhoodDraft.neighborhoodProposals[0]?.generatedHint
        ?.createNeighborhoodVersion.name === 'Harbor neighborhood' &&
      physicalSiteNeighborhoodDraft.neighborhoodProposals[0]?.generatedHint
        ?.createNeighborhoodVersion.facilityIds.length === 2,
    'singular campus and building suffixes share the same conservative neighborhood stem',
  );

  const kNamedFacilities = (
    [
      ['KMS', 'Key Peninsula School'],
      ['MCE', 'Minter Creek Elementary'],
      ['OHA', 'Oak Harbor Academy'],
    ] as const
  ).map(([code, name], index) =>
    FacilitySchema.parse({
      active: true,
      code,
      createdAt: generatedAt,
      id: `00000000-0000-4000-8000-${String(70 + index).padStart(12, '0')}`,
      name,
    }),
  );
  for (const [index, kNamedFacility] of kNamedFacilities.entries()) {
    const stem = siteSpecificFacilityNameTokens(kNamedFacility).join(' ');
    const kNamedFacilityGroup = parseCloudGroup(
      rawGroup(
        `synthetic-k-named-facility-${index}`,
        `${stem.replaceAll(' ', '.')}.staff@groups.synthetic.invalid`,
        `${stem} Staff`,
      ),
      parent,
    );
    const kNamedFacilityDraft = buildDraft(
      [kNamedFacility],
      [kNamedFacilityGroup],
      1,
      generatedAt,
    );
    assertSelfTest(
      kNamedFacilityDraft.inventoryGroups.length === 1 &&
        kNamedFacilityDraft.report.omittedUnverifiedGroupIdentityCount === 0 &&
        kNamedFacilityDraft.buildingMappings[0]?.assessment.outcome ===
          'strong-candidate' &&
        kNamedFacilityDraft.buildingMappings[0]?.createGroupSource
          ?.googleGroupId === kNamedFacilityGroup.googleGroupId,
      'authoritative multi-token facility aliases explain their own K characters and remain matchable',
    );
  }
  const kNamedQualifierGroups = [
    parseCloudGroup(
      rawGroup(
        'synthetic-kms-program-blue',
        'kms.program.blue.staff@groups.synthetic.invalid',
        'KMS Program Blue Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-kms-program-k-blue',
        'kms.program.kblue.staff@groups.synthetic.invalid',
        'KMS Program KBlue Staff',
      ),
      parent,
    ),
  ];
  const kNamedQualifierDraft = buildDraft(
    [kNamedFacilities[0]!],
    kNamedQualifierGroups,
    1,
    generatedAt,
  );
  assertSelfTest(
    kNamedQualifierDraft.inventoryGroups.length === 1 &&
      kNamedQualifierDraft.inventoryGroups[0]?.googleGroupId ===
        'groups/synthetic-kms-program-blue' &&
      kNamedQualifierDraft.report.omittedUnverifiedGroupIdentityCount === 1 &&
      !JSON.stringify(kNamedQualifierDraft).includes(
        'groups/synthetic-kms-program-k-blue',
      ),
    'a facility alias K is protected without masking an additional unexplained grade marker',
  );

  const indexedScaleFacilities = Array.from({ length: 200 }, (_, index) => {
    const suffix = String(index).padStart(3, '0');
    return FacilitySchema.parse({
      active: true,
      code: `BR${suffix}`,
      createdAt: generatedAt,
      id: `00000000-0000-4000-8000-${String(3_000 + index).padStart(12, '0')}`,
      name: `Benchmark Ridge ${suffix} School`,
    });
  });
  const indexedScaleExactGroups = indexedScaleFacilities.map(
    (facility, index) => {
      const stem = siteSpecificFacilityNameTokens(facility).join(' ');
      return parseCloudGroup(
        rawGroup(
          `synthetic-indexed-scale-exact-${index}`,
          `${stem.replaceAll(' ', '.')}.staff@groups.synthetic.invalid`,
          `${stem} Staff`,
        ),
        parent,
      );
    },
  );
  const indexedScaleUnanchoredGroups = Array.from(
    { length: 1_000 },
    (_, index) =>
      parseCloudGroup(
        rawGroup(
          `synthetic-indexed-scale-unanchored-${index}`,
          `operations.${index}.staff@groups.synthetic.invalid`,
          `Operations ${index} Staff`,
        ),
        parent,
      ),
  );
  const indexedScaleMetrics: DraftDerivationMetrics = {
    facilityGroupScoreEvaluations: 0,
    facilityTerminalContextEvaluations: 0,
  };
  const indexedScaleDraft = buildDraft(
    indexedScaleFacilities,
    [...indexedScaleExactGroups, ...indexedScaleUnanchoredGroups],
    3,
    generatedAt,
    indexedScaleMetrics,
  );
  assertSelfTest(
    indexedScaleMetrics.facilityGroupScoreEvaluations ===
      indexedScaleFacilities.length &&
      indexedScaleDraft.buildingMappings.every(
        ({ assessment, createGroupSource }) =>
          assessment.outcome === 'strong-candidate' &&
          createGroupSource !== null,
      ) &&
      indexedScaleDraft.inventoryGroups.length === 1_200,
    'indexed matching scores only facility-anchored pairs instead of the facility-by-group Cartesian product',
  );

  const retentionControls = [
    { id: 'delta', score: 90 },
    { id: 'alpha', score: 120 },
    { id: 'charlie', score: 90 },
    { id: 'bravo', score: 120 },
    { id: 'echo', score: 80 },
  ];
  const compareRetentionControls = (
    left: (typeof retentionControls)[number],
    right: (typeof retentionControls)[number],
  ): number => right.score - left.score || compareText(left.id, right.id);
  for (const order of [
    retentionControls,
    [...retentionControls].reverse(),
    [
      retentionControls[2]!,
      retentionControls[4]!,
      retentionControls[0]!,
      retentionControls[3]!,
      retentionControls[1]!,
    ],
  ]) {
    const retained: (typeof retentionControls)[number][] = [];
    for (const value of order) {
      retainBest(retained, value, compareRetentionControls, 3);
    }
    assertSelfTest(
      JSON.stringify(retained) ===
        JSON.stringify(
          [...retentionControls].sort(compareRetentionControls).slice(0, 3),
        ),
      'bounded best-item retention equals a complete deterministic sort',
    );
  }

  const collisionWords = [
    'academy',
    'bldg',
    'building',
    'campus',
    'center',
    'centre',
    'education',
    'educational',
    'elementary',
    'high',
    'learning',
    'middle',
    'school',
    'the',
  ] as const;
  const collisionFacilities = Array.from({ length: 500 }, (_, index) => {
    let encoded = index;
    const first = collisionWords[encoded % collisionWords.length]!;
    encoded = Math.floor(encoded / collisionWords.length);
    const second = collisionWords[encoded % collisionWords.length]!;
    encoded = Math.floor(encoded / collisionWords.length);
    const third = collisionWords[encoded % collisionWords.length]!;
    return FacilitySchema.parse({
      active: true,
      code: `A${String(index).padStart(3, '0')}`,
      createdAt: generatedAt,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      name: `Alpha School ${first} ${second} ${third}`,
    });
  });
  const collisionGroups = Array.from({ length: 500 }, (_, index) => {
    let encoded = index;
    let suffix = 'q';
    const safeLetters = 'qzjxv';
    for (let position = 0; position < 4; position += 1) {
      suffix += safeLetters[encoded % safeLetters.length]!;
      encoded = Math.floor(encoded / safeLetters.length);
    }
    return parseCloudGroup(
      rawGroup(
        `synthetic-alpha-collision-${index}`,
        `alpha.staff.${suffix}@groups.synthetic.invalid`,
        `Alpha Staff ${suffix}`,
      ),
      parent,
    );
  });
  const collisionMetrics: DraftDerivationMetrics = {
    facilityGroupScoreEvaluations: 0,
    facilityTerminalContextEvaluations: 0,
  };
  const collisionPrefixContext = compactPopulationPrefixes(collisionFacilities);
  const highFanoutCollisionDraft = buildDraft(
    collisionFacilities,
    collisionGroups,
    1,
    generatedAt,
    collisionMetrics,
  );
  const highFanoutCollisionValidation = validateDraft(highFanoutCollisionDraft);
  assertSelfTest(
    [
      collisionPrefixContext.automaticAliasIndex,
      collisionPrefixContext.distinctiveAliasIndex,
      collisionPrefixContext.evidenceSequenceIndex,
      collisionPrefixContext.exactAliasIndex,
    ].every((index) =>
      [...index.values()].every(
        ({ contexts }) =>
          contexts.length <= MAX_FACILITY_CONTEXTS_PER_IDENTITY_FIELD,
      ),
    ) &&
      collisionPrefixContext.automaticAliasIndex.get('alpha')?.overflow ===
        true &&
      collisionPrefixContext.automaticAliasIndex.get('alpha')?.contexts
        .length === MAX_FACILITY_CONTEXTS_PER_IDENTITY_FIELD &&
      collisionMetrics.facilityGroupScoreEvaluations === 0 &&
      collisionMetrics.facilityTerminalContextEvaluations === 0 &&
      highFanoutCollisionDraft.inventoryGroups.length ===
        collisionGroups.length &&
      highFanoutCollisionDraft.report.omittedUnverifiedGroupIdentityCount ===
        0 &&
      highFanoutCollisionDraft.report.ambiguousStaffScopeGroups.length ===
        collisionGroups.length &&
      highFanoutCollisionDraft.report.unassignedBuildingLikeGroups.length ===
        collisionGroups.length &&
      highFanoutCollisionDraft.buildingMappings.every(
        ({ assessment, createGroupSource }) =>
          assessment.outcome === 'missing' &&
          assessment.candidates.length === 0 &&
          createGroupSource === null,
      ) &&
      highFanoutCollisionValidation.structuralValidationPassed,
    'high-fanout ambiguous aliases remain visible without scoring or retaining their facility cross-product',
  );

  const ordinalCollisionFacilities = [
    ...Array.from(
      { length: MAX_FACILITY_CONTEXTS_PER_IDENTITY_FIELD },
      (_, index) => {
        let encoded = index;
        const first = collisionWords[encoded % collisionWords.length]!;
        encoded = Math.floor(encoded / collisionWords.length);
        const second = collisionWords[encoded % collisionWords.length]!;
        encoded = Math.floor(encoded / collisionWords.length);
        const third = collisionWords[encoded % collisionWords.length]!;
        return FacilitySchema.parse({
          active: true,
          code: `FC${String(index).padStart(3, '0')}`,
          createdAt: generatedAt,
          id: `00000000-0000-4000-8000-${String(index + 1_001).padStart(12, '0')}`,
          name: `Fir Stcreek Elementary ${first} ${second} ${third}`,
        });
      },
    ),
    FacilitySchema.parse({
      active: true,
      code: 'FCZZ',
      createdAt: generatedAt,
      id: '00000000-0000-4000-8000-000000002000',
      name: 'First Creek Elementary',
    }),
  ];
  const ordinalCollisionGroup = parseCloudGroup(
    rawGroup(
      'synthetic-first-creek-collision',
      'firstcreek.staff@groups.synthetic.invalid',
      'First Creek Staff',
    ),
    parent,
  );
  const ordinalCollisionMetrics: DraftDerivationMetrics = {
    facilityGroupScoreEvaluations: 0,
    facilityTerminalContextEvaluations: 0,
  };
  const ordinalCollisionPrefixContext = compactPopulationPrefixes(
    [...ordinalCollisionFacilities].sort(
      (left, right) =>
        compareText(left.code, right.code) || compareText(left.id, right.id),
    ),
  );
  const ordinalCollisionAliasEntry =
    ordinalCollisionPrefixContext.automaticAliasIndex.get('firstcreek');
  const ordinalCollisionAcademicYear = academicStartYearAt(
    new Date(generatedAt),
  );
  const ordinalCollisionDraft = buildDraft(
    ordinalCollisionFacilities,
    [ordinalCollisionGroup],
    1,
    generatedAt,
    ordinalCollisionMetrics,
  );
  assertSelfTest(
    ordinalCollisionAliasEntry?.overflow === true &&
      ordinalCollisionAliasEntry.contexts.length ===
        MAX_FACILITY_CONTEXTS_PER_IDENTITY_FIELD &&
      ordinalCollisionAliasEntry.contexts.every(
        ({ facility }) =>
          !isExactWholeBuildingIdentity(
            facility,
            ordinalCollisionGroup,
            ordinalCollisionAcademicYear,
          ),
      ) &&
      hasIndexedExactWholeBuildingIdentity(
        ordinalCollisionPrefixContext,
        ordinalCollisionGroup,
        ordinalCollisionAcademicYear,
      ) &&
      ordinalCollisionMetrics.facilityGroupScoreEvaluations === 0 &&
      ordinalCollisionMetrics.facilityTerminalContextEvaluations === 0 &&
      ordinalCollisionDraft.inventoryGroups[0]?.googleGroupId ===
        ordinalCollisionGroup.googleGroupId &&
      ordinalCollisionDraft.inventoryGroups.length === 1 &&
      ordinalCollisionDraft.report.omittedUnverifiedGroupIdentityCount === 0 &&
      ordinalCollisionDraft.report.ambiguousStaffScopeGroups[0]
        ?.googleGroupId === ordinalCollisionGroup.googleGroupId &&
      ordinalCollisionDraft.report.unassignedBuildingLikeGroups[0]
        ?.googleGroupId === ordinalCollisionGroup.googleGroupId &&
      ordinalCollisionDraft.buildingMappings.every(
        ({ assessment, createGroupSource }) =>
          assessment.outcome === 'missing' &&
          assessment.candidates.length === 0 &&
          createGroupSource === null,
      ) &&
      validateDraft(ordinalCollisionDraft).structuralValidationPassed,
    'an exact ordinal-named building group stays inventory-visible and ambiguous when its shared alias exceeds the context cap',
  );

  const crossAliasCollisionFacilities = [
    ...Array.from(
      { length: MAX_FACILITY_CONTEXTS_PER_IDENTITY_FIELD },
      (_, index) => {
        let encoded = index;
        const first = collisionWords[encoded % collisionWords.length]!;
        encoded = Math.floor(encoded / collisionWords.length);
        const second = collisionWords[encoded % collisionWords.length]!;
        encoded = Math.floor(encoded / collisionWords.length);
        const third = collisionWords[encoded % collisionWords.length]!;
        return FacilitySchema.parse({
          active: true,
          code: `SB${String(index).padStart(3, '0')}`,
          createdAt: generatedAt,
          id: `00000000-0000-4000-8000-${String(index + 3_001).padStart(12, '0')}`,
          name: `South Bay Elementary ${first} ${second} ${third}`,
        });
      },
    ),
    FacilitySchema.parse({
      active: true,
      code: 'NBE',
      createdAt: generatedAt,
      id: '00000000-0000-4000-8000-000000004000',
      name: 'North Bay Elementary',
    }),
    FacilitySchema.parse({
      active: true,
      code: 'ZKS',
      createdAt: generatedAt,
      id: '00000000-0000-4000-8000-000000004001',
      name: 'North Bay K School',
    }),
  ];
  const crossAliasPopulationGroup = parseCloudGroup(
    rawGroup(
      'synthetic-cross-alias-population',
      'southbay.nbe.staff@groups.synthetic.invalid',
      'NorthBayK Staff',
    ),
    parent,
  );
  const crossAliasStaffGroup = parseCloudGroup(
    rawGroup(
      'synthetic-cross-alias-staff',
      'southbay.nbe@groups.synthetic.invalid',
      'NorthBayStaff',
    ),
    parent,
  );
  const crossAliasRestrictedGroup = parseCloudGroup(
    rawGroup(
      'synthetic-cross-alias-restricted',
      'southbay.nbe.staff.role@groups.synthetic.invalid',
      'NorthBayTeachersStaff',
    ),
    parent,
  );
  const crossAliasStaleGroup = parseCloudGroup(
    rawGroup(
      'synthetic-cross-alias-stale',
      'southbay.nbe.staff.archive@groups.synthetic.invalid',
      'NorthBayOldStaff',
    ),
    parent,
  );
  const crossAliasGroups = [
    crossAliasPopulationGroup,
    crossAliasStaffGroup,
    crossAliasRestrictedGroup,
    crossAliasStaleGroup,
  ];
  const crossAliasMetrics: DraftDerivationMetrics = {
    facilityGroupScoreEvaluations: 0,
    facilityTerminalContextEvaluations: 0,
  };
  const crossAliasDraft = buildDraft(
    crossAliasCollisionFacilities,
    crossAliasGroups,
    1,
    generatedAt,
    crossAliasMetrics,
  );
  const reversedCrossAliasDraft = buildDraft(
    [...crossAliasCollisionFacilities].reverse(),
    [...crossAliasGroups].reverse(),
    1,
    generatedAt,
  );
  const crossAliasPrefixContext = compactPopulationPrefixes(
    [...crossAliasCollisionFacilities].sort(
      (left, right) =>
        compareText(left.code, right.code) || compareText(left.id, right.id),
    ),
  );
  const crossAliasPopulationFields = groupTokenFields(
    crossAliasPopulationGroup,
  );
  const crossAliasDisplayFacilities = facilityContextsForTokens(
    crossAliasPrefixContext,
    crossAliasPopulationFields.displayName,
  );
  const crossAliasLocalPartFacilities = facilityContextsForTokens(
    crossAliasPrefixContext,
    crossAliasPopulationFields.localPart,
  );
  const hasReportedGroup = (
    groups: readonly DraftGroupRef[],
    expected: CloudGroup,
  ): boolean =>
    groups.some(
      ({ googleGroupId }) => googleGroupId === expected.googleGroupId,
    );
  assertSelfTest(
    !crossAliasDisplayFacilities.overflow &&
      crossAliasLocalPartFacilities.overflow &&
      (crossAliasDisplayFacilities.facilityBits &
        crossAliasLocalPartFacilities.facilityBits) !==
        0n &&
      crossAliasDraft.inventoryGroups.length === 2 &&
      !hasReportedGroup(
        crossAliasDraft.inventoryGroups,
        crossAliasPopulationGroup,
      ) &&
      crossAliasDraft.report.omittedUnverifiedGroupIdentityCount === 2 &&
      !hasReportedGroup(
        crossAliasDraft.inventoryGroups,
        crossAliasStaffGroup,
      ) &&
      hasReportedGroup(
        crossAliasDraft.report.restrictedRoleGroups,
        crossAliasRestrictedGroup,
      ) &&
      crossAliasDraft.report.potentiallyStaleGroups.some(
        ({ googleGroupId }) =>
          googleGroupId === crossAliasStaleGroup.googleGroupId,
      ) &&
      crossAliasDraft.buildingMappings.every(
        ({ assessment, createGroupSource }) =>
          assessment.outcome === 'missing' &&
          assessment.candidates.length === 0 &&
          createGroupSource === null,
      ) &&
      crossAliasMetrics.facilityGroupScoreEvaluations === 0 &&
      crossAliasMetrics.facilityTerminalContextEvaluations === 0 &&
      JSON.stringify(crossAliasDraft) ===
        JSON.stringify(reversedCrossAliasDraft) &&
      validateDraft(crossAliasDraft).structuralValidationPassed,
    'lossless facility bits preserve population exclusion plus restricted-role and stale evidence without combining different facilities',
  );

  const crossFacilityIdentityGroup = parseCloudGroup(
    rawGroup(
      'synthetic-cross-facility-identity',
      'southbay.sb000@groups.synthetic.invalid',
      'NorthBayStaff',
    ),
    parent,
  );
  const crossFacilityDraft = buildDraft(
    crossAliasCollisionFacilities,
    [crossFacilityIdentityGroup],
    1,
    generatedAt,
  );
  assertSelfTest(
    crossFacilityDraft.inventoryGroups.length === 0 &&
      crossFacilityDraft.report.omittedUnverifiedGroupIdentityCount === 1 &&
      !JSON.stringify(crossFacilityDraft).includes(
        crossFacilityIdentityGroup.googleGroupId,
      ) &&
      validateDraft(crossFacilityDraft).structuralValidationPassed,
    'lossless facility bits never combine staff evidence from different facilities',
  );

  const southBayCollisionFacilities = crossAliasCollisionFacilities.filter(
    ({ code }) => code.startsWith('SB'),
  );
  const oakCreekFacility = FacilitySchema.parse({
    active: true,
    code: 'OAK',
    createdAt: generatedAt,
    id: '00000000-0000-4000-8000-000000004100',
    name: 'Oak Creek Elementary',
  });
  const oakCreekGroup = parseCloudGroup(
    rawGroup(
      'synthetic-oak-creek-overflow',
      'southbay.oakcreek.staff@groups.synthetic.invalid',
      'OakCreekStaff',
    ),
    parent,
  );
  const oakCreekMetrics: DraftDerivationMetrics = {
    facilityGroupScoreEvaluations: 0,
    facilityTerminalContextEvaluations: 0,
  };
  const oakCreekFacilities = [...southBayCollisionFacilities, oakCreekFacility];
  const oakCreekDraft = buildDraft(
    oakCreekFacilities,
    [oakCreekGroup],
    1,
    generatedAt,
    oakCreekMetrics,
  );
  const oakCreekPrefixContext = compactPopulationPrefixes(
    [...oakCreekFacilities].sort(
      (left, right) =>
        compareText(left.code, right.code) || compareText(left.id, right.id),
    ),
  );
  assertSelfTest(
    classifyPopulationGroup(
      oakCreekGroup,
      oakCreekPrefixContext,
      academicStartYearAt(new Date(generatedAt)),
    ) === 'none' &&
      oakCreekDraft.inventoryGroups[0]?.googleGroupId ===
        oakCreekGroup.googleGroupId &&
      oakCreekDraft.report.omittedUnverifiedGroupIdentityCount === 0 &&
      oakCreekDraft.report.ambiguousStaffScopeGroups[0]?.googleGroupId ===
        oakCreekGroup.googleGroupId &&
      oakCreekMetrics.facilityGroupScoreEvaluations === 0 &&
      oakCreekMetrics.facilityTerminalContextEvaluations === 0 &&
      oakCreekDraft.buildingMappings.every(
        ({ assessment, createGroupSource }) =>
          assessment.candidates.length === 0 && createGroupSource === null,
      ) &&
      validateDraft(oakCreekDraft).structuralValidationPassed,
    'overflow evaluates each facility only at its longest matching alias so creek cannot manufacture a kindergarten marker after oak',
  );

  const nbeAliasCollisionFacilities = Array.from(
    { length: MAX_FACILITY_CONTEXTS_PER_IDENTITY_FIELD },
    (_, index) => {
      let encoded = index;
      const first = collisionWords[encoded % collisionWords.length]!;
      encoded = Math.floor(encoded / collisionWords.length);
      const second = collisionWords[encoded % collisionWords.length]!;
      encoded = Math.floor(encoded / collisionWords.length);
      const third = collisionWords[encoded % collisionWords.length]!;
      return FacilitySchema.parse({
        active: true,
        code: `NE${String(index).padStart(3, '0')}`,
        createdAt: generatedAt,
        id: `00000000-0000-4000-8000-${String(index + 5_001).padStart(12, '0')}`,
        name: `Nbe Elementary ${first} ${second} ${third}`,
      });
    },
  );
  const northBayFacility = crossAliasCollisionFacilities.find(
    ({ code }) => code === 'NBE',
  )!;
  const unknownCompactStaffGroups = [
    parseCloudGroup(
      rawGroup(
        'synthetic-unknown-compact-staff-overflow',
        'nbe@groups.synthetic.invalid',
        'NorthBayProgramStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-overflow-unparsed-local-staff-qualifier',
        'nbeprogramstaff@groups.synthetic.invalid',
        'NBEStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-overflow-unparsed-display-staff-qualifier',
        'nbestaff@groups.synthetic.invalid',
        'NBEProgramStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-overflow-unparsed-trailing-staff-qualifier',
        'nbestaffunknown@groups.synthetic.invalid',
        'NBEStaff',
      ),
      parent,
    ),
  ];
  const overflowUnknownCompactStaffFacilities = [
    ...nbeAliasCollisionFacilities,
    northBayFacility,
  ];
  const unknownCompactStaffMetrics: DraftDerivationMetrics = {
    facilityGroupScoreEvaluations: 0,
    facilityTerminalContextEvaluations: 0,
  };
  const baselineUnknownCompactStaffDraft = buildDraft(
    [northBayFacility],
    unknownCompactStaffGroups,
    1,
    generatedAt,
  );
  const unknownCompactStaffDraft = buildDraft(
    overflowUnknownCompactStaffFacilities,
    unknownCompactStaffGroups,
    1,
    generatedAt,
    unknownCompactStaffMetrics,
  );
  const reversedUnknownCompactStaffDraft = buildDraft(
    [...overflowUnknownCompactStaffFacilities].reverse(),
    [...unknownCompactStaffGroups].reverse(),
    1,
    generatedAt,
  );
  const baselineUnknownCompactStaffContext = compactPopulationPrefixes([
    northBayFacility,
  ]);
  const overflowUnknownCompactStaffContext = compactPopulationPrefixes(
    [...overflowUnknownCompactStaffFacilities].sort(
      (left, right) =>
        compareText(left.code, right.code) || compareText(left.id, right.id),
    ),
  );
  assertSelfTest(
    baselineUnknownCompactStaffContext.exactAliasIndex.get('nbe')?.overflow ===
      false &&
      overflowUnknownCompactStaffContext.exactAliasIndex.get('nbe')
        ?.overflow === true &&
      unknownCompactStaffGroups.every(
        (group) =>
          !hasStaffIdentityEvidence(
            group,
            baselineUnknownCompactStaffContext,
          ) &&
          !hasStaffIdentityEvidence(group, overflowUnknownCompactStaffContext),
      ) &&
      baselineUnknownCompactStaffDraft.inventoryGroups.length === 0 &&
      baselineUnknownCompactStaffDraft.report
        .omittedUnverifiedGroupIdentityCount ===
        unknownCompactStaffGroups.length &&
      unknownCompactStaffDraft.inventoryGroups.length === 0 &&
      unknownCompactStaffDraft.report.omittedUnverifiedGroupIdentityCount ===
        unknownCompactStaffGroups.length &&
      unknownCompactStaffGroups.every(
        ({ googleGroupId }) =>
          !JSON.stringify(baselineUnknownCompactStaffDraft).includes(
            googleGroupId,
          ) &&
          !JSON.stringify(unknownCompactStaffDraft).includes(googleGroupId),
      ) &&
      JSON.stringify(unknownCompactStaffDraft) ===
        JSON.stringify(reversedUnknownCompactStaffDraft) &&
      unknownCompactStaffMetrics.facilityGroupScoreEvaluations === 0 &&
      unknownCompactStaffMetrics.facilityTerminalContextEvaluations === 0 &&
      validateDraft(baselineUnknownCompactStaffDraft)
        .structuralValidationPassed &&
      validateDraft(unknownCompactStaffDraft).structuralValidationPassed,
    'facility-alias overflow cannot turn unparsed compact staff qualifiers into staff identity in either field orientation',
  );

  const southBayReferenceFacility = FacilitySchema.parse({
    active: true,
    code: 'SBE',
    createdAt: generatedAt,
    id: '00000000-0000-4000-8000-000000004300',
    name: 'South Bay Elementary The The The The',
  });
  const sameFacilityExactTokenStaffGroups = [
    parseCloudGroup(
      rawGroup(
        'synthetic-repeated-exact-alias-staff-parity',
        'nbe.nbe@groups.synthetic.invalid',
        'NBEStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-multiple-exact-alias-staff-parity',
        'northbay.nbe@groups.synthetic.invalid',
        'NorthBayStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-alternate-exact-alias-staff-parity',
        'southbay.sbe@groups.synthetic.invalid',
        'SBEStaff',
      ),
      parent,
    ),
  ];
  const mixedFacilityExactTokenStaffGroups = [
    parseCloudGroup(
      rawGroup(
        'synthetic-mixed-exact-alias-local-field',
        'southbay.nbe@groups.synthetic.invalid',
        'NBEStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-reversed-mixed-exact-alias-local-field',
        'nbe.sbe@groups.synthetic.invalid',
        'SBEStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-mixed-exact-alias-display-field',
        'nbe.staff@groups.synthetic.invalid',
        'NorthBay SouthBay',
      ),
      parent,
    ),
  ];
  const exactTokenStaffParityGroups = [
    ...sameFacilityExactTokenStaffGroups,
    ...mixedFacilityExactTokenStaffGroups,
  ];
  const exactTokenStaffBaselineFacilities = [
    northBayFacility,
    southBayReferenceFacility,
  ];
  const exactTokenStaffAtCapFacilities = [
    ...nbeAliasCollisionFacilities.slice(
      0,
      MAX_FACILITY_CONTEXTS_PER_IDENTITY_FIELD - 1,
    ),
    ...southBayCollisionFacilities.slice(
      0,
      MAX_FACILITY_CONTEXTS_PER_IDENTITY_FIELD - 1,
    ),
    northBayFacility,
    southBayReferenceFacility,
  ];
  const exactTokenStaffOverflowFacilities = [
    ...nbeAliasCollisionFacilities,
    ...southBayCollisionFacilities,
    northBayFacility,
    southBayReferenceFacility,
  ];
  const exactTokenStaffBaselineContext = compactPopulationPrefixes(
    exactTokenStaffBaselineFacilities,
  );
  const exactTokenStaffAtCapContext = compactPopulationPrefixes(
    exactTokenStaffAtCapFacilities,
  );
  const exactTokenStaffOverflowContext = compactPopulationPrefixes(
    exactTokenStaffOverflowFacilities,
  );
  const exactTokenStaffReversedOverflowContext = compactPopulationPrefixes(
    [...exactTokenStaffOverflowFacilities].reverse(),
  );
  const exactTokenStaffBaselineDraft = buildDraft(
    exactTokenStaffBaselineFacilities,
    exactTokenStaffParityGroups,
    1,
    generatedAt,
  );
  const exactTokenStaffAtCapDraft = buildDraft(
    exactTokenStaffAtCapFacilities,
    exactTokenStaffParityGroups,
    1,
    generatedAt,
  );
  const exactTokenStaffOverflowDraft = buildDraft(
    exactTokenStaffOverflowFacilities,
    exactTokenStaffParityGroups,
    1,
    generatedAt,
  );
  const exactTokenStaffReversedOverflowDraft = buildDraft(
    [...exactTokenStaffOverflowFacilities].reverse(),
    [...exactTokenStaffParityGroups].reverse(),
    1,
    generatedAt,
  );
  assertSelfTest(
    exactTokenStaffBaselineContext.exactAliasIndex.get('nbe')?.overflow ===
      false &&
      exactTokenStaffBaselineContext.exactAliasIndex.get('southbay')
        ?.overflow === false &&
      exactTokenStaffAtCapContext.exactAliasIndex.get('nbe')?.overflow ===
        false &&
      exactTokenStaffAtCapContext.exactAliasIndex.get('southbay')?.overflow ===
        false &&
      exactTokenStaffOverflowContext.exactAliasIndex.get('nbe')?.overflow ===
        true &&
      exactTokenStaffOverflowContext.exactAliasIndex.get('southbay')
        ?.overflow === true &&
      sameFacilityExactTokenStaffGroups.every(
        (group) =>
          hasStaffIdentityEvidence(group, exactTokenStaffBaselineContext) &&
          hasStaffIdentityEvidence(group, exactTokenStaffAtCapContext) &&
          hasStaffIdentityEvidence(group, exactTokenStaffOverflowContext) &&
          hasStaffIdentityEvidence(
            group,
            exactTokenStaffReversedOverflowContext,
          ),
      ) &&
      mixedFacilityExactTokenStaffGroups.every(
        (group) =>
          !hasStaffIdentityEvidence(group, exactTokenStaffBaselineContext) &&
          !hasStaffIdentityEvidence(group, exactTokenStaffAtCapContext) &&
          !hasStaffIdentityEvidence(group, exactTokenStaffOverflowContext) &&
          !hasStaffIdentityEvidence(
            group,
            exactTokenStaffReversedOverflowContext,
          ),
      ) &&
      exactTokenStaffBaselineDraft.inventoryGroups.length ===
        sameFacilityExactTokenStaffGroups.length &&
      exactTokenStaffAtCapDraft.inventoryGroups.length ===
        sameFacilityExactTokenStaffGroups.length &&
      exactTokenStaffOverflowDraft.inventoryGroups.length ===
        sameFacilityExactTokenStaffGroups.length &&
      exactTokenStaffBaselineDraft.report
        .omittedUnverifiedGroupIdentityCount ===
        mixedFacilityExactTokenStaffGroups.length &&
      exactTokenStaffAtCapDraft.report.omittedUnverifiedGroupIdentityCount ===
        mixedFacilityExactTokenStaffGroups.length &&
      exactTokenStaffOverflowDraft.report
        .omittedUnverifiedGroupIdentityCount ===
        mixedFacilityExactTokenStaffGroups.length &&
      JSON.stringify(exactTokenStaffOverflowDraft) ===
        JSON.stringify(exactTokenStaffReversedOverflowDraft) &&
      validateDraft(exactTokenStaffBaselineDraft).structuralValidationPassed &&
      validateDraft(exactTokenStaffAtCapDraft).structuralValidationPassed &&
      validateDraft(exactTokenStaffOverflowDraft).structuralValidationPassed,
    'fully consumed exact tokens corroborate only a facility common to every token at zero, exact-cap, and overflow cardinalities',
  );

  const zedSouthBayFacility = FacilitySchema.parse({
    active: true,
    code: 'ZED',
    createdAt: generatedAt,
    id: '00000000-0000-4000-8000-000000004200',
    name: 'South Bay Elementary the the the',
  });
  const overflowAlternateAliasGroup = parseCloudGroup(
    rawGroup(
      'synthetic-overflow-alternate-alias-prefix',
      'southbay.staff@groups.synthetic.invalid',
      'ZEDClasslinkStaff',
    ),
    parent,
  );
  const overflowAlternateAliasFacilities = [
    ...southBayCollisionFacilities,
    zedSouthBayFacility,
  ];
  const overflowAlternateAliasMetrics: DraftDerivationMetrics = {
    facilityGroupScoreEvaluations: 0,
    facilityTerminalContextEvaluations: 0,
  };
  const overflowAlternateAliasDraft = buildDraft(
    overflowAlternateAliasFacilities,
    [overflowAlternateAliasGroup],
    1,
    generatedAt,
    overflowAlternateAliasMetrics,
  );
  const reversedOverflowAlternateAliasDraft = buildDraft(
    [...overflowAlternateAliasFacilities].reverse(),
    [overflowAlternateAliasGroup],
    1,
    generatedAt,
  );
  const overflowAlternateAliasPrefixContext = compactPopulationPrefixes(
    [...overflowAlternateAliasFacilities].sort(
      (left, right) =>
        compareText(left.code, right.code) || compareText(left.id, right.id),
    ),
  );
  assertSelfTest(
    classifyPopulationGroup(
      overflowAlternateAliasGroup,
      overflowAlternateAliasPrefixContext,
      academicStartYearAt(new Date(generatedAt)),
    ) === 'none' &&
      overflowAlternateAliasDraft.inventoryGroups[0]?.googleGroupId ===
        overflowAlternateAliasGroup.googleGroupId &&
      overflowAlternateAliasDraft.report.omittedUnverifiedGroupIdentityCount ===
        0 &&
      overflowAlternateAliasDraft.report.ambiguousStaffScopeGroups[0]
        ?.googleGroupId === overflowAlternateAliasGroup.googleGroupId &&
      overflowAlternateAliasMetrics.facilityGroupScoreEvaluations === 0 &&
      overflowAlternateAliasMetrics.facilityTerminalContextEvaluations === 0 &&
      JSON.stringify(overflowAlternateAliasDraft) ===
        JSON.stringify(reversedOverflowAlternateAliasDraft) &&
      validateDraft(overflowAlternateAliasDraft).structuralValidationPassed,
    'overflow corroboration recovers alternate aliases through same-facility bits so audited incidental words stay masked',
  );

  const inactiveCollisionFacility = FacilitySchema.parse({
    active: false,
    code: 'IAL',
    createdAt: generatedAt,
    id: '00000000-0000-4000-8000-000000000064',
    name: 'Alpha Elementary',
  });
  const inactiveCollisionGroup = parseCloudGroup(
    rawGroup(
      'synthetic-inactive-ambiguous-collision',
      'alpha.staff.backupkeycard@groups.synthetic.invalid',
      'Alpha Staff BackupKeycard',
    ),
    parent,
  );
  const inactiveCollisionDraft = buildDraft(
    [inactiveCollisionFacility],
    [inactiveCollisionGroup],
    1,
    generatedAt,
  );
  assertSelfTest(
    inactiveCollisionDraft.report.ambiguousStaffScopeGroups[0]
      ?.googleGroupId === inactiveCollisionGroup.googleGroupId &&
      inactiveCollisionDraft.report.potentiallyStaleGroups[0]?.reasonCodes.includes(
        'GROUP_MATCHES_INACTIVE_FACILITY',
      ) === true &&
      validateDraft(inactiveCollisionDraft).structuralValidationPassed,
    'an ambiguous inactive-facility match retains both review and staleness evidence without entering candidate buckets',
  );

  const workforceAliasFacility = FacilitySchema.parse({
    active: true,
    code: 'STAFF',
    createdAt: generatedAt,
    id: '00000000-0000-4000-8000-000000000051',
    name: 'Workforce Annex',
  });
  const crossFacilityWorkforceAliasDraft = buildDraft(
    [facilities[0]!, workforceAliasFacility],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-cross-facility-workforce-alias',
          'nbe.staff.students@groups.synthetic.invalid',
          'NBE Staff Students',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    crossFacilityWorkforceAliasDraft.inventoryGroups.length === 0 &&
      crossFacilityWorkforceAliasDraft.report
        .omittedUnverifiedGroupIdentityCount === 1 &&
      crossFacilityWorkforceAliasDraft.buildingMappings.every(
        ({ assessment, createGroupSource }) =>
          assessment.candidates.length === 0 && createGroupSource === null,
      ),
    'a workforce-like facility alias cannot retain explicit population identity metadata',
  );

  for (const [slug, localYear, displayYear] of [
    ['full-range', '2026-2027', '2026-2027'],
    ['short-range', '26-27', '26-27'],
    ['compact-full-range', '20262027', '20262027'],
    ['compact-full-short-range', '202627', '202627'],
    ['compact-short-range', '2627', '2627'],
    ['school-year-range', 'sy2026-2027', 'SY2026-2027'],
    ['word-range', '2026to2027', '2026 to 2027'],
  ] as const) {
    const currentAcademicDraft = buildDraft(
      [facilities[0]!],
      [
        parseCloudGroup(
          rawGroup(
            `synthetic-current-academic-${slug}`,
            `nbe.${localYear}.staff@groups.synthetic.invalid`,
            `NBE ${displayYear} Staff`,
          ),
          parent,
        ),
      ],
      1,
      generatedAt,
    );
    assertSelfTest(
      currentAcademicDraft.buildingMappings[0]?.createGroupSource !== null &&
        currentAcademicDraft.report.potentiallyStaleGroups.length === 0,
      `${slug} is accepted only as the current August academic year`,
    );
  }
  const januaryCurrentAcademicDraft = buildDraft(
    [facilities[0]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-january-current-academic-year',
          'nbe.2025-2026.staff@groups.synthetic.invalid',
          'NBE 2025-2026 Staff',
        ),
        parent,
      ),
    ],
    1,
    '2026-01-15T12:00:00.000Z',
  );
  assertSelfTest(
    januaryCurrentAcademicDraft.buildingMappings[0]?.createGroupSource !==
      null &&
      januaryCurrentAcademicDraft.report.potentiallyStaleGroups.length === 0,
    'the academic year remains current across the January calendar boundary',
  );

  const shorthandYearDraft = buildDraft(
    [facilities[0]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-short-year-range',
          'nbe.23-24.staff@groups.synthetic.invalid',
          'NBE 23-24 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-school-year-marker',
          'nbe.sy23.staff@groups.synthetic.invalid',
          'NBE SY23 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-compact-school-year-marker',
          'nbesy23staff@groups.synthetic.invalid',
          'NBESY23Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-old-explicit-school-year-marker',
          'nbe.sy09.staff@groups.synthetic.invalid',
          'NBE SY09 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-old-compact-explicit-school-year-marker',
          'nbesy09staff@groups.synthetic.invalid',
          'NBESY09Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-old-explicit-compact-school-year-range',
          'nbe.sy0910.staff@groups.synthetic.invalid',
          'NBE SY0910 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-old-separated-low-year-range',
          'nbe.09-10.staff@groups.synthetic.invalid',
          'NBE 09-10 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-old-compact-low-year-range',
          'nbe.0910.staff@groups.synthetic.invalid',
          'NBE 0910 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-old-full-short-year-range',
          'nbe.200910.staff@groups.synthetic.invalid',
          'NBE 200910 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-compact-short-year-range',
          'nbe2324staff@groups.synthetic.invalid',
          'NBE2324Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-compound-short-year-range',
          'nbe23-24staff@groups.synthetic.invalid',
          'NBE23-24Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-prior-full-academic-year',
          'nbe.2025-2026.staff@groups.synthetic.invalid',
          'NBE 2025-2026 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-prior-short-academic-year',
          'nbe.25-26.staff@groups.synthetic.invalid',
          'NBE 25-26 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-prior-sy-academic-year',
          'nbe.sy25-26.staff@groups.synthetic.invalid',
          'NBE SY25-26 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-prior-full-short-compact-year',
          'nbe.202526.staff@groups.synthetic.invalid',
          'NBE 202526 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-prior-sy-full-short-compact-year',
          'nbe.sy202526.staff@groups.synthetic.invalid',
          'NBE SY202526 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-prior-word-academic-year',
          'nbe.2025to2026.staff@groups.synthetic.invalid',
          'NBE 2025 to 2026 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-old-separated-to-range',
          'nbe.09.to.10.staff@groups.synthetic.invalid',
          'NBE 09 to 10 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-old-separated-through-range',
          'nbe.09.through.10.staff@groups.synthetic.invalid',
          'NBE 09 through 10 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-old-compact-to-range',
          'nbe.09to10.staff@groups.synthetic.invalid',
          'NBE09to10Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-old-compact-through-range',
          'nbe09through10staff@groups.synthetic.invalid',
          'NBE09through10Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-prior-standalone-short-year',
          'nbe.25.staff@groups.synthetic.invalid',
          'NBE 25 Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-district-prior-academic-year',
          'district.2025-2026.staff@groups.synthetic.invalid',
          'District Staff 2025-2026',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    shorthandYearDraft.report.potentiallyStaleGroups.length === 23 &&
      shorthandYearDraft.report.potentiallyStaleGroups.every(
        ({ reasonCodes }) =>
          reasonCodes.includes('GROUP_HAS_PRIOR_YEAR_MARKER'),
      ) &&
      shorthandYearDraft.buildingMappings[0]?.assessment.candidates.length ===
        0 &&
      shorthandYearDraft.buildingMappings[0]?.createGroupSource === null,
    'bounded prior academic-year shorthand is retained, quarantined, and reported as heuristic staleness',
  );

  const ambiguousBareLowYearDraft = buildDraft(
    [facilities[0]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-ambiguous-bare-low-year',
          'nbe.09.staff@groups.synthetic.invalid',
          'NBE 09 Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    ambiguousBareLowYearDraft.inventoryGroups.length === 1 &&
      ambiguousBareLowYearDraft.report.potentiallyStaleGroups.length === 0,
    'a bare low two-digit number remains ambiguous and is not treated as a prior academic year',
  );

  const compactStudentStaff = parseCloudGroup(
    rawGroup(
      'synthetic-compact-population',
      'synthetic.nbe.allstudentsstaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const compactScholarStaff = parseCloudGroup(
    rawGroup(
      'synthetic-compact-scholar-population',
      'synthetic.nbe.allscholarsstaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const compactPtaStaff = parseCloudGroup(
    rawGroup(
      'synthetic-compact-pta-population',
      'synthetic.nbe.allptastaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const facilityPrefixedCompactStudentStaff = parseCloudGroup(
    rawGroup(
      'synthetic-facility-prefixed-compact-population',
      'synthetic.nbeallstudentsstaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const facilityPrefixedStudent = parseCloudGroup(
    rawGroup(
      'synthetic-facility-prefixed-population',
      'synthetic.nbestudents@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const facilityPrefixedGrade = parseCloudGroup(
    rawGroup(
      'synthetic-facility-prefixed-grade-population',
      'synthetic.nbegrade5@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const facilityPrefixedOrdinalGrade = parseCloudGroup(
    rawGroup(
      'synthetic-facility-prefixed-ordinal-grade-population',
      'synthetic.nbe1stgrade@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const facilityPrefixedKindergarten = parseCloudGroup(
    rawGroup(
      'synthetic-facility-prefixed-kindergarten-population',
      'synthetic.nbek5@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const facilityPrefixedClass = parseCloudGroup(
    rawGroup(
      'synthetic-facility-prefixed-class-population',
      'synthetic.nbeclassstaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const facilityPrefixedPreK = parseCloudGroup(
    rawGroup(
      'synthetic-facility-prefixed-pre-k-population',
      'synthetic.nbepre.k@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const facilityPrefixedSeparatedGrade = parseCloudGroup(
    rawGroup(
      'synthetic-facility-prefixed-separated-grade-population',
      'synthetic.nbegrade.5@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const facilityPrefixedSeparatedOrdinal = parseCloudGroup(
    rawGroup(
      'synthetic-facility-prefixed-separated-ordinal-population',
      'synthetic.nbe1.grade@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const facilityPrefixedGradeWithStaff = parseCloudGroup(
    rawGroup(
      'synthetic-facility-prefixed-grade-with-staff-population',
      'synthetic.nbegrade5staff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const facilityPrefixedOrdinalWithStaff = parseCloudGroup(
    rawGroup(
      'synthetic-facility-prefixed-ordinal-with-staff-population',
      'synthetic.nbe1stgradestaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const facilityPrefixedKindergartenWithStaff = parseCloudGroup(
    rawGroup(
      'synthetic-facility-prefixed-kindergarten-with-staff-population',
      'synthetic.nbek5staff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const facilityPrefixedClassWithStaff = parseCloudGroup(
    rawGroup(
      'synthetic-facility-prefixed-class-with-staff-population',
      'synthetic.nbeclass5staff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const boundaryBeforeFacilityPrefix = parseCloudGroup(
    rawGroup(
      'synthetic-boundary-before-facility-prefix-population',
      'synthetic.allnbestudentsstaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const facilityPrefixedGradeSpan = parseCloudGroup(
    rawGroup(
      'synthetic-facility-prefixed-grade-span-population',
      'synthetic.nbe.k-5.staff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const consecutiveCompactPopulations = parseCloudGroup(
    rawGroup(
      'synthetic-consecutive-compact-populations',
      'synthetic.nbeallstudentsparentsstaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const compactPopulationConjunction = parseCloudGroup(
    rawGroup(
      'synthetic-compact-population-conjunction',
      'synthetic.nbestudentsandstaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const compactPopulationTeachers = parseCloudGroup(
    rawGroup(
      'synthetic-compact-population-teachers',
      'synthetic.nbestudentsandteachers@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const compactPopulationFaculty = parseCloudGroup(
    rawGroup(
      'synthetic-compact-population-faculty',
      'synthetic.nbeparentsandfaculty@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const compactPopulationAdmins = parseCloudGroup(
    rawGroup(
      'synthetic-compact-population-admins',
      'synthetic.nbeallstudentsadmins@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const roleBeforeFacilityPopulation = parseCloudGroup(
    rawGroup(
      'synthetic-role-before-facility-population',
      'synthetic.teachersnbestudents@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const roleBeforeFacilityParents = parseCloudGroup(
    rawGroup(
      'synthetic-role-before-facility-parents',
      'synthetic.facultynbeparentsstaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const roleBeforeOrganizationGrade = parseCloudGroup(
    rawGroup(
      'synthetic-role-before-organization-grade',
      'synthetic.adminpsdgrade5staff@groups.synthetic.invalid',
      'PSD Staff',
    ),
    parent,
  );
  const populationBeforeFacility = parseCloudGroup(
    rawGroup(
      'synthetic-population-before-facility',
      'synthetic.studentsnbestaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const boundaryPopulationBeforeFacility = parseCloudGroup(
    rawGroup(
      'synthetic-boundary-population-before-facility',
      'synthetic.allstudentsnbestaff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const populationBeforeOrganization = parseCloudGroup(
    rawGroup(
      'synthetic-population-before-organization',
      'synthetic.studentspsdstaff@groups.synthetic.invalid',
      'PSD Staff',
    ),
    parent,
  );
  const interleavedFacilityPopulation = parseCloudGroup(
    rawGroup(
      'synthetic-interleaved-facility-population',
      'synthetic.studentsandnbeteachers@groups.synthetic.invalid',
      'NBE Staff',
    ),
    parent,
  );
  const compactGradeKindergarten = parseCloudGroup(
    rawGroup(
      'synthetic-compact-grade-kindergarten',
      'synthetic.gradekstaff@groups.synthetic.invalid',
      'Staff',
    ),
    parent,
  );
  const compactKindergartenGrade = parseCloudGroup(
    rawGroup(
      'synthetic-compact-kindergarten-grade',
      'synthetic.kgradestaff@groups.synthetic.invalid',
      'Staff',
    ),
    parent,
  );
  const sameFieldLocalAliasEvidence = parseCloudGroup(
    rawGroup(
      'synthetic-same-field-local-alias-evidence',
      'synthetic.nbeallstudentsstaff.nbe@groups.synthetic.invalid',
      'Staff',
    ),
    parent,
  );
  const sameFieldDisplayAliasEvidence = parseCloudGroup(
    rawGroup(
      'synthetic-same-field-display-alias-evidence',
      'synthetic.staff@groups.synthetic.invalid',
      'NBEAllStudentsStaff NBE',
    ),
    parent,
  );
  const compactPopulationDraft = buildDraft(
    [facilities[0]!],
    [
      compactStudentStaff,
      compactScholarStaff,
      compactPtaStaff,
      facilityPrefixedCompactStudentStaff,
      facilityPrefixedStudent,
      facilityPrefixedGrade,
      facilityPrefixedOrdinalGrade,
      facilityPrefixedKindergarten,
      facilityPrefixedClass,
      facilityPrefixedPreK,
      facilityPrefixedSeparatedGrade,
      facilityPrefixedSeparatedOrdinal,
      facilityPrefixedGradeWithStaff,
      facilityPrefixedOrdinalWithStaff,
      facilityPrefixedKindergartenWithStaff,
      facilityPrefixedClassWithStaff,
      boundaryBeforeFacilityPrefix,
      facilityPrefixedGradeSpan,
      consecutiveCompactPopulations,
      compactPopulationConjunction,
      compactPopulationTeachers,
      compactPopulationFaculty,
      compactPopulationAdmins,
      roleBeforeFacilityPopulation,
      roleBeforeFacilityParents,
      roleBeforeOrganizationGrade,
      populationBeforeFacility,
      boundaryPopulationBeforeFacility,
      populationBeforeOrganization,
      interleavedFacilityPopulation,
      compactGradeKindergarten,
      compactKindergartenGrade,
      sameFieldLocalAliasEvidence,
      sameFieldDisplayAliasEvidence,
    ],
    1,
    generatedAt,
  );
  const serializedCompactPopulationDraft = JSON.stringify(
    compactPopulationDraft,
  );
  assertSelfTest(
    compactPopulationDraft.source.groupCount === 34 &&
      compactPopulationDraft.report.omittedUnverifiedGroupIdentityCount ===
        34 &&
      compactPopulationDraft.inventoryGroups.length === 0 &&
      !serializedCompactPopulationDraft.includes(
        'synthetic-compact-population',
      ) &&
      compactPopulationDraft.buildingMappings[0]?.createGroupSource === null,
    'staff-qualified population and role mixes are omitted without identity metadata',
  );
  const sameFieldAliasDraft = buildDraft(
    [facilities[0]!],
    [sameFieldLocalAliasEvidence],
    1,
    generatedAt,
  );
  assertSelfTest(
    sameFieldAliasDraft.inventoryGroups.length === 0 &&
      sameFieldAliasDraft.report.omittedUnverifiedGroupIdentityCount === 1 &&
      sameFieldAliasDraft.buildingMappings[0]?.assessment.candidates.length ===
        0 &&
      sameFieldAliasDraft.buildingMappings[0]?.createGroupSource === null,
    'same-field standalone facility evidence activates compact population omission',
  );
  const fullFacilityPopulationDraft = buildDraft(
    [facilities[0]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-code-generic-population',
          'synthetic.nbe.nbeelementarystudentsstaff@groups.synthetic.invalid',
          'Operations Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-name-generic-population',
          'synthetic.nbe.northbayelementarystudentsstaff@groups.synthetic.invalid',
          'Operations Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-year-before-population',
          'synthetic.nbe2026studentsstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-year-after-population',
          'synthetic.nbestudents2026staff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    fullFacilityPopulationDraft.inventoryGroups.length === 0 &&
      fullFacilityPopulationDraft.report.omittedUnverifiedGroupIdentityCount ===
        4 &&
      fullFacilityPopulationDraft.buildingMappings[0]?.assessment.candidates
        .length === 0 &&
      fullFacilityPopulationDraft.buildingMappings[0]?.createGroupSource ===
        null,
    'generic facility-name atoms cannot bypass population omission or become sources',
  );
  const crossFacilityIdentityDraft = buildDraft(
    [facilities[0]!, facilities[1]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-cross-facility-population',
          'synthetic.nbmstudentsstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-cross-facility-role',
          'synthetic.nbmteachersstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-cross-facility-stale',
          'synthetic.nbmlegacystaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    crossFacilityIdentityDraft.inventoryGroups.length === 0 &&
      crossFacilityIdentityDraft.report.omittedUnverifiedGroupIdentityCount ===
        3 &&
      crossFacilityIdentityDraft.report.restrictedRoleGroups.length === 0 &&
      crossFacilityIdentityDraft.report.potentiallyStaleGroups.length === 0 &&
      crossFacilityIdentityDraft.buildingMappings.every(
        ({ assessment, createGroupSource }) =>
          assessment.candidates.length === 0 && createGroupSource === null,
      ),
    'cross-facility identity fields are omitted rather than manufacturing compact staff, role, or stale evidence',
  );
  const crossAliasSameFacilityDraft = buildDraft(
    [facilities[0]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-cross-alias-population',
          'northbayprogramstudentsstaff@groups.synthetic.invalid',
          'NBEProgramStudentsStaff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-cross-alias-role',
          'northbayprogramteachersstaff@groups.synthetic.invalid',
          'NBETeachersStaff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-cross-alias-stale',
          'northbayprogramoldstaff@groups.synthetic.invalid',
          'NBEOldStaff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    crossAliasSameFacilityDraft.inventoryGroups.length === 0 &&
      crossAliasSameFacilityDraft.report.omittedUnverifiedGroupIdentityCount ===
        3 &&
      crossAliasSameFacilityDraft.report.restrictedRoleGroups.length === 0 &&
      crossAliasSameFacilityDraft.report.potentiallyStaleGroups.length === 0 &&
      crossAliasSameFacilityDraft.buildingMappings[0]?.assessment.candidates
        .length === 0,
    'unknown compact qualifiers remain unverified even when both fields use aliases for the same facility',
  );
  const unknownScopeMarkerDraft = buildDraft(
    [facilities[0]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-program-population',
          'synthetic.programstudentsstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-program-role',
          'synthetic.programteachersstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-program-subs-role',
          'synthetic.programsubsstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-backup-old',
          'synthetic.backupoldstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-unknown-legacy',
          'synthetic.zzlegacystaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-population-infix-scope',
          'synthetic.programstudentsrosterstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-population-middle-scope',
          'synthetic.studentsprogramstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-population-trailing-scope',
          'synthetic.studentsstaffprogram@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-role-infix-scope',
          'synthetic.programteachersrosterstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-stale-infix-scope',
          'synthetic.backuplegacyrosterstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-split-k-scope',
          'synthetic.programk.5.staff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-split-pre-k-scope',
          'synthetic.programpre.k.staff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    unknownScopeMarkerDraft.inventoryGroups.length === 0 &&
      unknownScopeMarkerDraft.report.omittedUnverifiedGroupIdentityCount ===
        12 &&
      unknownScopeMarkerDraft.report.restrictedRoleGroups.length === 0 &&
      unknownScopeMarkerDraft.report.potentiallyStaleGroups.length === 0 &&
      unknownScopeMarkerDraft.buildingMappings[0]?.assessment.candidates
        .length === 0 &&
      unknownScopeMarkerDraft.buildingMappings[0]?.createGroupSource === null,
    'unknown scope labels are omitted instead of manufacturing staff, role, or stale evidence from one field',
  );

  const compactRoleDraft = buildDraft(
    [facilities[0]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-compact-role',
          'synthetic.nbeteachersstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-year-compact-role',
          'synthetic.nbe2026teachersstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-compact-subs-role',
          'synthetic.nbesubsstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-compact-itinerant-role',
          'synthetic.nbeitinerantstaff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-exact-subs-role',
          'synthetic.nbe.subs.staff@groups.synthetic.invalid',
          'NBE Subs Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-exact-sub-role',
          'synthetic.nbe.sub.staff@groups.synthetic.invalid',
          'NBE Sub Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-exact-itinerant-role',
          'synthetic.nbe.itinerants.staff@groups.synthetic.invalid',
          'NBE Itinerants Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-fully-compact-subs-role',
          'nbesubsstaff@groups.synthetic.invalid',
          'NBESubsStaff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    compactRoleDraft.inventoryGroups.length === 8 &&
      compactRoleDraft.report.restrictedRoleGroups.length === 8 &&
      compactRoleDraft.buildingMappings[0]?.assessment.candidates.length ===
        0 &&
      compactRoleDraft.buildingMappings[0]?.createGroupSource === null,
    'compact role subsets stay visible but cannot represent whole-building staff',
  );
  const incidentalSubCompoundGroups = [
    'subclass',
    'subgroup',
    'subteam',
    'subschool',
    'subcampus',
  ].map((compound) =>
    parseCloudGroup(
      rawGroup(
        `synthetic-incidental-${compound}-staff`,
        `nbe.${compound}.staff@groups.synthetic.invalid`,
        `NBE ${compound} Staff`,
      ),
      parent,
    ),
  );
  const incidentalSubCompoundDraft = buildDraft(
    [facilities[0]!],
    incidentalSubCompoundGroups,
    1,
    generatedAt,
  );
  assertSelfTest(
    incidentalSubCompoundDraft.inventoryGroups.length ===
      incidentalSubCompoundGroups.length &&
      incidentalSubCompoundDraft.report.restrictedRoleGroups.length === 0 &&
      incidentalSubCompoundDraft.report.ambiguousStaffScopeGroups.length ===
        incidentalSubCompoundGroups.length &&
      incidentalSubCompoundDraft.buildingMappings[0]?.assessment.candidates
        .length === 0 &&
      incidentalSubCompoundDraft.buildingMappings[0]?.createGroupSource ===
        null,
    'ordinary sub-prefixed compounds remain visible without becoming substitute-role findings or automatic sources',
  );
  const numericOnlyStaffDraft = buildDraft(
    [facilities[0]!],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-numeric-only-staff',
          'nbe2026staff@groups.synthetic.invalid',
          'NBE Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    numericOnlyStaffDraft.report.restrictedRoleGroups.length === 0 &&
      numericOnlyStaffDraft.report.potentiallyStaleGroups.length === 0 &&
      numericOnlyStaffDraft.buildingMappings[0]?.createGroupSource !== null,
    'bounded numeric atoms alone do not quarantine a staff group',
  );

  const compactStaleGroups = [
    parseCloudGroup(
      rawGroup(
        'synthetic-compact-legacy',
        'synthetic.nbelegacystaff@groups.synthetic.invalid',
        'NBE Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-year-before-legacy',
        'synthetic.nbe2026legacystaff@groups.synthetic.invalid',
        'NBE Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-year-after-legacy',
        'synthetic.nbelegacy2026staff@groups.synthetic.invalid',
        'NBE Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-compact-old',
        'synthetic.nbestaffold@groups.synthetic.invalid',
        'NBE Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-fully-compact-legacy',
        'nbelegacystaff@groups.synthetic.invalid',
        'NBELegacyStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-fully-compact-program-old',
        'nbeoldstaff@groups.synthetic.invalid',
        'NBE Old Staff',
      ),
      parent,
    ),
  ];
  const compactStaleDraft = buildDraft(
    [facilities[0]!],
    [
      ...compactStaleGroups,
      parseCloudGroup(
        rawGroup(
          'synthetic-incidental-stale-substring',
          'synthetic.nbe.golden.staff@groups.synthetic.invalid',
          'NBE Golden Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  const compactStaleIds = new Set(
    compactStaleGroups.map(({ googleGroupId }) => googleGroupId),
  );
  assertSelfTest(
    compactStaleDraft.inventoryGroups.length === 7 &&
      compactStaleDraft.report.potentiallyStaleGroups.length === 6 &&
      compactStaleDraft.report.potentiallyStaleGroups.every(({ reasonCodes }) =>
        reasonCodes.includes('GROUP_HAS_STALE_NAME_MARKER'),
      ) &&
      compactStaleDraft.report.potentiallyStaleGroups.every(
        ({ googleGroupId }) =>
          googleGroupId !== 'groups/synthetic-incidental-stale-substring',
      ) &&
      compactStaleDraft.buildingMappings[0]?.assessment.candidates.every(
        ({ googleGroupId }) => !compactStaleIds.has(googleGroupId),
      ) === true &&
      compactStaleDraft.buildingMappings[0]?.assessment.candidates.length ===
        0 &&
      compactStaleDraft.buildingMappings[0]?.createGroupSource === null,
    'bounded compact stale markers are reported and blocked without matching incidental substrings',
  );
  const explicitlyConfirmedStaleGroup = compactStaleDraft.inventoryGroups.find(
    ({ googleGroupId }) =>
      googleGroupId === 'groups/synthetic-fully-compact-program-old',
  );
  const staleMapping = compactStaleDraft.buildingMappings[0];
  if (
    explicitlyConfirmedStaleGroup === undefined ||
    staleMapping === undefined
  ) {
    throw new Error(
      'Self-test fixture did not produce a stale review finding.',
    );
  }
  const confirmedStaleDraft: MappingDraft = {
    ...compactStaleDraft,
    buildingMappings: [
      {
        ...staleMapping,
        createGroupSource: parseGroupSourceFromDraft({
          active: true,
          displayName: staleMapping.facility.name,
          email: explicitlyConfirmedStaleGroup.email,
          facilityId: staleMapping.facility.id,
          googleGroupId: explicitlyConfirmedStaleGroup.googleGroupId,
          kind: 'google-group',
          purpose: 'building',
        }),
        reviewDecision: 'confirmed',
        reviewNote:
          'Synthetic human confirmation after reviewing heuristic staleness.',
      },
    ],
    report: {
      ...compactStaleDraft.report,
      unassignedBuildingLikeGroups:
        compactStaleDraft.report.unassignedBuildingLikeGroups.filter(
          ({ googleGroupId }) =>
            googleGroupId !== explicitlyConfirmedStaleGroup.googleGroupId,
        ),
    },
  };
  assertSelfTest(
    validateDraft(confirmedStaleDraft).confirmedMappingCount === 1,
    'explicit noted human confirmation may override a heuristic stale finding',
  );

  const legitimateSubstringGroups = [
    rawGroup(
      'synthetic-laptop-staff',
      'synthetic.nbe.laptop.staff@groups.synthetic.invalid',
      'NBE Laptop Staff',
    ),
    rawGroup(
      'synthetic-captains-staff',
      'synthetic.nbe.captains.staff@groups.synthetic.invalid',
      'NBE Captains Staff',
    ),
    rawGroup(
      'synthetic-skidmore-staff',
      'synthetic.nbe.skidmore.staff@groups.synthetic.invalid',
      'NBE Skidmore Staff',
    ),
    rawGroup(
      'synthetic-scholarship-staff',
      'synthetic.nbe.scholarship.staff@groups.synthetic.invalid',
      'NBE Scholarship Staff',
    ),
    rawGroup(
      'synthetic-parenting-staff',
      'synthetic.nbe.parenting.staff@groups.synthetic.invalid',
      'NBE Parenting Staff',
    ),
    rawGroup(
      'synthetic-staff-kidney',
      'synthetic.nbe.staffkidney@groups.synthetic.invalid',
      'NBE Staff Kidney',
    ),
    rawGroup(
      'synthetic-classified-staff',
      'synthetic.nbeclassifiedstaff@groups.synthetic.invalid',
      'NBE Classified Staff',
    ),
    rawGroup(
      'synthetic-subclass-staff',
      'synthetic.nbe.subclass.staff@groups.synthetic.invalid',
      'NBE Subclass Staff',
    ),
    rawGroup(
      'synthetic-subfamily-staff',
      'synthetic.nbe.subfamily.staff@groups.synthetic.invalid',
      'NBE Subfamily Staff',
    ),
    rawGroup(
      'synthetic-subgrade-staff',
      'synthetic.nbe.subgrade.staff@groups.synthetic.invalid',
      'NBE Subgrade Staff',
    ),
    rawGroup(
      'synthetic-masterclass-staff',
      'synthetic.nbe.masterclass.staff@groups.synthetic.invalid',
      'NBE Masterclass Staff',
    ),
    rawGroup(
      'synthetic-gradebook-staff',
      'synthetic.nbe.gradebook.staff@groups.synthetic.invalid',
      'NBE Gradebook Staff',
    ),
    rawGroup(
      'synthetic-compact-gradebook-staff',
      'nbegradebookstaff@groups.synthetic.invalid',
      'NBEGradebookStaff',
    ),
    rawGroup(
      'synthetic-classlink-staff',
      'synthetic.nbe.classlink.staff@groups.synthetic.invalid',
      'NBE ClassLink Staff',
    ),
    rawGroup(
      'synthetic-compact-classlink-staff',
      'nbeclasslinkstaff@groups.synthetic.invalid',
      'NBEClassLinkStaff',
    ),
    rawGroup(
      'synthetic-gold-staff',
      'synthetic.nbe.gold.staff@groups.synthetic.invalid',
      'NBE Gold Staff',
    ),
  ].map((group) => parseCloudGroup(group, parent));
  const legitimateSubstringDraft = buildDraft(
    [facilities[0]!],
    legitimateSubstringGroups,
    1,
    generatedAt,
  );
  assertSelfTest(
    legitimateSubstringDraft.inventoryGroups.length === 15 &&
      legitimateSubstringDraft.report.omittedUnverifiedGroupIdentityCount ===
        1 &&
      legitimateSubstringDraft.inventoryGroups.every(
        ({ googleGroupId }) =>
          googleGroupId !== 'groups/synthetic-staff-kidney',
      ),
    'incidental population substrings remain visible only when both identity fields carry bounded staff evidence',
  );

  const directAdjacencyPopulationMarkers = [
    ...new Set([
      ...HIGH_CONFIDENCE_EMBEDDED_POPULATION_MARKERS,
      ...SHORT_GRADE_POPULATION_MARKERS,
      ...SPELLED_GRADE_ORDINAL_MARKERS,
      'k',
      'pk',
    ]),
  ].sort(compareText);
  const directAdjacencyGroups: CloudGroup[] = [];
  let directAdjacencyIndex = 0;
  for (const incidentalWord of [...INCIDENTAL_POPULATION_WORDS].sort(
    compareText,
  )) {
    for (const populationMarker of directAdjacencyPopulationMarkers) {
      for (const direction of ['after', 'before'] as const) {
        const token =
          direction === 'after'
            ? `${incidentalWord}${populationMarker}blue`
            : `${populationMarker}${incidentalWord}blue`;
        for (const placement of ['both', 'display', 'local'] as const) {
          const index = directAdjacencyIndex;
          directAdjacencyIndex += 1;
          const displayName =
            placement === 'local'
              ? `NBE Staff Matrix ${index}`
              : `NBE ${token} Staff ${index}`;
          const localPart =
            placement === 'display'
              ? `nbe.staff.matrix${index}`
              : `nbe.${token}.staff.${index}`;
          directAdjacencyGroups.push(
            parseCloudGroup(
              rawGroup(
                `synthetic-direct-adjacency-${index}`,
                `${localPart}@groups.synthetic.invalid`,
                displayName,
              ),
              parent,
            ),
          );
        }
      }
    }
  }
  assertSelfTest(
    directAdjacencyGroups.length ===
      INCIDENTAL_POPULATION_WORDS.size *
        directAdjacencyPopulationMarkers.length *
        2 *
        3 &&
      directAdjacencyGroups.length <= MAX_GROUPS &&
      directAdjacencyGroups.some(({ displayName }) =>
        displayName?.includes('backupgradeblue'),
      ),
    'direct-adjacency fixture exhausts every incidental word, population marker, direction, and identity-field placement',
  );
  const directAdjacencyDraft = buildDraft(
    [facilities[0]!],
    directAdjacencyGroups,
    Math.ceil(directAdjacencyGroups.length / MAX_GROUPS_PER_PAGE),
    generatedAt,
  );
  const serializedDirectAdjacencyDraft = JSON.stringify(directAdjacencyDraft);
  assertSelfTest(
    directAdjacencyDraft.inventoryGroups.length === 0 &&
      directAdjacencyDraft.report.omittedUnverifiedGroupIdentityCount ===
        directAdjacencyGroups.length &&
      !serializedDirectAdjacencyDraft.includes(
        'groups/synthetic-direct-adjacency-',
      ) &&
      validateDraft(directAdjacencyDraft).structuralValidationPassed,
    'an audited incidental word cannot hide a directly adjacent population marker in either identity field',
  );

  const compactIncidentalControlGroups: CloudGroup[] = [];
  const compactIncidentalControlIds = new Set<string>();
  let compactIncidentalIndex = 0;
  for (const incidentalWord of [...INCIDENTAL_POPULATION_WORDS].sort(
    compareText,
  )) {
    for (const variant of [
      'both-compact',
      'both-separated',
      'display-compact',
      'local-compact',
    ] as const) {
      const index = compactIncidentalIndex;
      compactIncidentalIndex += 1;
      const id = `synthetic-incidental-control-${index}`;
      const compactDisplayName = `NBE${incidentalWord}Staff${index}`;
      const separatedDisplayName = `NBE ${incidentalWord} Staff ${index}`;
      const compactLocalPart = `nbe${incidentalWord}staff${index}`;
      const separatedLocalPart = `nbe.${incidentalWord}.staff.${index}`;
      compactIncidentalControlIds.add(`groups/${id}`);
      compactIncidentalControlGroups.push(
        parseCloudGroup(
          rawGroup(
            id,
            `${
              variant === 'both-compact' || variant === 'local-compact'
                ? compactLocalPart
                : separatedLocalPart
            }@groups.synthetic.invalid`,
            variant === 'both-compact' || variant === 'display-compact'
              ? compactDisplayName
              : separatedDisplayName,
          ),
          parent,
        ),
      );
    }
  }
  const compactIncidentalControlDraft = buildDraft(
    [facilities[0]!],
    compactIncidentalControlGroups,
    1,
    generatedAt,
  );
  const inventoriedCompactIncidentalIds = new Set(
    compactIncidentalControlDraft.inventoryGroups.map(
      ({ googleGroupId }) => googleGroupId,
    ),
  );
  assertSelfTest(
    compactIncidentalControlGroups.length ===
      INCIDENTAL_POPULATION_WORDS.size * 4 &&
      compactIncidentalControlDraft.inventoryGroups.length ===
        compactIncidentalControlGroups.length &&
      compactIncidentalControlDraft.report
        .omittedUnverifiedGroupIdentityCount === 0 &&
      [...compactIncidentalControlIds].every((id) =>
        inventoriedCompactIncidentalIds.has(id),
      ) &&
      ['captains', 'kidney', 'subfamily', 'transparent', 'upgrade'].every(
        (word) =>
          compactIncidentalControlGroups
            .filter(({ displayName }) => displayName?.includes(word))
            .every(({ googleGroupId }) =>
              inventoriedCompactIncidentalIds.has(googleGroupId),
            ),
      ) &&
      validateDraft(compactIncidentalControlDraft).structuralValidationPassed,
    'every audited incidental word remains inventory-visible in separated and fully compact identity fields',
  );

  const sortedIncidentalWords = [...INCIDENTAL_POPULATION_WORDS].sort(
    compareText,
  );
  const pairedIncidentalGroups = sortedIncidentalWords.flatMap(
    (left, leftIndex) =>
      sortedIncidentalWords.map((right, rightIndex) => {
        const index = leftIndex * sortedIncidentalWords.length + rightIndex;
        return parseCloudGroup(
          rawGroup(
            `synthetic-paired-incidental-${index}`,
            `nbe${left}${right}staff${index}@groups.synthetic.invalid`,
            `NBE${left}${right}Staff${index}`,
          ),
          parent,
        );
      }),
  );
  const pairedIncidentalDraft = buildDraft(
    [facilities[0]!],
    pairedIncidentalGroups,
    Math.ceil(pairedIncidentalGroups.length / MAX_GROUPS_PER_PAGE),
    generatedAt,
  );
  assertSelfTest(
    pairedIncidentalGroups.length === INCIDENTAL_POPULATION_WORDS.size ** 2 &&
      pairedIncidentalGroups.length === 3_364 &&
      pairedIncidentalDraft.inventoryGroups.length ===
        pairedIncidentalGroups.length &&
      pairedIncidentalDraft.report.omittedUnverifiedGroupIdentityCount === 0 &&
      validateDraft(pairedIncidentalDraft).structuralValidationPassed,
    'every ordered pair of adjacent audited incidental atoms remains inventory-visible',
  );

  const sequentialIncidentalGroups = [
    parseCloudGroup(
      rawGroup(
        'synthetic-sequential-incidental-safe',
        'nbebackupupgradestaff@groups.synthetic.invalid',
        'NBEBackupUpgradeStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-sequential-backup-grade-shadow',
        'nbebackupgradebluestaff@groups.synthetic.invalid',
        'NBEBackupGradeBlueStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-sequential-upgrade-student-shadow',
        'nbeupgradestudentsstaff@groups.synthetic.invalid',
        'NBEUpgradeStudentsStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-sequential-safe-atoms-population-shadow',
        'nbebackupupgradestudentsbluestaff@groups.synthetic.invalid',
        'NBEBackupUpgradeStudentsBlueStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-sequential-safe-atoms-short-grade-shadow',
        'nbebackupkeycardpkbluestaff@groups.synthetic.invalid',
        'NBEBackupKeycardPKBlueStaff',
      ),
      parent,
    ),
  ];
  const sequentialIncidentalDraft = buildDraft(
    [facilities[0]!],
    sequentialIncidentalGroups,
    1,
    generatedAt,
  );
  const serializedSequentialIncidentalDraft = JSON.stringify(
    sequentialIncidentalDraft,
  );
  assertSelfTest(
    sequentialIncidentalDraft.inventoryGroups.length === 1 &&
      sequentialIncidentalDraft.inventoryGroups[0]?.googleGroupId ===
        'groups/synthetic-sequential-incidental-safe' &&
      sequentialIncidentalDraft.report.omittedUnverifiedGroupIdentityCount ===
        4 &&
      !serializedSequentialIncidentalDraft.includes(
        'groups/synthetic-sequential-backup-grade-shadow',
      ) &&
      !serializedSequentialIncidentalDraft.includes(
        'groups/synthetic-sequential-upgrade-student-shadow',
      ) &&
      !serializedSequentialIncidentalDraft.includes(
        'groups/synthetic-sequential-safe-atoms-population-shadow',
      ) &&
      !serializedSequentialIncidentalDraft.includes(
        'groups/synthetic-sequential-safe-atoms-short-grade-shadow',
      ) &&
      validateDraft(sequentialIncidentalDraft).structuralValidationPassed,
    'sequential incidental atoms remain visible while every later genuine population marker fails closed',
  );

  const overlappingPopulationTokens = new Set<string>();
  const overlapPopulationMarkers = new Set([
    ...HIGH_CONFIDENCE_EMBEDDED_POPULATION_MARKERS,
    ...SHORT_GRADE_POPULATION_MARKERS,
    ...SPELLED_GRADE_ORDINAL_MARKERS,
    'pk',
  ]);
  for (const incidentalWord of INCIDENTAL_POPULATION_WORDS) {
    for (const populationMarker of overlapPopulationMarkers) {
      const maximumOverlap = Math.min(
        incidentalWord.length,
        populationMarker.length,
      );
      for (let overlap = 1; overlap < maximumOverlap; overlap += 1) {
        if (incidentalWord.endsWith(populationMarker.slice(0, overlap))) {
          overlappingPopulationTokens.add(
            `${incidentalWord}${populationMarker.slice(overlap)}`,
          );
        }
        if (populationMarker.endsWith(incidentalWord.slice(0, overlap))) {
          overlappingPopulationTokens.add(
            `${populationMarker}${incidentalWord.slice(overlap)}`,
          );
        }
      }
    }
  }
  assertSelfTest(
    [
      'bikestudent',
      'blackboardstudents',
      'bookkeepingrades',
      'checkindergarten',
      'classlinkids',
      'masterclassroom',
      'riskg',
      'riskids',
      'tkindness',
    ].every((token) => overlappingPopulationTokens.has(token)),
    'overlap fixture covers representative population markers on both incidental-word boundaries',
  );
  const overlappingPopulationGroups = [...overlappingPopulationTokens]
    .sort(compareText)
    .map((token, index) =>
      parseCloudGroup(
        rawGroup(
          `synthetic-overlap-population-${index}`,
          `nbe.${token}.staff@groups.synthetic.invalid`,
          `NBE ${token} Staff`,
        ),
        parent,
      ),
    );
  const overlappingPopulationDraft = buildDraft(
    [facilities[0]!],
    overlappingPopulationGroups,
    Math.max(
      1,
      Math.ceil(overlappingPopulationGroups.length / MAX_GROUPS_PER_PAGE),
    ),
    generatedAt,
  );
  const serializedOverlappingPopulationDraft = JSON.stringify(
    overlappingPopulationDraft,
  );
  assertSelfTest(
    overlappingPopulationDraft.inventoryGroups.length === 0 &&
      overlappingPopulationDraft.report.omittedUnverifiedGroupIdentityCount ===
        overlappingPopulationGroups.length &&
      overlappingPopulationGroups.every(
        ({ email, googleGroupId }) =>
          !serializedOverlappingPopulationDraft.includes(email) &&
          !serializedOverlappingPopulationDraft.includes(googleGroupId),
      ) &&
      validateDraft(overlappingPopulationDraft).structuralValidationPassed,
    'population markers that overlap either edge of an incidental word are omitted without identity metadata',
  );

  const operationalKGroups = [...OPERATIONAL_K_SAFE_WORDS]
    .sort(compareText)
    .flatMap((slug) => [
      parseCloudGroup(
        rawGroup(
          `synthetic-operational-${slug}`,
          `nbe.${slug}.staff@groups.synthetic.invalid`,
          `NBE ${slug} Staff`,
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          `synthetic-compact-operational-${slug}`,
          `nbe${slug}staff@groups.synthetic.invalid`,
          `NBE${slug}Staff`,
        ),
        parent,
      ),
    ]);
  operationalKGroups.push(
    parseCloudGroup(
      rawGroup(
        'synthetic-unknown-operational-bookkeeper',
        'operations.bookkeeper.staff@groups.synthetic.invalid',
        'Operations Bookkeeper Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-ordinal-collision-one-staff',
        'nbe1staff@groups.synthetic.invalid',
        'NBE1Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-ordinal-collision-four-through',
        'nbe4throughstaff@groups.synthetic.invalid',
        'NBE4ThroughStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-non-grade-twenty-first',
        'operations.21st.century.staff@groups.synthetic.invalid',
        'Operations 21st Century Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-out-of-range-band',
        'operations.13.14.staff@groups.synthetic.invalid',
        'Operations 13/14 Staff',
      ),
      parent,
    ),
  );
  const operationalKDraft = buildDraft(
    [facilities[0]!],
    operationalKGroups,
    1,
    generatedAt,
  );
  assertSelfTest(
    operationalKDraft.inventoryGroups.length === operationalKGroups.length &&
      operationalKDraft.report.omittedUnverifiedGroupIdentityCount === 0 &&
      operationalKDraft.buildingMappings[0]?.assessment.candidates.every(
        ({ googleGroupId }) => !googleGroupId.includes('operational-'),
      ) === true,
    'audited operational K words and non-grade numeric controls remain reviewable without masking an additional grade marker',
  );

  const falseStaffSubstringGroups = [
    ['badminton', 'Badminton'],
    ['submarine', 'Submarine'],
    ['stafford', 'Stafford'],
    ['employeee', 'Employeee'],
    ['paradise', 'Paradise'],
    ['administer', 'Administer'],
    ['subclass', 'Subclass'],
    ['subcampus', 'Subcampus'],
    ['subdistrict', 'Subdistrict'],
    ['subfamily', 'Subfamily'],
    ['subgrade', 'Subgrade'],
    ['subgroup', 'Subgroup'],
    ['sublist', 'Sublist'],
    ['subschool', 'Subschool'],
    ['subteam', 'Subteam'],
  ].map(([slug, displayName]) =>
    parseCloudGroup(
      rawGroup(
        `synthetic-false-staff-substring-${slug}`,
        `${slug}@groups.synthetic.invalid`,
        displayName!,
      ),
      parent,
    ),
  );
  const boundedStaffEvidenceGroups = [
    rawGroup(
      'synthetic-exact-staff-evidence',
      'nbe.staff@groups.synthetic.invalid',
      'NBE Staff',
    ),
    rawGroup(
      'synthetic-exact-role-evidence',
      'nbe.teachers@groups.synthetic.invalid',
      'NBE Teachers',
    ),
    rawGroup(
      'synthetic-compact-staff-evidence',
      'nbestaff@groups.synthetic.invalid',
      'NBEStaff',
    ),
    rawGroup(
      'synthetic-compact-role-evidence',
      'nbeteachers@groups.synthetic.invalid',
      'NBETeachers',
    ),
  ].map((group) => parseCloudGroup(group, parent));
  const boundedStaffEvidenceDraft = buildDraft(
    [facilities[0]!],
    [...falseStaffSubstringGroups, ...boundedStaffEvidenceGroups],
    1,
    generatedAt,
  );
  const serializedBoundedStaffEvidenceDraft = JSON.stringify(
    boundedStaffEvidenceDraft,
  );
  assertSelfTest(
    boundedStaffEvidenceDraft.inventoryGroups.length ===
      boundedStaffEvidenceGroups.length &&
      boundedStaffEvidenceDraft.report.omittedUnverifiedGroupIdentityCount ===
        falseStaffSubstringGroups.length &&
      falseStaffSubstringGroups.every(
        ({ googleGroupId }) =>
          !serializedBoundedStaffEvidenceDraft.includes(googleGroupId),
      ),
    'staff eligibility requires exact or fully consumed facility-corroborated evidence rather than incidental substrings',
  );

  const omittedOnlyValidation = validateDraft(
    buildDraft([], [falseStaffSubstringGroups[0]!], 1, generatedAt),
  );
  assertSelfTest(
    omittedOnlyValidation.allReviewFieldsStructurallyResolved &&
      omittedOnlyValidation.unresolvedFindingCount === 1,
    'omitted unverified identities remain explicit unresolved findings even when no serialized review field exists',
  );

  const embeddedPopulationGroups = [
    ['program-student-services', 'NBEProgramStudentServicesStaff'],
    ['parent-liaison', 'ParentLiaisonStaff'],
    ['child-nutrition', 'ChildNutritionStaff'],
    ['family-smith', 'FamilySmithStaff'],
    ['class-of-2026', 'ClassOf2026Staff'],
    ['class-music', 'ClassMusicStaff'],
    ['grade-blue', 'GradeBlueStaff'],
    ['grade-five', 'GradeFiveStaff'],
    ['named-grade-five', 'JaneDoeGradeFiveStaff'],
    ['cohort-alpha', 'CohortAlphaStaff'],
    ['cohort-blue', 'CohortBlueStaff'],
    ['split-students', 'NBEStu-dentsStaff'],
    ['wrapped-k-grade', 'JaneDoeK5SmithStaff'],
    ['wrapped-pk-grade', 'JaneDoePK5SmithStaff'],
    ['wrapped-bare-k-grade', 'NBEProgramKBlueStaff'],
    ['wrapped-bare-pk-grade', 'NBEProgramPKBlueStaff'],
  ].map(([slug, identity]) =>
    parseCloudGroup(
      rawGroup(
        `synthetic-embedded-population-${slug}`,
        `${identity!.toLowerCase()}@groups.synthetic.invalid`,
        identity!,
      ),
      parent,
    ),
  );
  embeddedPopulationGroups.push(
    parseCloudGroup(
      rawGroup(
        'synthetic-embedded-population-unicode-split-students',
        'nbe.staff@groups.synthetic.invalid',
        'NBE Stu\u2028dents Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-embedded-population-mismatched-bare-k',
        'nbeprogramkbluestaff@groups.synthetic.invalid',
        'NBE Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-embedded-population-mismatched-bare-pk',
        'nbeprogrampkbluestaff@groups.synthetic.invalid',
        'NBE Staff',
      ),
      parent,
    ),
  );
  const embeddedPopulationDraft = buildDraft(
    [facilities[0]!],
    embeddedPopulationGroups,
    1,
    generatedAt,
  );
  const serializedEmbeddedPopulationDraft = JSON.stringify(
    embeddedPopulationDraft,
  );
  assertSelfTest(
    embeddedPopulationDraft.inventoryGroups.length === 0 &&
      embeddedPopulationDraft.report.omittedUnverifiedGroupIdentityCount ===
        embeddedPopulationGroups.length &&
      embeddedPopulationGroups.every(
        ({ googleGroupId }) =>
          !serializedEmbeddedPopulationDraft.includes(googleGroupId),
      ),
    'high-confidence embedded population identities fail closed despite arbitrary surrounding text',
  );

  const operationalKShadowGroups = [...OPERATIONAL_K_SAFE_WORDS]
    .sort(compareText)
    .map((word) =>
      rawGroup(
        `synthetic-operational-${word}-extra-k-blue`,
        `nbe${word}kbluestaff@groups.synthetic.invalid`,
        `NBE${word}KBlueStaff`,
      ),
    );
  const repeatedGradeBandGroups = [
    ['double-hyphen', '6--8'],
    ['triple-hyphen', '6---8'],
    ['double-dot', '6..8'],
    ['double-underscore', '6__8'],
    ['mixed-hyphen-underscore', '6-_8'],
    ['mixed-symbol-run', '6-_/._8'],
    ['double-slash', '6//8'],
    ['wrapped-to', '6-to-8'],
    ['wrapped-through', '6-through-8'],
    ['wrapped-and', '6-and-8'],
    ['mixed-word-connectors', '6and-to8'],
    ['comma', '6,8'],
    ['semicolon', '6;8'],
    ['pipe', '6|8'],
    ['backslash', '6\\8'],
    ['hash', '6#8'],
    ['tilde', '6~8'],
    ['asterisk', '6*8'],
    ['percent', '6%8'],
    ['equals', '6=8'],
  ].map(([slug, band]) =>
    rawGroup(
      `synthetic-repeated-grade-band-${slug}`,
      `nbe.staff.band-${slug}@groups.synthetic.invalid`,
      `NBE${band}Staff`,
    ),
  );
  const expandedPopulationGrammarGroups = [
    ...operationalKShadowGroups,
    ...repeatedGradeBandGroups,
    rawGroup(
      'synthetic-ampersand-students',
      'nbe.staff@groups.synthetic.invalid',
      'NBE Stu&Dents Staff',
    ),
    rawGroup(
      'synthetic-ampersand-parents',
      'nbe.staff@groups.synthetic.invalid',
      'NBE Par&ents Staff',
    ),
    rawGroup(
      'synthetic-ampersand-family',
      'nbe.staff@groups.synthetic.invalid',
      'NBE Fam&ily Staff',
    ),
    rawGroup(
      'synthetic-ampersand-class',
      'nbe.staff@groups.synthetic.invalid',
      'NBE Cl&ass Staff',
    ),
    rawGroup(
      'synthetic-ampersand-grade',
      'nbe.staff@groups.synthetic.invalid',
      'NBE Gr&ade Staff',
    ),
    rawGroup(
      'synthetic-ampersand-cohort',
      'nbe.staff@groups.synthetic.invalid',
      'NBE Co&hort Staff',
    ),
    rawGroup(
      'synthetic-tk-grade',
      'nbe.tk.staff@groups.synthetic.invalid',
      'NBE TK Staff',
    ),
    rawGroup(
      'synthetic-compact-kg-grade',
      'nbekgstaff@groups.synthetic.invalid',
      'NBEKGStaff',
    ),
    rawGroup(
      'synthetic-kdg-grade',
      'nbe.kdg.staff@groups.synthetic.invalid',
      'NBE KDG Staff',
    ),
    rawGroup(
      'synthetic-fifth-grade',
      'nbe.5th.staff@groups.synthetic.invalid',
      'NBE 5th Staff',
    ),
    rawGroup(
      'synthetic-twelfth-grade',
      'nbe.12th.staff@groups.synthetic.invalid',
      'NBE 12th Staff',
    ),
    rawGroup(
      'synthetic-ascii-grade-range',
      'nbe.6-8.staff@groups.synthetic.invalid',
      'NBE 6-8 Staff',
    ),
    rawGroup(
      'synthetic-unicode-grade-range',
      'nbe.staff@groups.synthetic.invalid',
      'NBE 6–8 Staff',
    ),
    rawGroup(
      'synthetic-mis-class-of-year',
      'misclassof2026.staff@groups.synthetic.invalid',
      'MISClassOf2026 Staff',
    ),
    rawGroup(
      'synthetic-dotted-program-k-blue',
      'nbe.staff.programkblue@groups.synthetic.invalid',
      'NBE Staff',
    ),
    rawGroup(
      'synthetic-dotted-program-pk-blue',
      'nbe.staff.programpkblue@groups.synthetic.invalid',
      'NBE Staff',
    ),
    rawGroup(
      'synthetic-global-k-blue',
      'psd.staff.kblue@groups.synthetic.invalid',
      'PSD Staff',
    ),
    rawGroup(
      'synthetic-global-pk-blue',
      'psd.staff.pkblue@groups.synthetic.invalid',
      'PSD Staff',
    ),
    rawGroup(
      'synthetic-global-kg-blue',
      'psd.staff.kgblue@groups.synthetic.invalid',
      'PSD Staff',
    ),
    rawGroup(
      'synthetic-global-tk-blue',
      'district.staff.tkblue@groups.synthetic.invalid',
      'District Staff',
    ),
    rawGroup(
      'synthetic-global-kdg-blue',
      'district.staff.kdgblue@groups.synthetic.invalid',
      'District Staff',
    ),
    rawGroup(
      'synthetic-global-program-k-blue',
      'psd.staff.programkblue@groups.synthetic.invalid',
      'PSD Staff',
    ),
    rawGroup(
      'synthetic-prefix-before-facility-k-blue',
      'districtnbeprogramkblue.staff@groups.synthetic.invalid',
      'DistrictNBEProgramKBlue Staff',
    ),
    rawGroup(
      'synthetic-prefix-before-facility-pk-blue',
      'districtnbeprogrampkblue.staff@groups.synthetic.invalid',
      'DistrictNBEProgramPKBlue Staff',
    ),
    rawGroup(
      'synthetic-arbitrary-fifth-grade-suffix',
      'nbeprogram5thblue.staff@groups.synthetic.invalid',
      'NBEProgram5thBlue Staff',
    ),
    rawGroup(
      'synthetic-split-ordinal-ampersand',
      'nbe.staff@groups.synthetic.invalid',
      'NBE 5&th Staff',
    ),
    rawGroup(
      'synthetic-split-ordinal-hyphen',
      'nbe.5-th.staff@groups.synthetic.invalid',
      'NBE 5-th Staff',
    ),
    rawGroup(
      'synthetic-split-ordinal-space',
      'nbe.5.th.staff@groups.synthetic.invalid',
      'NBE 5 th Staff',
    ),
    rawGroup(
      'synthetic-slash-grade-band',
      'nbe.6.8.staff@groups.synthetic.invalid',
      'NBE 6/8 Staff',
    ),
    rawGroup(
      'synthetic-ampersand-grade-band',
      'nbe.6.and.8.staff@groups.synthetic.invalid',
      'NBE 6&8 Staff',
    ),
    rawGroup(
      'synthetic-compact-slash-grade-band',
      'nbe.staff.slashband@groups.synthetic.invalid',
      'NBE6/8Staff',
    ),
    rawGroup(
      'synthetic-compact-ampersand-grade-band',
      'nbe.staff.ampband@groups.synthetic.invalid',
      'NBE6&8Staff',
    ),
    rawGroup(
      'synthetic-unknown-program-k-blue',
      'operations.staff.programkblue@groups.synthetic.invalid',
      'Operations Staff',
    ),
    rawGroup(
      'synthetic-bookkeeper-extra-k-blue',
      'nbe.bookkeeper.kblue.staff@groups.synthetic.invalid',
      'NBE Bookkeeper KBlue Staff',
    ),
    rawGroup(
      'synthetic-kitchen-extra-pk-blue',
      'nbe.kitchen.pkblue.staff@groups.synthetic.invalid',
      'NBE Kitchen PKBlue Staff',
    ),
    rawGroup(
      'synthetic-skyward-extra-tk-blue',
      'nbe.skyward.tkblue.staff@groups.synthetic.invalid',
      'NBE Skyward TKBlue Staff',
    ),
    rawGroup(
      'synthetic-compact-risk-extra-pk-blue',
      'nberiskpkbluestaff@groups.synthetic.invalid',
      'NBERiskPKBlueStaff',
    ),
  ].map((group) => parseCloudGroup(group, parent));
  const expandedPopulationGrammarDraft = buildDraft(
    [facilities[0]!, facilities[3]!],
    expandedPopulationGrammarGroups,
    1,
    generatedAt,
  );
  const serializedExpandedPopulationGrammarDraft = JSON.stringify(
    expandedPopulationGrammarDraft,
  );
  assertSelfTest(
    expandedPopulationGrammarDraft.inventoryGroups.length === 0 &&
      expandedPopulationGrammarDraft.report
        .omittedUnverifiedGroupIdentityCount ===
        expandedPopulationGrammarGroups.length &&
      expandedPopulationGrammarGroups.every(
        ({ email, googleGroupId }) =>
          !serializedExpandedPopulationGrammarDraft.includes(email) &&
          !serializedExpandedPopulationGrammarDraft.includes(googleGroupId),
      ),
    'ampersand splits, grade aliases and ranges, and arbitrary embedded K/PK qualifiers are omitted without identity metadata',
  );

  const gradeBandControlGroups = [
    parseCloudGroup(
      rawGroup(
        'synthetic-current-year-double-delimiter',
        'nbe.2026--2027.staff@groups.synthetic.invalid',
        'NBE 2026--2027 Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-out-of-range-double-delimiter',
        'operations.13--14.staff@groups.synthetic.invalid',
        'Operations 13--14 Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-single-grade-number-control',
        'nbe.6.staff@groups.synthetic.invalid',
        'NBE 6 Staff',
      ),
      parent,
    ),
  ];
  const gradeBandControlDraft = buildDraft(
    [facilities[0]!],
    gradeBandControlGroups,
    1,
    generatedAt,
  );
  assertSelfTest(
    gradeBandControlDraft.inventoryGroups.length ===
      gradeBandControlGroups.length &&
      gradeBandControlDraft.report.omittedUnverifiedGroupIdentityCount === 0,
    'repeated delimiters do not turn academic years, out-of-range numbers, or a single bounded number into grade bands',
  );

  const spelledGradeEndpoints = [
    ...SPELLED_GRADE_CARDINALS,
    ...SPELLED_GRADE_ORDINALS,
  ];
  const precomposedGradeLetters = new Map<string, string>([
    ['a', '\u00e1'],
    ['c', '\u0107'],
    ['d', '\u010f'],
    ['e', '\u00e9'],
    ['f', '\u1e1f'],
    ['g', '\u01f5'],
    ['h', '\u0125'],
    ['i', '\u00ed'],
    ['l', '\u013a'],
    ['n', '\u0144'],
    ['o', '\u00f3'],
    ['r', '\u0155'],
    ['s', '\u015b'],
    ['t', '\u0163'],
    ['u', '\u00fa'],
    ['v', '\u1e7d'],
    ['w', '\u1e83'],
    ['x', '\u1e8b'],
  ]);
  const precomposedGradeVariants = [
    ...SPELLED_GRADE_CARDINALS.map(
      (endpoint) => ['cardinal', endpoint] as const,
    ),
    ...SPELLED_GRADE_ORDINALS.map((endpoint) => ['ordinal', endpoint] as const),
  ].flatMap(([kind, endpoint]) =>
    [...endpoint].map((character, index, characters) => {
      const replacement = precomposedGradeLetters.get(character);
      assertSelfTest(
        replacement !== undefined &&
          normalizeText(replacement) === character &&
          !hasUnsupportedIdentityContent(replacement),
        `a supported precomposed fixture exists for ${character}`,
      );
      return {
        endpoint,
        kind,
        variant: characters
          .map((candidate, candidateIndex) =>
            candidateIndex === index ? replacement : candidate,
          )
          .join(''),
      };
    }),
  );
  for (const { endpoint, kind, variant } of precomposedGradeVariants) {
    const field =
      kind === 'ordinal'
        ? `NBE ${variant} Staff`
        : `NBE ${variant}-to-Two Staff`;
    const evidence = writtenGradeEvidenceForField(field);
    assertSelfTest(
      kind === 'ordinal' ? evidence.hasOrdinal : evidence.hasRange,
      `precomposed ${kind} variant of ${endpoint} is recognized`,
    );
  }
  const precomposedSourceField = 'NBE F\u00edrst-to-Two Staff';
  const precomposedSourceMatch = scanWrittenGradeEndpoints(
    precomposedSourceField,
  ).matches.find(({ marker }) => marker === 'first');
  assertSelfTest(
    precomposedSourceMatch !== undefined &&
      precomposedSourceField.slice(
        precomposedSourceMatch.start,
        precomposedSourceMatch.end,
      ) === 'F\u00edrst' &&
      !precomposedSourceMatch.usedInternalSeparator &&
      !scanWrittenGradeEndpoints('NBE Fi\u03bbrst Staff').matches.some(
        ({ marker }) => marker === 'first',
      ),
    'precomposed grade matches retain raw offsets without bridging unsupported letters',
  );
  const precomposedGradeGroups = precomposedGradeVariants.map(
    ({ kind, variant }, index) =>
      parseCloudGroup(
        rawGroup(
          `synthetic-precomposed-grade-${index}`,
          `nbe.staff.precomposed.${index}@groups.synthetic.invalid`,
          kind === 'ordinal'
            ? `NBE ${variant} Staff`
            : `NBE ${variant}-to-Two Staff`,
        ),
        parent,
      ),
  );
  const precomposedGradeDraft = buildDraft(
    [facilities[0]!],
    precomposedGradeGroups,
    1,
    generatedAt,
  );
  const serializedPrecomposedGradeDraft = JSON.stringify(precomposedGradeDraft);
  assertSelfTest(
    precomposedGradeDraft.inventoryGroups.length === 0 &&
      precomposedGradeDraft.report.omittedUnverifiedGroupIdentityCount ===
        precomposedGradeGroups.length &&
      !serializedPrecomposedGradeDraft.includes(
        'groups/synthetic-precomposed-grade-',
      ) &&
      validateDraft(precomposedGradeDraft).structuralValidationPassed,
    'every supported precomposed written-grade variant is omitted without serialized identity metadata',
  );
  const spelledGradeRangeConnectors = [
    '-',
    '--',
    ' through ',
    '-to-',
    'and-to',
  ] as const;
  const spelledGradeRangeGroups = spelledGradeEndpoints.flatMap(
    (left, endpointIndex) =>
      spelledGradeRangeConnectors.map((connector, connectorIndex) => {
        const right =
          spelledGradeEndpoints[
            (endpointIndex + connectorIndex + 1) % spelledGradeEndpoints.length
          ]!;
        const fixtureIndex =
          endpointIndex * spelledGradeRangeConnectors.length + connectorIndex;
        return parseCloudGroup(
          rawGroup(
            `synthetic-spelled-grade-range-${fixtureIndex}`,
            `nbe.staff.written-range-${fixtureIndex}@groups.synthetic.invalid`,
            `NBE${left}${connector}${right}Staff`,
          ),
          parent,
        );
      }),
  );
  const spelledGradeOrdinalGroups = SPELLED_GRADE_ORDINALS.flatMap(
    (ordinal) => [
      parseCloudGroup(
        rawGroup(
          `synthetic-spelled-grade-ordinal-${ordinal}`,
          `nbe.${ordinal}.staff@groups.synthetic.invalid`,
          `NBE ${ordinal} Staff`,
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          `synthetic-compact-spelled-grade-ordinal-${ordinal}`,
          `nbe${ordinal}bluestaff@groups.synthetic.invalid`,
          `NBE${ordinal}BlueStaff`,
        ),
        parent,
      ),
    ],
  );
  const spelledGradeGroups = [
    ...spelledGradeRangeGroups,
    ...spelledGradeOrdinalGroups,
  ];
  const spelledGradeDraft = buildDraft(
    [facilities[0]!],
    spelledGradeGroups,
    1,
    generatedAt,
  );
  const serializedSpelledGradeDraft = JSON.stringify(spelledGradeDraft);
  assertSelfTest(
    spelledGradeDraft.inventoryGroups.length === 0 &&
      spelledGradeDraft.report.omittedUnverifiedGroupIdentityCount ===
        spelledGradeGroups.length &&
      spelledGradeGroups.every(
        ({ email, googleGroupId }) =>
          !serializedSpelledGradeDraft.includes(email) &&
          !serializedSpelledGradeDraft.includes(googleGroupId),
      ) &&
      validateDraft(spelledGradeDraft).structuralValidationPassed,
    'written cardinal and ordinal grade bands plus lone written ordinals are omitted without identity metadata',
  );

  const splitWrittenOrdinalDisplayDelimiters = [
    '-',
    '_',
    '.',
    '/',
    '&',
    ' ',
  ] as const;
  const splitWrittenOrdinalLocalDelimiters = ['-', '_', '.'] as const;
  const splitWrittenOrdinalGroups: CloudGroup[] = [];
  let splitWrittenOrdinalIndex = 0;
  let splitWrittenOrdinalDisplayCount = 0;
  for (const ordinal of SPELLED_GRADE_ORDINALS) {
    for (let split = 1; split < ordinal.length; split += 1) {
      for (const delimiter of splitWrittenOrdinalDisplayDelimiters) {
        const splitOrdinal = `${ordinal.slice(0, split)}${delimiter}${ordinal.slice(split)}`;
        const index = splitWrittenOrdinalIndex;
        splitWrittenOrdinalIndex += 1;
        splitWrittenOrdinalDisplayCount += 1;
        splitWrittenOrdinalGroups.push(
          parseCloudGroup(
            rawGroup(
              `synthetic-split-written-ordinal-display-${index}`,
              `nbe.staff.split${index}@groups.synthetic.invalid`,
              `NBE ${splitOrdinal} Blue Staff ${index}`,
            ),
            parent,
          ),
        );
      }
      for (const delimiter of splitWrittenOrdinalLocalDelimiters) {
        const splitOrdinal = `${ordinal.slice(0, split)}${delimiter}${ordinal.slice(split)}`;
        const index = splitWrittenOrdinalIndex;
        splitWrittenOrdinalIndex += 1;
        splitWrittenOrdinalGroups.push(
          parseCloudGroup(
            rawGroup(
              `synthetic-split-written-ordinal-local-${index}`,
              `nbe.${splitOrdinal}.blue.staff.${index}@groups.synthetic.invalid`,
              `NBE Staff Split ${index}`,
            ),
            parent,
          ),
        );
      }
    }
  }
  assertSelfTest(
    splitWrittenOrdinalDisplayCount === 348 &&
      splitWrittenOrdinalGroups.length === 522,
    'split-written-ordinal fixture exhausts every internal display split and every provider-valid local-part split',
  );
  const splitWrittenOrdinalDraft = buildDraft(
    [facilities[0]!],
    splitWrittenOrdinalGroups,
    Math.ceil(splitWrittenOrdinalGroups.length / MAX_GROUPS_PER_PAGE),
    generatedAt,
  );
  const serializedSplitWrittenOrdinalDraft = JSON.stringify(
    splitWrittenOrdinalDraft,
  );
  assertSelfTest(
    splitWrittenOrdinalDraft.inventoryGroups.length === 0 &&
      splitWrittenOrdinalDraft.report.omittedUnverifiedGroupIdentityCount ===
        splitWrittenOrdinalGroups.length &&
      !serializedSplitWrittenOrdinalDraft.includes(
        'groups/synthetic-split-written-ordinal-',
      ) &&
      validateDraft(splitWrittenOrdinalDraft).structuralValidationPassed,
    'punctuation-, ampersand-, and whitespace-split written ordinals fail closed in each identity field',
  );

  const exhaustiveWrittenRangeConnectors = [
    '-',
    '--',
    '..',
    '_',
    '/',
    '&',
    ' and ',
    '-to-',
    ' through ',
    '-thru-',
    'and-to',
  ] as const;
  let exhaustiveWrittenRangeCount = 0;
  for (const left of spelledGradeEndpoints) {
    for (const right of spelledGradeEndpoints) {
      for (const connector of exhaustiveWrittenRangeConnectors) {
        const field = `NBE${left}${connector}${right}Staff`;
        const evidence = writtenGradeEvidenceForField(field);
        assertSelfTest(
          evidence.hasRange,
          `written range ${left}${connector}${right} is recognized`,
        );
        exhaustiveWrittenRangeCount += 1;
      }
    }
  }
  assertSelfTest(
    exhaustiveWrittenRangeCount ===
      spelledGradeEndpoints.length ** 2 *
        exhaustiveWrittenRangeConnectors.length,
    'written-grade range fixture covers every endpoint pair and connector',
  );
  for (const endpoint of spelledGradeEndpoints) {
    for (let split = 1; split < endpoint.length; split += 1) {
      for (const delimiter of splitWrittenOrdinalDisplayDelimiters) {
        const splitEndpoint = `${endpoint.slice(0, split)}${delimiter}${endpoint.slice(split)}`;
        const leftField = `NBE${splitEndpoint}-to-TwoStaff`;
        const rightField = `NBEOne-to-${splitEndpoint}Staff`;
        assertSelfTest(
          writtenGradeEvidenceForField(leftField).hasRange &&
            writtenGradeEvidenceForField(rightField).hasRange,
          `split written endpoint ${splitEndpoint} is recognized on either side of a range`,
        );
      }
    }
  }
  const splitWrittenRangeGroups = [
    parseCloudGroup(
      rawGroup(
        'synthetic-split-written-range-left',
        'nbe.staff.split.range.left@groups.synthetic.invalid',
        'NBE O-ne-to-Two Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-split-written-range-right',
        'nbe.staff.split.range.right@groups.synthetic.invalid',
        'NBE One-to-T-wo Staff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-split-written-range-both',
        'nbe.o-ne.to.t-wo.staff@groups.synthetic.invalid',
        'NBE O-ne-through-T-wo Staff',
      ),
      parent,
    ),
  ];
  const splitWrittenRangeDraft = buildDraft(
    [facilities[0]!],
    splitWrittenRangeGroups,
    1,
    generatedAt,
  );
  assertSelfTest(
    splitWrittenRangeDraft.inventoryGroups.length === 0 &&
      splitWrittenRangeDraft.report.omittedUnverifiedGroupIdentityCount ===
        splitWrittenRangeGroups.length &&
      validateDraft(splitWrittenRangeDraft).structuralValidationPassed,
    'one- and two-sided internally split written grade ranges fail closed end to end',
  );

  const compactFirIdentityGroup = parseCloudGroup(
    rawGroup(
      'synthetic-compact-fir-whole-building',
      'syntheticfirstaff@groups.synthetic.invalid',
      'SyntheticFirStaff',
    ),
    parent,
  );
  const compactFirShadowGroups = [
    parseCloudGroup(
      rawGroup(
        'synthetic-compact-fir-students-shadow',
        'syntheticfirstudentsstaff@groups.synthetic.invalid',
        'SyntheticFirStudentsStaff',
      ),
      parent,
    ),
    parseCloudGroup(
      rawGroup(
        'synthetic-compact-fir-sixth-shadow',
        'syntheticfirsixthbluestaff@groups.synthetic.invalid',
        'SyntheticFirSixthBlueStaff',
      ),
      parent,
    ),
  ];
  const compactFirIdentityDraft = buildDraft(
    [facilities[2]!],
    [compactFirIdentityGroup, ...compactFirShadowGroups],
    1,
    generatedAt,
  );
  const serializedCompactFirIdentityDraft = JSON.stringify(
    compactFirIdentityDraft,
  );
  assertSelfTest(
    compactFirIdentityDraft.inventoryGroups.length === 1 &&
      compactFirIdentityDraft.report.omittedUnverifiedGroupIdentityCount ===
        2 &&
      compactFirIdentityDraft.buildingMappings[0]?.assessment.outcome ===
        'strong-candidate' &&
      compactFirIdentityDraft.buildingMappings[0]?.createGroupSource
        ?.googleGroupId === compactFirIdentityGroup.googleGroupId &&
      compactFirShadowGroups.every(
        ({ googleGroupId }) =>
          !serializedCompactFirIdentityDraft.includes(googleGroupId),
      ) &&
      validateDraft(compactFirIdentityDraft).structuralValidationPassed,
    'an exact compact Fir facility identity is retained without allowing population or grade shadows',
  );

  const firAliasFacility = FacilitySchema.parse({
    active: true,
    code: 'FIR',
    createdAt: generatedAt,
    id: '00000000-0000-4000-8000-000000000062',
    name: 'Fir Elementary',
  });
  const firAliasControlGroup = parseCloudGroup(
    rawGroup(
      'synthetic-fir-alias-control',
      'fir.staff@groups.synthetic.invalid',
      'FIR Staff',
    ),
    parent,
  );
  const firAliasOrdinalShadows = [
    ['after', 'FIR First Staff'],
    ['before', 'First FIR Staff'],
    ['compact', 'FIRFirstStaff'],
    ['precomposed', 'FIR F\u00edrst Staff'],
  ].map(([slug, displayName]) =>
    parseCloudGroup(
      rawGroup(
        `synthetic-fir-alias-ordinal-${slug}`,
        `fir.staff.ordinal.${slug}@groups.synthetic.invalid`,
        displayName!,
      ),
      parent,
    ),
  );
  const firAliasDraft = buildDraft(
    [firAliasFacility],
    [firAliasControlGroup, ...firAliasOrdinalShadows],
    1,
    generatedAt,
  );
  const serializedFirAliasDraft = JSON.stringify(firAliasDraft);
  assertSelfTest(
    firAliasDraft.inventoryGroups.length === 1 &&
      firAliasDraft.inventoryGroups[0]?.googleGroupId ===
        firAliasControlGroup.googleGroupId &&
      firAliasDraft.report.omittedUnverifiedGroupIdentityCount ===
        firAliasOrdinalShadows.length &&
      firAliasDraft.buildingMappings[0]?.assessment.outcome ===
        'strong-candidate' &&
      firAliasOrdinalShadows.every(
        ({ googleGroupId }) => !serializedFirAliasDraft.includes(googleGroupId),
      ) &&
      validateDraft(firAliasDraft).structuralValidationPassed,
    'a facility alias protects its exact whole-building identity but cannot mask a separate written ordinal',
  );

  const oneAliasFacility = FacilitySchema.parse({
    active: true,
    code: 'ONE',
    createdAt: generatedAt,
    id: '00000000-0000-4000-8000-000000000063',
    name: 'One Elementary',
  });
  const oneAliasRangeShadows = [
    ['after', 'ONE One-to-Two Staff'],
    ['before', 'One-to-Two ONE Staff'],
    ['repeated', 'ONE ONE-to-Two Staff'],
  ].map(([slug, displayName]) =>
    parseCloudGroup(
      rawGroup(
        `synthetic-one-alias-range-${slug}`,
        `one.staff.range.${slug}@groups.synthetic.invalid`,
        displayName!,
      ),
      parent,
    ),
  );
  const oneAliasRangeDraft = buildDraft(
    [oneAliasFacility],
    oneAliasRangeShadows,
    1,
    generatedAt,
  );
  const serializedOneAliasRangeDraft = JSON.stringify(oneAliasRangeDraft);
  assertSelfTest(
    oneAliasRangeDraft.inventoryGroups.length === 0 &&
      oneAliasRangeDraft.report.omittedUnverifiedGroupIdentityCount ===
        oneAliasRangeShadows.length &&
      oneAliasRangeShadows.every(
        ({ googleGroupId }) =>
          !serializedOneAliasRangeDraft.includes(googleGroupId),
      ) &&
      validateDraft(oneAliasRangeDraft).structuralValidationPassed,
    'reordered and repeated facility aliases cannot mask a written-grade range',
  );

  const firstCreekFacility = FacilitySchema.parse({
    active: true,
    code: 'FCE',
    createdAt: generatedAt,
    id: '00000000-0000-4000-8000-000000000061',
    name: 'First Creek Elementary',
  });
  const firstCreekGroup = parseCloudGroup(
    rawGroup(
      'synthetic-first-creek-whole-building',
      'firstcreek.staff@groups.synthetic.invalid',
      'First Creek Staff',
    ),
    parent,
  );
  const authoritativeFirstCreekDraft = buildDraft(
    [firstCreekFacility],
    [firstCreekGroup],
    1,
    generatedAt,
  );
  const nonAuthoritativeFirstCreekDraft = buildDraft(
    [facilities[0]!],
    [firstCreekGroup],
    1,
    generatedAt,
  );
  assertSelfTest(
    authoritativeFirstCreekDraft.inventoryGroups.length === 1 &&
      authoritativeFirstCreekDraft.buildingMappings[0]?.assessment.outcome ===
        'strong-candidate' &&
      authoritativeFirstCreekDraft.buildingMappings[0]?.createGroupSource
        ?.googleGroupId === firstCreekGroup.googleGroupId &&
      nonAuthoritativeFirstCreekDraft.inventoryGroups.length === 0 &&
      nonAuthoritativeFirstCreekDraft.report
        .omittedUnverifiedGroupIdentityCount === 1,
    'a written ordinal is protected only when it belongs to the authoritative exact facility identity',
  );

  const operationalOrdinalPhrases = [
    ['eighth', 'street'],
    ['eleventh', 'hour'],
    ['fifth', 'avenue'],
    ['first', 'aid'],
    ['first', 'response'],
    ['fourth', 'floor'],
    ['second', 'floor'],
    ['second', 'shift'],
    ['third', 'party'],
    ['twelfth', 'night'],
  ] as const;
  const operationalOrdinalGroups = operationalOrdinalPhrases.map(
    ([ordinal, noun], index) =>
      parseCloudGroup(
        rawGroup(
          `synthetic-operational-ordinal-${index}`,
          `nbe.${ordinal}${noun}.staff.${index}@groups.synthetic.invalid`,
          `NBE ${ordinal} ${noun} Staff ${index}`,
        ),
        parent,
      ),
  );
  const operationalOrdinalDraft = buildDraft(
    [facilities[0]!],
    operationalOrdinalGroups,
    1,
    generatedAt,
  );
  assertSelfTest(
    operationalOrdinalDraft.inventoryGroups.length ===
      operationalOrdinalGroups.length &&
      operationalOrdinalDraft.report.omittedUnverifiedGroupIdentityCount ===
        0 &&
      operationalOrdinalDraft.buildingMappings[0]?.createGroupSource === null &&
      validateDraft(operationalOrdinalDraft).structuralValidationPassed,
    'the exact audited operational ordinal phrases remain reviewable without becoming automatic whole-building mappings',
  );

  const operationalOrdinalShadowGroups = [
    ['bounded-sixth', 'nbe.sixth.blue.staff', 'NBE Sixth Blue Staff'],
    ['compact-sixth', 'nbesixthbluestaff', 'NBESixthBlueStaff'],
    [
      'first-aid-students',
      'nbe.firstaid.students.staff',
      'NBE First Aid Students Staff',
    ],
    [
      'first-aid-sixth',
      'nbe.firstaidsixthbluestaff',
      'NBE FirstAidSixthBlueStaff',
    ],
    [
      'first-aid-extra-first',
      'nbe.firstaid.first.staff',
      'NBE First Aid First Staff',
    ],
    ['split-first-aid', 'nbe.fi-rst.aid.staff', 'NBE Fi-rst Aid Staff'],
  ].map(([slug, localPart, displayName]) =>
    parseCloudGroup(
      rawGroup(
        `synthetic-operational-ordinal-shadow-${slug}`,
        `${localPart}@groups.synthetic.invalid`,
        displayName!,
      ),
      parent,
    ),
  );
  const operationalOrdinalShadowDraft = buildDraft(
    [facilities[0]!],
    operationalOrdinalShadowGroups,
    1,
    generatedAt,
  );
  const serializedOperationalOrdinalShadowDraft = JSON.stringify(
    operationalOrdinalShadowDraft,
  );
  assertSelfTest(
    operationalOrdinalShadowDraft.inventoryGroups.length === 0 &&
      operationalOrdinalShadowDraft.report
        .omittedUnverifiedGroupIdentityCount ===
        operationalOrdinalShadowGroups.length &&
      operationalOrdinalShadowGroups.every(
        ({ googleGroupId }) =>
          !serializedOperationalOrdinalShadowDraft.includes(googleGroupId),
      ) &&
      validateDraft(operationalOrdinalShadowDraft).structuralValidationPassed,
    'operational ordinal phrases cannot mask a split, repeated, compact, or explicit population marker',
  );

  const loneSpelledCardinalGroups = SPELLED_GRADE_CARDINALS.map((cardinal) =>
    parseCloudGroup(
      rawGroup(
        `synthetic-lone-spelled-cardinal-${cardinal}`,
        `nbe.${cardinal}.staff@groups.synthetic.invalid`,
        `NBE ${cardinal} Staff`,
      ),
      parent,
    ),
  );
  const loneSpelledCardinalDraft = buildDraft(
    [facilities[0]!],
    loneSpelledCardinalGroups,
    1,
    generatedAt,
  );
  assertSelfTest(
    loneSpelledCardinalDraft.inventoryGroups.length ===
      loneSpelledCardinalGroups.length &&
      loneSpelledCardinalDraft.report.omittedUnverifiedGroupIdentityCount === 0,
    'a lone written cardinal remains reviewable unless another grade or population marker supplies scope',
  );
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...expandedPopulationGrammarDraft,
        inventoryGroups: [groupRef(expandedPopulationGrammarGroups[0]!)],
      }),
    'validation rejects reintroduction of an omitted population identity',
  );

  const shortCodeFacility = FacilitySchema.parse({
    ...facilities[0]!,
    code: 'UP',
    id: '00000000-0000-4000-8000-000000000006',
    name: 'Uplands Academy',
  });
  const shortCodeSubstringDraft = buildDraft(
    [shortCodeFacility],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-short-code-substring',
          'technology.upgrade.staff@groups.synthetic.invalid',
          'Technology Upgrade Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-short-code-compact-population',
          'synthetic.upstudentsstaff@groups.synthetic.invalid',
          'UP Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-short-code-name-corroboration',
          'synthetic.upstudentsstaff.name@groups.synthetic.invalid',
          'Uplands Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-short-code-ambiguous-word',
          'synthetic.upgradestaff@groups.synthetic.invalid',
          'UP Upgrade Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    shortCodeSubstringDraft.inventoryGroups.length === 1 &&
      shortCodeSubstringDraft.report.omittedUnverifiedGroupIdentityCount ===
        3 &&
      shortCodeSubstringDraft.buildingMappings[0]?.assessment.candidates
        .length === 0 &&
      shortCodeSubstringDraft.buildingMappings[0]?.createGroupSource === null,
    'short facility aliases omit explicit population markers and unbounded compact staff evidence without matching ordinary words',
  );

  const transFacility = FacilitySchema.parse({
    ...facilities[0]!,
    code: 'TRANS',
    id: '00000000-0000-4000-8000-000000000007',
    name: 'Transportation Center',
  });
  const facilityWordCollisionDraft = buildDraft(
    [facilities[3]!, transFacility],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-misclass-staff',
          'synthetic.misclass@groups.synthetic.invalid',
          'MIS Classified Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-transparent-staff',
          'synthetic.transparent.staff@groups.synthetic.invalid',
          'Transparent Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-trans-transparent-staff',
          'synthetic.trans.transparent.staff@groups.synthetic.invalid',
          'TRANS Transparent Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    facilityWordCollisionDraft.inventoryGroups.length === 2 &&
      facilityWordCollisionDraft.report.omittedUnverifiedGroupIdentityCount ===
        1 &&
      facilityWordCollisionDraft.buildingMappings.every(
        ({ createGroupSource }) => createGroupSource === null,
      ),
    'facility-prefix word collisions require bounded staff evidence in both fields and cannot become proposals',
  );

  const multiTokenAliasFacility = FacilitySchema.parse({
    ...facilities[0]!,
    code: 'SYN-NORTH',
    id: '00000000-0000-4000-8000-000000000008',
    name: 'North Bay Elementary',
  });
  const multiTokenAliasDraft = buildDraft(
    [multiTokenAliasFacility],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-hyphenated-code-population',
          'synthetic.synnorthstudentsstaff@groups.synthetic.invalid',
          'SYN-NORTH Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-multi-token-name-population',
          'synthetic.northbaystudentsstaff@groups.synthetic.invalid',
          'North Bay Staff',
        ),
        parent,
      ),
      parseCloudGroup(
        rawGroup(
          'synthetic-compacted-name-evidence-population',
          'synthetic.northbayparentsstaff@groups.synthetic.invalid',
          'NorthBay Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  assertSelfTest(
    multiTokenAliasDraft.inventoryGroups.length === 0 &&
      multiTokenAliasDraft.report.omittedUnverifiedGroupIdentityCount === 3 &&
      multiTokenAliasDraft.buildingMappings[0]?.assessment.candidates.length ===
        0 &&
      multiTokenAliasDraft.buildingMappings[0]?.createGroupSource === null,
    'hyphenated codes and multi-token name stems activate facility-linked quarantine aliases',
  );
  const editableValidationDraft = buildDraft(
    [],
    [
      parseCloudGroup(
        rawGroup(
          'synthetic-edited-validation',
          'synthetic.operations.staff@groups.synthetic.invalid',
          'Operations Staff',
        ),
        parent,
      ),
    ],
    1,
    generatedAt,
  );
  const editedPopulationDraft: MappingDraft = {
    ...editableValidationDraft,
    inventoryGroups: editableValidationDraft.inventoryGroups.map((group) => ({
      ...group,
      displayName: 'PSD Staff',
      email: 'synthetic.studentsandpsdteachers@groups.synthetic.invalid',
    })),
  };
  expectSelfTestThrow(
    () => validateDraft(editedPopulationDraft),
    'edited drafts cannot reintroduce a compact population group',
  );
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...editableValidationDraft,
        inventoryGroups: editableValidationDraft.inventoryGroups.map(
          (group) => ({
            ...group,
            displayName: 'Jane Doe',
            email: 'jane.doe@groups.synthetic.invalid',
          }),
        ),
      }),
    'edited drafts cannot reintroduce an identity without positive staff evidence',
  );
  expectSelfTestThrow(
    () =>
      validateDraft({
        ...editableValidationDraft,
        inventoryGroups: editableValidationDraft.inventoryGroups.map(
          (group) => ({
            ...group,
            displayName: 'NBE 学生 Staff',
          }),
        ),
      }),
    'edited drafts cannot reintroduce unsupported potentially non-staff identity metadata',
  );

  const subsetGroup = parseCloudGroup(
    rawGroup(
      'synthetic-subset',
      'synthetic.nbe.certificated.staff@groups.synthetic.invalid',
      'NBE Certificated Staff',
    ),
    parent,
  );
  const subsetDraft = buildDraft(
    [facilities[0]!],
    [subsetGroup],
    1,
    generatedAt,
  );
  assertSelfTest(
    subsetDraft.buildingMappings[0]?.assessment.outcome === 'missing' &&
      subsetDraft.buildingMappings[0]?.createGroupSource === null &&
      subsetDraft.buildingMappings[0]?.assessment.candidates.length === 0 &&
      subsetDraft.report.restrictedRoleGroups.length === 1,
    'workforce subset groups are quarantined from whole-building candidates',
  );
  const subsetMapping = subsetDraft.buildingMappings[0];
  const subsetInventoryGroup = subsetDraft.inventoryGroups[0];
  if (subsetMapping === undefined || subsetInventoryGroup === undefined) {
    throw new Error('Self-test fixture did not produce a role review finding.');
  }
  const confirmedSubsetDraft: MappingDraft = {
    ...subsetDraft,
    buildingMappings: [
      {
        ...subsetMapping,
        createGroupSource: parseGroupSourceFromDraft({
          active: true,
          displayName: subsetMapping.facility.name,
          email: subsetInventoryGroup.email,
          facilityId: subsetMapping.facility.id,
          googleGroupId: subsetInventoryGroup.googleGroupId,
          kind: 'google-group',
          purpose: 'building',
        }),
        reviewDecision: 'confirmed',
        reviewNote:
          'Synthetic human confirmation after reviewing restricted role scope.',
      },
    ],
    report: {
      ...subsetDraft.report,
      unassignedBuildingLikeGroups: [],
    },
  };
  assertSelfTest(
    validateDraft(confirmedSubsetDraft).confirmedMappingCount === 1,
    'explicit noted human confirmation may override a restricted-role heuristic',
  );

  const missingDisplayNameGroup = parseCloudGroup(
    {
      ...rawGroup(
        'synthetic-missing-display-name',
        'synthetic.nbe.staff@groups.synthetic.invalid',
        'unused',
      ),
      displayName: '',
    },
    parent,
  );
  const missingDisplayNameDraft = buildDraft(
    [facilities[0]!],
    [missingDisplayNameGroup],
    1,
    generatedAt,
  );
  assertSelfTest(
    missingDisplayNameDraft.inventoryGroups[0]?.displayName === null &&
      missingDisplayNameDraft.buildingMappings[0]?.assessment.outcome ===
        'missing' &&
      missingDisplayNameDraft.buildingMappings[0]?.createGroupSource === null &&
      missingDisplayNameDraft.report.ambiguousStaffScopeGroups.length === 1,
    'missing optional display names are inventoried and quarantined, not fatal',
  );

  const crossFieldGroup = parseCloudGroup(
    rawGroup(
      'synthetic-cross-field',
      'synthetic.bay.staff@groups.synthetic.invalid',
      'North',
    ),
    parent,
  );
  const crossFieldDraft = buildDraft(
    [facilities[0]!],
    [crossFieldGroup],
    1,
    generatedAt,
  );
  assertSelfTest(
    crossFieldDraft.buildingMappings[0]?.assessment.outcome === 'missing' &&
      crossFieldDraft.buildingMappings[0]?.createGroupSource === null,
    'exact facility evidence cannot span display-name and email fields',
  );

  const twinFacilities: Facility[] = [
    {
      ...facilities[0]!,
      code: 'TWE',
      id: '00000000-0000-4000-8000-000000000011',
      name: 'Twin Harbor Elementary',
    },
    {
      ...facilities[1]!,
      code: 'TWM',
      id: '00000000-0000-4000-8000-000000000012',
      name: 'Twin Harbor Middle',
    },
  ].map((facility) => FacilitySchema.parse(facility));
  const sharedGroup = parseCloudGroup(
    rawGroup(
      'synthetic-twin',
      'twin.harbor.staff@groups.synthetic.invalid',
      'Twin Harbor Staff',
    ),
    parent,
  );
  const collisionDraft = buildDraft(
    twinFacilities,
    [sharedGroup],
    1,
    generatedAt,
  );
  assertSelfTest(
    collisionDraft.buildingMappings.every(
      ({ assessment, createGroupSource }) =>
        assessment.outcome === 'uncertain' && createGroupSource === null,
    ),
    'one group matching multiple facilities is never proposed',
  );

  const tamperedEnvelope = structuredClone(draft) as unknown as JsonObject;
  tamperedEnvelope.importAuthorized = true;
  expectSelfTestThrow(
    () => validateDraft(tamperedEnvelope),
    'an edited draft cannot grant import authority',
  );
  const duplicateConfirmed = structuredClone(draft);
  const matchedMappings = duplicateConfirmed.buildingMappings.filter(
    ({ createGroupSource }) => createGroupSource !== null,
  );
  const firstSource = matchedMappings[0]?.createGroupSource;
  const secondMapping = matchedMappings[1];
  if (
    firstSource === null ||
    firstSource === undefined ||
    secondMapping === undefined
  ) {
    throw new Error('Self-test fixture did not produce two mappings.');
  }
  secondMapping.createGroupSource = {
    ...firstSource,
    displayName: secondMapping.facility.name,
    facilityId: secondMapping.facility.id,
  };
  secondMapping.reviewDecision = 'confirmed';
  secondMapping.reviewNote = 'Synthetic duplicate selection for validation.';
  expectSelfTestThrow(
    () => validateDraft(duplicateConfirmed),
    'confirmed mappings cannot reuse a group',
  );

  const missingConfirmationNote = structuredClone(draft);
  const proposedMapping = missingConfirmationNote.buildingMappings.find(
    ({ createGroupSource }) => createGroupSource !== null,
  );
  if (proposedMapping === undefined) {
    throw new Error('Self-test fixture did not produce a proposed mapping.');
  }
  proposedMapping.reviewDecision = 'confirmed';
  expectSelfTestThrow(
    () => validateDraft(missingConfirmationNote),
    'confirmed mappings require a review note',
  );

  const tamperedPendingProposal = structuredClone(draft);
  const pendingProposal = tamperedPendingProposal.buildingMappings.find(
    ({ createGroupSource }) => createGroupSource !== null,
  );
  const unrelatedGroup = tamperedPendingProposal.inventoryGroups.find(
    ({ email }) =>
      email === 'synthetic.operations.staff@groups.synthetic.invalid',
  );
  if (
    pendingProposal === undefined ||
    pendingProposal.createGroupSource === null ||
    unrelatedGroup === undefined
  ) {
    throw new Error(
      'Self-test fixture lacks a pending proposal or spare group.',
    );
  }
  pendingProposal.createGroupSource = {
    ...pendingProposal.createGroupSource,
    email: unrelatedGroup.email,
    googleGroupId: unrelatedGroup.googleGroupId,
  };
  expectSelfTestThrow(
    () => validateDraft(tamperedPendingProposal),
    'pending proposals cannot silently replace the generated top candidate',
  );

  const structurallyResolved = structuredClone(draft);
  for (const mapping of structurallyResolved.buildingMappings) {
    mapping.reviewDecision =
      mapping.createGroupSource === null
        ? 'intentionally-unmapped'
        : 'confirmed';
    mapping.reviewNote = 'Synthetic structural-review decision.';
  }
  for (const neighborhood of structurallyResolved.neighborhoodProposals) {
    neighborhood.reviewDecision = 'rejected';
    neighborhood.reviewNote = 'Synthetic structural-review decision.';
  }
  const resolvedValidation = validateDraft(structurallyResolved);
  assertSelfTest(
    resolvedValidation.allReviewFieldsStructurallyResolved &&
      resolvedValidation.unresolvedFindingCount > 0 &&
      !resolvedValidation.canonicalSourcesReverified &&
      !resolvedValidation.importAuthorized,
    'resolved JSON fields still do not prove trusted review or permit import',
  );

  assertSelfTest(
    parseCli(['self-test']).command === 'self-test',
    'self-test CLI parses',
  );
  expectSelfTestThrow(
    () => parseCli(['inventory', '--apply', 'yes']),
    'apply and unknown CLI flags do not exist',
  );
  const ioDirectory = await mkdtemp(
    join(tmpdir(), 'psd-eoc-groups-self-test-'),
  );
  await chmod(ioDirectory, 0o700);
  try {
    const isolatedGcloudConfigPath =
      await createIsolatedGcloudConfigPath(ioDirectory);
    const isolatedGcloudConfigMetadata = await stat(isolatedGcloudConfigPath);
    assertSelfTest(
      dirname(isolatedGcloudConfigPath) === (await realpath(ioDirectory)) &&
        isolatedGcloudConfigMetadata.isDirectory() &&
        (isolatedGcloudConfigMetadata.mode & 0o777) === 0o700,
      'gcloud configuration uses a private directory beneath the verified temporary root',
    );

    const unsafeTemporaryRoot = await mkdtemp(
      join(ioDirectory, 'unsafe-temporary-root-'),
    );
    await chmod(unsafeTemporaryRoot, 0o777);
    await expectSelfTestReject(
      () => createIsolatedGcloudConfigPath(unsafeTemporaryRoot),
      'a non-sticky temporary root writable by another principal is refused before gcloud state is created',
    );

    const privateInputPath = join(ioDirectory, 'synthetic-input.json');
    const privateInput = await open(privateInputPath, 'wx', 0o600);
    try {
      await privateInput.writeFile('{"synthetic":true}\n', 'utf8');
    } finally {
      await privateInput.close();
    }
    const privateInputValue = await readPrivateJson(
      privateInputPath,
      'Self-test private input',
      MAX_FACILITY_INPUT_BYTES,
    );
    assertSelfTest(
      isRecord(privateInputValue) && privateInputValue.synthetic === true,
      'private JSON is validated and read from one bounded file handle',
    );

    const fifoInputPath = join(ioDirectory, 'synthetic-input.fifo');
    const fifoCreation = Bun.spawnSync(['mkfifo', fifoInputPath], {
      stderr: 'pipe',
      stdout: 'pipe',
    });
    assertSelfTest(
      fifoCreation.exitCode === 0,
      'self-test can create a synthetic FIFO input',
    );
    await chmod(fifoInputPath, 0o600);
    const fifoValidation = Bun.spawn(
      [Bun.argv[0]!, import.meta.path, 'validate', '--draft', fifoInputPath],
      {
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'ignore',
      },
    );
    const fifoDiagnostic = readBoundedStream(
      fifoValidation.stderr,
      16_000,
      'Self-test FIFO diagnostic',
    );
    const fifoValidationCompletion = await Promise.race([
      fifoValidation.exited.then((exitCode) => ({ exitCode, timedOut: false })),
      Bun.sleep(2_000).then(() => ({ exitCode: null, timedOut: true })),
    ]);
    if (fifoValidationCompletion.timedOut) {
      fifoValidation.kill(9);
      await fifoValidation.exited;
    }
    const fifoDiagnosticText = await fifoDiagnostic;
    assertSelfTest(
      !fifoValidationCompletion.timedOut &&
        fifoValidationCompletion.exitCode !== 0 &&
        fifoDiagnosticText.includes(
          'Mapping draft must be a regular file within its size limit.',
        ),
      'non-regular private inputs are rejected before a blocking open',
    );

    const privateOutputPath = join(ioDirectory, 'groups-mapping.draft.json');
    await writePrivateDraft(privateOutputPath, draft);
    const outputMetadata = await stat(privateOutputPath);
    const writtenDraft = await readPrivateJson(
      privateOutputPath,
      'Self-test private output',
      MAX_DRAFT_FILE_BYTES,
    );
    assertSelfTest(
      (outputMetadata.mode & 0o777) === 0o600 &&
        validateDraft(writtenDraft).structuralValidationPassed,
      'draft output is private, complete, and structurally valid',
    );
    await expectSelfTestReject(
      () => writePrivateDraft(privateOutputPath, draft),
      'draft output never overwrites an existing file',
    );

    const syntheticGitRoot = await mkdtemp(
      join(ioDirectory, 'synthetic-git-worktree-'),
    );
    await chmod(syntheticGitRoot, 0o700);
    const syntheticGitMarker = await open(
      join(syntheticGitRoot, '.git'),
      'wx',
      0o600,
    );
    await syntheticGitMarker.close();
    const syntheticGitInputPath = join(syntheticGitRoot, 'input.json');
    const syntheticGitInput = await open(syntheticGitInputPath, 'wx', 0o600);
    try {
      await syntheticGitInput.writeFile('{"synthetic":true}\n', 'utf8');
    } finally {
      await syntheticGitInput.close();
    }
    await expectSelfTestReject(
      () =>
        readPrivateJson(
          syntheticGitInputPath,
          'Self-test Git-contained input',
          MAX_FACILITY_INPUT_BYTES,
        ),
      'operational inputs in any Git worktree are refused',
    );
    await expectSelfTestReject(
      () => createIsolatedGcloudConfigPath(syntheticGitRoot),
      'a caller-controlled in-repository temporary root is refused before gcloud state is created',
    );
  } finally {
    await rm(ioDirectory, { force: true, recursive: true });
  }
};

const main = async (arguments_: readonly string[]): Promise<void> => {
  if (arguments_.includes('--help')) {
    console.log(usage);
    return;
  }
  const options = parseCli(arguments_);
  if (options.command === 'self-test') {
    await runSelfTest();
    console.log('groups-inventory self-test: passed');
    return;
  }
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
