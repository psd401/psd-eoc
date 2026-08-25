import { type Facility } from '@psd-eoc/contracts';

import {
  NON_STAFF_MARKERS,
  SHORT_GRADE_POPULATION_MARKERS,
  SPELLED_GRADE_CARDINALS,
  SPELLED_GRADE_ORDINALS,
  SPELLED_GRADE_ORDINAL_MARKERS,
  EXPLICIT_NUMERIC_GRADE_RANGE_PATTERN,
  OPERATIONAL_ORDINAL_SAFE_PHRASES,
  OPERATIONAL_K_SAFE_WORDS,
  POPULATION_DESCRIPTOR_MARKERS,
  STAFF_MARKERS,
  NARROW_ROLE_MARKERS,
  STALE_MARKERS,
  FACILITY_GENERIC_MARKERS,
  AGGREGATE_FACILITY_NAME_MARKERS,
  DISQUALIFYING_AGGREGATE_FACILITY_NAME_MARKERS,
  GENERIC_AUTOMATIC_FACILITY_CODE_ALIASES,
  WEAK_NEIGHBORHOOD_STEMS,
  AUTOMATIC_PHYSICAL_SITE_TYPE_MARKERS,
  type CloudGroup,
  type DraftGroupRef,
  compareText,
  sortedUnique,
  normalizeText,
} from './groups-inventory-model';
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

export const tokensOf = (value: string): readonly string[] => {
  const normalized = normalizeText(value);
  return normalized === '' ? [] : normalized.split(' ');
};

