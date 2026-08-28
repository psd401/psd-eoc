import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { parseTestInfo } from './asc-inputs';
import {
  appendQuery,
  type AscAppConfiguration,
  type AscClient,
  attributesOf,
  BETA_BUILD_LOCALIZATION_LOCALES,
  type BetaTestInfo,
  canonicalJson,
  canonicalValue,
  deepFreezeCanonical,
  EMPTY_JSON_OBJECT,
  INTERNAL_TESTER_WRITE_REQUEST_COST,
  isEmail,
  isRecord,
  type JsonApiPageSummary,
  type JsonApiResource,
  type JsonObject,
  MAX_APP_BUILDS,
  MAX_APP_LOCALIZATIONS,
  MAX_APP_TESTERS,
  MAX_APPLY_REQUEST_COST,
  MAX_GET_ATTEMPTS,
  MAX_GROUP_BUILDS,
  MAX_GROUPS,
  MAX_INDIVIDUAL_TESTERS_PER_BUILD,
  MAX_INTERNAL_TESTERS,
  MAX_RESOURCES,
  MAX_TESTER_RELATIONSHIPS,
  MAX_TESTER_WRITE_REQUEST_COST_PER_APPLY,
  MAX_TESTER_WRITES_PER_APPLY,
  MAX_TESTERS_PER_GROUP,
  MIN_FINAL_AUDIT_REQUEST_RESERVE,
  type MutationMethod,
  optionalString,
  PLAN_DIGEST_PATTERN,
  RATE_LIMIT_GROUP_SETUP_RESERVE,
  type ReconcileOptions,
  type ReconcileResult,
  requireOpaqueIdentifier,
  requireString,
  resourceFromUnknown,
  type SyncAction,
  type SyncOptions,
  type SyncResult,
  type Tester,
} from './asc-model';
const sameSelectedAttributes = (
  current: Readonly<JsonObject>,
  expected: Readonly<JsonObject>,
): boolean =>
  Object.entries(expected).every(([key, value]) => current[key] === value);
const actionStatus = (apply: boolean): 'applied' | 'planned' =>
  apply ? 'applied' : 'planned';
const createGroupBody = (
  appId: string,
  name: string,
  internal: boolean,
): JsonObject => ({
  data: {
    attributes: {
      feedbackEnabled: true,
      hasAccessToAllBuilds: false,
      isInternalGroup: internal,
      name,
      ...(internal ? {} : { publicLinkEnabled: false }),
    },
    relationships: { app: { data: { id: appId, type: 'apps' } } },
    type: 'betaGroups',
  },
});
interface GroupTarget {
  readonly existedInSnapshot: boolean;
  readonly id: string | null;
  readonly internal: boolean;
  readonly name: string;
}
interface BetaGroupInventoryState {
  current: readonly JsonApiResource[];
}
const appIdentityPath = (configuration: AscAppConfiguration): string =>
  appendQuery('/v1/apps', {
    'fields[apps]': 'name,bundleId,sku',
    'filter[bundleId]': configuration.bundleId,
    limit: '2',
  });
const appGroupsPath = (appId: string): string =>
  appendQuery(`/v1/apps/${encodeURIComponent(appId)}/betaGroups`, {
    'fields[betaGroups]':
      'name,isInternalGroup,hasAccessToAllBuilds,feedbackEnabled,publicLinkEnabled',
    limit: '200',
  });
const groupTestersPath = (groupId: string): string =>
  appendQuery(`/v1/betaGroups/${encodeURIComponent(groupId)}/betaTesters`, {
    'fields[betaTesters]': 'email',
    limit: '200',
  });
const groupBuildsPath = (groupId: string): string =>
  appendQuery(`/v1/betaGroups/${encodeURIComponent(groupId)}/builds`, {
    'fields[builds]': 'version,uploadedDate',
    limit: '200',
  });
const betaLocalizationsPath = (appId: string): string =>
  appendQuery(`/v1/apps/${encodeURIComponent(appId)}/betaAppLocalizations`, {
    limit: '200',
  });
const betaBuildLocalizationsPath = (buildId: string): string =>
  appendQuery(
    `/v1/builds/${encodeURIComponent(buildId)}/betaBuildLocalizations`,
    { limit: '200' },
  );
const validateBoundedResourceInventory = (
  resources: readonly JsonApiResource[],
  expectedType: string,
  label: string,
  maximum: number,
): readonly JsonApiResource[] => {
  if (resources.length > maximum) {
    throw new Error(`Apple returned too many ${label} resources.`);
  }
  const verified = resources.map((resource) =>
    resourceFromUnknown(resource, expectedType),
  );
  if (new Set(verified.map(({ id }) => id)).size !== verified.length) {
    throw new Error(`Apple returned duplicate ${label} identities.`);
  }
  return verified;
};
const resourceIds = (
  resources: readonly JsonApiResource[],
): readonly string[] => resources.map(({ id }) => id).sort();
const assertSameResourceIds = (
  related: readonly JsonApiResource[],
  linkage: readonly JsonApiResource[],
  mismatchMessage: string,
): void => {
  if (
    canonicalJson(resourceIds(related)) !== canonicalJson(resourceIds(linkage))
  ) {
    throw new Error(mismatchMessage);
  }
};
const assertExactParent = async (
  client: AscClient,
  path: string,
  expectedType: string,
  expectedId: string,
  mismatchMessage: string,
): Promise<void> => {
  const parent = resourceFromUnknown(
    await client.get(path, expectedType),
    expectedType,
  );
  if (parent.id !== expectedId) throw new Error(mismatchMessage);
};
const assertBetaGroupBelongsToApp = async (
  client: AscClient,
  groupId: string,
  appId: string,
): Promise<void> =>
  assertExactParent(
    client,
    `/v1/betaGroups/${encodeURIComponent(groupId)}/app`,
    'apps',
    appId,
    'Beta group does not belong to the exact configured app.',
  );
const listVerifiedBetaGroupsForApp = async (
  client: AscClient,
  appId: string,
): Promise<readonly JsonApiResource[]> => {
  const groups = await client.list(appGroupsPath(appId));
  const verifiedGroups = validateBoundedResourceInventory(
    groups,
    'betaGroups',
    'beta-group',
    MAX_GROUPS,
  );
  const linkage = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/apps/${encodeURIComponent(appId)}/relationships/betaGroups`,
        { limit: '200' },
      ),
    ),
    'betaGroups',
    'app beta-group relationship',
    MAX_GROUPS,
  );
  assertSameResourceIds(
    verifiedGroups,
    linkage,
    'App beta-group related resources did not match their relationship linkage.',
  );
  return groups;
};
const betaGroupInventoryFingerprint = (
  groups: readonly JsonApiResource[],
): readonly JsonObject[] =>
  groups
    .map((group) => ({
      attributes: attributesOf(group),
      id: group.id,
      type: group.type,
    }))
    .sort((left, right) => {
      const leftIdentity = `${String(left.type)}:${String(left.id)}`;
      const rightIdentity = `${String(right.type)}:${String(right.id)}`;
      return leftIdentity < rightIdentity
        ? -1
        : leftIdentity > rightIdentity
          ? 1
          : 0;
    });
const assertSameBetaGroupInventory = (
  current: readonly JsonApiResource[],
  expected: readonly JsonApiResource[],
  message: string,
): void => {
  if (
    canonicalJson(betaGroupInventoryFingerprint(current)) !==
    canonicalJson(betaGroupInventoryFingerprint(expected))
  ) {
    throw new Error(message);
  }
};
const assertEquivalentBetaGroupInventory = async (
  client: AscClient,
  appId: string,
  expected: readonly JsonApiResource[],
): Promise<readonly JsonApiResource[]> => {
  const current = await listVerifiedBetaGroupsForApp(client, appId);
  assertSameBetaGroupInventory(
    current,
    expected,
    'App beta-group inventory or settings changed after confirmation; no mutations were attempted.',
  );
  return current;
};
const assertBetaAppLocalizationBelongsToApp = async (
  client: AscClient,
  localizationId: string,
  appId: string,
): Promise<void> =>
  assertExactParent(
    client,
    `/v1/betaAppLocalizations/${encodeURIComponent(localizationId)}/app`,
    'apps',
    appId,
    'Beta app localization does not belong to the exact configured app.',
  );
const listVerifiedBetaAppLocalizationsForApp = async (
  client: AscClient,
  appId: string,
): Promise<readonly JsonApiResource[]> => {
  const localizations = await client.list(betaLocalizationsPath(appId));
  const verifiedLocalizations = validateBoundedResourceInventory(
    localizations,
    'betaAppLocalizations',
    'beta app localization',
    MAX_APP_LOCALIZATIONS,
  );
  for (const verified of verifiedLocalizations) {
    await assertBetaAppLocalizationBelongsToApp(client, verified.id, appId);
  }
  return localizations;
};
const assertBuildBetaDetailBelongsToBuild = async (
  client: AscClient,
  detailId: string,
  buildId: string,
): Promise<void> =>
  assertExactParent(
    client,
    `/v1/buildBetaDetails/${encodeURIComponent(detailId)}/build`,
    'builds',
    buildId,
    'Build beta details do not belong to the selected exact build.',
  );
const assertBuildBelongsToApp = async (
  client: AscClient,
  buildId: string,
  appId: string,
): Promise<void> =>
  assertExactParent(
    client,
    `/v1/builds/${encodeURIComponent(buildId)}/app`,
    'apps',
    appId,
    'Build does not belong to the exact configured app.',
  );
const listBetaTesterRelationshipSnapshot = async (
  client: AscClient,
  testerId: string,
  relationship: 'apps' | 'betaGroups' | 'builds',
  expectedType: 'apps' | 'betaGroups' | 'builds',
): Promise<readonly JsonApiResource[]> => {
  const label = `beta tester ${relationship}`;
  const relatedQuery: Record<string, string> = { limit: '200' };
  if (relationship === 'betaGroups') {
    relatedQuery['fields[betaGroups]'] = 'isInternalGroup';
  }
  const related = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/betaTesters/${encodeURIComponent(testerId)}/${relationship}`,
        relatedQuery,
      ),
    ),
    expectedType,
    label,
    MAX_TESTER_RELATIONSHIPS,
  );
  const linkage = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/betaTesters/${encodeURIComponent(testerId)}/relationships/${relationship}`,
        { limit: '200' },
      ),
    ),
    expectedType,
    `${label} relationship`,
    MAX_TESTER_RELATIONSHIPS,
  );
  assertSameResourceIds(
    related,
    linkage,
    'Beta tester related resources did not match their relationship linkage.',
  );
  return related;
};
const assertCreatedBetaTesterHasExactRelationships = async (
  client: AscClient,
  testerId: string,
  groupId: string,
  appId: string,
  internal: boolean,
): Promise<void> => {
  const groups = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'betaGroups',
    'betaGroups',
  );
  if (
    groups.length !== 1 ||
    groups[0]?.id !== groupId ||
    attributesOf(groups[0]).isInternalGroup !== internal
  ) {
    throw new Error(
      'Apple returned unexpected relationships for the created beta tester.',
    );
  }
  const apps = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'apps',
    'apps',
  );
  if (apps.length !== 1 || apps[0]?.id !== appId) {
    throw new Error(
      'Apple returned unexpected relationships for the created beta tester.',
    );
  }
  const builds = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'builds',
    'builds',
  );
  if (builds.length !== 0) {
    throw new Error(
      'Apple returned unexpected relationships for the created beta tester.',
    );
  }
};
const listGroupTesterSnapshot = async (
  client: AscClient,
  groupId: string,
): Promise<readonly JsonApiResource[]> => {
  const related = validateBoundedResourceInventory(
    await client.list(groupTestersPath(groupId)),
    'betaTesters',
    'group tester',
    MAX_TESTERS_PER_GROUP,
  );
  const linkage = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/betaTesters`,
        { limit: '200' },
      ),
    ),
    'betaTesters',
    'group tester relationship',
    MAX_TESTERS_PER_GROUP,
  );
  assertSameResourceIds(
    related,
    linkage,
    'Group tester relationship linkage did not match its related inventory.',
  );
  return related;
};
const assertGroupTesterRosterTotal = async (
  client: AscClient,
  groupId: string,
  expectedTotal: number,
): Promise<void> => {
  if (
    !Number.isInteger(expectedTotal) ||
    expectedTotal < 0 ||
    expectedTotal > MAX_TESTERS_PER_GROUP
  ) {
    throw new Error('Projected managed-group tester total is unsafe.');
  }
  const related = await client.pageSummary(
    appendQuery(`/v1/betaGroups/${encodeURIComponent(groupId)}/betaTesters`, {
      'fields[betaTesters]': 'email',
      limit: '1',
    }),
  );
  const linkage = await client.pageSummary(
    appendQuery(
      `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/betaTesters`,
      { limit: '1' },
    ),
  );
  const relatedResources = validateBoundedResourceInventory(
    related.resources,
    'betaTesters',
    'group tester page-summary',
    1,
  );
  const linkageResources = validateBoundedResourceInventory(
    linkage.resources,
    'betaTesters',
    'group tester relationship page-summary',
    1,
  );
  for (const tester of relatedResources) testerEmail(tester);
  if (
    relatedResources.length !== Math.min(related.total, 1) ||
    linkageResources.length !== Math.min(linkage.total, 1) ||
    related.total !== linkage.total ||
    related.total !== expectedTotal
  ) {
    throw new Error(
      'Managed group tester total changed around the risky write.',
    );
  }
};
const listVerifiedGroupTesters = async (
  client: AscClient,
  groupId: string,
): Promise<readonly JsonApiResource[]> =>
  listGroupTesterSnapshot(client, groupId);
