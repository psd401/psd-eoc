import {
  CreateGroupSourceInputSchema,
  CreateNeighborhoodVersionInputSchema,
  FacilityPageSchema,
  FacilitySchema,
  type CreateNeighborhoodVersionInput,
  type Facility,
} from '@psd-eoc/contracts';

import {
  MAX_PAGES,
  MAX_GROUPS,
  MAX_FACILITIES,
  MAX_GROUPS_PER_PAGE,
  MAX_NEIGHBORHOOD_FACILITIES,
  type JsonObject,
  type GroupsInventoryConfiguration,
  type GoogleBuildingGroupSource,
  type ReviewDecision,
  type DraftGroupRef,
  type MatchCandidate,
  type BuildingMapping,
  type NeighborhoodProposal,
  type SkippedNeighborhoodHint,
  type ValidationSummary,
  isRecord,
  requireString,
  requireAbsoluteTimestamp,
  isHostedGroupEmail,
  hasUnsafeDisplayControl,
  compareText,
  normalizeText,
} from './groups-inventory-model';

import {
  createNeighborhoodProposals,
  buildDraft,
} from './groups-inventory-report';
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
  hostedDomain: string,
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
  hostedDomain: string,
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
  hostedDomain: string,
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
    if (source.googleGroupId === null) {
      throw new Error(
        'Draft group source must name a Google group Google holds, not a waiting one.',
      );
    }
    return { ...source, googleGroupId: source.googleGroupId };
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
  configuration: GroupsInventoryConfiguration,
): ValidationSummary => {
  const { hostedDomain } = configuration;
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
    configuration,
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
