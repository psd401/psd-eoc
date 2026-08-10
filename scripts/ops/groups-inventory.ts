import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { exit as exitProcess } from 'node:process';

import {
  CreateGroupSourceInputSchema,
  CreateNeighborhoodVersionInputSchema,
  FacilityPageSchema,
  FacilitySchema,
  type CreateGroupSourceInput,
  type CreateNeighborhoodVersionInput,
  type Facility,
} from '@psd-eoc/contracts';

const CLOUD_IDENTITY_ORIGIN = 'https://cloudidentity.googleapis.com';
const CLOUD_IDENTITY_SCOPE =
  'https://www.googleapis.com/auth/cloud-identity.groups.readonly';
const MAX_FACILITY_INPUT_BYTES = 5_000_000;
// A bounded 20,000-group inventory can repeat safe group references in the
// inventory, candidate, staleness, and unassigned sections. Keep draft reads
// and writes aligned at a limit that accommodates that worst-case shape.
const MAX_DRAFT_FILE_BYTES = 128_000_000;
const MAX_RESPONSE_BYTES = 8_000_000;
const FILE_READ_CHUNK_BYTES = 64 * 1_024;
const MAX_PAGES = 100;
const MAX_GROUPS = 20_000;
const MAX_FACILITIES = 1_000;

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
  'kid',
  'kids',
  'learner',
  'learners',
  'parent',
  'parents',
  'pta',
  'pto',
  'pupil',
  'pupils',
  'scholar',
  'scholars',
  'student',
  'students',
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
  'janitor',
  'janitors',
  'nurse',
  'nurses',
  'office',
  'para',
  'paraeducator',
  'paraeducators',
  'principal',
  'principals',
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

const WEAK_NEIGHBORHOOD_STEMS = new Set([
  'central',
  'east',
  'north',
  'south',
  'west',
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
  readonly heuristicStrength: 'low';
  readonly reasonCodes: readonly string[];
  reviewDecision: ReviewDecision;
  reviewNote: string | null;
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
    readonly missingFacilityIds: readonly string[];
    readonly uncertainFacilityIds: readonly string[];
    readonly potentiallyStaleGroups: readonly PotentiallyStaleGroup[];
    readonly duplicateGroupProposals: readonly {
      readonly group: DraftGroupRef;
      readonly facilityIds: readonly string[];
    }[];
    readonly unassignedBuildingLikeGroups: readonly DraftGroupRef[];
    readonly omittedNonStaffGroupCount: number;
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
  const timestamp = requireString(value, label, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      timestamp,
    ) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw new Error(`${label} must be an absolute timestamp.`);
  }
  return timestamp;
};

const isPsdGroupEmail = (value: string): boolean =>
  value.length <= 75 &&
  /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@psd401\.net$/u.test(value);

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
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/&/gu, ' and ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');

const tokensOf = (value: string): readonly string[] => {
  const normalized = normalizeText(value);
  return normalized === '' ? [] : normalized.split(' ');
};

const hasAnyToken = (
  tokens: readonly string[],
  choices: ReadonlySet<string>,
): boolean => tokens.some((token) => choices.has(token));

const NON_STAFF_SUBSTRING_EXCEPTIONS = new Set([
  // `classified` is a staff subset and must stay visible as uncertain rather
  // than being omitted as though it were a student/family population.
  'class',
]);

const COMPACT_NON_STAFF_MARKERS = [...NON_STAFF_MARKERS].filter(
  (marker) => !NON_STAFF_SUBSTRING_EXCEPTIONS.has(marker),
);

const COMPACT_WORD_BOUNDARIES = [
  'all',
  'employee',
  'employees',
  'group',
  'groups',
  'list',
  'lists',
  'member',
  'members',
  'staff',
  'team',
] as const;

const hasBoundedCompactPopulationMarker = (token: string): boolean =>
  COMPACT_NON_STAFF_MARKERS.some(
    (marker) =>
      token.length > marker.length &&
      (token.startsWith(marker) ||
        token.endsWith(marker) ||
        COMPACT_WORD_BOUNDARIES.some(
          (boundary) =>
            token.includes(`${boundary}${marker}`) ||
            token.includes(`${marker}${boundary}`),
        )),
  );