const listVerifiedAppTesters = async (
  client: AscClient,
  appId: string,
): Promise<readonly JsonApiResource[]> => {
  const testers = validateBoundedResourceInventory(
    await client.list(
      appendQuery('/v1/betaTesters', {
        'fields[betaTesters]': 'email',
        'filter[apps]': appId,
        limit: '200',
      }),
    ),
    'betaTesters',
    'app tester',
    MAX_APP_TESTERS,
  );
  return testers;
};
const listVerifiedIndividualBuildTesters = async (
  client: AscClient,
  buildId: string,
): Promise<readonly JsonApiResource[]> => {
  const related = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/builds/${encodeURIComponent(buildId)}/individualTesters`,
        { 'fields[betaTesters]': 'email', limit: '200' },
      ),
    ),
    'betaTesters',
    'individual build tester',
    MAX_INDIVIDUAL_TESTERS_PER_BUILD,
  );
  const linkage = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/builds/${encodeURIComponent(buildId)}/relationships/individualTesters`,
        { limit: '200' },
      ),
    ),
    'betaTesters',
    'individual build tester relationship',
    MAX_INDIVIDUAL_TESTERS_PER_BUILD,
  );
  assertSameResourceIds(
    related,
    linkage,
    'Individual build tester relationship linkage did not match its related inventory.',
  );
  return related;
};
const listVerifiedAppBuilds = async (
  client: AscClient,
  appId: string,
): Promise<readonly JsonApiResource[]> => {
  const related = validateBoundedResourceInventory(
    await client.list(
      appendQuery(`/v1/apps/${encodeURIComponent(appId)}/builds`, {
        'fields[builds]': 'version',
        limit: '200',
      }),
    ),
    'builds',
    'app build',
    MAX_APP_BUILDS,
  );
  const linkage = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/apps/${encodeURIComponent(appId)}/relationships/builds`,
        { limit: '200' },
      ),
    ),
    'builds',
    'app build relationship',
    MAX_APP_BUILDS,
  );
  assertSameResourceIds(
    related,
    linkage,
    'App build related resources did not match their relationship linkage.',
  );
  return related;
};
const listGroupBuildSnapshot = async (
  client: AscClient,
  groupId: string,
): Promise<readonly JsonApiResource[]> => {
  const related = validateBoundedResourceInventory(
    await client.list(groupBuildsPath(groupId)),
    'builds',
    'group build',
    MAX_GROUP_BUILDS,
  );
  const linkage = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`,
        { limit: '200' },
      ),
    ),
    'builds',
    'group build relationship',
    MAX_GROUP_BUILDS,
  );
  assertSameResourceIds(
    related,
    linkage,
    'Group build relationship linkage did not match its related inventory.',
  );
  return related;
};
const listVerifiedGroupBuilds = async (
  client: AscClient,
  appId: string,
  groupId: string,
): Promise<readonly JsonApiResource[]> => {
  const related = await listGroupBuildSnapshot(client, groupId);
  for (const build of related) {
    await assertBuildBelongsToApp(client, build.id, appId);
  }
  return related;
};
const readExactBetaTester = async (
  client: AscClient,
  testerId: string,
  expectedEmail: string,
): Promise<JsonApiResource> => {
  const tester = resourceFromUnknown(
    await client.get(
      appendQuery(`/v1/betaTesters/${encodeURIComponent(testerId)}`, {
        'fields[betaTesters]': 'email',
      }),
      'betaTesters',
    ),
    'betaTesters',
  );
  if (tester.id !== testerId || testerEmail(tester) !== expectedEmail) {
    throw new Error('Apple returned an unexpected exact beta tester identity.');
  }
  return tester;
};
const assertPreReleaseVersionScope = async (
  client: AscClient,
  preReleaseVersionId: string,
  appId: string,
  buildId: string,
): Promise<void> => {
  await assertExactParent(
    client,
    `/v1/preReleaseVersions/${encodeURIComponent(preReleaseVersionId)}/app`,
    'apps',
    appId,
    'Pre-release version does not belong to the exact configured app.',
  );
  const verifiedBuilds = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/preReleaseVersions/${encodeURIComponent(preReleaseVersionId)}/builds`,
        { limit: '200' },
      ),
    ),
    'builds',
    'pre-release version build',
    MAX_APP_BUILDS,
  );
  if (verifiedBuilds.filter(({ id }) => id === buildId).length !== 1) {
    throw new Error(
      'The selected build is not in the exact pre-release version inventory.',
    );
  }
};
const hasSafeGroupSettings = (
  group: JsonApiResource,
  name: string,
  internal: boolean,
): boolean => {
  const attributes = attributesOf(group);
  return (
    group.type === 'betaGroups' &&
    attributes.name === name &&
    attributes.isInternalGroup === internal &&
    attributes.hasAccessToAllBuilds === false &&
    attributes.feedbackEnabled === true &&
    (internal || attributes.publicLinkEnabled === false)
  );
};
const verifyCreatedGroupBeforeUse = async (
  client: AscClient,
  appId: string,
  createdId: string,
  name: string,
  internal: boolean,
  expectedBefore: readonly JsonApiResource[],
): Promise<readonly JsonApiResource[]> => {
  const groups = await listVerifiedBetaGroupsForApp(client, appId);
  if (
    groups.length > MAX_GROUPS ||
    groups.some(({ type }) => type !== 'betaGroups')
  ) {
    throw new Error('Apple returned an unsafe beta-group inventory.');
  }
  const named = groups.filter((group) => attributesOf(group).name === name);
  if (
    named.length !== 1 ||
    named[0]?.id !== createdId ||
    !hasSafeGroupSettings(named[0], name, internal)
  ) {
    throw new Error(
      'Apple did not verify the created group in the expected app scope.',
    );
  }
  assertSameBetaGroupInventory(
    groups.filter(({ id }) => id !== createdId),
    expectedBefore,
    'App beta-group inventory changed during group creation; mutation outcome is indeterminate.',
  );
  await assertBetaGroupBelongsToApp(client, createdId, appId);
  const testers = await listVerifiedGroupTesters(client, createdId);
  const builds = await listVerifiedGroupBuilds(client, appId, createdId);
  if (
    testers.length !== 0 ||
    builds.length !== 0 ||
    testers.some(({ type }) => type !== 'betaTesters') ||
    builds.some(({ type }) => type !== 'builds')
  ) {
    throw new Error(
      'Apple returned a nonempty created group; refusing follow-on writes.',
    );
  }
  return groups;
};
const ensureGroup = async (
  client: AscClient,
  assertionClient: AscClient | undefined,
  appId: string,
  groups: readonly JsonApiResource[],
  groupInventoryState: BetaGroupInventoryState,
  rateBudget: ApplyRateBudget | undefined,
  name: string,
  configuration: AscAppConfiguration,
  apply: boolean,
  actions: SyncAction[],
): Promise<GroupTarget> => {
  const internal = true;
  const rateStage: ApplyRateStage = 'group-internal';
  const named = groups.filter(
    (group) => group.type === 'betaGroups' && attributesOf(group).name === name,
  );
  if (named.length > 1)
    throw new Error(`Apple has duplicate ${name} beta groups.`);
  const existing = named[0];
  if (existing === undefined) {
    actions.push({
      detail: `Create internal group ${name}.`,
      kind: 'group',
      status: actionStatus(apply),
    });
    if (!apply) {
      return { existedInSnapshot: false, id: null, internal, name };
    }
    if (assertionClient === undefined || rateBudget === undefined) {
      throw new Error('Apply is missing its live assertion client.');
    }
    rateBudget.assertStageStart(assertionClient, rateStage);
    groupInventoryState.current = await assertEquivalentBetaGroupInventory(
      assertionClient,
      appId,
      groupInventoryState.current,
    );
    const expectedBefore = groupInventoryState.current;
    await assertExactAppIdentity(assertionClient, appId, configuration);
    rateBudget.assertBeforeMutation(assertionClient, rateStage);
    const created = await client.mutate(
      'POST',
      '/v1/betaGroups',
      createGroupBody(appId, name, internal),
      'betaGroups',
    );
    if (created === null)
      throw new Error('Apple did not return the created group.');
    const createdGroup = resourceFromUnknown(created, 'betaGroups');
    groupInventoryState.current = await verifyCreatedGroupBeforeUse(
      assertionClient,
      appId,
      createdGroup.id,
      name,
      internal,
      expectedBefore,
    );
    rateBudget.complete(rateStage);
    return {
      existedInSnapshot: false,
      id: createdGroup.id,
      internal,
      name,
    };
  }
  if (attributesOf(existing).isInternalGroup !== internal) {
    throw new Error(`${name} exists with the wrong TestFlight group type.`);
  }
  if (attributesOf(existing).hasAccessToAllBuilds !== false) {
    throw new Error(
      `${name} must explicitly use manual build assignment; no changes were made.`,
    );
  }
  const mutableDesired: JsonObject = {
    feedbackEnabled: true,
    ...(internal ? {} : { publicLinkEnabled: false }),
  };
  if (sameSelectedAttributes(attributesOf(existing), mutableDesired)) {
    actions.push({
      detail: `${name} group already matches.`,
      kind: 'group',
      status: 'unchanged',
    });
    if (apply) {
      if (rateBudget === undefined) {
        throw new Error('Apply is missing its rate-limit budget.');
      }
      rateBudget.complete(rateStage);
    }
    return {
      existedInSnapshot: true,
      id: existing.id,
      internal,
      name,
    };
  }
  actions.push({
    detail: `Make ${name} private after verifying manual build assignment.`,
    kind: 'group',
    status: actionStatus(apply),
  });
  if (apply) {
    if (assertionClient === undefined || rateBudget === undefined) {
      throw new Error('Apply is missing its live assertion client.');
    }
    rateBudget.assertStageStart(assertionClient, rateStage);
    groupInventoryState.current = await assertEquivalentBetaGroupInventory(
      assertionClient,
      appId,
      groupInventoryState.current,
    );
    const expectedBefore = groupInventoryState.current;
    await assertBetaGroupBelongsToApp(assertionClient, existing.id, appId);
    await assertExactAppIdentity(assertionClient, appId, configuration);
    rateBudget.assertBeforeMutation(assertionClient, rateStage);
    const updated = await client.mutate(
      'PATCH',
      `/v1/betaGroups/${encodeURIComponent(existing.id)}`,
      {
        data: {
          attributes: mutableDesired,
          id: existing.id,
          type: 'betaGroups',
        },
      },
      'betaGroups',
    );
    if (updated === null || updated.id !== existing.id) {
      throw new Error('Apple did not return the updated beta group.');
    }
    await assertBetaGroupBelongsToApp(assertionClient, updated.id, appId);
    const currentAfter = await listVerifiedBetaGroupsForApp(
      assertionClient,
      appId,
    );
    const updatedMatches = currentAfter.filter(({ id }) => id === existing.id);
    if (
      updatedMatches.length !== 1 ||
      !hasSafeGroupSettings(
        updatedMatches[0] as JsonApiResource,
        name,
        internal,
      )
    ) {
      throw new Error(
        'Apple did not verify the updated beta group; mutation outcome is indeterminate.',
      );
    }
    assertSameBetaGroupInventory(
      currentAfter.filter(({ id }) => id !== existing.id),
      expectedBefore.filter(({ id }) => id !== existing.id),
      'App beta-group inventory changed during group update; mutation outcome is indeterminate.',
    );
    groupInventoryState.current = currentAfter;
    rateBudget.complete(rateStage);
  }
  return {
    existedInSnapshot: true,
    id: existing.id,
    internal,
    name,
  };
};
const testerEmail = (resource: JsonApiResource): string => {
  if (resource.type !== 'betaTesters') {
    throw new Error('Apple returned an unexpected tester resource.');
  }
  const value = attributesOf(resource).email;
  if (typeof value !== 'string' || !isEmail(value)) {
    throw new Error('Apple returned a tester without a valid email identity.');
  }
  return value.toLocaleLowerCase('en-US');
};
const ACCOUNT_USERS_PATH = appendQuery('/v1/users', {
  'fields[users]': 'username,roles,allAppsVisible',
  limit: '200',
});
const ACCOUNT_BETA_TESTERS_PATH = appendQuery('/v1/betaTesters', {
  'fields[betaTesters]': 'email',
  limit: '200',
});
const ELIGIBLE_INTERNAL_USER_ROLES = new Set([
  'ACCOUNT_HOLDER',
  'ADMIN',
  'APP_MANAGER',
  'DEVELOPER',
  'MARKETING',
]);
const accountUserAccess = (
  user: JsonApiResource,
): {
  readonly allAppsVisible: boolean;
  readonly roles: readonly string[];
  readonly username: string;
} => {
  const attributes = attributesOf(user);
  const username = attributes.username;
  const roles = attributes.roles;
  const allAppsVisible = attributes.allAppsVisible;
  if (
    user.type !== 'users' ||
    typeof username !== 'string' ||
    !isEmail(username) ||
    !Array.isArray(roles) ||
    roles.length === 0 ||
    roles.some(
      (role) =>
        typeof role !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/u.test(role),
    ) ||
    new Set(roles).size !== roles.length ||
    typeof allAppsVisible !== 'boolean'
  ) {
    throw new Error('Apple returned malformed account-user access data.');
  }
  return {
    allAppsVisible,
    roles: roles as readonly string[],
    username: username.toLocaleLowerCase('en-US'),
  };
};
const listVerifiedVisibleAppsForUser = async (
  client: AscClient,
  userId: string,
): Promise<readonly JsonApiResource[]> => {
  const related = validateBoundedResourceInventory(
    await client.list(
      appendQuery(`/v1/users/${encodeURIComponent(userId)}/visibleApps`, {
        limit: '200',
      }),
    ),
    'apps',
    'visible app',
    MAX_TESTER_RELATIONSHIPS,
  );
  const linkage = validateBoundedResourceInventory(
    await client.list(
      appendQuery(
        `/v1/users/${encodeURIComponent(userId)}/relationships/visibleApps`,
        { limit: '200' },
      ),
    ),
    'apps',
    'visible app relationship',
    MAX_TESTER_RELATIONSHIPS,
  );
  assertSameResourceIds(
    related,
    linkage,
    'User visible-app relationship linkage did not match its related inventory.',
  );
  return related;
};
const readExactAccountUser = async (
  client: AscClient,
  userId: string,
  expectedUsername: string,
): Promise<JsonApiResource> => {
  const user = resourceFromUnknown(
    await client.get(
      appendQuery(`/v1/users/${encodeURIComponent(userId)}`, {
        'fields[users]': 'username,roles,allAppsVisible',
      }),
      'users',
    ),
    'users',
  );
  if (
    user.id !== userId ||
    accountUserAccess(user).username !== expectedUsername
  ) {
    throw new Error(
      'Apple returned an unexpected exact account-user identity.',
    );
  }
  return user;
};
const collectEligibleInternalTesterUsers = async (
  client: AscClient,
  desired: readonly Tester[],
): Promise<ReadonlyMap<string, JsonApiResource>> => {
  if (desired.length === 0) return new Map<string, JsonApiResource>();
  const users = validateBoundedResourceInventory(
    await client.list(ACCOUNT_USERS_PATH),
    'users',
    'account user',
    MAX_RESOURCES,
  );
  const desiredEmails = new Set(desired.map(({ email }) => email));
  const eligible = new Map<string, JsonApiResource>();
  const seenUsernames = new Set<string>();
  for (const user of users) {
    const access = accountUserAccess(user);
    if (seenUsernames.has(access.username)) {
      throw new Error('Apple returned duplicate account-user identities.');
    }
    seenUsernames.add(access.username);
    if (
      desiredEmails.has(access.username) &&
      access.roles.some((role) => ELIGIBLE_INTERNAL_USER_ROLES.has(role))
    ) {
      eligible.set(access.username, user);
    }
  }
  const missingCount = desired.filter(
    ({ email }) => !eligible.has(email),
  ).length;
  if (missingCount > 0) {
    throw new Error(
      `${missingCount} internal tester(s) are not eligible App Store Connect users; no changes were made.`,
    );
  }
  return eligible;
};
const assertExactInternalTesterEligibility = async (
  client: AscClient,
  appId: string,
  tester: Tester,
  candidate: JsonApiResource | undefined,
): Promise<number> => {
  if (candidate === undefined) {
    throw new Error(
      'An internal tester is no longer an eligible App Store Connect user; no changes were made.',
    );
  }
  const user = await readExactAccountUser(client, candidate.id, tester.email);
  const access = accountUserAccess(user);
  if (!access.roles.some((role) => ELIGIBLE_INTERNAL_USER_ROLES.has(role))) {
    throw new Error(
      'An internal tester is no longer an eligible App Store Connect user; no changes were made.',
    );
  }
  if (!access.allAppsVisible) {
    const visibleApps = await listVerifiedVisibleAppsForUser(client, user.id);
    if (!visibleApps.some(({ id }) => id === appId)) {
      throw new Error(
        'An internal tester lacks access to the configured app; no changes were made.',
      );
    }
    return 1 + 2 * Math.max(1, Math.ceil(visibleApps.length / 200));
  }
  return 1;
};
const assertEligibleInternalTesters = async (
  client: AscClient,
  appId: string,
  desired: readonly Tester[],
): Promise<void> => {
  const eligible = await collectEligibleInternalTesterUsers(client, desired);
  for (const tester of desired) {
    await assertExactInternalTesterEligibility(
      client,
      appId,
      tester,
      eligible.get(tester.email),
    );
  }
};
const preflightInternalTesters = async (
  client: AscClient,
  appId: string,
  desired: readonly Tester[],
  actions: SyncAction[],
): Promise<void> => {
  if (desired.length === 0) return;
  await assertEligibleInternalTesters(client, appId, desired);
  actions.push({
    detail: `${desired.length} internal tester(s) are eligible App Store Connect users.`,
    kind: 'tester',
    status: 'unchanged',
  });
};
type TesterAudience = 'external' | 'internal';
interface AppWideTesterInventory {
  readonly appTesters: readonly {
    readonly audience: TesterAudience;
    readonly email?: string;
    readonly id: string;
  }[];
  readonly buildIds: readonly string[];
  readonly groupMemberships: readonly {
    readonly audience: TesterAudience;
    readonly email?: string;
    readonly groupId: string;
    readonly id: string;
  }[];
  readonly individualTesters: readonly {
    readonly audience: TesterAudience;
    readonly buildId: string;
    readonly email: string;
    readonly id: string;
  }[];
}
const sortByCanonicalJson = <Value>(values: readonly Value[]): Value[] =>
  [...values].sort((left, right) => {
    const leftJson = canonicalJson(left);
    const rightJson = canonicalJson(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
const canonicalAppWideTesterInventory = (
  inventory: AppWideTesterInventory,
): AppWideTesterInventory =>
  deepFreezeCanonical(
    canonicalValue({
      appTesters: sortByCanonicalJson(inventory.appTesters),
      buildIds: [...inventory.buildIds].sort(),
      groupMemberships: sortByCanonicalJson(inventory.groupMemberships),
      individualTesters: sortByCanonicalJson(inventory.individualTesters),
    }),
  ) as unknown as AppWideTesterInventory;
const inventoryAppTesterCapacity = async (
  client: AscClient,
  appId: string,
  groups: readonly JsonApiResource[],
  internalDesired: readonly Tester[],
): Promise<AppWideTesterInventory> => {
  const groupIds = new Set<string>();
  const idToEmail = new Map<string, string>();
  const emailToId = new Map<string, string>();
  const memberships: Array<{
    audience: TesterAudience;
    email?: string;
    groupId: string;
    id: string;
  }> = [];
  const membershipsById = new Map<
    string,
    Array<{
      audience: TesterAudience;
      email?: string;
      groupId: string;
    }>
  >();
  const captureTester = (
    tester: JsonApiResource,
    label: string,
    requireEmail: boolean,
  ): {
    email?: string;
    id: string;
  } => {
    if (tester.type !== 'betaTesters') {
      throw new Error(`Apple returned an unexpected ${label} resource.`);
    }
    const rawEmail = attributesOf(tester).email;
    let email: string | undefined;
    if (rawEmail === undefined || rawEmail === null) {
      if (requireEmail) {
        throw new Error(
          `Apple returned an ${label} without an email identity.`,
        );
      }
    } else if (typeof rawEmail !== 'string' || !isEmail(rawEmail)) {
      throw new Error(`Apple returned an ${label} with an invalid identity.`);
    } else {
      email = rawEmail.toLocaleLowerCase('en-US');
    }
    const priorEmail = idToEmail.get(tester.id);
    const priorId = email === undefined ? undefined : emailToId.get(email);
    if (
      (priorEmail !== undefined &&
        email !== undefined &&
        priorEmail !== email) ||
      (priorId !== undefined && priorId !== tester.id)
    ) {
      throw new Error(
        'Apple returned conflicting beta tester IDs or email identities.',
      );
    }
    if (email !== undefined) {
      idToEmail.set(tester.id, email);
      emailToId.set(email, tester.id);
    }
    return { ...(email === undefined ? {} : { email }), id: tester.id };
  };
  for (const group of groups) {
    if (group.type !== 'betaGroups') {
      throw new Error('Apple returned a non-group in the beta-group list.');
    }
    if (groupIds.has(group.id)) {
      throw new Error('Apple returned duplicate beta-group IDs.');
    }
    groupIds.add(group.id);
    const groupIsInternal = attributesOf(group).isInternalGroup;
    if (typeof groupIsInternal !== 'boolean') {
      throw new Error('Apple returned a beta group without an audience type.');
    }
    const audience: TesterAudience = groupIsInternal ? 'internal' : 'external';
    const seenInGroup = new Set<string>();
    const testers = await listVerifiedGroupTesters(client, group.id);
    for (const tester of testers) {
      const identity = captureTester(tester, 'tester', false);
      if (seenInGroup.has(identity.id)) {
        throw new Error('Apple returned a duplicate tester in a beta group.');
      }
      seenInGroup.add(identity.id);
      memberships.push({
        audience,
        ...(identity.email === undefined ? {} : { email: identity.email }),
        groupId: group.id,
        id: identity.id,
      });
      if (memberships.length > MAX_RESOURCES) {
        throw new Error(
          'Apple returned more app tester memberships than the safety limit.',
        );
      }
      const existing = membershipsById.get(identity.id) ?? [];
      existing.push({
        audience,
        ...(identity.email === undefined ? {} : { email: identity.email }),
        groupId: group.id,
      });
      membershipsById.set(identity.id, existing);
    }
  }
  const requireConsistentAudience = (
    identity: {
      email?: string;
      id: string;
    },
    label: string,
  ): TesterAudience => {
    const matching = membershipsById.get(identity.id) ?? [];
    const audience = matching[0]?.audience;
    if (
      audience === undefined ||
      matching.some((membership) => membership.audience !== audience) ||
      (identity.email !== undefined &&
        matching.some(
          (membership) =>
            membership.email !== undefined &&
            membership.email !== identity.email,
        ))
    ) {
      throw new Error(
        `Apple returned an ${label} that is not classifiable through one consistent typed app beta-group audience.`,
      );
    }
    return audience;
  };
  const rawAppTesters = await listVerifiedAppTesters(client, appId);
  const seenAppTesterIds = new Set<string>();
  const appTesters: Array<{
    audience: TesterAudience;
    email?: string;
    id: string;
  }> = [];
  for (const tester of rawAppTesters) {
    const identity = captureTester(tester, 'app tester', false);
    if (seenAppTesterIds.has(identity.id)) {
      throw new Error('Apple returned a duplicate app tester.');
    }
    seenAppTesterIds.add(identity.id);
    appTesters.push({
      ...identity,
      audience: requireConsistentAudience(identity, 'app tester'),
    });
    if (appTesters.length > MAX_RESOURCES) {
      throw new Error('Apple returned more app testers than the safety limit.');
    }
  }
  for (const testerId of membershipsById.keys()) {
    if (!seenAppTesterIds.has(testerId)) {
      throw new Error(
        'Apple app tester inventory omitted a typed beta-group member.',
      );
    }
  }
  const builds = await listVerifiedAppBuilds(client, appId);
  const buildIds = new Set<string>();
  const individualTesters: Array<{
    audience: TesterAudience;
    buildId: string;
    email: string;
    id: string;
  }> = [];
  for (const build of builds) {
    if (build.type !== 'builds') {
      throw new Error('Apple returned a non-build in the app build inventory.');
    }
    if (buildIds.has(build.id)) {
      throw new Error('Apple returned duplicate app build IDs.');
    }
    buildIds.add(build.id);
    const individuals = await listVerifiedIndividualBuildTesters(
      client,
      build.id,
    );
    const seenInBuild = new Set<string>();
    for (const tester of individuals) {
      const identity = captureTester(
        tester,
        'individual build tester',
        true,
      ) as {
        email: string;
        id: string;
      };
      if (seenInBuild.has(identity.id)) {
        throw new Error('Apple returned a duplicate individual build tester.');
      }
      seenInBuild.add(identity.id);
      individualTesters.push({
        ...identity,
        audience: requireConsistentAudience(
          identity,
          'individual build tester',
        ),
        buildId: build.id,
      });
      if (individualTesters.length > MAX_RESOURCES) {
        throw new Error(
          'Apple returned more individual build assignments than the safety limit.',
        );
      }
    }
  }
  for (const id of membershipsById.keys()) {
    requireConsistentAudience(
      {
        id,
        ...(idToEmail.has(id) ? { email: idToEmail.get(id) as string } : {}),
      },
      'beta tester',
    );
  }
  const audienceByEmail = new Map<string, TesterAudience>();
  const idsByAudience: Record<TesterAudience, Set<string>> = {
    external: new Set<string>(),
    internal: new Set<string>(),
  };
  for (const membership of memberships) {
    const email = idToEmail.get(membership.id) ?? membership.email;
    if (email !== undefined) audienceByEmail.set(email, membership.audience);
    idsByAudience[membership.audience].add(membership.id);
  }
  // No external roster is ever desired; Apple-side external memberships are
  // still read so app-wide capacity stays accurate.
  const desiredByAudience: Readonly<Record<TesterAudience, readonly Tester[]>> =
    { external: [], internal: internalDesired };
  const maximumByAudience: Readonly<Record<TesterAudience, number>> = {
    external: 10000,
    internal: 100,
  };
  for (const audience of ['internal', 'external'] as const) {
    const opposite: TesterAudience =
      audience === 'internal' ? 'external' : 'internal';
    let additions = 0;
    for (const tester of desiredByAudience[audience]) {
      const currentAudience = audienceByEmail.get(tester.email);
      if (currentAudience === opposite) {
        throw new Error(
          `A desired ${audience} tester already belongs to the opposite app audience; no changes were made.`,
        );
      }
      if (currentAudience === undefined) additions += 1;
    }
    const maximum = maximumByAudience[audience];
    if (idsByAudience[audience].size + additions > maximum) {
      throw new Error(
        `App-wide ${audience} membership plus proposed additions exceeds Apple's ${maximum.toLocaleString('en-US')}-tester limit; no changes were made.`,
      );
    }
  }
  return canonicalAppWideTesterInventory({
    appTesters,
    buildIds: [...buildIds],
    groupMemberships: memberships,
    individualTesters,
  });
};
class TesterIdentityAudienceRegistry {
  readonly #byId = new Map<
    string,
    {
      audience: TesterAudience;
      email?: string;
    }
  >();
  readonly #idByEmail = new Map<string, string>();
  constructor(inventory: AppWideTesterInventory) {
    for (const membership of inventory.groupMemberships) {
      this.#register(membership.id, membership.email, membership.audience);
    }
    for (const tester of inventory.appTesters) {
      this.#register(tester.id, tester.email, tester.audience);
    }
    for (const tester of inventory.individualTesters) {
      this.#register(tester.id, tester.email, tester.audience);
    }
  }
  registerResolvedTester(
    tester: JsonApiResource,
    audience: TesterAudience,
    approvedEmails?: ReadonlySet<string>,
  ): string {
    const email = this.validateResolvedTesterIdentity(tester);
    if (approvedEmails !== undefined && !approvedEmails.has(email)) {
      throw new Error(
        'Apple returned a beta tester outside the approved local roster.',
      );
    }
    this.#register(tester.id, email, audience);
    return email;
  }
  validateResolvedTesterIdentity(tester: JsonApiResource): string {
    const email = testerEmail(tester);
    const existing = this.#byId.get(tester.id);
    const existingId = this.#idByEmail.get(email);
    if (
      (existing?.email !== undefined && existing.email !== email) ||
      (existingId !== undefined && existingId !== tester.id)
    ) {
      throw new Error(
        'Apple returned conflicting beta tester identity or audience data.',
      );
    }
    return email;
  }
  registerCreatedTester(
    tester: JsonApiResource,
    audience: TesterAudience,
  ): string {
    const email = testerEmail(tester);
    if (this.#byId.has(tester.id) || this.#idByEmail.has(email)) {
      throw new Error(
        'Apple returned a reused beta tester identity after creation.',
      );
    }
    this.#register(tester.id, email, audience);
    return email;
  }
  #register(
    id: string,
    email: string | undefined,
    audience: TesterAudience,
  ): void {
    const existing = this.#byId.get(id);
    const existingId =
      email === undefined ? undefined : this.#idByEmail.get(email);
    if (
      (existing !== undefined && existing.audience !== audience) ||
      (existing?.email !== undefined &&
        email !== undefined &&
        existing.email !== email) ||
      (existingId !== undefined && existingId !== id)
    ) {
      throw new Error(
        'Apple returned conflicting beta tester identity or audience data.',
      );
    }
    const knownEmail = existing?.email ?? email;
    this.#byId.set(id, {
      audience,
      ...(knownEmail === undefined ? {} : { email: knownEmail }),
    });
    if (knownEmail !== undefined) this.#idByEmail.set(knownEmail, id);
  }
}
const collectAccountBetaTesters = async (
  client: AscClient,
  identityRegistry: TesterIdentityAudienceRegistry,
  needed: boolean,
): Promise<ReadonlyMap<string, JsonApiResource>> => {
  if (!needed) return new Map<string, JsonApiResource>();
  const accountTesters = await client.list(ACCOUNT_BETA_TESTERS_PATH);
  if (accountTesters.length > MAX_RESOURCES) {
    throw new Error(
      'Apple returned more account beta testers than the safety limit.',
    );
  }
  const accountTesterByEmail = new Map<string, JsonApiResource>();
  const emailById = new Map<string, string>();
  for (const resource of accountTesters) {
    const email = identityRegistry.validateResolvedTesterIdentity(resource);
    const priorEmail = emailById.get(resource.id);
    if (accountTesterByEmail.has(email) || priorEmail !== undefined) {
      throw new Error(
        'Apple returned duplicate account beta tester identities.',
      );
    }
    accountTesterByEmail.set(email, resource);
    emailById.set(resource.id, email);
  }
  return accountTesterByEmail;
};
interface AppWideTesterInventoryState {
  current: AppWideTesterInventory;
}
interface TesterRelationshipSnapshot {
  readonly apps: readonly JsonApiResource[];
  readonly builds: readonly JsonApiResource[];
  readonly groups: readonly JsonApiResource[];
}
const evolveAppWideTesterInventory = (
  current: AppWideTesterInventory,
  target: GroupTarget,
  testers: readonly JsonApiResource[],
): AppWideTesterInventory => {
  if (target.id === null) {
    throw new Error('Apply has no verified beta-group ID.');
  }
  const audience: TesterAudience = target.internal ? 'internal' : 'external';
  const appTesters = [...current.appTesters];
  const groupMemberships = [...current.groupMemberships];
  for (const tester of testers) {
    const email = testerEmail(tester);
    const appIndex = appTesters.findIndex(({ id }) => id === tester.id);
    const existingAppTester = appTesters[appIndex];
    if (
      existingAppTester !== undefined &&
      (existingAppTester.audience !== audience ||
        (existingAppTester.email !== undefined &&
          existingAppTester.email !== email))
    ) {
      throw new Error(
        'Apple returned conflicting beta tester identity or audience data.',
      );
    }
    const nextAppTester = { audience, email, id: tester.id } as const;
    if (appIndex < 0) appTesters.push(nextAppTester);
    else appTesters.splice(appIndex, 1, nextAppTester);
    const membership = groupMemberships.find(
      ({ groupId, id }) => groupId === target.id && id === tester.id,
    );
    if (
      membership !== undefined &&
      (membership.audience !== audience ||
        (membership.email !== undefined && membership.email !== email))
    ) {
      throw new Error(
        'Apple returned conflicting beta tester identity or audience data.',
      );
    }
    if (membership === undefined) {
      groupMemberships.push({
        audience,
        email,
        groupId: target.id,
        id: tester.id,
      });
    }
  }
  return canonicalAppWideTesterInventory({
    appTesters,
    buildIds: current.buildIds,
    groupMemberships,
    individualTesters: current.individualTesters,
  });
};
const assertCurrentTesterAppAudienceSafety = async (
  client: AscClient,
  appId: string,
  testerId: string,
  audience: TesterAudience,
  expected: AppWideTesterInventory,
): Promise<TesterRelationshipSnapshot> => {
  const expectedMemberships = expected.groupMemberships.filter(
    ({ id }) => id === testerId,
  );
  if (
    expectedMemberships.some((membership) => membership.audience !== audience)
  ) {
    throw new Error(
      'A beta tester belongs to the opposite app audience; no changes were made.',
    );
  }
  const expectedGroupIds = new Set(
    expectedMemberships.map(({ groupId }) => groupId),
  );
  const expectedAppTester = expected.appTesters.find(
    ({ id }) => id === testerId,
  );
  if (
    expectedAppTester !== undefined &&
    expectedAppTester.audience !== audience
  ) {
    throw new Error(
      'A beta tester belongs to the opposite app audience; no changes were made.',
    );
  }
  const apps = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'apps',
    'apps',
  );
  const expectedInApp =
    expectedAppTester !== undefined || expectedMemberships.length > 0;
  const currentInApp = apps.some(({ id }) => id === appId);
  if (currentInApp !== expectedInApp) {
    throw new Error('A beta tester app relationship changed before the write.');
  }
  if (!expectedInApp && apps.length >= MAX_TESTER_RELATIONSHIPS) {
    throw new Error(
      'A beta tester has no safe app-relationship capacity for the additive write.',
    );
  }
  const appGroups = await listVerifiedBetaGroupsForApp(client, appId);
  const appGroupsById = new Map(appGroups.map((group) => [group.id, group]));
  const groups = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'betaGroups',
    'betaGroups',
  );
  if (groups.length >= MAX_TESTER_RELATIONSHIPS) {
    throw new Error(
      'A beta tester has no safe group-relationship capacity for the additive write.',
    );
  }
  const currentAppGroups = groups.filter(({ id }) => appGroupsById.has(id));
  const currentAppGroupIds = new Set(currentAppGroups.map(({ id }) => id));
  if (
    currentAppGroupIds.size !== expectedGroupIds.size ||
    [...expectedGroupIds].some((id) => !currentAppGroupIds.has(id))
  ) {
    throw new Error(
      'A beta tester group relationship changed before the write.',
    );
  }
  for (const group of currentAppGroups) {
    const typedAppGroup = appGroupsById.get(group.id) as JsonApiResource;
    const groupIsInternal = attributesOf(typedAppGroup).isInternalGroup;
    const testerGroupIsInternal = attributesOf(group).isInternalGroup;
    if (
      typeof groupIsInternal !== 'boolean' ||
      testerGroupIsInternal !== groupIsInternal ||
      groupIsInternal !== (audience === 'internal')
    ) {
      throw new Error('A beta tester gained an unsafe group in the exact app.');
    }
  }
  const builds = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'builds',
    'builds',
  );
  return { apps, builds, groups };
};
const assertExactTesterRelationshipDelta = async (
  client: AscClient,
  testerId: string,
  appId: string,
  groupId: string,
  internal: boolean,
  before: TesterRelationshipSnapshot,
): Promise<void> => {
  const currentGroups = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'betaGroups',
    'betaGroups',
  );
  const currentApps = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'apps',
    'apps',
  );
  const currentBuilds = await listBetaTesterRelationshipSnapshot(
    client,
    testerId,
    'builds',
    'builds',
  );
  const assertExactAdditiveSet = (
    prior: readonly JsonApiResource[],
    current: readonly JsonApiResource[],
    addedId: string,
    expectedType: string,
    label: string,
  ): JsonApiResource => {
    const expectedIds = new Set([...prior.map(({ id }) => id), addedId]);
    if (
      current.length !== expectedIds.size ||
      current.some(
        (resource) =>
          resource.type !== expectedType || !expectedIds.has(resource.id),
      )
    ) {
      throw new Error(
        `Apple returned an unexpected beta tester ${label} relationship delta.`,
      );
    }
    for (const previous of prior) {
      const matches = current.filter(({ id }) => id === previous.id);
      if (
        matches.length !== 1 ||
        canonicalJson(matches[0]) !== canonicalJson(previous)
      ) {
        throw new Error(
          `Apple changed an existing beta tester ${label} relationship.`,
        );
      }
    }
    const added = current.filter(({ id }) => id === addedId);
    if (added.length !== 1) {
      throw new Error(
        `Apple omitted the exact beta tester ${label} relationship.`,
      );
    }
    return added[0] as JsonApiResource;
  };
  const addedGroup = assertExactAdditiveSet(
    before.groups,
    currentGroups,
    groupId,
    'betaGroups',
    'group',
  );
  if (attributesOf(addedGroup).isInternalGroup !== internal) {
    throw new Error(
      'Apple returned an unexpected audience for the added beta tester group relationship.',
    );
  }
  assertExactAdditiveSet(before.apps, currentApps, appId, 'apps', 'app');
  const expectedBuildIds = new Set(before.builds.map(({ id }) => id));
  if (
    expectedBuildIds.size > MAX_TESTER_RELATIONSHIPS ||
    currentBuilds.length !== expectedBuildIds.size ||
    currentBuilds.some(
      (resource) =>
        resource.type !== 'builds' || !expectedBuildIds.has(resource.id),
    )
  ) {
    throw new Error(
      'Apple returned an unexpected beta tester build relationship delta.',
    );
  }
  for (const previous of before.builds) {
    const matches = currentBuilds.filter(({ id }) => id === previous.id);
    if (
      matches.length !== 1 ||
      canonicalJson(matches[0]) !== canonicalJson(previous)
    ) {
      throw new Error(
        'Apple changed an existing beta tester build relationship.',
      );
    }
  }
};
const assertEquivalentAppTesterInventory = async (
  client: AscClient,
  appId: string,
  expected: AppWideTesterInventory,
  internalDesired: readonly Tester[],
): Promise<AppWideTesterInventory> => {
  const groups = await listVerifiedBetaGroupsForApp(client, appId);
  if (groups.length > MAX_GROUPS) {
    throw new Error('Apple returned an unsafe beta-group inventory.');
  }
  const current = await inventoryAppTesterCapacity(
    client,
    appId,
    groups,
    internalDesired,
  );
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw new Error(
      'App-wide tester inventory changed after confirmation; refusing tester writes.',
    );
  }
  return current;
};
const resourceIdentitySet = (
  resources: readonly JsonApiResource[],
  expectedType: string,
  label: string,
): readonly string[] => {
  const identities = resources.map((resource) => {
    if (resource.type !== expectedType) {
      throw new Error(`Apple returned an unexpected ${label} resource.`);
    }
    return expectedType === 'betaTesters'
      ? `${resource.type}:${resource.id}:${testerEmail(resource)}`
      : `${resource.type}:${resource.id}`;
  });
  if (new Set(identities).size !== identities.length) {
    throw new Error(`Apple returned a duplicate ${label} resource.`);
  }
  return identities.sort();
};
const canonicalGroupBuildInventory = (
  resources: readonly JsonApiResource[],
): readonly JsonApiResource[] => {
  resourceIdentitySet(resources, 'builds', 'group build');
  const projected = resources.map(({ id }) =>
    canonicalResource({ id, type: 'builds' }),
  );
  projected.sort((left, right) => {
    const leftIdentity = canonicalJson(left);
    const rightIdentity = canonicalJson(right);
    return leftIdentity < rightIdentity
      ? -1
      : leftIdentity > rightIdentity
        ? 1
        : 0;
  });
  return Object.freeze(projected);
};
const assertSameGroupBuildInventory = (
  current: readonly JsonApiResource[],
  expected: readonly JsonApiResource[],
): void => {
  if (
    canonicalJson(canonicalGroupBuildInventory(current)) !==
    canonicalJson(canonicalGroupBuildInventory(expected))
  ) {
    throw new Error(
      'Managed group build inventory changed after confirmation.',
    );
  }
};
const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);
const assertExactTargetGroupSettingsAndParent = async (
  client: AscClient,
  appId: string,
  target: GroupTarget,
): Promise<string> => {
  if (target.id === null) {
    throw new Error('Apply has no verified beta-group ID.');
  }
  const group = resourceFromUnknown(
    await client.get(
      appendQuery(`/v1/betaGroups/${encodeURIComponent(target.id)}`, {
        'fields[betaGroups]':
          'name,isInternalGroup,hasAccessToAllBuilds,feedbackEnabled,publicLinkEnabled',
      }),
      'betaGroups',
    ),
    'betaGroups',
  );
  if (
    group.id !== target.id ||
    !hasSafeGroupSettings(group, target.name, target.internal)
  ) {
    throw new Error(
      'Managed group settings changed immediately before the risky write.',
    );
  }
  await assertBetaGroupBelongsToApp(client, group.id, appId);
  return group.id;
};
const verifyTargetGroupEnvelopeBeforeTesterWrite = async (
  client: AscClient,
  appId: string,
  target: GroupTarget,
  expectedTesterTotal: number,
  expectedBuilds: readonly JsonApiResource[],
): Promise<void> => {
  const groupId = await assertExactTargetGroupSettingsAndParent(
    client,
    appId,
    target,
  );
  const currentBuilds = await listGroupBuildSnapshot(client, groupId);
  assertSameGroupBuildInventory(currentBuilds, expectedBuilds);
  await assertGroupTesterRosterTotal(client, groupId, expectedTesterTotal);
};
const verifyTargetGroupSnapshotBeforeBuildWrite = async (
  client: AscClient,
  appId: string,
  target: GroupTarget,
  expectedTesters: readonly JsonApiResource[],
  expectedBuilds: readonly JsonApiResource[],
): Promise<void> => {
  const groupId = await assertExactTargetGroupSettingsAndParent(
    client,
    appId,
    target,
  );
  const currentTesters = await listGroupTesterSnapshot(client, groupId);
  const currentBuilds = await listGroupBuildSnapshot(client, groupId);
  if (
    !sameStrings(
      resourceIdentitySet(expectedTesters, 'betaTesters', 'tester'),
      resourceIdentitySet(currentTesters, 'betaTesters', 'tester'),
    ) ||
    !sameStrings(
      resourceIdentitySet(expectedBuilds, 'builds', 'group build'),
      resourceIdentitySet(currentBuilds, 'builds', 'group build'),
    )
  ) {
    throw new Error(
      'Managed group audience or builds changed immediately before the risky write.',
    );
  }
};
interface PlannedTesterWrite {
  readonly audience: TesterAudience;
  readonly email: string;
  readonly existing?: JsonApiResource;
}
interface TesterWritePlan {
  readonly auditReserve: number;
  readonly costByEmail: Map<string, number>;
  deferred: number;
  readonly pendingCount: number;
  remainingRateCost: number;
  readonly selected: readonly PlannedTesterWrite[];
  readonly selectedEmails: ReadonlySet<string>;
}
interface TesterSyncResult {
  readonly deferredWrites: number;
  readonly expectedBuilds: readonly JsonApiResource[];
}
interface ManagedGroupSnapshot {
  readonly builds: readonly JsonApiResource[];
  readonly target: GroupTarget;
  readonly testers: readonly JsonApiResource[];
}
const collectManagedGroupSnapshot = async (
  client: AscClient,
  appId: string,
  groups: readonly JsonApiResource[],
  name: string,
  internal: boolean,
): Promise<ManagedGroupSnapshot> => {
  const named = groups.filter(
    (group) => group.type === 'betaGroups' && attributesOf(group).name === name,
  );
  if (named.length !== 1) {
    return {
      builds: [],
      target: { existedInSnapshot: false, id: null, internal, name },
      testers: [],
    };
  }
  const group = named[0] as JsonApiResource;
  return {
    builds: await listVerifiedGroupBuilds(client, appId, group.id),
    target: {
      existedInSnapshot: true,
      id: group.id,
      internal,
      name,
    },
    testers: await listVerifiedGroupTesters(client, group.id),
  };
};
const assertTesterWriteRateLimitBudget = (
  client: AscClient,
  remainingSelectedRequestCost: number,
  auditReserve: number,
): void => {
  const remaining = client.rateLimitRemaining();
  if (remaining === null || !Number.isSafeInteger(remaining) || remaining < 0) {
    throw new Error(
      'Apple rate-limit budget is unavailable; refusing the tester write.',
    );
  }
  const required = remainingSelectedRequestCost + auditReserve;
  if (remaining < required) {
    throw new Error(
      'Apple rate-limit budget is too low for the selected tester chunk and final audit; no further tester writes were attempted.',
    );
  }
};
const pagedRequestCount = (count: number): number =>
  Math.max(1, Math.ceil(count / 200));