export const hasAnyToken = (
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

export const DEFAULT_ORGANIZATION_PREFIXES = ['district'] as const;
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

export const containsSequence = (
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

export const facilityStemTokens = (facility: Facility): readonly string[] =>
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

export const hasDistinctiveStem = (tokens: readonly string[]): boolean =>
  tokens.length >= 2 ||
  (tokens.length === 1 &&
    (tokens[0]?.length ?? 0) >= 6 &&
    !WEAK_NEIGHBORHOOD_STEMS.has(tokens[0] ?? ''));

export interface CompactFacilityPrefixContext {
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
  organizationPrefixes: readonly string[] = DEFAULT_ORGANIZATION_PREFIXES,
): CompactPopulationPrefixContext => {
  const global = new Set<string>(organizationPrefixes);
  const compactFacilities: CompactFacilityPrefixContext[] = [];
  for (const facility of facilities) {
    const codeTokens = tokensOf(facility.code);
    const stemTokens = facilityStemTokens(facility);
    const fullNameTokens = tokensOf(facility.name);
    const automaticAliases = new Set(
      compactFacilityAliases(facility, organizationPrefixes),
    );
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
          alias.length >= 3 &&
          isDistinctiveAutomaticFacilityAlias(alias, organizationPrefixes),
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
        isDistinctiveAutomaticFacilityAlias(alias, organizationPrefixes),
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

export const automaticFacilityContextsForGroup = (
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

export const STAFF_IDENTITY_MARKERS = new Set([
  ...STAFF_MARKERS,
  ...NARROW_ROLE_MARKERS,
]);

// `sub` is meaningful only as an exact bounded word. In compact parsing it is
// too short to distinguish a substitute role from ordinary words such as
// subgroup, subteam, or subschool.
const COMPACT_STAFF_IDENTITY_MARKERS = new Set(
  [...STAFF_IDENTITY_MARKERS].filter((marker) => marker !== 'sub'),
);

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

export type WholeBuildingFieldState =
  | 'facility'
  | 'facility-workforce'
  | 'invalid';

const NON_DISTINCTIVE_AUTOMATIC_FACILITY_ALIASES = new Set([
  ...WHOLE_BUILDING_MARKERS,
  ...FACILITY_GENERIC_MARKERS,
  ...AGGREGATE_FACILITY_NAME_MARKERS,
  ...GENERIC_AUTOMATIC_FACILITY_CODE_ALIASES,
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
  'site',
  'sites',
  'system',
  'systems',
  'user',
  'users',
  'wide',
  'workforce',
]);

const isFullyNonDistinctiveAutomaticAlias = (
  alias: string,
  organizationPrefixes: readonly string[] = DEFAULT_ORGANIZATION_PREFIXES,
): boolean => {
  const reachable = new Set([0]);
  const nonDistinctiveMarkers = new Set([
    ...NON_DISTINCTIVE_AUTOMATIC_FACILITY_ALIASES,
    ...organizationPrefixes,
  ]);
  for (let offset = 0; offset < alias.length; offset += 1) {
    if (!reachable.has(offset)) continue;
    for (const marker of nonDistinctiveMarkers) {
      if (marker !== '' && alias.startsWith(marker, offset)) {
        reachable.add(offset + marker.length);
      }
    }
    const numeric = /^[0-9]+/u.exec(alias.slice(offset));
    if (numeric !== null) reachable.add(offset + numeric[0].length);
  }
  return reachable.has(alias.length);
};

export const isDistinctiveAutomaticFacilityAlias = (
  value: string,
  organizationPrefixes: readonly string[] = DEFAULT_ORGANIZATION_PREFIXES,
): boolean => {
  const alias = tokensOf(value).join('');
  return (
    alias.length >= 3 &&
    !isFullyNonDistinctiveAutomaticAlias(alias, organizationPrefixes)
  );
};

export const siteSpecificFacilityNameTokens = (
  facility: Facility,
): readonly string[] =>
  tokensOf(facility.name).filter(
    (token) =>
      !FACILITY_GENERIC_MARKERS.has(token) &&
      !AGGREGATE_FACILITY_NAME_MARKERS.has(token),
  );

export const hasSiteSpecificAutomaticFacilityIdentity = (
  facility: Facility,
  organizationPrefixes: readonly string[] = DEFAULT_ORGANIZATION_PREFIXES,
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
      isDistinctiveAutomaticFacilityAlias(token, organizationPrefixes),
  );
  if (!hasDistinctiveToken) return false;
  return siteSpecificTokens.length > 0;
};

export const isFacilitySpecificCodeAlias = (
  facility: Facility,
  organizationPrefixes: readonly string[] = DEFAULT_ORGANIZATION_PREFIXES,
): boolean => {
  if (
    !hasSiteSpecificAutomaticFacilityIdentity(facility, organizationPrefixes)
  ) {
    return false;
  }
  const codeTokens = tokensOf(facility.code);
  const alias = codeTokens.join('');
  if (!isDistinctiveAutomaticFacilityAlias(alias, organizationPrefixes)) {
    return false;
  }
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

export const compactFacilityAliases = (
  facility: Facility,
  organizationPrefixes: readonly string[] = DEFAULT_ORGANIZATION_PREFIXES,
): readonly string[] => {
  if (
    !hasSiteSpecificAutomaticFacilityIdentity(facility, organizationPrefixes)
  ) {
    return [];
  }
  const codeAlias = tokensOf(facility.code).join('');
  const stemTokens = siteSpecificFacilityNameTokens(facility);
  const stemAlias = stemTokens.join('');
  const fullNameTokens = tokensOf(facility.name);
  const fullNameAlias = fullNameTokens.join('');
  return sortedUnique([
    ...(isFacilitySpecificCodeAlias(facility, organizationPrefixes)
      ? [codeAlias]
      : []),
    ...(isDistinctiveAutomaticFacilityAlias(stemAlias, organizationPrefixes)
      ? [stemAlias]
      : []),
    ...(isDistinctiveAutomaticFacilityAlias(fullNameAlias, organizationPrefixes)
      ? [fullNameAlias]
      : []),
  ]);
};

export const hasBoundaryPreservingAutomaticFacilityEvidence = (
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

export const wholeBuildingFieldStateForAliases = (
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

export const hasSerializableStaffIdentity = (
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

export const hasRestrictedRoleGroupMarker = (
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

// The operational school year turns over at July 1 in the configured local
// time zone. A UTC boundary can mark the new year hours too early and
// misclassify a just-ended academic-year group as current.
export const academicStartYearAt = (
  timestamp: Date,
  academicTimeZone: string,
): number => {
  const dateFormat = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    month: 'numeric',
    timeZone: academicTimeZone,
    year: 'numeric',
  });
  const parts = dateFormat.formatToParts(timestamp);
  const year = Number(parts.find(({ type }) => type === 'year')?.value);
  const month = Number(parts.find(({ type }) => type === 'month')?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    throw new Error('Could not determine the configured academic year.');
  }
  return month >= 7 ? year : year - 1;
};

export const academicYearAliases = (
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

export const staleSignalReasons = (
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