const hasNonStaffPopulationMarker = (tokens: readonly string[]): boolean =>
  hasAnyToken(tokens, NON_STAFF_MARKERS) ||
  tokens.some(
    (token) =>
      /^(?:class|classroom|cohort|grade)[0-9]{1,2}$/u.test(token) ||
      /^[0-9]{1,2}(?:st|nd|rd|th)?grade$/u.test(token) ||
      /^(?:k[0-9]{1,2}|kindergarten|prek|prekindergarten)$/u.test(token) ||
      hasBoundedCompactPopulationMarker(token),
  ) ||
  tokens.some(
    (token, index) =>
      (token === 'pre' &&
        (tokens[index + 1] === 'k' || tokens[index + 1] === 'kindergarten')) ||
      ((token === 'grade' || token === 'class' || token === 'cohort') &&
        /^[0-9]{1,2}$/u.test(tokens[index + 1] ?? '')) ||
      (/^[0-9]{1,2}$/u.test(token) && tokens[index + 1] === 'grade'),
  );

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

const groupTokens = (group: CloudGroup): readonly string[] =>
  groupTokenFields(group).combined;

const hasNonStaffGroupMarker = (group: CloudGroup): boolean => {
  const tokenFields = groupTokenFields(group);
  return (
    hasNonStaffPopulationMarker(tokenFields.displayName) ||
    hasNonStaffPopulationMarker(tokenFields.localPart)
  );
};

const groupRef = (group: CloudGroup): DraftGroupRef => ({
  displayName: group.displayName,
  email: group.email,
  googleGroupId: group.googleGroupId,
});