const finalAuditRequestReserve = (
  groups: readonly JsonApiResource[],
  inventory: AppWideTesterInventory,
  internalSnapshot: ManagedGroupSnapshot,
  selected: readonly PlannedTesterWrite[],
): number => {
  const groupCounts = new Map<string, number>();
  for (const group of groups) groupCounts.set(group.id, 0);
  for (const membership of inventory.groupMemberships) {
    groupCounts.set(
      membership.groupId,
      (groupCounts.get(membership.groupId) ?? 0) + 1,
    );
  }
  const targetKey = (audience: TesterAudience): string =>
    audience === 'internal'
      ? (internalSnapshot.target.id ?? 'planned:internal:group')
      : `planned:${audience}:group`;
  const internalKey = targetKey('internal');
  if (!groupCounts.has(internalKey)) groupCounts.set(internalKey, 0);
  for (const write of selected) {
    const key = targetKey(write.audience);
    groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
  }
  const appTesterIds = new Set(inventory.appTesters.map(({ id }) => id));
  let appTesterCount = inventory.appTesters.length;
  for (const write of selected) {
    if (write.existing === undefined || !appTesterIds.has(write.existing.id)) {
      appTesterCount += 1;
    }
  }
  const individualsByBuild = new Map<string, number>();
  for (const buildId of inventory.buildIds) individualsByBuild.set(buildId, 0);
  for (const tester of inventory.individualTesters) {
    individualsByBuild.set(
      tester.buildId,
      (individualsByBuild.get(tester.buildId) ?? 0) + 1,
    );
  }
  const groupCount = Math.max(groups.length, groupCounts.size);
  let requests = 4 * pagedRequestCount(groupCount);
  for (const count of groupCounts.values()) {
    requests += 2 * pagedRequestCount(count);
  }
  requests += pagedRequestCount(appTesterCount);
  requests += 2 * pagedRequestCount(inventory.buildIds.length);
  for (const count of individualsByBuild.values()) {
    requests += 2 * pagedRequestCount(count);
  }
  for (const snapshot of [internalSnapshot]) {
    const rosterCount =
      groupCounts.get(
        targetKey(snapshot.target.internal ? 'internal' : 'external'),
      ) ?? 0;
    requests += 2 * pagedRequestCount(rosterCount);
    requests += 2 * pagedRequestCount(snapshot.builds.length);
    requests += snapshot.builds.length;
  }
  requests += 1;
  return Math.max(MIN_FINAL_AUDIT_REQUEST_RESERVE, requests * MAX_GET_ATTEMPTS);
};
interface DownstreamTopology {
  readonly appLocalizationCount: number;
  readonly buildLocalizationCount: number;
}
type ApplyRateStage =
  | 'app-localization'
  | 'build-localization'
  | 'group-internal'
  | 'internal-build';
