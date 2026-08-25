import {
  CreateGroupSourceInputSchema,
  CreateNeighborhoodVersionInputSchema,
  type Facility,
} from '@psd-eoc/contracts';

import {
  STAFF_MARKERS,
  NARROW_ROLE_MARKERS,
  STALE_MARKERS,
  type GoogleBuildingGroupSource,
  type GroupsInventoryConfiguration,
  type MatchOutcome,
  type CloudGroup,
  type MatchCandidate,
  type BuildingMapping,
  type NeighborhoodProposal,
  type SkippedNeighborhoodHint,
  type PotentiallyStaleGroup,
  type MappingDraft,
  requireAbsoluteTimestamp,
  compareText,
  sortedUnique,
} from './groups-inventory-model';

import {
  hasUnsupportedIdentityContent,
  tokensOf,
  hasAnyToken,
  containsSequence,
  facilityStemTokens,
  groupTokenFields,
  hasDistinctiveStem,
  type CompactFacilityPrefixContext,
  type DraftDerivationMetrics,
  type WholeBuildingFieldState,
  compactPopulationPrefixes,
  automaticFacilityContextsForGroup,
  isDistinctiveAutomaticFacilityAlias,
  siteSpecificFacilityNameTokens,
  compactFacilityAliases,
  hasBoundaryPreservingAutomaticFacilityEvidence,
  isFacilitySpecificCodeAlias,
  hasSiteSpecificAutomaticFacilityIdentity,
  wholeBuildingFieldStateForAliases,
  hasSerializableStaffIdentity,
  classifyPopulationGroup,
  hasRestrictedRoleGroupMarker,
  academicStartYearAt,
  staleSignalReasons,
  groupRef,
} from './groups-inventory-classification';

interface ScoredGroup {
  readonly group: CloudGroup;
  readonly score: number;
  readonly reasonCodes: readonly string[];
  readonly strongEligible: boolean;
}

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

export const createNeighborhoodProposals = (
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
  configuration: GroupsInventoryConfiguration,
  derivationMetrics?: DraftDerivationMetrics,
): MappingDraft => {
  const validatedGeneratedAt = requireAbsoluteTimestamp(
    generatedAt,
    'Draft generation time',
  );
  const referenceDate = new Date(validatedGeneratedAt);
  const referenceYear = referenceDate.getUTCFullYear();
  const academicStartYear = academicStartYearAt(
    referenceDate,
    configuration.academicTimeZone,
  );
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
    configuration.organizationPrefixes,
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
        createGroupSource = CreateGroupSourceInputSchema.parse({
          active: true,
          displayName: facility.name,
          email: best.group.email,
          facilityId: facility.id,
          googleGroupId: best.group.googleGroupId,
          kind: 'google-group',
          purpose: 'building',
        }) as GoogleBuildingGroupSource;
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