const parseCloudGroup = (
  value: unknown,
  expectedParent: string,
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
  if (!isPsdGroupEmail(email)) {
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

const parseGroupPage = (value: unknown, expectedParent: string): GroupPage => {
  if (!isRecord(value)) {
    throw new Error('Google returned a malformed groups page.');
  }
  const rawGroups = value.groups === undefined ? [] : value.groups;
  if (!Array.isArray(rawGroups)) {
    throw new Error('Google returned a malformed groups page.');
  }
  const groups = rawGroups.map((group) =>
    parseCloudGroup(group, expectedParent),
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
        await reader.cancel();
        throw new Error(`${label} exceeded its size limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
};

const readBoundedResponseJson = async (
  response: Response,
): Promise<unknown> => {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
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
        await response.body?.cancel();
        await Bun.sleep(attempt * 500);
        continue;
      }
      await response.body?.cancel();
      throw new Error(
        `The read-only Google Groups request failed with HTTP ${response.status}.`,
      );
    }
    throw new Error(
      'The read-only Google Groups request exhausted its retries.',
    );
  };

const gcloudTokenArguments = (serviceAccount: string): string[] => [
  'gcloud',
  'auth',
  'application-default',
  'print-access-token',
  `--impersonate-service-account=${serviceAccount}`,
  `--scopes=${CLOUD_IDENTITY_SCOPE}`,
  '--lifetime=900s',
  '--quiet',
];

const obtainImpersonatedToken = async (
  serviceAccount: string,
): Promise<string> => {
  const subprocess = Bun.spawn(gcloudTokenArguments(serviceAccount), {
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
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
};

interface ScoredGroup {
  readonly group: CloudGroup;
  readonly score: number;
  readonly reasonCodes: readonly string[];
  readonly strongEligible: boolean;
}

const hasDistinctiveStem = (tokens: readonly string[]): boolean =>
  tokens.length >= 2 ||
  (tokens.length === 1 &&
    (tokens[0]?.length ?? 0) >= 6 &&
    !WEAK_NEIGHBORHOOD_STEMS.has(tokens[0] ?? ''));

const scoreGroupForFacility = (
  facility: Facility,
  group: CloudGroup,
): ScoredGroup => {
  const tokenFields = groupTokenFields(group);
  const tokens = tokenFields.combined;
  const codeTokens = tokensOf(facility.code);
  const stemTokens = facilityStemTokens(facility);
  const codeIsDistinctive =
    normalizeText(facility.code).replace(/ /gu, '').length >= 3;
  const exactCode =
    codeIsDistinctive &&
    (containsSequence(tokenFields.displayName, codeTokens) ||
      containsSequence(tokenFields.localPart, codeTokens));
  const exactStem =
    hasDistinctiveStem(stemTokens) &&
    (containsSequence(tokenFields.displayName, stemTokens) ||
      containsSequence(tokenFields.localPart, stemTokens));
  const broadStaff = hasAnyToken(tokens, STAFF_MARKERS);
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
      (exactCode || exactStem) &&
      !narrowRole &&
      !staleMarker &&
      group.displayName !== null,
  };
};

const compareScoredGroups = (left: ScoredGroup, right: ScoredGroup): number =>
  right.score - left.score ||
  compareText(left.group.email, right.group.email) ||
  compareText(left.group.googleGroupId, right.group.googleGroupId);

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
): readonly NeighborhoodProposal[] => {
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
  for (const [stem, members] of [...byStem.entries()].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    if (members.length < 2) continue;
    const name = `${stem
      .split(' ')
      .map((token) => `${token.slice(0, 1).toUpperCase()}${token.slice(1)}`)
      .join(' ')} neighborhood`;
    const createNeighborhoodVersion =
      CreateNeighborhoodVersionInputSchema.parse({
        facilityIds: members.map(({ id }) => id).sort(compareText),
        name,
        neighborhoodId: null,
      });
    proposals.push({
      createNeighborhoodVersion,
      heuristicStrength: 'low',
      reasonCodes: [
        'NAME_ONLY_HINT',
        'NO_GEOGRAPHY_EVIDENCE',
        'SHARED_EXACT_NAME_STEM',
      ],
      reviewDecision: 'pending',
      reviewNote: null,
    });
  }
  return proposals;
};

const buildDraft = (
  facilitiesInput: readonly Facility[],
  groupsInput: readonly CloudGroup[],
  pageCount: number,
  generatedAt: string,
): MappingDraft => {
  requireAbsoluteTimestamp(generatedAt, 'Draft generation time');
  const facilities = [...facilitiesInput].sort(
    (left, right) =>
      compareText(left.code, right.code) || compareText(left.id, right.id),
  );
  const groups = [...groupsInput].sort(
    (left, right) =>
      compareText(left.email, right.email) ||
      compareText(left.googleGroupId, right.googleGroupId),
  );
  const excluded = new Set(
    groups
      .filter(hasNonStaffGroupMarker)
      .map(({ googleGroupId }) => googleGroupId),
  );
  const eligibleGroups = groups.filter(
    ({ googleGroupId }) => !excluded.has(googleGroupId),
  );
  const scoresByFacility = new Map<string, readonly ScoredGroup[]>();
  for (const facility of facilities) {
    scoresByFacility.set(
      facility.id,
      eligibleGroups
        .map((group) => scoreGroupForFacility(facility, group))
        .filter(({ score }) => score >= 90)
        .sort(compareScoredGroups),
    );
  }

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
      const reverseScores = facilities
        .map((candidateFacility) => ({
          facility: candidateFacility,
          scored: scoreGroupForFacility(candidateFacility, best.group),
        }))
        .sort(
          (left, right) =>
            right.scored.score - left.scored.score ||
            compareText(left.facility.id, right.facility.id),
        );
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
    const reasons: string[] = [];
    if (hasAnyToken(groupTokens(group), STALE_MARKERS)) {
      reasons.push('GROUP_HAS_STALE_NAME_MARKER');
    }
    const inactiveExactMatch = facilities.some((facility) => {
      if (facility.active) return false;
      const scored = scoreGroupForFacility(facility, group);
      return scored.score >= 90;
    });
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
    .filter(
      (group) =>
        hasAnyToken(groupTokens(group), STAFF_MARKERS) &&
        !selectedGroupIds.has(group.googleGroupId),
    )
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
  const neighborhoodProposals = createNeighborhoodProposals(facilities);

  return {
    buildingMappings: mappings,
    generatedAt,
    importAuthorized: false,
    inventoryGroups: eligibleGroups.map(groupRef),
    kind: 'psd-eoc.google-groups-mapping-draft',
    neighborhoodProposals,
    report: {
      duplicateGroupProposals: duplicateGroupProposals.sort((left, right) =>
        compareText(left.group.email, right.group.email),
      ),
      missingFacilityIds,
      omittedNonStaffGroupCount: excluded.size,
      potentiallyStaleGroups: [...potentiallyStale.values()].sort(
        (left, right) => compareText(left.email, right.email),
      ),
      unassignedBuildingLikeGroups,
      uncertainFacilityIds,
      warnings: [
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

const readPrivateJson = async (
  path: string,
  label: string,
  maximumBytes: number,
): Promise<unknown> => {
  const safePath = await requirePathOutsideGitRepository(path, label);
  const handle = await open(
    safePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let text: string;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) {
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
  const directory = await mkdtemp(join(tmpdir(), 'psd-eoc-groups-'));
  await chmod(directory, 0o700);
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

const parseDraftGroupRef = (value: unknown, label: string): DraftGroupRef => {
  if (!isRecord(value)) throw new Error(`${label} must be a group reference.`);
  assertExactKeys(value, ['displayName', 'email', 'googleGroupId'], label);
  const googleGroupId = requireString(value.googleGroupId, label, 255);
  const email = requireString(value.email, label, 320).toLocaleLowerCase(
    'en-US',
  );
  if (
    !/^groups\/[A-Za-z0-9_-]{1,248}$/u.test(googleGroupId) ||
    !isPsdGroupEmail(email)
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

const parseCandidate = (value: unknown): MatchCandidate => {
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

const parseAssessment = (value: unknown): BuildingMapping['assessment'] => {
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
  const candidates = value.candidates.map(parseCandidate);
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

const validateDraft = (value: unknown): ValidationSummary => {
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
  requireAbsoluteTimestamp(value.generatedAt, 'Draft generation time');
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

  if (!Array.isArray(value.inventoryGroups)) {
    throw new Error('Draft group inventory is malformed.');
  }
  const inventoryGroups = value.inventoryGroups.map((group) =>
    parseDraftGroupRef(group, 'Draft inventory group'),
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
    if (hasNonStaffGroupMarker(group)) {
      throw new Error('Draft inventory contains an excluded population group.');
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
    if (facilityIds.has(facility.id) || facilityCodes.has(facility.code)) {
      throw new Error('Draft repeats a facility identity.');
    }
    facilityIds.add(facility.id);
    facilityCodes.add(facility.code);
    const decision = parseReviewDecision(rawMapping.reviewDecision);
    const reviewNote = parseReviewNote(rawMapping.reviewNote);
    const assessment = parseAssessment(rawMapping.assessment);
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

  if (
    !Array.isArray(value.neighborhoodProposals) ||
    value.neighborhoodProposals.length > MAX_FACILITIES
  ) {
    throw new Error('Draft neighborhood proposals are malformed.');
  }
  const neighborhoods: NeighborhoodProposal[] = [];
  const confirmedNeighborhoodFacilities = new Set<string>();
  for (const rawProposal of value.neighborhoodProposals) {
    if (!isRecord(rawProposal)) {
      throw new Error('Draft neighborhood proposal is malformed.');
    }
    assertExactKeys(
      rawProposal,
      [
        'createNeighborhoodVersion',
        'heuristicStrength',
        'reasonCodes',
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
    if (decision === 'confirmed') {
      for (const facilityId of createNeighborhoodVersion.facilityIds) {
        if (confirmedNeighborhoodFacilities.has(facilityId)) {
          throw new Error('A facility is confirmed in multiple neighborhoods.');
        }
        confirmedNeighborhoodFacilities.add(facilityId);
      }
    }
    if (rawProposal.heuristicStrength !== 'low') {
      throw new Error('Draft neighborhood heuristic strength is invalid.');
    }
    neighborhoods.push({
      createNeighborhoodVersion,
      heuristicStrength: rawProposal.heuristicStrength,
      reasonCodes: parseReasonCodes(
        rawProposal.reasonCodes,
        'Draft neighborhood reasons',
      ),
      reviewDecision: decision,
      reviewNote,
    });
  }

  if (!isRecord(value.report)) throw new Error('Draft report is malformed.');
  assertExactKeys(
    value.report,
    [
      'duplicateGroupProposals',
      'missingFacilityIds',
      'omittedNonStaffGroupCount',
      'potentiallyStaleGroups',
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
    const groups = raw.map((group) => parseDraftGroupRef(group, label));
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
  if (!Array.isArray(value.report.potentiallyStaleGroups)) {
    throw new Error('Draft potential-staleness report is malformed.');
  }
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
    );
    const inventoryGroup = inventoryById.get(staleGroup.googleGroupId);
    const reasons = parseReasonCodes(
      rawStale.reasonCodes,
      'Draft potential-staleness reasons',
    );
    if (
      inventoryGroup === undefined ||
      !sameGroupRef(staleGroup, inventoryGroup) ||
      staleIds.has(staleGroup.googleGroupId) ||
      !reasons.includes('HEURISTIC_NOT_STALENESS_PROOF')
    ) {
      throw new Error('Draft potential-staleness entry overstates evidence.');
    }
    staleIds.add(staleGroup.googleGroupId);
  }
  if (!Array.isArray(value.report.duplicateGroupProposals)) {
    throw new Error('Draft duplicate-group report is malformed.');
  }
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
    );
    const inventoryGroup = inventoryById.get(group.googleGroupId);
    if (inventoryGroup === undefined || !sameGroupRef(group, inventoryGroup)) {
      throw new Error('Draft duplicate-group entry is outside the inventory.');
    }
    const duplicateFacilityIds = parseFacilityIdList(
      rawDuplicate.facilityIds,
      facilityIds,
      'Draft duplicate-group facilities',
    );
    if (duplicateFacilityIds.length < 2) {
      throw new Error('Draft duplicate-group entry needs multiple facilities.');
    }
  }
  const omittedNonStaffGroupCount = requireInteger(
    value.report.omittedNonStaffGroupCount,
    'Draft omitted-group count',
    MAX_GROUPS,
  );
  if (sourceGroupCount !== inventoryGroups.length + omittedNonStaffGroupCount) {
    throw new Error('Draft total group count is internally inconsistent.');
  }
  const warnings = parseReasonCodes(value.report.warnings, 'Draft warnings');
  for (const requiredWarning of [
    'AUTHORIZATION_COVERAGE_NOT_VERIFIED',
    'GROUP_MEMBERSHIP_AND_STAFF_POPULATION_NOT_FETCHED',
    'NO_GEOGRAPHY_HINTS_AVAILABLE',
  ]) {
    if (!warnings.includes(requiredWarning)) {
      throw new Error('Draft omits a required evidence warning.');
    }
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
  const unresolvedFindingCount =
    missingFacilityIds.length +
    uncertainFacilityIds.length +
    unassigned.length +
    staleIds.size +
    value.report.duplicateGroupProposals.length;
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
  - Inputs and output must be outside Git and private (0600). Output never
    overwrites an existing file. Omitting --output creates a private random
    temporary directory.
  - A human must first run gcloud auth application-default login and receive
    Service Account Token Creator on the read-only service account.
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
      code: 'EVE',
      createdAt: generatedAt,
      id: '00000000-0000-4000-8000-000000000003',
      name: 'Evergreen Elementary',
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
    rawGroup('synthetic-nbe', 'synthetic.nbe.staff@psd401.net', 'NBE Staff'),
    rawGroup('synthetic-nbm', 'synthetic.nbm.staff@psd401.net', 'NBM Staff'),
    rawGroup(
      'synthetic-evergreen-a',
      'synthetic.evergreen.a@psd401.net',
      'Evergreen Staff A',
    ),
    rawGroup(
      'synthetic-evergreen-b',
      'synthetic.evergreen.b@psd401.net',
      'Evergreen Staff B',
    ),
    rawGroup(
      'synthetic-legacy',
      'synthetic.legacy.staff@psd401.net',
      'Legacy Staff Archived',
    ),
    rawGroup(
      'synthetic-operations',
      'synthetic.operations.staff@psd401.net',
      'Operations Staff',
    ),
    rawGroup(
      'synthetic-excluded-population',
      'synthetic.nbe.students@psd401.net',
      'NBE Staff and Students',
    ),
  ];
  const groups = rawGroups.map((group) => parseCloudGroup(group, parent));

  let pageCalls = 0;
  const paginated = await inventoryAllGroups(async (pageToken) => {
    pageCalls += 1;
    if (pageToken === null) {
      return { groups: [rawGroups[0]], nextPageToken: 'page-two' };
    }
    assertSelfTest(
      pageToken === 'page-two',
      'pagination passed the exact token',
    );
    return { groups: [rawGroups[1]] };
  }, 'C1234567');
  assertSelfTest(
    paginated.pageCount === 2 &&
      paginated.groups.length === 2 &&
      pageCalls === 2,
    'all group pages are read',
  );
  const emptyInventory = await inventoryAllGroups(async () => ({}), 'C1234567');
  assertSelfTest(
    emptyInventory.groups.length === 0 && emptyInventory.pageCount === 1,
    'an omitted empty repeated field is a complete empty inventory',
  );
  await expectSelfTestReject(
    () =>
      inventoryAllGroups(
        async () => ({ groups: [], nextPageToken: 'repeat' }),
        'C1234567',
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
      ),
    'cross-customer groups fail closed',
  );
  await expectSelfTestReject(
    () =>
      inventoryAllGroups(
        async () => ({ groups: [rawGroups[0], rawGroups[0]] }),
        'C1234567',
      ),
    'duplicate provider identity fails closed',
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
  const tokenArguments = gcloudTokenArguments(
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
      !tokenArguments.some((argument) => argument.includes('delegat')),
    'gcloud uses short-lived read-only impersonation without delegation',
  );
  expectSelfTestThrow(
    () =>
      parseCloudGroup(
        rawGroup(
          'synthetic-format-control',
          'synthetic.nbe.staff@psd401.net',
          'NBE Stu\u200bdents Staff',
        ),
        parent,
      ),
    'Unicode format controls in group names fail closed',
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

  const draft = buildDraft(facilities, groups, 2, generatedAt);
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
    draft.report.omittedNonStaffGroupCount === 1,
    'student-marked groups are hard excluded',
  );
  const serialized = JSON.stringify(draft);
  assertSelfTest(
    !serialized.includes('synthetic-excluded-population') &&
      !serialized.includes('synthetic.nbe.students@psd401.net'),
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
  const evergreen = draft.buildingMappings.find(
    ({ facility }) => facility.code === 'EVE',
  );
  assertSelfTest(
    evergreen?.assessment.outcome === 'uncertain' &&
      evergreen.createGroupSource === null &&
      evergreen.assessment.reasonCodes.includes('CLOSE_OR_TIED_CANDIDATES'),
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
      draft.neighborhoodProposals[0]?.reasonCodes.includes(
        'NO_GEOGRAPHY_EVIDENCE',
      ) === true,
    'shared exact stems only produce name-only neighborhood hints',
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
      'synthetic.missing.staff.students@psd401.net',
      'MIS Staff Students',
    ),
    parent,
  );
  const mixedDraft = buildDraft(facilities, [studentStaff], 1, generatedAt);
  assertSelfTest(
    mixedDraft.inventoryGroups.length === 0 &&
      mixedDraft.report.omittedNonStaffGroupCount === 1,
    'non-staff markers override staff markers',
  );

  const compactStudentStaff = parseCloudGroup(
    rawGroup(
      'synthetic-compact-population',
      'synthetic.nbe.allstudentsstaff@psd401.net',
      'NBE Staff',
    ),
    parent,
  );
  const compactScholarStaff = parseCloudGroup(
    rawGroup(
      'synthetic-compact-scholar-population',
      'synthetic.nbe.allscholarsstaff@psd401.net',
      'NBE Staff',
    ),
    parent,
  );
  const compactPtaStaff = parseCloudGroup(
    rawGroup(
      'synthetic-compact-pta-population',
      'synthetic.nbe.allptastaff@psd401.net',
      'NBE Staff',
    ),
    parent,
  );
  const compactPopulationDraft = buildDraft(
    [facilities[0]!],
    [compactStudentStaff, compactScholarStaff, compactPtaStaff],
    1,
    generatedAt,
  );
  assertSelfTest(
    compactPopulationDraft.inventoryGroups.length === 0 &&
      compactPopulationDraft.report.omittedNonStaffGroupCount === 3,
    'bounded compact population markers are hard excluded',
  );

  const legitimateSubstringGroups = [
    rawGroup(
      'synthetic-laptop-staff',
      'synthetic.nbe.laptop.staff@psd401.net',
      'NBE Laptop Staff',
    ),
    rawGroup(
      'synthetic-captains-staff',
      'synthetic.nbe.captains.staff@psd401.net',
      'NBE Captains Staff',
    ),
    rawGroup(
      'synthetic-skidmore-staff',
      'synthetic.nbe.skidmore.staff@psd401.net',
      'NBE Skidmore Staff',
    ),
  ].map((group) => parseCloudGroup(group, parent));
  const legitimateSubstringDraft = buildDraft(
    [facilities[0]!],
    legitimateSubstringGroups,
    1,
    generatedAt,
  );
  assertSelfTest(
    legitimateSubstringDraft.inventoryGroups.length === 3 &&
      legitimateSubstringDraft.report.omittedNonStaffGroupCount === 0,
    'incidental pta, pto, and kid substrings never hide staff groups',
  );

  const subsetGroup = parseCloudGroup(
    rawGroup(
      'synthetic-subset',
      'synthetic.nbe.certificated.staff@psd401.net',
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
    subsetDraft.buildingMappings[0]?.assessment.outcome === 'uncertain' &&
      subsetDraft.buildingMappings[0]?.createGroupSource === null &&
      subsetDraft.buildingMappings[0]?.assessment.reasonCodes.includes(
        'NO_SAFE_BROAD_STAFF_MATCH',
      ) === true,
    'workforce subset groups are never proposed as whole-building rosters',
  );

  const missingDisplayNameGroup = parseCloudGroup(
    {
      ...rawGroup(
        'synthetic-missing-display-name',
        'synthetic.nbe.staff@psd401.net',
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
        'uncertain' &&
      missingDisplayNameDraft.buildingMappings[0]?.createGroupSource === null &&
      missingDisplayNameDraft.buildingMappings[0]?.assessment.reasonCodes.includes(
        'MISSING_GROUP_DISPLAY_NAME',
      ) === true,
    'missing optional display names are inventoried and flagged, not fatal',
  );

  const crossFieldGroup = parseCloudGroup(
    rawGroup(
      'synthetic-cross-field',
      'synthetic.bay.staff@psd401.net',
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
      'synthetic.twin.harbor.staff@psd401.net',
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
    ({ email }) => email === 'synthetic.operations.staff@psd401.net',
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
  } finally {
    await rm(ioDirectory, { force: true, recursive: true });
  }
  await expectSelfTestReject(
    () => requirePathOutsideGitRepository(import.meta.path, 'Self-test input'),
    'operational inputs in any Git worktree are refused',
  );
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
        buildingMappingCount: draft.buildingMappings.length,
        groupCount: draft.source.groupCount,
        missingFacilityCount: draft.report.missingFacilityIds.length,
        neighborhoodProposalCount: draft.neighborhoodProposals.length,
        omittedNonStaffGroupCount: draft.report.omittedNonStaffGroupCount,
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