interface ApplyRateStageReservation {
  readonly guardCost: number;
  readonly totalCost: number;
}
interface ApplyRatePlan {
  readonly finalAuditReserve: number;
  readonly stages: ReadonlyMap<ApplyRateStage, ApplyRateStageReservation>;
  readonly total: number;
}
class ApplyRateBudget {
  readonly #finalAuditReserve: number;
  readonly #stages: Map<ApplyRateStage, ApplyRateStageReservation>;
  #remaining: number;
  constructor(plan: ApplyRatePlan) {
    this.#finalAuditReserve = plan.finalAuditReserve;
    this.#stages = new Map(plan.stages);
    this.#remaining = plan.total;
  }
  assertStageStart(client: AscClient, stage: ApplyRateStage): void {
    this.#reservation(stage);
    this.#assertRemaining(client, this.#remaining);
  }
  assertBeforeMutation(client: AscClient, stage: ApplyRateStage): void {
    const reservation = this.#reservation(stage);
    this.#assertRemaining(client, this.#remaining - reservation.guardCost);
  }
  complete(stage: ApplyRateStage): void {
    const reservation = this.#reservation(stage);
    this.#remaining -= reservation.totalCost;
    this.#stages.delete(stage);
  }
  assertFinalAudit(client: AscClient): void {
    if (
      [...this.#stages.values()].some(({ totalCost }) => totalCost !== 0) ||
      this.#remaining !== this.#finalAuditReserve
    ) {
      throw new Error('Apply rate-limit stage plan is incomplete.');
    }
    this.#assertRemaining(client, this.#finalAuditReserve);
  }
  #reservation(stage: ApplyRateStage): ApplyRateStageReservation {
    const reservation = this.#stages.get(stage);
    if (reservation === undefined) {
      throw new Error('Apply rate-limit stage plan is inconsistent.');
    }
    return reservation;
  }
  #assertRemaining(client: AscClient, required: number): void {
    const remaining = client.rateLimitRemaining();
    if (
      remaining === null ||
      !Number.isSafeInteger(remaining) ||
      remaining < 0 ||
      remaining < required
    ) {
      throw new Error(
        'Apple request budget changed before a provider mutation; no further mutations were attempted.',
      );
    }
  }
}
const appTesterAuditLogicalRequestCount = (
  groups: readonly JsonApiResource[],
  inventory: AppWideTesterInventory,
  internalSnapshot: ManagedGroupSnapshot,
): number => {
  const groupCounts = new Map(groups.map(({ id }) => [id, 0]));
  for (const membership of inventory.groupMemberships) {
    groupCounts.set(
      membership.groupId,
      (groupCounts.get(membership.groupId) ?? 0) + 1,
    );
  }
  const internalKey = internalSnapshot.target.id ?? 'planned:internal:group';
  if (!groupCounts.has(internalKey)) groupCounts.set(internalKey, 0);
  const individualsByBuild = new Map(
    inventory.buildIds.map((buildId) => [buildId, 0]),
  );
  for (const tester of inventory.individualTesters) {
    individualsByBuild.set(
      tester.buildId,
      (individualsByBuild.get(tester.buildId) ?? 0) + 1,
    );
  }
  return (
    2 * pagedRequestCount(Math.max(groups.length, groupCounts.size)) +
    2 *
      [...groupCounts.values()].reduce(
        (total, count) => total + pagedRequestCount(count),
        0,
      ) +
    pagedRequestCount(inventory.appTesters.length) +
    2 * pagedRequestCount(inventory.buildIds.length) +
    2 *
      [...individualsByBuild.values()].reduce(
        (total, count) => total + pagedRequestCount(count),
        0,
      )
  );
};
const downstreamRequestReserve = (
  groups: readonly JsonApiResource[],
  inventory: AppWideTesterInventory,
  internalSnapshot: ManagedGroupSnapshot,
  build: JsonApiResource | null,
  testInfoPresent: boolean,
  topology: DownstreamTopology,
): ApplyRatePlan => {
  const appendBuild = (
    snapshot: ManagedGroupSnapshot,
    shouldAttach: boolean,
  ): ManagedGroupSnapshot => ({
    ...snapshot,
    builds:
      shouldAttach &&
      build !== null &&
      !snapshot.builds.some(({ id }) => id === build.id)
        ? [...snapshot.builds, build]
        : snapshot.builds,
  });
  const attachInternal =
    build !== null &&
    !internalSnapshot.builds.some(({ id }) => id === build.id);
  const projectedInternal = appendBuild(internalSnapshot, attachInternal);
  const groupCount = Math.max(
    groups.length,
    new Set([
      ...groups.map(({ id }) => id),
      internalSnapshot.target.id ?? 'planned:internal:group',
    ]).size,
  );
  const coreAudit = appTesterAuditLogicalRequestCount(
    groups,
    inventory,
    internalSnapshot,
  );
  const appLocalizationCount = testInfoPresent
    ? Math.min(MAX_APP_LOCALIZATIONS, topology.appLocalizationCount + 1)
    : topology.appLocalizationCount;
  const buildLocalizationCount =
    testInfoPresent && build !== null
      ? Math.min(
          BETA_BUILD_LOCALIZATION_LOCALES.size,
          topology.buildLocalizationCount + 1,
        )
      : topology.buildLocalizationCount;
  const appLocalizationAudit =
    pagedRequestCount(appLocalizationCount) + appLocalizationCount;
  const buildLocalizationAudit =
    pagedRequestCount(buildLocalizationCount) + buildLocalizationCount;
  const completeLocalizationAudit =
    appLocalizationAudit + (build === null ? 0 : buildLocalizationAudit);
  const buildRefresh = 6 + pagedRequestCount(MAX_APP_BUILDS);
  const groupReadiness = (snapshot: ManagedGroupSnapshot): number =>
    2 * pagedRequestCount(groupCount) +
    2 * pagedRequestCount(snapshot.testers.length) +
    2 * pagedRequestCount(snapshot.builds.length) +
    snapshot.builds.length;
  const exactTargetSnapshot = (snapshot: ManagedGroupSnapshot): number =>
    2 +
    2 * pagedRequestCount(snapshot.testers.length) +
    2 * pagedRequestCount(snapshot.builds.length);
  const buildReadback = (snapshot: ManagedGroupSnapshot): number =>
    2 * pagedRequestCount(snapshot.builds.length) + snapshot.builds.length;
  const attachLogicalCost = (
    before: ManagedGroupSnapshot,
    after: ManagedGroupSnapshot,
  ): number =>
    groupReadiness(before) +
    buildLocalizationAudit +
    buildRefresh +
    completeLocalizationAudit +
    coreAudit +
    1 +
    exactTargetSnapshot(before) +
    1 +
    buildReadback(after);
  const exactAppIdentityCost = MAX_GET_ATTEMPTS;
  const stages = new Map<ApplyRateStage, ApplyRateStageReservation>([
    ['group-internal', { guardCost: 12, totalCost: 33 }],
  ]);
  if (testInfoPresent) {
    const appGuardCost =
      6 + exactAppIdentityCost + appLocalizationAudit * MAX_GET_ATTEMPTS;
    stages.set('app-localization', {
      guardCost: appGuardCost,
      totalCost: appGuardCost + 10,
    });
    if (build !== null) {
      const buildGuardCost =
        6 +
        exactAppIdentityCost +
        (appLocalizationAudit + buildLocalizationAudit) * MAX_GET_ATTEMPTS;
      stages.set('build-localization', {
        guardCost: buildGuardCost,
        totalCost: buildGuardCost + 15,
      });
    }
  }
  if (attachInternal) {
    const totalCost =
      attachLogicalCost(internalSnapshot, projectedInternal) * MAX_GET_ATTEMPTS;
    stages.set('internal-build', {
      guardCost: Math.max(
        0,
        totalCost - buildReadback(projectedInternal) * MAX_GET_ATTEMPTS - 1,
      ),
      totalCost,
    });
  } else {
    stages.set('internal-build', { guardCost: 0, totalCost: 0 });
  }
  let finalAuditReserve = finalAuditRequestReserve(
    groups,
    inventory,
    projectedInternal,
    [],
  );
  if (testInfoPresent) {
    finalAuditReserve += (2 + completeLocalizationAudit) * MAX_GET_ATTEMPTS;
  }
  return {
    finalAuditReserve,
    stages,
    total:
      finalAuditReserve +
      [...stages.values()].reduce(
        (total, reservation) => total + reservation.totalCost,
        0,
      ),
  };
};
const managedGroupEmails = (
  groups: readonly JsonApiResource[],
  inventory: AppWideTesterInventory,
  name: string,
  internal: boolean,
): ReadonlySet<string> => {
  const matches = groups.filter(
    (group) =>
      group.type === 'betaGroups' &&
      attributesOf(group).name === name &&
      attributesOf(group).isInternalGroup === internal,
  );
  if (matches.length !== 1) return new Set<string>();
  const groupId = (matches[0] as JsonApiResource).id;
  return new Set(
    inventory.groupMemberships.flatMap((membership) =>
      membership.groupId === groupId && membership.email !== undefined
        ? [membership.email]
        : [],
    ),
  );
};
const planTesterWriteChunk = (
  groups: readonly JsonApiResource[],
  inventory: AppWideTesterInventory,
  accountTesterByEmail: ReadonlyMap<string, JsonApiResource>,
  internalSnapshot: ManagedGroupSnapshot,
  internalDesired: readonly Tester[],
  configuration: AscAppConfiguration,
  availableRateBudget: number | null,
  confirmedMaxWrites?: number,
): TesterWritePlan => {
  const audiences = [
    [
      'internal',
      internalDesired,
      managedGroupEmails(
        groups,
        inventory,
        configuration.internalGroupName,
        true,
      ),
    ],
  ] as const;
  const pendingEmails = audiences.flatMap(([, desired, currentEmails]) =>
    desired.flatMap(({ email }) => (currentEmails.has(email) ? [] : [email])),
  );
  if (
    inventory.groupMemberships.length + pendingEmails.length >
    MAX_RESOURCES
  ) {
    throw new Error(
      'Approved tester writes exceed the safe app group-membership capacity.',
    );
  }
  const requiredAccountCreates = pendingEmails.filter(
    (email) => !accountTesterByEmail.has(email),
  ).length;
  if (accountTesterByEmail.size + requiredAccountCreates > MAX_RESOURCES) {
    throw new Error(
      'Approved tester creates exceed the safe account tester capacity.',
    );
  }
  const selected: PlannedTesterWrite[] = [];
  const costByEmail = new Map<string, number>();
  let selectedRequestCost = 0;
  let selectionComplete = false;
  const maxSelectedWrites = confirmedMaxWrites ?? MAX_TESTER_WRITES_PER_APPLY;
  if (
    !Number.isSafeInteger(maxSelectedWrites) ||
    maxSelectedWrites < 0 ||
    maxSelectedWrites > MAX_TESTER_WRITES_PER_APPLY
  ) {
    throw new Error('Confirmed tester-write selection limit is invalid.');
  }
  const effectiveApplyBudget =
    confirmedMaxWrites === undefined
      ? Math.min(MAX_APPLY_REQUEST_COST, availableRateBudget ?? 0)
      : MAX_APPLY_REQUEST_COST;
  for (const [audience, desired, currentEmails] of audiences) {
    for (const tester of desired) {
      if (currentEmails.has(tester.email)) continue;
      const existing = accountTesterByEmail.get(tester.email);
      const requestCost = INTERNAL_TESTER_WRITE_REQUEST_COST;
      const candidate = [
        ...selected,
        {
          audience,
          email: tester.email,
          ...(existing === undefined ? {} : { existing }),
        },
      ];
      const candidateAuditReserve = finalAuditRequestReserve(
        groups,
        inventory,
        internalSnapshot,
        candidate,
      );
      if (
        selected.length >= maxSelectedWrites ||
        selectedRequestCost + requestCost >
          MAX_TESTER_WRITE_REQUEST_COST_PER_APPLY ||
        selectedRequestCost +
          requestCost +
          RATE_LIMIT_GROUP_SETUP_RESERVE +
          candidateAuditReserve >
          effectiveApplyBudget
      ) {
        selectionComplete = true;
        break;
      }
      selected.push({
        audience,
        email: tester.email,
        ...(existing === undefined ? {} : { existing }),
      });
      costByEmail.set(tester.email, requestCost);
      selectedRequestCost += requestCost;
    }
    if (selectionComplete) break;
  }
  const auditReserve = finalAuditRequestReserve(
    groups,
    inventory,
    internalSnapshot,
    selected,
  );
  return {
    auditReserve,
    costByEmail,
    deferred: 0,
    pendingCount: pendingEmails.length,
    remainingRateCost: selectedRequestCost,
    selected: Object.freeze(selected),
    selectedEmails: new Set(selected.map(({ email }) => email)),
  };
};
const syncTesters = async (
  client: AscClient,
  assertionClient: AscClient | undefined,
  appId: string,
  identityRegistry: TesterIdentityAudienceRegistry,
  inventoryState: AppWideTesterInventoryState,
  internalDesired: readonly Tester[],
  accountTesterByEmail: ReadonlyMap<string, JsonApiResource>,
  target: GroupTarget,
  snapshotGroupTesters: readonly JsonApiResource[],
  snapshotGroupBuilds: readonly JsonApiResource[],
  desired: readonly Tester[],
  writePlan: TesterWritePlan,
  preflightInternalUsers: ReadonlyMap<string, JsonApiResource> | undefined,
  configuration: AscAppConfiguration,
  apply: boolean,
  actions: SyncAction[],
): Promise<TesterSyncResult> => {
  const { id: groupId, name: groupName } = target;
  const audience: TesterAudience = target.internal ? 'internal' : 'external';
  const groupTesters = snapshotGroupTesters;
  const groupBuilds = snapshotGroupBuilds;
  const expectedGroupBuilds = canonicalGroupBuildInventory(groupBuilds);
  const approved = new Set(desired.map(({ email }) => email));
  const inGroup = new Set<string>();
  for (const tester of groupTesters) {
    const email = identityRegistry.registerResolvedTester(tester, audience);
    if (inGroup.has(email)) {
      throw new Error(
        'Apple returned duplicate managed-group tester identities.',
      );
    }
    inGroup.add(email);
  }
  if ([...inGroup].some((email) => !approved.has(email))) {
    throw new Error(
      `${groupName} contains tester(s) outside the complete approved roster; no changes were made.`,
    );
  }
  const matchedTesterByEmail = new Map<string, JsonApiResource>();
  for (const tester of desired) {
    const resource = accountTesterByEmail.get(tester.email);
    if (resource !== undefined) {
      identityRegistry.registerResolvedTester(resource, audience, approved);
      matchedTesterByEmail.set(tester.email, resource);
    }
  }
  const pendingWrites: Array<
    | {
        readonly kind: 'create';
        readonly tester: Tester;
      }
    | {
        readonly kind: 'link';
        readonly resource: JsonApiResource;
        readonly tester: Tester;
      }
  > = [];
  let unchanged = 0;
  for (const tester of desired) {
    if (inGroup.has(tester.email)) {
      unchanged += 1;
      continue;
    }
    const existing = matchedTesterByEmail.get(tester.email);
    if (existing === undefined) pendingWrites.push({ kind: 'create', tester });
    else pendingWrites.push({ kind: 'link', resource: existing, tester });
  }
  const selectedWrites = pendingWrites.filter(({ tester }) =>
    writePlan.selectedEmails.has(tester.email),
  );
  const deferredWrites = pendingWrites.length - selectedWrites.length;
  writePlan.deferred += deferredWrites;
  const existingToLink = selectedWrites.filter(
    (
      item,
    ): item is {
      readonly kind: 'link';
      readonly resource: JsonApiResource;
      readonly tester: Tester;
    } => item.kind === 'link',
  );
  const missing = selectedWrites.filter(
    (
      item,
    ): item is {
      readonly kind: 'create';
      readonly tester: Tester;
    } => item.kind === 'create',
  );
  if (unchanged > 0) {
    actions.push({
      detail: `${unchanged} approved tester(s) already belong to ${groupName}.`,
      kind: 'tester',
      status: 'unchanged',
    });
  }
  const invitationConsequence = target.internal
    ? expectedGroupBuilds.length === 0
      ? '; Apple may send a real TestFlight invitation email'
      : `; ${expectedGroupBuilds.length} existing build(s) mean Apple may immediately send invitation email, including a real TestFlight invitation email`
    : '; Apple may send a real TestFlight invitation email';
  if (existingToLink.length > 0) {
    actions.push({
      detail: `Add ${existingToLink.length} approved existing tester(s) to ${groupName}${invitationConsequence}.`,
      kind: 'tester',
      status: actionStatus(apply),
    });
  }
  if (missing.length > 0) {
    actions.push({
      detail: `Create and add ${missing.length} approved tester(s) to ${groupName}${invitationConsequence}.`,
      kind: 'tester',
      status: actionStatus(apply),
    });
  }
  if (deferredWrites > 0) {
    actions.push({
      detail: `Defer ${deferredWrites} approved tester write(s) for ${groupName}; a fresh preview, digest review, and human-confirmed apply are required for the next chunk.`,
      kind: 'tester',
      status: 'deferred',
    });
  }
  let expectedGroupTesters = canonicalResources(groupTesters);
  const hasTesterWrites = existingToLink.length > 0 || missing.length > 0;
  if (!apply || !hasTesterWrites) {
    return { deferredWrites, expectedBuilds: expectedGroupBuilds };
  }
  if (assertionClient === undefined || groupId === null) {
    throw new Error('Apply is missing a verified group assertion.');
  }
  const liveIdentityRegistry = new TesterIdentityAudienceRegistry(
    inventoryState.current,
  );
  const selectedApprovedTesters = selectedWrites.map(({ tester }) => tester);
  const liveInternalUsers = target.internal
    ? (preflightInternalUsers ??
      (await collectEligibleInternalTesterUsers(
        assertionClient,
        selectedApprovedTesters,
      )))
    : undefined;
  const evolveProjectedGlobalInventory = (
    added: readonly JsonApiResource[],
  ): void => {
    inventoryState.current = evolveAppWideTesterInventory(
      inventoryState.current,
      target,
      added,
    );
  };
  const acceptVerifiedTester = async (
    tester: JsonApiResource,
    email: string,
  ): Promise<void> => {
    const expectedAfter = canonicalResources([...expectedGroupTesters, tester]);
    await assertGroupTesterRosterTotal(
      assertionClient,
      groupId,
      expectedAfter.length,
    );
    expectedGroupTesters = expectedAfter;
    evolveProjectedGlobalInventory([tester]);
    const requestCost = writePlan.costByEmail.get(email);
    if (
      requestCost === undefined ||
      requestCost > writePlan.remainingRateCost
    ) {
      throw new Error('Selected tester write rate-limit plan is inconsistent.');
    }
    writePlan.remainingRateCost -= requestCost;
  };
  if (existingToLink.length > 0) {
    for (const { resource: tester, tester: approvedTester } of existingToLink) {
      const expectedEmail = testerEmail(tester);
      assertTesterWriteRateLimitBudget(
        assertionClient,
        writePlan.remainingRateCost,
        writePlan.auditReserve,
      );
      if (target.internal) {
        if (approvedTester.email !== expectedEmail) {
          throw new Error(
            'An existing beta tester is outside the approved internal roster.',
          );
        }
        await assertExactInternalTesterEligibility(
          assertionClient,
          appId,
          approvedTester,
          liveInternalUsers?.get(approvedTester.email),
        );
      }
      await assertExactAppIdentity(assertionClient, appId, configuration);
      const relationshipSnapshot = await assertCurrentTesterAppAudienceSafety(
        assertionClient,
        appId,
        tester.id,
        audience,
        inventoryState.current,
      );
      const liveTester = await readExactBetaTester(
        assertionClient,
        tester.id,
        expectedEmail,
      );
      liveIdentityRegistry.registerResolvedTester(
        liveTester,
        audience,
        approved,
      );
      identityRegistry.registerResolvedTester(liveTester, audience, approved);
      await verifyTargetGroupEnvelopeBeforeTesterWrite(
        assertionClient,
        appId,
        target,
        expectedGroupTesters.length,
        expectedGroupBuilds,
      );
      assertTesterWriteRateLimitBudget(
        assertionClient,
        writePlan.remainingRateCost,
        writePlan.auditReserve,
      );
      const relationshipResult = await client.mutate(
        'POST',
        `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/betaTesters`,
        { data: [{ id: liveTester.id, type: 'betaTesters' }] },
      );
      if (relationshipResult !== null) {
        throw new Error(
          'Apple tester relationship mutation outcome is indeterminate.',
        );
      }
      const linked = await readExactBetaTester(
        assertionClient,
        liveTester.id,
        expectedEmail,
      );
      await assertExactTesterRelationshipDelta(
        assertionClient,
        linked.id,
        appId,
        groupId,
        target.internal,
        relationshipSnapshot,
      );
      liveIdentityRegistry.registerResolvedTester(linked, audience, approved);
      identityRegistry.registerResolvedTester(linked, audience, approved);
      await acceptVerifiedTester(linked, expectedEmail);
    }
  }
  for (const { tester } of missing) {
    assertTesterWriteRateLimitBudget(
      assertionClient,
      writePlan.remainingRateCost,
      writePlan.auditReserve,
    );
    if (target.internal) {
      await assertExactInternalTesterEligibility(
        assertionClient,
        appId,
        tester,
        liveInternalUsers?.get(tester.email),
      );
    }
    await assertExactAppIdentity(assertionClient, appId, configuration);
    await verifyTargetGroupEnvelopeBeforeTesterWrite(
      assertionClient,
      appId,
      target,
      expectedGroupTesters.length,
      expectedGroupBuilds,
    );
    assertTesterWriteRateLimitBudget(
      assertionClient,
      writePlan.remainingRateCost,
      writePlan.auditReserve,
    );
    const created = await client.mutate(
      'POST',
      '/v1/betaTesters',
      {
        data: {
          attributes: {
            email: tester.email,
            ...(tester.firstName === undefined
              ? {}
              : { firstName: tester.firstName }),
            ...(tester.lastName === undefined
              ? {}
              : { lastName: tester.lastName }),
          },
          relationships: {
            betaGroups: {
              data: [{ id: groupId, type: 'betaGroups' }],
            },
          },
          type: 'betaTesters',
        },
      },
      'betaTesters',
    );
    if (created === null) {
      throw new Error('Apple did not return the created beta tester.');
    }
    const createdEmailFromResponse = testerEmail(created);
    if (createdEmailFromResponse !== tester.email) {
      throw new Error('Apple returned an unexpected created tester identity.');
    }
    const verifiedCreated = await readExactBetaTester(
      assertionClient,
      created.id,
      tester.email,
    );
    await assertCreatedBetaTesterHasExactRelationships(
      assertionClient,
      verifiedCreated.id,
      groupId,
      appId,
      target.internal,
    );
    const createdEmail = identityRegistry.registerCreatedTester(
      verifiedCreated,
      audience,
    );
    liveIdentityRegistry.registerCreatedTester(verifiedCreated, audience);
    if (createdEmail !== tester.email) {
      throw new Error('Apple returned an unexpected created tester identity.');
    }
    await acceptVerifiedTester(verifiedCreated, tester.email);
  }
  return { deferredWrites, expectedBuilds: expectedGroupBuilds };
};
const localizationAttributes = (review: BetaTestInfo): JsonObject => ({
  description: review.betaDescription,
  feedbackEmail: review.feedbackEmail,
});
const buildLocalizationAttributes = (review: BetaTestInfo): JsonObject => ({
  whatsNew: review.whatsNew,
});
interface LocalizationEvidence {
  readonly appLocalizations: readonly JsonApiResource[];
  readonly buildLocalizations?: readonly JsonApiResource[];
}
interface TestInfoSyncEvidence {
  readonly appLocalizations: readonly JsonApiResource[];
}
const nullableLocalizationString = (
  value: unknown,
  label: string,
): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Apple returned a malformed ${label}.`);
  }
  return value;
};
const requiredLocalizationString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Apple returned a malformed ${label}.`);
  }
  return value;
};
const appLocalizationLocale = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value
  ) {
    throw new Error('Apple returned a malformed beta app locale.');
  }
  return value;
};
const supportedBuildLocalizationLocale = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !BETA_BUILD_LOCALIZATION_LOCALES.has(value)
  ) {
    throw new Error('Apple returned an unsupported beta-localization locale.');
  }
  return value;
};
const projectAppLocalization = (
  localization: JsonApiResource,
): JsonApiResource => {
  if (localization.type !== 'betaAppLocalizations') {
    throw new Error('Apple returned an unexpected beta-localization resource.');
  }
  requireOpaqueIdentifier(localization.id, 'Beta app localization ID');
  const attributes = attributesOf(localization);
  return canonicalResource({
    attributes: {
      description: requiredLocalizationString(
        attributes.description,
        'beta app localization description',
      ),
      feedbackEmail: nullableLocalizationString(
        attributes.feedbackEmail,
        'beta app localization feedback email',
      ),
      locale: appLocalizationLocale(attributes.locale),
      marketingUrl: nullableLocalizationString(
        attributes.marketingUrl,
        'beta app localization marketing URL',
      ),
      privacyPolicyUrl: nullableLocalizationString(
        attributes.privacyPolicyUrl,
        'beta app localization privacy-policy URL',
      ),
      tvOsPrivacyPolicy: nullableLocalizationString(
        attributes.tvOsPrivacyPolicy,
        'beta app localization tvOS privacy policy',
      ),
    },
    id: localization.id,
    type: 'betaAppLocalizations',
  });
};
const projectBuildLocalization = (
  localization: JsonApiResource,
): JsonApiResource => {
  if (localization.type !== 'betaBuildLocalizations') {
    throw new Error(
      'Apple returned an unexpected beta-build-localization resource.',
    );
  }
  requireOpaqueIdentifier(localization.id, 'Beta build localization ID');
  const attributes = attributesOf(localization);
  return canonicalResource({
    attributes: {
      locale: supportedBuildLocalizationLocale(attributes.locale),
      whatsNew: requiredLocalizationString(
        attributes.whatsNew,
        'beta build localization What to Test text',
      ),
    },
    id: localization.id,
    type: 'betaBuildLocalizations',
  });
};
const projectLocalizationInventory = (
  localizations: readonly JsonApiResource[],
  kind: 'app' | 'build',
): readonly JsonApiResource[] => {
  const projected = localizations.map((localization) =>
    kind === 'app'
      ? projectAppLocalization(localization)
      : projectBuildLocalization(localization),
  );
  const ids = new Set<string>();
  const locales = new Set<string>();
  for (const localization of projected) {
    const locale = attributesOf(localization).locale;
    if (typeof locale !== 'string') {
      throw new Error('Apple returned a malformed localization locale.');
    }
    if (ids.has(localization.id) || locales.has(locale)) {
      throw new Error(
        `Apple returned duplicate beta ${kind} localization identity evidence.`,
      );
    }
    ids.add(localization.id);
    locales.add(locale);
  }
  return canonicalResources(projected);
};
const expectedAppLocalization = (
  id: string,
  review: BetaTestInfo,
  previous?: JsonApiResource,
): JsonApiResource => {
  const previousAttributes =
    previous === undefined ? EMPTY_JSON_OBJECT : attributesOf(previous);
  return projectAppLocalization({
    attributes: {
      description: review.betaDescription,
      feedbackEmail: review.feedbackEmail,
      locale: review.locale,
      marketingUrl: previousAttributes.marketingUrl ?? null,
      privacyPolicyUrl: previousAttributes.privacyPolicyUrl ?? null,
      tvOsPrivacyPolicy: previousAttributes.tvOsPrivacyPolicy ?? null,
    },
    id,
    type: 'betaAppLocalizations',
  });
};
const expectedBuildLocalization = (
  id: string,
  review: BetaTestInfo,
): JsonApiResource =>
  projectBuildLocalization({
    attributes: { locale: review.locale, whatsNew: review.whatsNew },
    id,
    type: 'betaBuildLocalizations',
  });
const plannedLocalizationId = (
  prefix: string,
  current: readonly JsonApiResource[],
): string => {
  const ids = new Set(current.map(({ id }) => id));
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
};
const withLocalization = (
  current: readonly JsonApiResource[],
  replacement: JsonApiResource,
  replacedId?: string,
): readonly JsonApiResource[] =>
  projectLocalizationInventory(
    [...current.filter(({ id }) => id !== replacedId), replacement],
    replacement.type === 'betaAppLocalizations' ? 'app' : 'build',
  );
const assertSameLocalizationInventory = (
  current: readonly JsonApiResource[],
  expected: readonly JsonApiResource[],
  label: string,
): void => {
  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw new Error(`${label} changed after the confirmed plan.`);
  }
};
const syncTestInfo = async (
  client: AscClient,
  assertionClient: AscClient | undefined,
  appId: string,
  review: BetaTestInfo,
  configuration: AscAppConfiguration,
  rateBudget: ApplyRateBudget | undefined,
  apply: boolean,
  actions: SyncAction[],
): Promise<TestInfoSyncEvidence> => {
  const localizations = await listVerifiedBetaAppLocalizationsForApp(
    client,
    appId,
  );
  const projected = projectLocalizationInventory(localizations, 'app');
  const assertExactLiveReviewInventory = async (): Promise<void> => {
    if (assertionClient === undefined) {
      throw new Error('Apply is missing its app-localization assertion.');
    }
    const current = projectLocalizationInventory(
      await listVerifiedBetaAppLocalizationsForApp(assertionClient, appId),
      'app',
    );
    assertSameLocalizationInventory(
      current,
      projected,
      'Complete beta app localization inventory',
    );
    await assertExactAppIdentity(assertionClient, appId, configuration);
  };
  const matching = projected.filter(
    (item) => attributesOf(item).locale === review.locale,
  );
  const expectedLocalization = localizationAttributes(review);
  const existing = matching[0];
  if (existing === undefined) {
    if (projected.length >= MAX_APP_LOCALIZATIONS) {
      throw new Error(
        'Beta app localization inventory has no safe capacity for an additive write.',
      );
    }
    actions.push({
      detail: `Create ${review.locale} TestFlight beta description.`,
      kind: 'beta-localization',
      status: actionStatus(apply),
    });
    if (apply) {
      if (assertionClient === undefined || rateBudget === undefined) {
        throw new Error('Apply is missing its app-localization assertion.');
      }
      rateBudget.assertStageStart(assertionClient, 'app-localization');
      await assertExactLiveReviewInventory();
      rateBudget.assertBeforeMutation(assertionClient, 'app-localization');
      const created = await client.mutate(
        'POST',
        '/v1/betaAppLocalizations',
        {
          data: {
            attributes: { locale: review.locale, ...expectedLocalization },
            relationships: { app: { data: { id: appId, type: 'apps' } } },
            type: 'betaAppLocalizations',
          },
        },
        'betaAppLocalizations',
      );
      if (created === null) {
        throw new Error('Apple did not return the beta app localization.');
      }
      await assertBetaAppLocalizationBelongsToApp(
        assertionClient,
        created.id,
        appId,
      );
      const expectedCreated = expectedAppLocalization(created.id, review);
      const projectedCreated = projectAppLocalization(created);
      if (canonicalJson(projectedCreated) !== canonicalJson(expectedCreated)) {
        throw new Error(
          'Apple returned unexpected beta app localization attributes.',
        );
      }
      rateBudget.complete('app-localization');
      return {
        appLocalizations: withLocalization(projected, projectedCreated),
      };
    }
    const planned = expectedAppLocalization(
      plannedLocalizationId('planned-beta-app-localization', projected),
      review,
    );
    return {
      appLocalizations: withLocalization(projected, planned),
    };
  } else if (
    sameSelectedAttributes(attributesOf(existing), expectedLocalization)
  ) {
    actions.push({
      detail: `${review.locale} TestFlight beta description already matches.`,
      kind: 'beta-localization',
      status: 'unchanged',
    });
    if (apply) {
      if (rateBudget === undefined) {
        throw new Error('Apply is missing its rate-limit budget.');
      }
      rateBudget.complete('app-localization');
    }
  } else {
    actions.push({
      detail: `Update ${review.locale} TestFlight beta description.`,
      kind: 'beta-localization',
      status: actionStatus(apply),
    });
    if (apply) {
      if (assertionClient === undefined || rateBudget === undefined) {
        throw new Error('Apply is missing its app-localization assertion.');
      }
      rateBudget.assertStageStart(assertionClient, 'app-localization');
      await assertExactLiveReviewInventory();
      rateBudget.assertBeforeMutation(assertionClient, 'app-localization');
      const updated = await client.mutate(
        'PATCH',
        `/v1/betaAppLocalizations/${encodeURIComponent(existing.id)}`,
        {
          data: {
            attributes: expectedLocalization,
            id: existing.id,
            type: 'betaAppLocalizations',
          },
        },
        'betaAppLocalizations',
      );
      if (updated === null || updated.id !== existing.id) {
        throw new Error('Apple did not return the beta app localization.');
      }
      await assertBetaAppLocalizationBelongsToApp(
        assertionClient,
        updated.id,
        appId,
      );
      const expectedUpdated = expectedAppLocalization(
        existing.id,
        review,
        existing,
      );
      const projectedUpdated = projectAppLocalization(updated);
      if (canonicalJson(projectedUpdated) !== canonicalJson(expectedUpdated)) {
        throw new Error(
          'Apple returned unexpected beta app localization attributes.',
        );
      }
      rateBudget.complete('app-localization');
      return {
        appLocalizations: withLocalization(
          projected,
          projectedUpdated,
          existing.id,
        ),
      };
    }
    return {
      appLocalizations: withLocalization(
        projected,
        expectedAppLocalization(existing.id, review, existing),
        existing.id,
      ),
    };
  }
  return { appLocalizations: projected };
};
const assertBuildLocalizationRelationship = async (
  client: AscClient,
  localizationId: string,
  buildId: string,
): Promise<void> => {
  const relatedBuild = await client.get(
    `/v1/betaBuildLocalizations/${encodeURIComponent(localizationId)}/build`,
    'builds',
  );
  if (relatedBuild.id !== buildId) {
    throw new Error(
      'Beta build localization does not belong to the selected exact build.',
    );
  }
};
const listVerifiedBetaBuildLocalizations = async (
  client: AscClient,
  buildId: string,
): Promise<readonly JsonApiResource[]> => {
  const localizations = validateBoundedResourceInventory(
    await client.list(betaBuildLocalizationsPath(buildId)),
    'betaBuildLocalizations',
    'beta build localization',
    BETA_BUILD_LOCALIZATION_LOCALES.size,
  );
  for (const localization of localizations) {
    await assertBuildLocalizationRelationship(client, localization.id, buildId);
  }
  return localizations;
};
const syncBuildLocalization = async (
  client: AscClient,
  assertionClient: AscClient | undefined,
  appId: string,
  build: JsonApiResource,
  review: BetaTestInfo,
  configuration: AscAppConfiguration,
  expectedAppLocalizations: readonly JsonApiResource[],
  rateBudget: ApplyRateBudget | undefined,
  apply: boolean,
  actions: SyncAction[],
): Promise<readonly JsonApiResource[]> => {
  const localizations = await listVerifiedBetaBuildLocalizations(
    client,
    build.id,
  );
  const projected = projectLocalizationInventory(localizations, 'build');
  const assertExactLiveLocalizationState = async (): Promise<void> => {
    if (assertionClient === undefined) {
      throw new Error('Apply is missing its build-localization assertion.');
    }
    const currentAppLocalizations = projectLocalizationInventory(
      await listVerifiedBetaAppLocalizationsForApp(assertionClient, appId),
      'app',
    );
    assertSameLocalizationInventory(
      currentAppLocalizations,
      expectedAppLocalizations,
      'Complete beta app localization inventory',
    );
    const currentBuildLocalizations = projectLocalizationInventory(
      await listVerifiedBetaBuildLocalizations(assertionClient, build.id),
      'build',
    );
    assertSameLocalizationInventory(
      currentBuildLocalizations,
      projected,
      'Complete beta build localization inventory',
    );
    await assertExactAppIdentity(assertionClient, appId, configuration);
  };
  const matching = projected.filter(
    (localization) => attributesOf(localization).locale === review.locale,
  );
  const expected = buildLocalizationAttributes(review);
  const existing = matching[0];
  if (existing === undefined) {
    if (projected.length >= BETA_BUILD_LOCALIZATION_LOCALES.size) {
      throw new Error(
        'Beta build localization inventory has no safe capacity for an additive write.',
      );
    }
    actions.push({
      detail: `Create ${review.locale} What to Test text for build ${build.id}.`,
      kind: 'beta-build-localization',
      status: actionStatus(apply),
    });
    if (apply) {
      if (assertionClient === undefined || rateBudget === undefined) {
        throw new Error('Apply is missing its build-localization assertion.');
      }
      rateBudget.assertStageStart(assertionClient, 'build-localization');
      await assertExactLiveLocalizationState();
      rateBudget.assertBeforeMutation(assertionClient, 'build-localization');
      const created = await client.mutate(
        'POST',
        '/v1/betaBuildLocalizations',
        {
          data: {
            attributes: { locale: review.locale, ...expected },
            relationships: {
              build: { data: { id: build.id, type: 'builds' } },
            },
            type: 'betaBuildLocalizations',
          },
        },
        'betaBuildLocalizations',
      );
      if (created === null) {
        throw new Error('Apple did not return the beta build localization.');
      }
      await assertBuildLocalizationRelationship(
        assertionClient,
        created.id,
        build.id,
      );
      const projectedCreated = projectBuildLocalization(created);
      const expectedCreated = expectedBuildLocalization(created.id, review);
      if (canonicalJson(projectedCreated) !== canonicalJson(expectedCreated)) {
        throw new Error(
          'Apple returned unexpected beta build localization attributes.',
        );
      }
      rateBudget.complete('build-localization');
      return withLocalization(projected, projectedCreated);
    }
    return withLocalization(
      projected,
      expectedBuildLocalization(
        plannedLocalizationId('planned-beta-build-localization', projected),
        review,
      ),
    );
  }
  if (sameSelectedAttributes(attributesOf(existing), expected)) {
    actions.push({
      detail: `${review.locale} What to Test text already matches build ${build.id}.`,
      kind: 'beta-build-localization',
      status: 'unchanged',
    });
    if (apply) {
      if (rateBudget === undefined) {
        throw new Error('Apply is missing its rate-limit budget.');
      }
      rateBudget.complete('build-localization');
    }
    return projected;
  }
  actions.push({
    detail: `Update ${review.locale} What to Test text for build ${build.id}.`,
    kind: 'beta-build-localization',
    status: actionStatus(apply),
  });
  if (apply) {
    if (assertionClient === undefined || rateBudget === undefined) {
      throw new Error('Apply is missing its build-localization assertion.');
    }
    rateBudget.assertStageStart(assertionClient, 'build-localization');
    await assertExactLiveLocalizationState();
    rateBudget.assertBeforeMutation(assertionClient, 'build-localization');
    const updated = await client.mutate(
      'PATCH',
      `/v1/betaBuildLocalizations/${encodeURIComponent(existing.id)}`,
      {
        data: {
          attributes: expected,
          id: existing.id,
          type: 'betaBuildLocalizations',
        },
      },
      'betaBuildLocalizations',
    );
    if (updated === null || updated.id !== existing.id) {
      throw new Error('Apple did not return the beta build localization.');
    }
    await assertBuildLocalizationRelationship(
      assertionClient,
      updated.id,
      build.id,
    );
    const projectedUpdated = projectBuildLocalization(updated);
    const expectedUpdated = expectedBuildLocalization(existing.id, review);
    if (canonicalJson(projectedUpdated) !== canonicalJson(expectedUpdated)) {
      throw new Error(
        'Apple returned unexpected beta build localization attributes.',
      );
    }
    rateBudget.complete('build-localization');
    return withLocalization(projected, projectedUpdated, existing.id);
  }
  return withLocalization(
    projected,
    expectedBuildLocalization(existing.id, review),
    existing.id,
  );
};
const assertCompleteLocalizationEvidence = async (
  client: AscClient,
  appId: string,
  build: JsonApiResource | null,
  expected: LocalizationEvidence,
): Promise<void> => {
  const currentApp = projectLocalizationInventory(
    await listVerifiedBetaAppLocalizationsForApp(client, appId),
    'app',
  );
  assertSameLocalizationInventory(
    currentApp,
    expected.appLocalizations,
    'Complete beta app localization inventory',
  );
  if (build === null) {
    if (expected.buildLocalizations !== undefined) {
      throw new Error('Unexpected beta build localization evidence.');
    }
    return;
  }
  if (expected.buildLocalizations === undefined) {
    throw new Error('Missing complete beta build localization evidence.');
  }
  const currentBuild = projectLocalizationInventory(
    await listVerifiedBetaBuildLocalizations(client, build.id),
    'build',
  );
  assertSameLocalizationInventory(
    currentBuild,
    expected.buildLocalizations,
    'Complete beta build localization inventory',
  );
};
const assertExpectedBuildLocalization = async (
  client: AscClient,
  build: JsonApiResource,
  review: BetaTestInfo,
): Promise<void> => {
  const localizations = await listVerifiedBetaBuildLocalizations(
    client,
    build.id,
  );
  const matching = localizations.filter(
    (localization) =>
      localization.type === 'betaBuildLocalizations' &&
      attributesOf(localization).locale === review.locale,
  );
  if (
    localizations.some(({ type }) => type !== 'betaBuildLocalizations') ||
    matching.length !== 1 ||
    !sameSelectedAttributes(
      attributesOf(matching[0] as JsonApiResource),
      buildLocalizationAttributes(review),
    )
  ) {
    throw new Error(
      'Selected build What to Test localization does not match the approved value.',
    );
  }
};
const INTERNAL_BETA_STATES = new Set([
  'PROCESSING',
  'PROCESSING_EXCEPTION',
  'MISSING_EXPORT_COMPLIANCE',
  'READY_FOR_BETA_TESTING',
  'IN_BETA_TESTING',
  'EXPIRED',
  'IN_EXPORT_COMPLIANCE_REVIEW',
]);
const EXTERNAL_BETA_STATES = new Set([
  'PROCESSING',
  'PROCESSING_EXCEPTION',
  'MISSING_EXPORT_COMPLIANCE',
  'READY_FOR_BETA_TESTING',
  'IN_BETA_TESTING',
  'EXPIRED',
  'READY_FOR_BETA_SUBMISSION',
  'IN_EXPORT_COMPLIANCE_REVIEW',
  'WAITING_FOR_BETA_REVIEW',
  'IN_BETA_REVIEW',
  'BETA_REJECTED',
  'BETA_APPROVED',
  'NOT_APPLICABLE',
]);
const requireBuildBetaStates = (
  detail: JsonApiResource,
): {
  externalBuildState: string;
  internalBuildState: string;
} => {
  const attributes = attributesOf(detail);
  const internalBuildState = attributes.internalBuildState;
  const externalBuildState = attributes.externalBuildState;
  if (
    typeof internalBuildState !== 'string' ||
    !INTERNAL_BETA_STATES.has(internalBuildState) ||
    typeof externalBuildState !== 'string' ||
    !EXTERNAL_BETA_STATES.has(externalBuildState)
  ) {
    throw new Error('Apple returned an unknown build beta state.');
  }
  if (
    internalBuildState !== 'READY_FOR_BETA_TESTING' &&
    internalBuildState !== 'IN_BETA_TESTING'
  ) {
    throw new Error(
      'The selected build is not ready for internal beta testing; export-compliance answers remain a human action.',
    );
  }
  return { externalBuildState, internalBuildState };
};
const resolveBuild = async (
  client: AscClient,
  appId: string,
  build: string,
): Promise<JsonApiResource> => {
  const parameters: Record<string, string> = {
    'fields[builds]':
      'version,uploadedDate,expired,processingState,buildAudienceType,usesNonExemptEncryption',
    'filter[app]': appId,
    'filter[expired]': 'false',
    'filter[preReleaseVersion.platform]': 'IOS',
    'filter[processingState]': 'VALID',
    limit: build === 'latest' ? '1' : '2',
  };
  if (build === 'latest') parameters.sort = '-uploadedDate';
  else parameters['filter[id]'] = build;
  const builds =
    build === 'latest'
      ? null
      : await client.list(appendQuery('/v1/builds', parameters));
  const selected =
    build === 'latest'
      ? await client.first(appendQuery('/v1/builds', parameters))
      : builds?.[0];
  if (
    selected === undefined ||
    selected === null ||
    selected.type !== 'builds' ||
    (build !== 'latest' && (builds?.length !== 1 || selected.id !== build)) ||
    attributesOf(selected).expired !== false ||
    attributesOf(selected).processingState !== 'VALID'
  ) {
    throw new Error(
      build === 'latest'
        ? 'No single processed, non-expired TestFlight build is available.'
        : 'The requested processed, non-expired TestFlight build was not found.',
    );
  }
  const selectedAttributes = attributesOf(selected);
  if (
    typeof selectedAttributes.version !== 'string' ||
    !/^[A-Za-z0-9._+-]{1,100}$/u.test(selectedAttributes.version) ||
    typeof selectedAttributes.uploadedDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(
      selectedAttributes.uploadedDate,
    ) ||
    typeof selectedAttributes.usesNonExemptEncryption !== 'boolean' ||
    (selectedAttributes.buildAudienceType !== 'APP_STORE_ELIGIBLE' &&
      selectedAttributes.buildAudienceType !== 'INTERNAL_ONLY')
  ) {
    throw new Error('Apple returned malformed selected-build metadata.');
  }
  const selectedApp = await client.get(
    `/v1/builds/${encodeURIComponent(selected.id)}/app`,
    'apps',
  );
  if (selectedApp.id !== appId) {
    throw new Error(
      'The selected build does not belong to the configured app.',
    );
  }
  const preReleaseVersion = await client.get(
    appendQuery(
      `/v1/builds/${encodeURIComponent(selected.id)}/preReleaseVersion`,
      { 'fields[preReleaseVersions]': 'platform' },
    ),
    'preReleaseVersions',
  );
  await assertPreReleaseVersionScope(
    client,
    preReleaseVersion.id,
    appId,
    selected.id,
  );
  if (attributesOf(preReleaseVersion).platform !== 'IOS') {
    throw new Error('The selected build is not positively identified as iOS.');
  }
  const betaDetail = await client.get(
    appendQuery(
      `/v1/builds/${encodeURIComponent(selected.id)}/buildBetaDetail`,
      {
        'fields[buildBetaDetails]':
          'autoNotifyEnabled,internalBuildState,externalBuildState',
      },
    ),
    'buildBetaDetails',
  );
  await assertBuildBetaDetailBelongsToBuild(client, betaDetail.id, selected.id);
  const states = requireBuildBetaStates(betaDetail);
  return canonicalResource({
    ...selected,
    attributes: { ...selectedAttributes, ...states, platform: 'IOS' },
  });
};
const assertLiveBuildStillMatches = async (
  client: AscClient,
  appId: string,
  expectedBuild: JsonApiResource,
): Promise<JsonApiResource> => {
  const liveBuild = await resolveBuild(client, appId, expectedBuild.id);
  const expected = attributesOf(expectedBuild);
  const live = attributesOf(liveBuild);
  if (
    liveBuild.id !== expectedBuild.id ||
    !sameSelectedAttributes(live, {
      buildAudienceType: expected.buildAudienceType,
      expired: false,
      platform: expected.platform,
      processingState: 'VALID',
      uploadedDate: expected.uploadedDate,
      usesNonExemptEncryption: expected.usesNonExemptEncryption,
      version: expected.version,
    })
  ) {
    throw new Error('Selected build metadata changed before distribution.');
  }
  return liveBuild;
};
const buildSummary = (
  build: JsonApiResource,
): NonNullable<SyncResult['selectedBuild']> => {
  const attributes = attributesOf(build);
  const version = attributes.version;
  const uploadedDate = attributes.uploadedDate;
  const audienceType = attributes.buildAudienceType;
  const externalBuildState = attributes.externalBuildState;
  const internalBuildState = attributes.internalBuildState;
  const platform = attributes.platform;
  const usesNonExemptEncryption = attributes.usesNonExemptEncryption;
  if (
    typeof externalBuildState !== 'string' ||
    typeof internalBuildState !== 'string' ||
    platform !== 'IOS' ||
    typeof usesNonExemptEncryption !== 'boolean'
  ) {
    throw new Error('Selected build readiness metadata was not captured.');
  }
  return {
    externalBuildState,
    id: build.id,
    internalBuildState,
    platform,
    usesNonExemptEncryption,
    ...(typeof version === 'string' ? { version } : {}),
    ...(typeof uploadedDate === 'string' ? { uploadedDate } : {}),
    ...(typeof audienceType === 'string' ? { audienceType } : {}),
  };
};
const verifyGroupReadyForBuild = async (
  client: AscClient,
  appId: string,
  target: GroupTarget,
  approved: readonly Tester[],
  expectedBuilds: readonly JsonApiResource[],
): Promise<readonly JsonApiResource[]> => {
  if (target.id === null) throw new Error('Apply has no verified group ID.');
  const groups = await listVerifiedBetaGroupsForApp(client, appId);
  const matches = groups.filter(({ id }) => id === target.id);
  if (
    groups.length > MAX_GROUPS ||
    groups.some(({ type }) => type !== 'betaGroups') ||
    matches.length !== 1 ||
    !hasSafeGroupSettings(
      matches[0] as JsonApiResource,
      target.name,
      target.internal,
    )
  ) {
    throw new Error(
      'Managed group settings changed before build distribution.',
    );
  }
  const currentTesters = await listVerifiedGroupTesters(client, target.id);
  const currentBuilds = await listVerifiedGroupBuilds(client, appId, target.id);
  const actualEmails = currentTesters.map(testerEmail).sort();
  const approvedEmails = approved.map(({ email }) => email).sort();
  if (!sameStrings(actualEmails, approvedEmails)) {
    throw new Error(
      'Managed group audience or builds changed before distribution.',
    );
  }
  assertSameGroupBuildInventory(currentBuilds, expectedBuilds);
  return canonicalResources(currentTesters);
};
const attachBuild = async (
  client: AscClient,
  assertionClient: AscClient | undefined,
  appId: string,
  target: GroupTarget,
  build: JsonApiResource,
  approvedAudience: readonly Tester[],
  expectedBuilds: readonly JsonApiResource[],
  testerInventoryState: AppWideTesterInventoryState,
  internalDesired: readonly Tester[],
  configuration: AscAppConfiguration,
  review: BetaTestInfo | undefined,
  localizationEvidence: LocalizationEvidence | undefined,
  rateBudget: ApplyRateBudget | undefined,
  apply: boolean,
  actions: SyncAction[],
): Promise<readonly JsonApiResource[]> => {
  const rateStage: ApplyRateStage = 'internal-build';
  const { id: groupId, name: groupName } = target;
  const approvedAudienceCount = approvedAudience.length;
  const consequence = `grant access to ${approvedAudienceCount} approved internal tester(s) and may send real TestFlight invitation email`;
  const linked = canonicalGroupBuildInventory(expectedBuilds);
  if (linked.some((item) => item.type === 'builds' && item.id === build.id)) {
    if (apply) {
      if (rateBudget === undefined) {
        throw new Error('Apply is missing its rate-limit budget.');
      }
      rateBudget.complete(rateStage);
    }
    actions.push({
      detail: `Selected build is already distributed to ${groupName}.`,
      kind: 'build-distribution',
      status: 'unchanged',
    });
    return canonicalResources(linked);
  }
  if (linked.length >= MAX_GROUP_BUILDS) {
    throw new Error(
      'Managed group build inventory has no safe capacity for an additive write.',
    );
  }
  actions.push({
    detail: `Distribute build ${build.id} to ${groupName}; ${consequence}.`,
    kind: 'build-distribution',
    status: actionStatus(apply),
  });
  if (apply) {
    if (
      assertionClient === undefined ||
      groupId === null ||
      rateBudget === undefined
    ) {
      throw new Error('Apply is missing its build-distribution assertion.');
    }
    if (review === undefined) {
      throw new Error('Build distribution is missing approved What to Test.');
    }
    if (localizationEvidence === undefined) {
      throw new Error(
        'Build distribution is missing complete localization evidence.',
      );
    }
    rateBudget.assertStageStart(assertionClient, rateStage);
    const expectedTargetTesters = await verifyGroupReadyForBuild(
      assertionClient,
      appId,
      target,
      approvedAudience,
      linked,
    );
    await assertExpectedBuildLocalization(assertionClient, build, review);
    await assertLiveBuildStillMatches(assertionClient, appId, build);
    await assertCompleteLocalizationEvidence(
      assertionClient,
      appId,
      build,
      localizationEvidence,
    );
    testerInventoryState.current = await assertEquivalentAppTesterInventory(
      assertionClient,
      appId,
      testerInventoryState.current,
      internalDesired,
    );
    await assertExactAppIdentity(assertionClient, appId, configuration);
    await verifyTargetGroupSnapshotBeforeBuildWrite(
      assertionClient,
      appId,
      target,
      expectedTargetTesters,
      linked,
    );
    rateBudget.assertBeforeMutation(assertionClient, rateStage);
    const relationshipResult = await client.mutate(
      'POST',
      `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`,
      { data: [{ id: build.id, type: 'builds' }] },
    );
    if (relationshipResult !== null) {
      throw new Error(
        'Apple build relationship mutation outcome is indeterminate.',
      );
    }
    const expectedAfter = canonicalGroupBuildInventory([...linked, build]);
    const readback = await listVerifiedGroupBuilds(
      assertionClient,
      appId,
      groupId,
    );
    assertSameGroupBuildInventory(readback, expectedAfter);
    rateBudget.complete(rateStage);
    return expectedAfter;
  }
  return canonicalGroupBuildInventory([...linked, build]);
};
const assertApp = (
  apps: readonly JsonApiResource[],
  configuration: AscAppConfiguration,
): JsonApiResource => {
  const app = apps[0];
  if (
    apps.length !== 1 ||
    app === undefined ||
    app.type !== 'apps' ||
    attributesOf(app).bundleId !== configuration.bundleId ||
    attributesOf(app).name !== configuration.appName ||
    attributesOf(app).sku !== configuration.appSku
  ) {
    throw new Error(
      `Expected exactly one App Store Connect app named ${configuration.appName} with bundle ID ${configuration.bundleId} and SKU ${configuration.appSku}.`,
    );
  }
  return app;
};
const assertExactAppIdentity = async (
  client: AscClient,
  expectedAppId: string,
  configuration: AscAppConfiguration,
): Promise<JsonApiResource> => {
  const app = assertApp(
    await client.list(appIdentityPath(configuration)),
    configuration,
  );
  if (app.id !== expectedAppId) {
    throw new Error('The exact App Store Connect app identity changed.');
  }
  return app;
};
const verifyAppliedState = async (
  client: AscClient,
  appId: string,
  options: ReconcileOptions,
  build: JsonApiResource | null,
  localizationEvidence: LocalizationEvidence | undefined,
  expectedTesterInventory: AppWideTesterInventory,
  expectedInternalBuilds: readonly JsonApiResource[],
  downstreamDeferred: boolean,
  configuration: AscAppConfiguration,
): Promise<void> => {
  const groups = await listVerifiedBetaGroupsForApp(client, appId);
  if (
    groups.length > MAX_GROUPS ||
    groups.some(({ type }) => type !== 'betaGroups')
  ) {
    throw new Error('Apply verification found an unsafe group inventory.');
  }
  const find = (name: string): JsonApiResource => {
    const matches = groups.filter(
      (group) =>
        group.type === 'betaGroups' &&
        attributesOf(group).name === name &&
        attributesOf(group).isInternalGroup === true,
    );
    if (matches.length !== 1)
      throw new Error(`Apply verification failed for ${name}.`);
    const match = matches[0] as JsonApiResource;
    const expected: JsonObject = {
      feedbackEnabled: true,
      hasAccessToAllBuilds: false,
    };
    if (!sameSelectedAttributes(attributesOf(match), expected)) {
      throw new Error(`Apply verification found unsafe settings for ${name}.`);
    }
    return match;
  };
  const internal = find(configuration.internalGroupName);
  for (const [group, name] of [
    [internal, configuration.internalGroupName],
  ] as const) {
    const actual = await listVerifiedGroupTesters(client, group.id);
    const expectedMemberships = expectedTesterInventory.groupMemberships
      .filter(({ groupId }) => groupId === group.id)
      .map((membership) => {
        if (membership.email === undefined) {
          throw new Error(
            `Apply verification is missing a tester identity in ${name}.`,
          );
        }
        return `${membership.id}:${membership.email}`;
      })
      .sort();
    const actualMemberships = actual
      .map((tester) => `${tester.id}:${testerEmail(tester)}`)
      .sort();
    if (!sameStrings(actualMemberships, expectedMemberships)) {
      throw new Error(`Apply verification found a roster mismatch in ${name}.`);
    }
  }
  assertSameGroupBuildInventory(
    await listVerifiedGroupBuilds(client, appId, internal.id),
    expectedInternalBuilds,
  );
  if (downstreamDeferred) {
    if (localizationEvidence !== undefined) {
      throw new Error('Deferred downstream work produced unexpected evidence.');
    }
  } else if (options.testInfo !== undefined) {
    if (localizationEvidence === undefined) {
      throw new Error('Apply verification is missing localization evidence.');
    }
    await assertCompleteLocalizationEvidence(
      client,
      appId,
      build,
      localizationEvidence,
    );
  } else if (localizationEvidence !== undefined) {
    throw new Error(
      'Apply verification found unexpected localization evidence.',
    );
  }
  await assertEquivalentAppTesterInventory(
    client,
    appId,
    expectedTesterInventory,
    options.internalTesters,
  );
  await assertExactAppIdentity(client, appId, configuration);
};
const verifyManagedGroupInventoryBeforeMutation = async (
  client: AscClient,
  appId: string,
  snapshot: ManagedGroupSnapshot,
): Promise<void> => {
  if (snapshot.target.id === null) return;
  await assertBetaGroupBelongsToApp(client, snapshot.target.id, appId);
  const currentTesters = await listVerifiedGroupTesters(
    client,
    snapshot.target.id,
  );
  const currentBuilds = await listVerifiedGroupBuilds(
    client,
    appId,
    snapshot.target.id,
  );
  if (
    !sameStrings(
      resourceIdentitySet(snapshot.testers, 'betaTesters', 'tester'),
      resourceIdentitySet(currentTesters, 'betaTesters', 'tester'),
    ) ||
    !sameStrings(
      resourceIdentitySet(snapshot.builds, 'builds', 'group build'),
      resourceIdentitySet(currentBuilds, 'builds', 'group build'),
    )
  ) {
    throw new Error(
      'Managed group audience or builds changed after confirmation; no mutations were attempted.',
    );
  }
};
const reconcileTestFlight = async (
  client: AscClient,
  options: ReconcileOptions,
  assertionClient?: AscClient,
  beforeVerification?: () => void,
  confirmedTesterWriteLimit?: number,
  captureTesterWriteLimit?: (limit: number) => void,
): Promise<ReconcileResult> => {
  if (
    options.build !== undefined &&
    options.build !== 'latest' &&
    options.testInfo === undefined
  ) {
    throw new Error(
      'An exact build plan or apply requires approved beta test info, including What to Test text.',
    );
  }
  if (options.apply && options.build === 'latest') {
    throw new Error(
      'Apply requires the exact build ID returned by a prior latest-build preview.',
    );
  }
  if (options.internalTesters.length > MAX_INTERNAL_TESTERS) {
    throw new Error("Internal tester input exceeds Apple's 100-user limit.");
  }
  const allTesterEmails = options.internalTesters.map(({ email }) => email);
  if (new Set(allTesterEmails).size !== allTesterEmails.length) {
    throw new Error('Tester inputs must be unique.');
  }
  const apps = await client.list(appIdentityPath(options.app));
  const app = assertApp(apps, options.app);
  const build =
    options.build === undefined
      ? null
      : await resolveBuild(client, app.id, options.build);
  const actions: SyncAction[] = [];
  await preflightInternalTesters(
    client,
    app.id,
    options.internalTesters,
    actions,
  );
  const groups = await listVerifiedBetaGroupsForApp(client, app.id);
  if (
    groups.length > MAX_GROUPS ||
    groups.some(({ type }) => type !== 'betaGroups')
  ) {
    throw new Error('Apple returned an unsafe beta-group inventory.');
  }
  const groupInventoryState: BetaGroupInventoryState = { current: groups };
  const requiredGroupCreations = (
    [[options.app.internalGroupName, true]] as const
  ).filter(
    ([name, internal]) =>
      !groups.some(
        (group) =>
          attributesOf(group).name === name &&
          attributesOf(group).isInternalGroup === internal,
      ),
  ).length;
  if (groups.length + requiredGroupCreations > MAX_GROUPS) {
    throw new Error(
      'App beta-group inventory has no safe capacity for required group creation.',
    );
  }
  const expectedTesterInventory = await inventoryAppTesterCapacity(
    client,
    app.id,
    groups,
    options.internalTesters,
  );
  const testerIdentityRegistry = new TesterIdentityAudienceRegistry(
    expectedTesterInventory,
  );
  const accountTesterByEmail = await collectAccountBetaTesters(
    client,
    testerIdentityRegistry,
    options.internalTesters.length > 0,
  );
  const internalGroupSnapshot = await collectManagedGroupSnapshot(
    client,
    app.id,
    groups,
    options.app.internalGroupName,
    true,
  );
  const testerInventoryState: AppWideTesterInventoryState = {
    current: expectedTesterInventory,
  };
  const testerWritePlan = planTesterWriteChunk(
    groups,
    expectedTesterInventory,
    accountTesterByEmail,
    internalGroupSnapshot,
    options.internalTesters,
    options.app,
    client.rateLimitRemaining(),
    confirmedTesterWriteLimit,
  );
  captureTesterWriteLimit?.(testerWritePlan.selected.length);
  if (
    testerWritePlan.pendingCount > 0 &&
    testerWritePlan.selected.length === 0
  ) {
    throw new Error(
      'Apple request budget leaves no safe tester chunk to preview; no mutations were attempted.',
    );
  }
  let preflightInternalUsers: ReadonlyMap<string, JsonApiResource> | undefined;
  let applyRateBudget: ApplyRateBudget | undefined;
  let enforceDownstreamRateBudget = false;
  if (options.apply) {
    if (assertionClient === undefined) {
      throw new Error('Apply is missing its app-wide tester assertion.');
    }
    groupInventoryState.current = await assertEquivalentBetaGroupInventory(
      assertionClient,
      app.id,
      groupInventoryState.current,
    );
    testerInventoryState.current = await assertEquivalentAppTesterInventory(
      assertionClient,
      app.id,
      expectedTesterInventory,
      options.internalTesters,
    );
    assertTesterWriteRateLimitBudget(
      assertionClient,
      0,
      testerWritePlan.auditReserve,
    );
    for (const snapshot of [internalGroupSnapshot]) {
      if (!snapshot.target.existedInSnapshot) continue;
      await verifyManagedGroupInventoryBeforeMutation(
        assertionClient,
        app.id,
        snapshot,
      );
    }
    const selectedInternalTesters = options.internalTesters.filter(
      ({ email }) => testerWritePlan.selectedEmails.has(email),
    );
    preflightInternalUsers = await collectEligibleInternalTesterUsers(
      assertionClient,
      selectedInternalTesters,
    );
    for (const tester of selectedInternalTesters) {
      await assertExactInternalTesterEligibility(
        assertionClient,
        app.id,
        tester,
        preflightInternalUsers.get(tester.email),
      );
    }
    for (const selected of testerWritePlan.selected) {
      if (selected.existing === undefined) continue;
      const liveTester = await readExactBetaTester(
        assertionClient,
        selected.existing.id,
        selected.email,
      );
      testerIdentityRegistry.registerResolvedTester(
        liveTester,
        selected.audience,
        new Set(options.internalTesters.map(({ email }) => email)),
      );
    }
    if (testerWritePlan.pendingCount === 0) {
      const appLocalizations =
        options.testInfo === undefined
          ? []
          : await listVerifiedBetaAppLocalizationsForApp(
              assertionClient,
              app.id,
            );
      const buildLocalizations =
        options.testInfo === undefined || build === null
          ? []
          : await listVerifiedBetaBuildLocalizations(assertionClient, build.id);
      const ratePlan = downstreamRequestReserve(
        groups,
        testerInventoryState.current,
        internalGroupSnapshot,
        build,
        options.testInfo !== undefined,
        {
          appLocalizationCount: appLocalizations.length,
          buildLocalizationCount: buildLocalizations.length,
        },
      );
      assertTesterWriteRateLimitBudget(assertionClient, 0, ratePlan.total);
      applyRateBudget = new ApplyRateBudget(ratePlan);
      enforceDownstreamRateBudget = true;
    } else {
      assertTesterWriteRateLimitBudget(
        assertionClient,
        testerWritePlan.remainingRateCost + RATE_LIMIT_GROUP_SETUP_RESERVE,
        testerWritePlan.auditReserve,
      );
      const stages = new Map<ApplyRateStage, ApplyRateStageReservation>([
        ['group-internal', { guardCost: 12, totalCost: 33 }],
      ]);
      applyRateBudget = new ApplyRateBudget({
        finalAuditReserve:
          testerWritePlan.remainingRateCost + testerWritePlan.auditReserve,
        stages,
        total:
          RATE_LIMIT_GROUP_SETUP_RESERVE +
          testerWritePlan.remainingRateCost +
          testerWritePlan.auditReserve,
      });
    }
  }
  const internalGroupId = await ensureGroup(
    client,
    assertionClient,
    app.id,
    groups,
    groupInventoryState,
    applyRateBudget,
    options.app.internalGroupName,
    options.app,
    options.apply,
    actions,
  );
  const internalTesterSync = await syncTesters(
    client,
    assertionClient,
    app.id,
    testerIdentityRegistry,
    testerInventoryState,
    options.internalTesters,
    accountTesterByEmail,
    internalGroupId,
    internalGroupSnapshot.testers,
    internalGroupSnapshot.builds,
    options.internalTesters,
    testerWritePlan,
    preflightInternalUsers,
    options.app,
    options.apply,
    actions,
  );
  let expectedInternalBuilds = internalTesterSync.expectedBuilds;
  const selectedTesterWrites = testerWritePlan.selected.length;
  const downstreamDeferred =
    testerWritePlan.deferred > 0 || selectedTesterWrites > 0;
  let localizationEvidence: LocalizationEvidence | undefined;
  if (downstreamDeferred && options.testInfo !== undefined) {
    actions.push({
      detail:
        'Defer TestFlight beta test metadata until every approved tester chunk has been freshly previewed and applied.',
      kind: 'beta-localization',
      status: 'deferred',
    });
  } else if (options.testInfo !== undefined) {
    const testInfoEvidence = await syncTestInfo(
      client,
      assertionClient,
      app.id,
      options.testInfo,
      options.app,
      applyRateBudget,
      options.apply,
      actions,
    );
    if (build !== null) {
      const buildLocalizations = await syncBuildLocalization(
        client,
        assertionClient,
        app.id,
        build,
        options.testInfo,
        options.app,
        testInfoEvidence.appLocalizations,
        applyRateBudget,
        options.apply,
        actions,
      );
      localizationEvidence = {
        appLocalizations: testInfoEvidence.appLocalizations,
        buildLocalizations,
      };
    } else {
      localizationEvidence = {
        appLocalizations: testInfoEvidence.appLocalizations,
      };
    }
  }
  if (downstreamDeferred && build !== null) {
    actions.push({
      detail: `Defer build ${build.id} distribution to ${options.app.internalGroupName} until a fresh zero-backlog preview confirms the complete approved roster.`,
      kind: 'build-distribution',
      status: 'deferred',
    });
  } else if (build !== null) {
    expectedInternalBuilds = await attachBuild(
      client,
      assertionClient,
      app.id,
      internalGroupId,
      build,
      options.internalTesters,
      expectedInternalBuilds,
      testerInventoryState,
      options.internalTesters,
      options.app,
      options.testInfo,
      localizationEvidence,
      applyRateBudget,
      options.apply,
      actions,
    );
  }
  if (options.apply) {
    beforeVerification?.();
    if (assertionClient === undefined) {
      throw new Error('Apply is missing its verification client.');
    }
    if (enforceDownstreamRateBudget) {
      if (applyRateBudget === undefined) {
        throw new Error('Apply is missing its downstream rate-limit budget.');
      }
      applyRateBudget.assertFinalAudit(assertionClient);
    }
    await verifyAppliedState(
      assertionClient,
      app.id,
      options,
      build,
      localizationEvidence,
      testerInventoryState.current,
      expectedInternalBuilds,
      downstreamDeferred,
      options.app,
    );
    actions.push({
      detail: 'Read-back verification passed.',
      kind: 'verification',
      status: 'applied',
    });
  }
  return {
    actions,
    appId: app.id,
    mode: options.apply ? 'apply' : 'plan',
    ...(build === null ? {} : { selectedBuild: buildSummary(build) }),
  };
};
const canonicalResource = (resource: JsonApiResource): JsonApiResource =>
  deepFreezeCanonical(
    canonicalValue(resourceFromUnknown(resource)),
  ) as unknown as JsonApiResource;
const canonicalResources = (
  resources: readonly JsonApiResource[],
): readonly JsonApiResource[] => {
  const canonical = canonicalValue(resources);
  if (!Array.isArray(canonical)) {
    throw new Error('Apple returned a malformed resource list.');
  }
  const result: JsonApiResource[] = [];
  for (let index = 0; index < canonical.length; index += 1) {
    result.push(
      deepFreezeCanonical(
        canonicalValue(resourceFromUnknown(canonical[index])),
      ) as unknown as JsonApiResource,
    );
  }
  result.sort((left, right) => {
    const leftJson = canonicalJson(left);
    const rightJson = canonicalJson(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
  return Object.freeze(result);
};
const canonicalPageSummary = (
  summary: JsonApiPageSummary,
): JsonApiPageSummary => {
  const total = summary?.total;
  if (
    typeof total !== 'number' ||
    !Number.isInteger(total) ||
    total < 0 ||
    total > MAX_TESTERS_PER_GROUP
  ) {
    throw new Error('Apple returned a malformed tester roster total.');
  }
  const resources = canonicalResources(summary.resources);
  if (resources.length !== Math.min(total, 1)) {
    throw new Error('Apple returned an inconsistent tester roster summary.');
  }
  return Object.freeze({ resources, total });
};
type ReadObservation =
  | {
      readonly operation: 'first';
      readonly path: string;
      readonly value: JsonApiResource | null;
    }
  | {
      readonly operation: 'get';
      readonly expectedType: string;
      readonly path: string;
      readonly value: JsonApiResource;
    }
  | {
      readonly operation: 'list';
      readonly path: string;
      readonly value: readonly JsonApiResource[];
    }
  | {
      readonly operation: 'page-summary';
      readonly path: string;
      readonly value: JsonApiPageSummary;
    };
class RecordingReadClient implements AscClient {
  readonly #client: AscClient;
  readonly observations: ReadObservation[] = [];
  constructor(client: AscClient) {
    this.#client = client;
  }
  rateLimitRemaining(): number | null {
    return this.#client.rateLimitRemaining();
  }
  async first(path: string): Promise<JsonApiResource | null> {
    const received = await this.#client.first(path);
    const value = received === null ? null : canonicalResource(received);
    this.observations.push(
      Object.freeze({
        operation: 'first',
        path,
        value,
      }),
    );
    return value;
  }
  async list(path: string): Promise<readonly JsonApiResource[]> {
    const value = canonicalResources(await this.#client.list(path));
    this.observations.push(
      Object.freeze({
        operation: 'list',
        path,
        value,
      }),
    );
    return value;
  }
  async pageSummary(path: string): Promise<JsonApiPageSummary> {
    const value = canonicalPageSummary(await this.#client.pageSummary(path));
    this.observations.push(
      Object.freeze({
        operation: 'page-summary',
        path,
        value,
      }),
    );
    return value;
  }
  async get(path: string, expectedType: string): Promise<JsonApiResource> {
    const value = canonicalResource(await this.#client.get(path, expectedType));
    this.observations.push(
      Object.freeze({
        expectedType,
        operation: 'get',
        path,
        value,
      }),
    );
    return value;
  }
  async mutate(): Promise<JsonApiResource | null> {
    throw new Error('Plan mode attempted an App Store Connect mutation.');
  }
}
class ReplayingApplyClient implements AscClient {
  readonly #client: AscClient;
  readonly #observations: readonly ReadObservation[];
  #index = 0;
  constructor(observations: readonly ReadObservation[], client: AscClient) {
    this.#observations = Object.freeze([...observations]);
    this.#client = client;
  }
  rateLimitRemaining(): number | null {
    return this.#client.rateLimitRemaining();
  }
  #take(
    operation: ReadObservation['operation'],
    path: string,
    expectedType?: string,
  ): ReadObservation {
    const observation = this.#observations[this.#index];
    this.#index += 1;
    if (
      observation === undefined ||
      observation.operation !== operation ||
      observation.path !== path ||
      (operation === 'get' &&
        (observation.operation !== 'get' ||
          observation.expectedType !== expectedType))
    ) {
      throw new Error(
        'Confirmed plan transcript did not match apply execution; refusing further writes.',
      );
    }
    return observation;
  }
  async first(path: string): Promise<JsonApiResource | null> {
    const observation = this.#take('first', path);
    if (observation.operation !== 'first') {
      throw new Error('Confirmed plan transcript was malformed.');
    }
    return observation.value;
  }
  async list(path: string): Promise<readonly JsonApiResource[]> {
    const observation = this.#take('list', path);
    if (observation.operation !== 'list') {
      throw new Error('Confirmed plan transcript was malformed.');
    }
    return observation.value;
  }
  async pageSummary(path: string): Promise<JsonApiPageSummary> {
    const observation = this.#take('page-summary', path);
    if (observation.operation !== 'page-summary') {
      throw new Error('Confirmed plan transcript was malformed.');
    }
    return observation.value;
  }
  async get(path: string, expectedType: string): Promise<JsonApiResource> {
    const observation = this.#take('get', path, expectedType);
    if (observation.operation !== 'get') {
      throw new Error('Confirmed plan transcript was malformed.');
    }
    return observation.value;
  }
  mutate(
    method: MutationMethod,
    path: string,
    body: unknown,
    expectedType?: string,
  ): Promise<JsonApiResource | null> {
    return this.#client.mutate(method, path, body, expectedType);
  }
  assertExhausted(): void {
    if (this.#index !== this.#observations.length) {
      throw new Error(
        'Confirmed plan transcript was not fully consumed; refusing success.',
      );
    }
  }
}
class MutationTrackingClient implements AscClient {
  readonly #client: AscClient;
  acceptedMutations = 0;
  attemptedMutations = 0;
  constructor(client: AscClient) {
    this.#client = client;
  }
  rateLimitRemaining(): number | null {
    return this.#client.rateLimitRemaining();
  }
  async first(path: string): Promise<JsonApiResource | null> {
    const value = await this.#client.first(path);
    return value === null ? null : canonicalResource(value);
  }
  async list(path: string): Promise<readonly JsonApiResource[]> {
    return canonicalResources(await this.#client.list(path));
  }
  async pageSummary(path: string): Promise<JsonApiPageSummary> {
    return canonicalPageSummary(await this.#client.pageSummary(path));
  }
  async get(path: string, expectedType: string): Promise<JsonApiResource> {
    return canonicalResource(
      resourceFromUnknown(
        await this.#client.get(path, expectedType),
        expectedType,
      ),
    );
  }
  async mutate(
    method: MutationMethod,
    path: string,
    body: unknown,
    expectedType?: string,
  ): Promise<JsonApiResource | null> {
    this.attemptedMutations += 1;
    const result = await this.#client.mutate(method, path, body, expectedType);
    this.acceptedMutations += 1;
    if (expectedType === undefined) {
      if (result !== null) {
        throw new Error('Apple relationship mutation returned content.');
      }
      return null;
    }
    if (result === null) {
      throw new Error('Apple resource mutation omitted its response.');
    }
    return canonicalResource(resourceFromUnknown(result, expectedType));
  }
}
const snapshotTesterList = (
  value: readonly Tester[],
  label: string,
  maximum: number,
): readonly Tester[] => {
  const lengthDescriptor =
    Array.isArray(value) && !isProxy(value)
      ? Object.getOwnPropertyDescriptor(value, 'length')
      : undefined;
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' ||
    lengthDescriptor.value > maximum
  ) {
    throw new Error(`${label} exceeds its safety limit.`);
  }
  const snapshot = canonicalValue(value);
  if (!Array.isArray(snapshot)) {
    throw new Error(`${label} contains invalid data.`);
  }
  const result: Tester[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < snapshot.length; index += 1) {
    const tester = snapshot[index];
    if (!isRecord(tester)) throw new Error(`${label} contains invalid data.`);
    const email = requireString(
      tester.email,
      `${label} email`,
      320,
    ).toLocaleLowerCase('en-US');
    if (!isEmail(email)) throw new Error(`${label} contains an invalid email.`);
    const firstName = optionalString(
      tester.firstName,
      `${label} first name`,
      255,
    );
    const lastName = optionalString(tester.lastName, `${label} last name`, 255);
    if (seen.has(email)) {
      throw new Error(`${label} contains a duplicate tester identity.`);
    }
    seen.add(email);
    result.push(
      deepFreezeCanonical(
        canonicalValue({
          email,
          ...(firstName === undefined ? {} : { firstName }),
          ...(lastName === undefined ? {} : { lastName }),
        }),
      ) as unknown as Tester,
    );
  }
  return Object.freeze(
    result.sort((left, right) =>
      left.email < right.email ? -1 : left.email > right.email ? 1 : 0,
    ),
  );
};
interface SnapshotOptions extends ReconcileOptions {
  readonly confirmPlanDigest?: string;
}
const snapshotSyncOptions = (options: SyncOptions): SnapshotOptions => {
  const appInput = options.app;
  const apply = options.apply;
  const internalTesterInput = options.internalTesters;
  const testInput = options.testInfo;
  const buildInput = options.build;
  const confirmPlanDigest = options.confirmPlanDigest;
  if (apply !== true && apply !== false) {
    throw new Error('Sync options are invalid.');
  }
  if (apply && !PLAN_DIGEST_PATTERN.test(confirmPlanDigest ?? '')) {
    throw new Error(
      'Apply requires the sha256 planDigest emitted by a prior preview.',
    );
  }
  if (!apply && confirmPlanDigest !== undefined) {
    throw new Error('Plan mode cannot accept an apply confirmation digest.');
  }
  const internalTesters = snapshotTesterList(
    internalTesterInput,
    'Internal tester input',
    MAX_INTERNAL_TESTERS,
  );
  const testInfo =
    testInput === undefined
      ? undefined
      : Object.freeze(parseTestInfo(testInput));
  const build =
    buildInput === undefined
      ? undefined
      : buildInput === 'latest'
        ? 'latest'
        : requireOpaqueIdentifier(buildInput, 'Build ID');
  const app = Object.freeze({
    appName: requireString(appInput?.appName, 'App name', 255),
    appSku: requireString(appInput?.appSku, 'App SKU', 255),
    bundleId: requireString(appInput?.bundleId, 'Bundle ID', 255),
    internalGroupName: requireString(
      appInput?.internalGroupName,
      'Internal group name',
      255,
    ),
  });
  return Object.freeze({
    app,
    apply,
    internalTesters,
    ...(build === undefined ? {} : { build }),
    ...(confirmPlanDigest === undefined ? {} : { confirmPlanDigest }),
    ...(testInfo === undefined ? {} : { testInfo }),
  });
};
const digestPlan = (
  options: ReconcileOptions,
  observations: readonly ReadObservation[],
  plan: ReconcileResult,
): string => {
  const material = {
    appIdentity: {
      bundleId: options.app.bundleId,
      name: options.app.appName,
      sku: options.app.appSku,
    },
    observations,
    operations: {
      build: options.build ?? null,
      internalTesters: options.internalTesters,
      testInfo: options.testInfo ?? null,
    },
    plan,
    schemaVersion: 15,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(material)).digest('hex')}`;
};
export const syncTestFlight = async (
  client: AscClient,
  options: SyncOptions,
): Promise<SyncResult> => {
  const snapshot = snapshotSyncOptions(options);
  if (snapshot.apply && snapshot.build === 'latest') {
    throw new Error(
      'Apply requires the exact build ID returned by a prior latest-build preview.',
    );
  }
  const previewClient = new RecordingReadClient(client);
  let confirmedTesterWriteLimit = 0;
  const preview = await reconcileTestFlight(
    previewClient,
    {
      ...snapshot,
      apply: false,
    },
    undefined,
    undefined,
    undefined,
    (limit) => {
      confirmedTesterWriteLimit = limit;
    },
  );
  const planDigest = digestPlan(snapshot, previewClient.observations, preview);
  if (!snapshot.apply) return { ...preview, planDigest };
  if (planDigest !== snapshot.confirmPlanDigest) {
    throw new Error(
      'Confirmed plan digest does not match the current inputs and Apple state; no changes were made.',
    );
  }
  const trackingClient = new MutationTrackingClient(client);
  const replayClient = new ReplayingApplyClient(
    previewClient.observations,
    trackingClient,
  );
  try {
    const applied = await reconcileTestFlight(
      replayClient,
      { ...snapshot, apply: true },
      trackingClient,
      () => replayClient.assertExhausted(),
      confirmedTesterWriteLimit,
    );
    return { ...applied, planDigest };
  } catch {
    if (trackingClient.attemptedMutations === 0) {
      throw new Error(
        'Apple state changed after plan confirmation; no mutations were attempted. Run a new preview.',
      );
    }
    throw new Error(
      `App Store Connect apply is partial or indeterminate after ${trackingClient.acceptedMutations} provider-accepted mutation(s); stop, inspect App Store Connect, and run a new preview.`,
    );
  }
};
