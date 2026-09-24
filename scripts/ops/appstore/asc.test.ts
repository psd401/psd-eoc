import { Buffer } from 'node:buffer';
import { generateKeyPairSync, verify } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open as openFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { createAscJwt } from './asc-auth';
import { parseCli as parseConfiguredCli } from './asc-cli';
import { syncTestFlight as syncConfiguredTestFlight } from './asc-commands';
import {
  isPathInside,
  parseTestInfo,
  parseTestInfoJson,
  parseTesterCsv,
  readPrivateFile,
} from './asc-inputs';
import {
  type AscAppConfiguration,
  type AscClient,
  type AscCredentials,
  type BetaTestInfo,
  type JsonApiPageSummary,
  type JsonApiResource,
  type SyncOptions,
} from './asc-model';
import { AppStoreConnectClient } from './asc-resources';
import { type AscTransport, AppStoreConnectTransport } from './asc-transport';
import * as ascEntry from './asc';

const TEST_APP_CONFIGURATION = Object.freeze({
  appName: 'Synthetic Emergency App',
  appSku: 'SYNTHETIC-EOC-IOS',
  bundleId: 'org.example.synthetic.eoc',
  internalGroupName: 'Synthetic Internal Technology',
}) satisfies AscAppConfiguration;

type TestSyncOptions =
  | Omit<Extract<SyncOptions, { readonly apply: false }>, 'app'>
  | Omit<Extract<SyncOptions, { readonly apply: true }>, 'app'>;

// Internal distribution requires every tester to be an eligible App Store
// Connect user. Eligibility has its own dedicated tests; every other test here
// is about tester-write mechanics, so the fixture supplies an eligible user for
// any desired email a test has not already seeded on purpose.
const syncTestFlight = (client: AscClient, options: TestSyncOptions) => {
  const candidate = client as { users?: JsonApiResource[] };
  if (Array.isArray(candidate.users)) {
    const emails: string[] = [];
    for (let index = 0; index < options.internalTesters.length; index += 1) {
      const tester = options.internalTesters[index];
      if (tester !== undefined) emails.push(tester.email);
    }
    seedInternalUsers(
      candidate as { readonly users: JsonApiResource[] },
      emails,
    );
  }
  return syncConfiguredTestFlight(client, {
    ...options,
    app: TEST_APP_CONFIGURATION,
  } as SyncOptions);
};

const parseCli = (arguments_: readonly string[]) =>
  parseConfiguredCli(arguments_, TEST_APP_CONFIGURATION);

const resource = (
  type: string,
  id: string,
  attributes: Record<string, unknown> = {},
): JsonApiResource => ({ attributes, id, type });

const bodyData = (body: unknown): Record<string, unknown> => {
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new Error('Expected JSON:API data.');
  }
  const data = body.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Expected one JSON:API resource.');
  }
  return data as Record<string, unknown>;
};

const dataAttributes = (body: unknown): Record<string, unknown> => {
  const data = bodyData(body);
  const attributes = data.attributes;
  if (
    typeof attributes !== 'object' ||
    attributes === null ||
    Array.isArray(attributes)
  ) {
    throw new Error('Expected JSON:API attributes.');
  }
  return attributes as Record<string, unknown>;
};

const relationshipId = (body: unknown, name: string): string => {
  const data = bodyData(body);
  const relationships = data.relationships;
  if (
    typeof relationships !== 'object' ||
    relationships === null ||
    !(name in relationships)
  ) {
    throw new Error(`Expected ${name} relationship.`);
  }
  const relationship = (relationships as Record<string, unknown>)[name];
  if (
    typeof relationship !== 'object' ||
    relationship === null ||
    !('data' in relationship)
  ) {
    throw new Error(`Expected ${name} relationship data.`);
  }
  const linkage = relationship.data;
  const first = Array.isArray(linkage) ? linkage[0] : linkage;
  if (typeof first !== 'object' || first === null || !('id' in first)) {
    throw new Error(`Expected ${name} linkage ID.`);
  }
  return String(first.id);
};

const relationshipLinkageIds = (body: unknown): readonly string[] => {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('data' in body) ||
    !Array.isArray(body.data)
  ) {
    throw new Error('Expected JSON:API relationship linkages.');
  }
  return body.data.map((linkage) => {
    if (
      typeof linkage !== 'object' ||
      linkage === null ||
      !('id' in linkage) ||
      typeof linkage.id !== 'string'
    ) {
      throw new Error('Expected JSON:API relationship linkage ID.');
    }
    return linkage.id;
  });
};

const sortedTesterEmails = (
  testers: readonly JsonApiResource[],
): readonly string[] =>
  testers
    .map((tester) => {
      const email = tester.attributes?.email;
      if (typeof email !== 'string') {
        throw new Error('Synthetic tester is missing an email.');
      }
      return email.toLocaleLowerCase('en-US');
    })
    .sort();

class StatefulClient implements AscClient {
  rateLimitBudget: number | null = 1_000_000;
  readonly app = resource('apps', 'app-1', {
    bundleId: TEST_APP_CONFIGURATION.bundleId,
    name: TEST_APP_CONFIGURATION.appName,
    sku: TEST_APP_CONFIGURATION.appSku,
  });
  readonly groups = [
    resource('betaGroups', 'internal-group', {
      feedbackEnabled: true,
      hasAccessToAllBuilds: false,
      isInternalGroup: true,
      name: TEST_APP_CONFIGURATION.internalGroupName,
    }),
    resource('betaGroups', 'external-group', {
      feedbackEnabled: true,
      hasAccessToAllBuilds: false,
      isInternalGroup: false,
      name: 'Unmanaged External Staff',
      publicLinkEnabled: false,
    }),
  ];
  readonly buildAttributes: Record<string, unknown> = {
    buildAudienceType: 'APP_STORE_ELIGIBLE',
    expired: false,
    processingState: 'VALID',
    uploadedDate: '2026-08-08T12:00:00Z',
    usesNonExemptEncryption: false,
    version: '1',
  };
  readonly build = resource('builds', 'build-1', this.buildAttributes);
  readonly appBuilds: JsonApiResource[] = [this.build];
  readonly buildAppIds = new Map<string, string>([['build-1', 'app-1']]);
  appBuildLinkageOverride: JsonApiResource[] | undefined;
  preReleaseVersion = resource('preReleaseVersions', 'pre-release-1', {
    platform: 'IOS',
    version: '1.0',
  });
  readonly preReleaseVersionAppIds = new Map<string, string>([
    ['pre-release-1', 'app-1'],
  ]);
  readonly preReleaseVersionBuilds = new Map<string, JsonApiResource[]>([
    ['pre-release-1', [this.build]],
  ]);
  buildBetaDetail = resource('buildBetaDetails', 'build-detail-1', {
    autoNotifyEnabled: false,
    externalBuildState: 'READY_FOR_BETA_SUBMISSION',
    internalBuildState: 'READY_FOR_BETA_TESTING',
  });

  rateLimitRemaining(): number | null {
    return this.rateLimitBudget;
  }
  readonly mutations: Array<{
    body: unknown;
    method: string;
    path: string;
  }> = [];
  readonly getPaths: string[] = [];
  readonly listPaths: string[] = [];
  readonly pageSummaryPaths: string[] = [];
  readonly accountTesters: JsonApiResource[] = [];
  readonly appTesters: JsonApiResource[] = [];
  readonly buildLocalizations: JsonApiResource[] = [];
  readonly buildLocalizationBuildIds = new Map<string, string>();
  buildBetaDetailBuildId = 'build-1';
  readonly groupAppIds = new Map<string, string>([
    ['internal-group', 'app-1'],
    ['external-group', 'app-1'],
  ]);
  appGroupLinkageOverride: JsonApiResource[] | undefined;
  readonly groupTesters = new Map<string, JsonApiResource[]>([
    ['internal-group', []],
    ['external-group', []],
  ]);
  readonly groupTesterLinkageOverrides = new Map<string, JsonApiResource[]>();
  readonly groupBuilds = new Map<string, JsonApiResource[]>([
    ['internal-group', []],
    ['external-group', []],
  ]);
  readonly groupBuildLinkageOverrides = new Map<string, JsonApiResource[]>();
  readonly individualTesters = new Map<string, JsonApiResource[]>([
    ['build-1', []],
  ]);
  readonly individualTesterLinkageOverrides = new Map<
    string,
    JsonApiResource[]
  >();
  reviewDetails = resource('betaAppReviewDetails', 'review-1', {
    demoAccountName: null,
    demoAccountPassword: null,
    demoAccountRequired: false,
    notes: null,
  });
  reviewDetailsAppId = 'app-1';
  readonly localizations: JsonApiResource[] = [];
  readonly appLocalizationAppIds = new Map<string, string>();
  readonly submissions: JsonApiResource[] = [];
  readonly submissionBuildIds = new Map<string, string>();
  readonly userVisibleApps = new Map<string, JsonApiResource[]>();
  readonly userVisibleAppLinkageOverrides = new Map<
    string,
    JsonApiResource[]
  >();
  readonly testerAppRelationshipOverrides = new Map<
    string,
    JsonApiResource[]
  >();
  readonly testerBuildRelationshipOverrides = new Map<
    string,
    JsonApiResource[]
  >();
  readonly testerGroupRelationshipOverrides = new Map<
    string,
    JsonApiResource[]
  >();
  readonly users: JsonApiResource[] = [
    resource('users', 'user-1', {
      allAppsVisible: true,
      roles: ['APP_MANAGER'],
      username: 'internal@example.invalid',
    }),
  ];

  async first(path: string): Promise<JsonApiResource | null> {
    this.listPaths.push(path);
    if (path.startsWith('/v1/builds?')) return this.build;
    throw new Error(`Unexpected first path ${path}`);
  }

  async pageSummary(path: string): Promise<JsonApiPageSummary> {
    this.pageSummaryPaths.push(path);
    const groupTesterMatch = /^\/v1\/betaGroups\/([^/]+)\/betaTesters\?/u.exec(
      path,
    );
    if (groupTesterMatch?.[1] !== undefined) {
      const testers = this.groupTesters.get(groupTesterMatch[1]) ?? [];
      return { resources: testers.slice(0, 1), total: testers.length };
    }
    const groupTesterLinkageMatch =
      /^\/v1\/betaGroups\/([^/]+)\/relationships\/betaTesters\?/u.exec(path);
    if (groupTesterLinkageMatch?.[1] !== undefined) {
      const testers =
        this.groupTesterLinkageOverrides.get(groupTesterLinkageMatch[1]) ??
        this.groupTesters.get(groupTesterLinkageMatch[1]) ??
        [];
      return { resources: testers.slice(0, 1), total: testers.length };
    }
    throw new Error(`Unexpected page-summary path ${path}`);
  }

  async list(path: string): Promise<readonly JsonApiResource[]> {
    this.listPaths.push(path);
    if (path.startsWith('/v1/apps?')) return [this.app];
    if (path.startsWith('/v1/users?')) return this.users;
    const visibleAppsMatch = /^\/v1\/users\/([^/]+)\/visibleApps\?/u.exec(path);
    if (visibleAppsMatch?.[1] !== undefined) {
      return this.userVisibleApps.get(visibleAppsMatch[1]) ?? [];
    }
    const visibleAppLinkageMatch =
      /^\/v1\/users\/([^/]+)\/relationships\/visibleApps(?:\?.*)?$/u.exec(path);
    if (visibleAppLinkageMatch?.[1] !== undefined) {
      return (
        this.userVisibleAppLinkageOverrides.get(visibleAppLinkageMatch[1]) ??
        this.userVisibleApps.get(visibleAppLinkageMatch[1]) ??
        []
      );
    }
    if (path.startsWith('/v1/apps/app-1/betaGroups?')) return this.groups;
    if (path.startsWith('/v1/apps/app-1/relationships/betaGroups?')) {
      return this.appGroupLinkageOverride ?? this.groups;
    }
    if (path.startsWith('/v1/betaTesters?')) {
      if (
        path.includes('filter%5Bapps%5D=') ||
        path.includes('filter[apps]=')
      ) {
        return this.appTesters;
      }
      return this.accountTesters;
    }
    if (path.startsWith('/v1/apps/app-1/betaAppLocalizations?'))
      return this.localizations;
    if (path.startsWith('/v1/apps/app-1/builds?')) return this.appBuilds;
    if (path.startsWith('/v1/apps/app-1/relationships/builds?')) {
      return this.appBuildLinkageOverride ?? this.appBuilds;
    }
    const preReleaseBuildsMatch =
      /^\/v1\/preReleaseVersions\/([^/]+)\/builds\?/u.exec(path);
    if (preReleaseBuildsMatch?.[1] !== undefined) {
      return (
        this.preReleaseVersionBuilds.get(preReleaseBuildsMatch[1]) ?? [
          this.build,
        ]
      );
    }
    if (path.startsWith('/v1/builds/build-1/betaBuildLocalizations?'))
      return this.buildLocalizations;
    if (path.startsWith('/v1/builds?')) return [this.build];
    if (path.startsWith('/v1/betaAppReviewSubmissions?'))
      return this.submissions;
    const testerLinkageMatch =
      /^\/v1\/betaGroups\/([^/]+)\/relationships\/betaTesters(?:\?.*)?$/u.exec(
        path,
      );
    if (testerLinkageMatch?.[1] !== undefined) {
      return (
        this.groupTesterLinkageOverrides.get(testerLinkageMatch[1]) ??
        this.groupTesters.get(testerLinkageMatch[1]) ??
        []
      );
    }
    const testerMatch = /^\/v1\/betaGroups\/([^/]+)\/betaTesters\?/u.exec(path);
    if (testerMatch?.[1] !== undefined) {
      return this.groupTesters.get(testerMatch[1]) ?? [];
    }
    const testerGroupsMatch =
      /^\/v1\/betaTesters\/([^/]+)\/(?:relationships\/)?betaGroups(?:\?.*)?$/u.exec(
        path,
      );
    if (testerGroupsMatch?.[1] !== undefined) {
      const testerId = testerGroupsMatch[1];
      const overridden = this.testerGroupRelationshipOverrides.get(testerId);
      if (overridden !== undefined) return overridden;
      return this.groups.filter((group) =>
        (this.groupTesters.get(group.id) ?? []).some(
          ({ id }) => id === testerId,
        ),
      );
    }
    const testerAppsMatch =
      /^\/v1\/betaTesters\/([^/]+)\/(?:relationships\/)?apps(?:\?.*)?$/u.exec(
        path,
      );
    if (testerAppsMatch?.[1] !== undefined) {
      const testerId = testerAppsMatch[1];
      const overridden = this.testerAppRelationshipOverrides.get(testerId);
      if (overridden !== undefined) return overridden;
      return this.appTesters.some(({ id }) => id === testerId)
        ? [this.app]
        : [];
    }
    const testerBuildsMatch =
      /^\/v1\/betaTesters\/([^/]+)\/(?:relationships\/)?builds(?:\?.*)?$/u.exec(
        path,
      );
    if (testerBuildsMatch?.[1] !== undefined) {
      const testerId = testerBuildsMatch[1];
      const overridden = this.testerBuildRelationshipOverrides.get(testerId);
      if (overridden !== undefined) return overridden;
      return [...this.individualTesters.entries()]
        .filter(([, testers]) => testers.some(({ id }) => id === testerId))
        .map(([buildId]) =>
          buildId === this.build.id ? this.build : resource('builds', buildId),
        );
    }
    const buildMatch = /^\/v1\/betaGroups\/([^/]+)\/builds\?/u.exec(path);
    if (buildMatch?.[1] !== undefined) {
      return this.groupBuilds.get(buildMatch[1]) ?? [];
    }
    const buildLinkageMatch =
      /^\/v1\/betaGroups\/([^/]+)\/relationships\/builds(?:\?.*)?$/u.exec(path);
    if (buildLinkageMatch?.[1] !== undefined) {
      return (
        this.groupBuildLinkageOverrides.get(buildLinkageMatch[1]) ??
        this.groupBuilds.get(buildLinkageMatch[1]) ??
        []
      );
    }
    const individualMatch = /^\/v1\/builds\/([^/]+)\/individualTesters\?/u.exec(
      path,
    );
    if (individualMatch?.[1] !== undefined) {
      return this.individualTesters.get(individualMatch[1]) ?? [];
    }
    const individualLinkageMatch =
      /^\/v1\/builds\/([^/]+)\/relationships\/individualTesters(?:\?.*)?$/u.exec(
        path,
      );
    if (individualLinkageMatch?.[1] !== undefined) {
      return (
        this.individualTesterLinkageOverrides.get(individualLinkageMatch[1]) ??
        this.individualTesters.get(individualLinkageMatch[1]) ??
        []
      );
    }
    throw new Error(`Unexpected list path ${path}`);
  }

  async get(path: string, expectedType: string): Promise<JsonApiResource> {
    this.getPaths.push(path);
    const betaGroupMatch = /^\/v1\/betaGroups\/([^/?]+)(?:\?.*)?$/u.exec(path);
    if (betaGroupMatch?.[1] !== undefined && expectedType === 'betaGroups') {
      const group = this.groups.find(({ id }) => id === betaGroupMatch[1]);
      if (group !== undefined) return group;
    }
    const buildAppMatch = /^\/v1\/builds\/([^/]+)\/app$/u.exec(path);
    if (buildAppMatch?.[1] !== undefined && expectedType === 'apps') {
      const appId = this.buildAppIds.get(buildAppMatch[1]) ?? this.app.id;
      return appId === this.app.id ? this.app : resource('apps', appId);
    }
    if (
      path.startsWith('/v1/builds/build-1/preReleaseVersion') &&
      expectedType === 'preReleaseVersions'
    ) {
      return this.preReleaseVersion;
    }
    const preReleaseAppMatch = /^\/v1\/preReleaseVersions\/([^/]+)\/app$/u.exec(
      path,
    );
    if (preReleaseAppMatch?.[1] !== undefined && expectedType === 'apps') {
      const appId =
        this.preReleaseVersionAppIds.get(preReleaseAppMatch[1]) ?? this.app.id;
      return appId === this.app.id ? this.app : resource('apps', appId);
    }
    if (
      path.startsWith('/v1/builds/build-1/buildBetaDetail?') &&
      expectedType === 'buildBetaDetails'
    ) {
      return this.buildBetaDetail;
    }
    if (
      path === '/v1/apps/app-1/betaAppReviewDetail' &&
      expectedType === 'betaAppReviewDetails'
    ) {
      return this.reviewDetails;
    }
    const groupAppMatch = /^\/v1\/betaGroups\/([^/]+)\/app$/u.exec(path);
    if (groupAppMatch?.[1] !== undefined && expectedType === 'apps') {
      const appId = this.groupAppIds.get(groupAppMatch[1]) ?? this.app.id;
      return appId === this.app.id ? this.app : resource('apps', appId);
    }
    const reviewDetailsAppMatch =
      /^\/v1\/betaAppReviewDetails\/([^/]+)\/app$/u.exec(path);
    if (reviewDetailsAppMatch?.[1] !== undefined && expectedType === 'apps') {
      return this.reviewDetailsAppId === this.app.id
        ? this.app
        : resource('apps', this.reviewDetailsAppId);
    }
    const appLocalizationAppMatch =
      /^\/v1\/betaAppLocalizations\/([^/]+)\/app$/u.exec(path);
    if (appLocalizationAppMatch?.[1] !== undefined && expectedType === 'apps') {
      const appId =
        this.appLocalizationAppIds.get(appLocalizationAppMatch[1]) ??
        this.app.id;
      return appId === this.app.id ? this.app : resource('apps', appId);
    }
    const buildDetailBuildMatch =
      /^\/v1\/buildBetaDetails\/([^/]+)\/build$/u.exec(path);
    if (buildDetailBuildMatch?.[1] !== undefined && expectedType === 'builds') {
      return this.buildBetaDetailBuildId === this.build.id
        ? this.build
        : resource('builds', this.buildBetaDetailBuildId);
    }
    const betaTesterMatch = /^\/v1\/betaTesters\/([^/?]+)(?:\?.*)?$/u.exec(
      path,
    );
    if (betaTesterMatch?.[1] !== undefined && expectedType === 'betaTesters') {
      const tester = this.accountTesters.find(
        ({ id }) => id === betaTesterMatch[1],
      );
      if (tester !== undefined) return tester;
    }
    const userMatch = /^\/v1\/users\/([^/?]+)(?:\?.*)?$/u.exec(path);
    if (userMatch?.[1] !== undefined && expectedType === 'users') {
      const user = this.users.find(({ id }) => id === userMatch[1]);
      if (user !== undefined) return user;
    }
    const localizationBuildMatch =
      /^\/v1\/betaBuildLocalizations\/([^/]+)\/build$/u.exec(path);
    if (
      localizationBuildMatch?.[1] !== undefined &&
      expectedType === 'builds'
    ) {
      const buildId = this.buildLocalizationBuildIds.get(
        localizationBuildMatch[1],
      );
      if (buildId === this.build.id) return this.build;
      if (buildId !== undefined) return resource('builds', buildId);
    }
    const submissionBuildMatch =
      /^\/v1\/betaAppReviewSubmissions\/([^/]+)\/build$/u.exec(path);
    if (submissionBuildMatch?.[1] !== undefined && expectedType === 'builds') {
      const buildId = this.submissionBuildIds.get(submissionBuildMatch[1]);
      if (buildId === this.build.id) return this.build;
      if (buildId !== undefined) return resource('builds', buildId);
    }
    throw new Error(`Unexpected get path ${path}`);
  }

  async mutate(
    method: 'PATCH' | 'POST',
    path: string,
    body: unknown,
    expectedType?: string,
  ): Promise<JsonApiResource | null> {
    this.mutations.push({ body, method, path });
    if (method === 'POST' && path === '/v1/betaGroups') {
      const attributes = dataAttributes(body);
      const internal = attributes.isInternalGroup === true;
      const group = resource(
        'betaGroups',
        internal ? 'created-internal-group' : 'created-external-group',
        attributes,
      );
      this.groups.push(group);
      this.groupAppIds.set(group.id, relationshipId(body, 'app'));
      this.groupTesters.set(group.id, []);
      this.groupBuilds.set(group.id, []);
      return group;
    }
    const groupPatchMatch = /^\/v1\/betaGroups\/([^/]+)$/u.exec(path);
    if (method === 'PATCH' && groupPatchMatch?.[1] !== undefined) {
      const group = this.groups.find(({ id }) => id === groupPatchMatch[1]);
      if (group === undefined) throw new Error('Missing group to patch.');
      const updated = resource('betaGroups', group.id, {
        ...group.attributes,
        ...dataAttributes(body),
      });
      this.groups.splice(this.groups.indexOf(group), 1, updated);
      return updated;
    }
    if (method === 'POST' && path === '/v1/betaTesters') {
      const attributes = dataAttributes(body);
      const tester = resource(
        'betaTesters',
        `tester-${this.accountTesters.length + 1}`,
        {
          email: attributes.email,
        },
      );
      const groupId = relationshipId(body, 'betaGroups');
      this.accountTesters.push(tester);
      this.appTesters.push(tester);
      this.groupTesters.get(groupId)?.push(tester);
      return tester;
    }
    const testerRelationshipMatch =
      /^\/v1\/betaGroups\/([^/]+)\/relationships\/betaTesters$/u.exec(path);
    if (method === 'POST' && testerRelationshipMatch?.[1] !== undefined) {
      if (
        typeof body !== 'object' ||
        body === null ||
        !('data' in body) ||
        !Array.isArray(body.data)
      ) {
        throw new Error('Expected tester relationship linkages.');
      }
      const target = this.groupTesters.get(testerRelationshipMatch[1]);
      for (const linkage of body.data) {
        if (
          typeof linkage !== 'object' ||
          linkage === null ||
          !('id' in linkage)
        ) {
          throw new Error('Expected tester relationship linkage ID.');
        }
        const tester = this.accountTesters.find(({ id }) => id === linkage.id);
        if (tester !== undefined) target?.push(tester);
        if (tester !== undefined) {
          const appIndex = this.appTesters.findIndex(
            ({ id }) => id === tester.id,
          );
          if (appIndex < 0) this.appTesters.push(tester);
          else this.appTesters.splice(appIndex, 1, tester);
        }
      }
      return null;
    }
    if (method === 'PATCH' && path === '/v1/betaAppReviewDetails/review-1') {
      this.reviewDetails = resource(
        'betaAppReviewDetails',
        'review-1',
        dataAttributes(body),
      );
      return this.reviewDetails;
    }
    if (method === 'PATCH' && path === '/v1/buildBetaDetails/build-detail-1') {
      this.buildBetaDetail = resource('buildBetaDetails', 'build-detail-1', {
        ...this.buildBetaDetail.attributes,
        ...dataAttributes(body),
      });
      return this.buildBetaDetail;
    }
    if (method === 'POST' && path === '/v1/betaAppLocalizations') {
      const localization = resource(
        'betaAppLocalizations',
        'localization-1',
        dataAttributes(body),
      );
      this.localizations.push(localization);
      this.appLocalizationAppIds.set(
        localization.id,
        relationshipId(body, 'app'),
      );
      return localization;
    }
    const appLocalizationPatch = /^\/v1\/betaAppLocalizations\/([^/]+)$/u.exec(
      path,
    );
    if (method === 'PATCH' && appLocalizationPatch?.[1] !== undefined) {
      const localization = this.localizations.find(
        ({ id }) => id === appLocalizationPatch[1],
      );
      if (localization === undefined) {
        throw new Error('Missing app localization to patch.');
      }
      const updated = resource('betaAppLocalizations', localization.id, {
        ...localization.attributes,
        ...dataAttributes(body),
      });
      this.localizations.splice(
        this.localizations.indexOf(localization),
        1,
        updated,
      );
      return updated;
    }
    if (method === 'POST' && path === '/v1/betaBuildLocalizations') {
      const localization = resource(
        'betaBuildLocalizations',
        `build-localization-${this.buildLocalizations.length + 1}`,
        dataAttributes(body),
      );
      this.buildLocalizations.push(localization);
      this.buildLocalizationBuildIds.set(
        localization.id,
        relationshipId(body, 'build'),
      );
      return localization;
    }
    const buildLocalizationPatch =
      /^\/v1\/betaBuildLocalizations\/([^/]+)$/u.exec(path);
    if (method === 'PATCH' && buildLocalizationPatch?.[1] !== undefined) {
      const localization = this.buildLocalizations.find(
        ({ id }) => id === buildLocalizationPatch[1],
      );
      if (localization === undefined) {
        throw new Error('Missing build localization to patch.');
      }
      const updated = resource('betaBuildLocalizations', localization.id, {
        ...localization.attributes,
        ...dataAttributes(body),
      });
      this.buildLocalizations.splice(
        this.buildLocalizations.indexOf(localization),
        1,
        updated,
      );
      return updated;
    }
    const buildMatch =
      /^\/v1\/betaGroups\/([^/]+)\/relationships\/builds$/u.exec(path);
    if (method === 'POST' && buildMatch?.[1] !== undefined) {
      this.groupBuilds.get(buildMatch[1])?.push(this.build);
      return null;
    }
    if (method === 'POST' && path === '/v1/betaAppReviewSubmissions') {
      const submission = resource('betaAppReviewSubmissions', 'submission-1', {
        betaReviewState: 'WAITING_FOR_REVIEW',
      });
      this.submissions.push(submission);
      this.submissionBuildIds.set(submission.id, relationshipId(body, 'build'));
      return submission;
    }
    throw new Error(
      `Unexpected mutation ${method} ${path} (${expectedType ?? 'no type'}).`,
    );
  }
}

class PlanClient extends StatefulClient {
  override readonly groups: JsonApiResource[] = [];

  override async mutate(): Promise<JsonApiResource | null> {
    throw new Error('Plan mode attempted a mutation.');
  }
}

class OrderedStatefulClient extends StatefulClient {
  readonly operations: string[] = [];

  override async list(path: string): Promise<readonly JsonApiResource[]> {
    const result = await super.list(path);
    this.operations.push(`list ${path}`);
    return result;
  }

  override async pageSummary(path: string): Promise<JsonApiPageSummary> {
    const result = await super.pageSummary(path);
    this.operations.push(`pageSummary ${path}`);
    return result;
  }

  override async get(
    path: string,
    expectedType: string,
  ): Promise<JsonApiResource> {
    const result = await super.get(path, expectedType);
    this.operations.push(`get ${path}`);
    return result;
  }

  override async mutate(
    method: 'PATCH' | 'POST',
    path: string,
    body: unknown,
    expectedType?: string,
  ): Promise<JsonApiResource | null> {
    this.operations.push(`mutate ${method} ${path}`);
    return super.mutate(method, path, body, expectedType);
  }
}

class ScaleStatefulClient extends OrderedStatefulClient {
  operationCeiling = Number.POSITIVE_INFINITY;
  providerRequestCeiling = Number.POSITIVE_INFINITY;
  providerRequestCount = 0;
  readonly providerRequests: Array<{ cost: number; operation: string }> = [];
  readonly rateLimitChecks: Array<{
    providerRequestCount: number;
    remaining: number | null;
  }> = [];

  override rateLimitRemaining(): number | null {
    const remaining = super.rateLimitRemaining();
    this.rateLimitChecks.push({
      providerRequestCount: this.providerRequestCount,
      remaining,
    });
    return remaining;
  }

  #assertOperationRoom(): void {
    if (this.operations.length >= this.operationCeiling) {
      throw new Error(
        `Synthetic scale request ceiling ${this.operationCeiling.toLocaleString('en-US')} exceeded.`,
      );
    }
  }

  #recordProviderRequests(operation: string, cost: number): void {
    if (this.providerRequestCount + cost > this.providerRequestCeiling) {
      throw new Error(
        `Synthetic scale provider-request ceiling ${this.providerRequestCeiling.toLocaleString('en-US')} exceeded.`,
      );
    }
    this.providerRequestCount += cost;
    this.providerRequests.push({ cost, operation });
    if (this.rateLimitBudget !== null) {
      this.rateLimitBudget -= cost;
      if (this.rateLimitBudget < 0) {
        throw new Error('Synthetic Apple rate-limit budget exhausted.');
      }
    }
  }

  resetScaleCounters(): void {
    this.operations.splice(0);
    this.providerRequests.splice(0);
    this.rateLimitChecks.splice(0);
    this.providerRequestCount = 0;
  }

  override async first(path: string): Promise<JsonApiResource | null> {
    this.#assertOperationRoom();
    const result = await super.first(path);
    this.operations.push(`first ${path}`);
    this.#recordProviderRequests(`first ${path}`, 1);
    return result;
  }

  override async list(path: string): Promise<readonly JsonApiResource[]> {
    this.#assertOperationRoom();
    const result = await super.list(path);
    this.#recordProviderRequests(
      `list ${path}`,
      Math.max(1, Math.ceil(result.length / 200)),
    );
    return result;
  }

  override async pageSummary(path: string): Promise<JsonApiPageSummary> {
    this.#assertOperationRoom();
    this.#recordProviderRequests(`pageSummary ${path}`, 1);
    return super.pageSummary(path);
  }

  override async get(
    path: string,
    expectedType: string,
  ): Promise<JsonApiResource> {
    this.#assertOperationRoom();
    this.#recordProviderRequests(`get ${path}`, 1);
    return super.get(path, expectedType);
  }

  override async mutate(
    method: 'PATCH' | 'POST',
    path: string,
    body: unknown,
    expectedType?: string,
  ): Promise<JsonApiResource | null> {
    this.#assertOperationRoom();
    this.#recordProviderRequests(`mutate ${method} ${path}`, 1);
    return super.mutate(method, path, body, expectedType);
  }
}

const review: BetaTestInfo = {
  betaDescription: 'Synthetic emergency app beta description.',
  feedbackEmail: 'feedback@example.invalid',
  locale: 'en-US',
  whatsNew: 'Synthetic TestFlight release notes.',
};

// Smallest Apple request budget the apply guard accepts for a zero-write and a
// one-write internal sync. A one-write sync costs more than a zero-write one
// because each internal tester adds account-user eligibility reads. The tests
// below assert the boundary: one below fails without mutating, at the value it
// applies.
const ZERO_WRITE_BUDGET = 433;
const ONE_WRITE_BUDGET = 731;

let seededUserCount = 0;
const seedInternalUsers = (
  client: { readonly users: JsonApiResource[] },
  emails: readonly string[],
): void => {
  for (const email of emails) {
    const normalized = email.toLocaleLowerCase('en-US');
    if (
      client.users.some((user) => {
        const username = (user.attributes as { username?: unknown } | undefined)
          ?.username;
        return (
          typeof username === 'string' &&
          username.toLocaleLowerCase('en-US') === normalized
        );
      })
    ) {
      continue;
    }
    seededUserCount += 1;
    client.users.push(
      resource('users', `seeded-user-${String(seededUserCount)}`, {
        allAppsVisible: true,
        roles: ['APP_MANAGER'],
        username: email,
      }),
    );
  }
};

const supportedBetaBuildLocalizationLocales = [
  'da',
  'de-DE',
  'el',
  'en-AU',
  'en-CA',
  'en-GB',
  'en-US',
  'es-ES',
  'es-MX',
  'fi',
  'fr-CA',
  'fr-FR',
  'id',
  'it',
  'ja',
  'ko',
  'ms',
  'nl-NL',
  'no',
  'pt-BR',
  'pt-PT',
  'ru',
  'sv',
  'th',
  'tr',
  'vi',
  'zh-Hans',
  'zh-Hant',
] as const;

const seedMatchingTestMetadata = (
  client: StatefulClient,
  info: BetaTestInfo = review,
): void => {
  client.localizations.splice(
    0,
    client.localizations.length,
    resource('betaAppLocalizations', 'localization-1', {
      description: info.betaDescription,
      feedbackEmail: info.feedbackEmail,
      locale: info.locale,
    }),
  );
  client.appLocalizationAppIds.set('localization-1', client.app.id);
  client.buildLocalizations.splice(
    0,
    client.buildLocalizations.length,
    resource('betaBuildLocalizations', 'build-localization-1', {
      locale: info.locale,
      whatsNew: info.whatsNew,
    }),
  );
  client.buildLocalizationBuildIds.set('build-localization-1', client.build.id);
};

const seedMatchingFrenchLocalizations = (client: StatefulClient): void => {
  client.localizations.push(
    resource('betaAppLocalizations', 'localization-fr-FR', {
      description: 'Description bêta synthétique approuvée.',
      feedbackEmail: review.feedbackEmail,
      locale: 'fr-FR',
    }),
  );
  client.appLocalizationAppIds.set('localization-fr-FR', client.app.id);
  client.buildLocalizations.push(
    resource('betaBuildLocalizations', 'build-localization-fr-FR', {
      locale: 'fr-FR',
      whatsNew: 'Instructions de test synthétiques approuvées.',
    }),
  );
  client.buildLocalizationBuildIds.set(
    'build-localization-fr-FR',
    client.build.id,
  );
};

const addTypedGroup = (
  client: StatefulClient,
  id: string,
  internal: boolean,
  testers: readonly JsonApiResource[],
): void => {
  client.groups.push(
    resource('betaGroups', id, {
      hasAccessToAllBuilds: false,
      isInternalGroup: internal,
      name: `Synthetic ${id}`,
    }),
  );
  client.groupAppIds.set(id, client.app.id);
  client.groupTesters.set(id, [...testers]);
  client.groupBuilds.set(id, []);
};

const syntheticTesters = (prefix: string, count: number): JsonApiResource[] =>
  Array.from({ length: count }, (_, index) =>
    resource('betaTesters', `${prefix}-${index}`, {
      email: `${prefix}-${index}@example.invalid`,
    }),
  );

type FixedAppIdentityDrift = 'bundleId' | 'id' | 'name' | 'sku';

const appWithIdentityDrift = (drift: FixedAppIdentityDrift): JsonApiResource =>
  resource('apps', drift === 'id' ? 'another-app-id' : 'app-1', {
    bundleId:
      drift === 'bundleId'
        ? 'org.example.concurrent.eoc'
        : TEST_APP_CONFIGURATION.bundleId,
    name:
      drift === 'name'
        ? 'Concurrent Emergency App'
        : TEST_APP_CONFIGURATION.appName,
    sku: drift === 'sku' ? 'CONCURRENT-EOC-IOS' : TEST_APP_CONFIGURATION.appSku,
  });

interface RequestedSync {
  readonly build?: string;
  readonly internalTesters: readonly {
    readonly email: string;
    readonly firstName?: string;
    readonly lastName?: string;
  }[];
  readonly testInfo?: BetaTestInfo;
}

const previewAndApply = async (client: AscClient, options: RequestedSync) => {
  const preview = await syncTestFlight(client, { ...options, apply: false });
  return syncTestFlight(client, {
    ...options,
    apply: true,
    confirmPlanDigest: preview.planDigest,
  });
};

const writePrivate = async (path: string, contents: string): Promise<void> => {
  const handle = await openFile(path, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
  } finally {
    await handle.close();
  }
};

const createHttpCredentials = (): AscCredentials => {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  return {
    issuerId: 'synthetic-issuer',
    keyId: 'synthetic-key',
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
};

const createHttpClient = (): AppStoreConnectClient =>
  new AppStoreConnectClient(createHttpCredentials());

const TRUSTED_PAGINATION_PATH =
  '/v1/betaTesters?fields%5BbetaTesters%5D=email&filter%5Bapps%5D=app-1&filter%5Bapps%5D=app-2&limit=200';
const APP_STORE_CONNECT_ORIGIN = 'https://api.appstoreconnect.apple.com';

const paginationLinks = (
  input: Parameters<typeof fetch>[0] | string,
  next: string | null = null,
): { readonly next: string | null; readonly self: string } => ({
  next,
  self: new URL(String(input), APP_STORE_CONNECT_ORIGIN).href,
});

const paginatedBody = (
  input: Parameters<typeof fetch>[0] | string,
  data: readonly JsonApiResource[],
  next: string | null = null,
  total = data.length,
): unknown => {
  const url = new URL(String(input), APP_STORE_CONNECT_ORIGIN);
  return {
    data,
    links: paginationLinks(url.href, next),
    meta: {
      paging: {
        limit: Number(url.searchParams.get('limit')),
        total,
      },
    },
  };
};

const rejectedPaginationContinuation = async (
  next: string,
): Promise<{ readonly calls: number; readonly message: string }> => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls += 1;
    return new Response(JSON.stringify(paginatedBody(input, [], next, 200)), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  try {
    let message = '';
    try {
      await createHttpClient().list(TRUSTED_PAGINATION_PATH);
    } catch (error) {
      message = String(error);
    }
    return { calls, message };
  } finally {
    globalThis.fetch = originalFetch;
  }
};

describe('App Store Connect authentication', () => {
  test('creates a standards-compliant short-lived ES256 token', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const token = createAscJwt(
      {
        issuerId: 'issuer-id',
        keyId: 'key-id',
        privateKey: privateKey
          .export({ format: 'pem', type: 'pkcs8' })
          .toString(),
      },
      new Date('2026-08-08T12:00:00Z'),
    );
    const [headerPart, payloadPart, signaturePart] = token.split('.');
    expect(headerPart).toBeDefined();
    expect(payloadPart).toBeDefined();
    expect(signaturePart).toBeDefined();
    const header = JSON.parse(
      Buffer.from(headerPart ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const payload = JSON.parse(
      Buffer.from(payloadPart ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(header).toEqual({ alg: 'ES256', kid: 'key-id', typ: 'JWT' });
    expect(payload.aud).toBe('appstoreconnect-v1');
    expect(payload.iss).toBe('issuer-id');
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(
      1_200,
    );
    expect(
      verify(
        'sha256',
        Buffer.from(`${headerPart}.${payloadPart}`),
        { dsaEncoding: 'ieee-p1363', key: publicKey },
        Buffer.from(signaturePart ?? '', 'base64url'),
      ),
    ).toBe(true);
  });
});

describe('App Store Connect HTTP safety', () => {
  test('keeps fixed-origin HTTP transport independent from resource parsing', async () => {
    const transport = new AppStoreConnectTransport(createHttpCredentials());
    expect(transport.validatedUrl('/v1/apps?limit=1').href).toBe(
      `${APP_STORE_CONNECT_ORIGIN}/v1/apps?limit=1`,
    );
    expect(() =>
      transport.validatedUrl('https://example.invalid/v1/apps'),
    ).toThrow(/unexpected URL/u);

    const requestedUrls: string[] = [];
    const injectedTransport: AscTransport = {
      rateLimitRemaining: () => 99,
      requestJson: (_method, url) => {
        requestedUrls.push(url.href);
        return Promise.resolve({ data: [resource('apps', 'app-1')] });
      },
      validatedContinuationUrl: () => {
        throw new Error('Unexpected continuation.');
      },
      validatedUrl: (path) => new URL(path, APP_STORE_CONNECT_ORIGIN),
    };
    const client = new AppStoreConnectClient(
      createHttpCredentials(),
      injectedTransport,
    );
    expect(await client.first('/v1/apps?limit=1')).toEqual(
      resource('apps', 'app-1'),
    );
    expect(client.rateLimitRemaining()).toBe(99);
    expect(requestedUrls).toEqual([
      `${APP_STORE_CONNECT_ORIGIN}/v1/apps?limit=1`,
    ]);
  });

  test('accepts only the exact documented status for each request shape', async () => {
    const originalFetch = globalThis.fetch;
    let responseFactory = (): Response =>
      new Response(JSON.stringify(paginatedBody('/v1/apps?limit=1', [])), {
        status: 200,
      });
    globalThis.fetch = (async () =>
      responseFactory()) as unknown as typeof fetch;
    const client = createHttpClient();
    const resourceBody = JSON.stringify({
      data: { id: 'safe-resource-id', type: 'betaGroups' },
    });
    try {
      responseFactory = () =>
        new Response(JSON.stringify(paginatedBody('/v1/apps?limit=1', [])), {
          status: 200,
        });
      expect(await client.list('/v1/apps?limit=1')).toEqual([]);

      for (const status of [201, 206]) {
        responseFactory = () =>
          new Response(JSON.stringify({ data: [] }), { status });
        await expect(client.list('/v1/apps?limit=1')).rejects.toThrow(
          `HTTP ${status}`,
        );
      }
      responseFactory = () => new Response(null, { status: 200 });
      await expect(client.list('/v1/apps?limit=1')).rejects.toThrow(
        'unusable response',
      );

      responseFactory = () => new Response(resourceBody, { status: 201 });
      expect(
        await client.mutate('POST', '/v1/betaGroups', {}, 'betaGroups'),
      ).toMatchObject({ id: 'safe-resource-id', type: 'betaGroups' });
      for (const status of [200, 202, 206]) {
        responseFactory = () => new Response(resourceBody, { status });
        await expect(
          client.mutate('POST', '/v1/betaGroups', {}, 'betaGroups'),
        ).rejects.toThrow('indeterminate');
      }
      responseFactory = () => new Response(null, { status: 201 });
      await expect(
        client.mutate('POST', '/v1/betaGroups', {}, 'betaGroups'),
      ).rejects.toThrow('indeterminate');

      responseFactory = () => new Response(resourceBody, { status: 200 });
      expect(
        await client.mutate(
          'PATCH',
          '/v1/betaGroups/safe-resource-id',
          {},
          'betaGroups',
        ),
      ).toMatchObject({ id: 'safe-resource-id', type: 'betaGroups' });
      for (const status of [201, 202, 206]) {
        responseFactory = () => new Response(resourceBody, { status });
        await expect(
          client.mutate(
            'PATCH',
            '/v1/betaGroups/safe-resource-id',
            {},
            'betaGroups',
          ),
        ).rejects.toThrow('indeterminate');
      }
      responseFactory = () => new Response(null, { status: 200 });
      await expect(
        client.mutate(
          'PATCH',
          '/v1/betaGroups/safe-resource-id',
          {},
          'betaGroups',
        ),
      ).rejects.toThrow('indeterminate');

      responseFactory = () => new Response(null, { status: 204 });
      expect(
        await client.mutate(
          'POST',
          '/v1/betaGroups/safe-resource-id/relationships/builds',
          {},
        ),
      ).toBeNull();
      responseFactory = () => new Response(null, { status: 200 });
      await expect(
        client.mutate(
          'POST',
          '/v1/betaGroups/safe-resource-id/relationships/builds',
          {},
        ),
      ).rejects.toThrow('indeterminate');
      for (const status of [201, 206]) {
        responseFactory = () => new Response(resourceBody, { status });
        await expect(
          client.mutate(
            'POST',
            '/v1/betaGroups/safe-resource-id/relationships/builds',
            {},
          ),
        ).rejects.toThrow('indeterminate');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('parses only a complete, internally consistent Apple rate-limit budget', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const client = createHttpClient();
      expect(client.rateLimitRemaining()).toBeNull();
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(paginatedBody('/v1/apps?limit=1', [])), {
          headers: {
            'X-Rate-Limit': 'user-hour-lim:3500;user-hour-rem:3000;',
          },
          status: 200,
        })) as unknown as typeof fetch;
      expect(await client.list('/v1/apps?limit=1')).toEqual([]);
      expect(client.rateLimitRemaining()).toBe(3_000);

      globalThis.fetch = (async () =>
        new Response(JSON.stringify(paginatedBody('/v1/apps?limit=1', [])), {
          status: 200,
        })) as unknown as typeof fetch;
      expect(await client.list('/v1/apps?limit=1')).toEqual([]);
      expect(client.rateLimitRemaining()).toBeNull();

      for (const malformed of [
        '',
        'user-hour-lim:3500;',
        'user-hour-rem:3000;user-hour-lim:3500;',
        'user-hour-lim:0;user-hour-rem:0;',
        'user-hour-lim:3500;user-hour-rem:3501;',
        'user-hour-lim:3500;user-hour-rem:-1;',
        'user-hour-lim:3500;user-hour-rem:1.5;',
        'user-hour-lim:3500; user-hour-rem:3000;',
        'user-hour-lim:3500;user-hour-rem:3000;unexpected:1;',
        'user-hour-lim:99999999999999999999;user-hour-rem:3000;',
      ]) {
        const malformedClient = createHttpClient();
        globalThis.fetch = (async () =>
          new Response(JSON.stringify(paginatedBody('/v1/apps?limit=1', [])), {
            headers: { 'X-Rate-Limit': malformed },
            status: 200,
          })) as unknown as typeof fetch;
        await expect(
          malformedClient.list('/v1/apps?limit=1'),
          malformed,
        ).rejects.toThrow('malformed rate-limit budget');
        expect(malformedClient.rateLimitRemaining(), malformed).toBeNull();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('validates one-item page summaries and their complete paging totals', async () => {
    const originalFetch = globalThis.fetch;
    const client = createHttpClient();
    const path =
      '/v1/betaGroups/safe-group/betaTesters?fields%5BbetaTesters%5D=email&limit=1';
    let responseBody: unknown = {
      data: [
        resource('betaTesters', 'safe-tester', {
          email: 'safe@example.invalid',
        }),
      ],
      meta: { paging: { limit: 1, total: 1 } },
    };
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify(responseBody), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      expect(await client.pageSummary(path)).toEqual({
        resources: [
          resource('betaTesters', 'safe-tester', {
            email: 'safe@example.invalid',
          }),
        ],
        total: 1,
      });
      expect(calls).toBe(1);

      for (const unsafePath of [
        '/v1/betaGroups/safe-group/betaTesters',
        '/v1/betaGroups/safe-group/betaTesters?limit=2',
        '/v1/betaGroups/safe-group/betaTesters?limit=1&limit=1',
        '/v1/betaGroups/safe-group/betaTesters?limit=1&cursor=opaque',
      ]) {
        await expect(
          client.pageSummary(unsafePath),
          unsafePath,
        ).rejects.toThrow('exact one-item limit');
      }
      expect(calls).toBe(1);

      const oneTester = resource('betaTesters', 'safe-tester', {
        email: 'safe@example.invalid',
      });
      const malformedBodies: readonly unknown[] = [
        {},
        { data: [] },
        { data: [], meta: {} },
        { data: [], meta: { paging: {} } },
        { data: [], meta: { paging: { limit: 1 } } },
        { data: [], meta: { paging: { total: 0 } } },
        { data: [], meta: { paging: { limit: '1', total: 0 } } },
        { data: [], meta: { paging: { limit: 2, total: 0 } } },
        { data: [], meta: { paging: { limit: 1, total: '0' } } },
        { data: [], meta: { paging: { limit: 1, total: -1 } } },
        { data: [], meta: { paging: { limit: 1, total: 1.5 } } },
        { data: [], meta: { paging: { limit: 1, total: 10_001 } } },
        { data: [], meta: { paging: { limit: 1, total: 1 } } },
        {
          data: [oneTester],
          meta: { paging: { limit: 1, total: 0 } },
        },
        {
          data: [oneTester, resource('betaTesters', 'another-tester')],
          meta: { paging: { limit: 1, total: 2 } },
        },
      ];
      for (const body of malformedBodies) {
        responseBody = body;
        await expect(client.pageSummary(path)).rejects.toThrow();
      }
      expect(calls).toBe(1 + malformedBodies.length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects invalid UTF-8 in both GET and mutation responses', async () => {
    const originalFetch = globalThis.fetch;
    const client = createHttpClient();
    try {
      globalThis.fetch = (async () =>
        new Response(new Uint8Array([0xff]), {
          status: 200,
        })) as unknown as typeof fetch;
      await expect(client.list('/v1/apps?limit=1')).rejects.toThrow(
        'unusable response',
      );

      globalThis.fetch = (async () =>
        new Response(new Uint8Array([0xff]), {
          status: 201,
        })) as unknown as typeof fetch;
      await expect(
        client.mutate('POST', '/v1/betaGroups', {}, 'betaGroups'),
      ).rejects.toThrow('indeterminate');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('never follows redirects or echoes hostile Apple error text', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      calls += 1;
      expect(init?.redirect).toBe('error');
      expect(String(input)).toStartWith(
        'https://api.appstoreconnect.apple.com/v1/',
      );
      expect(init?.headers).toHaveProperty('Authorization');
      return new Response(
        JSON.stringify({
          errors: [
            {
              code: 'SAFE_CODE',
              title: 'secret@example.invalid\n\u001B[31m hostile',
            },
          ],
        }),
        { status: 302 },
      );
    }) as unknown as typeof fetch;
    try {
      let message = '';
      try {
        await createHttpClient().list('/v1/apps?limit=1');
      } catch (error) {
        message = String(error);
      }
      expect(calls).toBe(1);
      expect(message).toContain('HTTP 302');
      expect(message).not.toContain('SAFE_CODE');
      expect(message).not.toContain('secret@example.invalid');
      expect(message).not.toContain('\u001B');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('never echoes provider-controlled phone or name-like error codes for GET or mutation failures', async () => {
    const originalFetch = globalThis.fetch;
    const privateValues = ['12065550198', 'PRIVATE_REVIEWER_NAME'];
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          errors: privateValues.map((code) => ({ code })),
        }),
        { status: 400 },
      )) as unknown as typeof fetch;
    try {
      const operations = [
        () => createHttpClient().list('/v1/apps?limit=1'),
        () =>
          createHttpClient().mutate('POST', '/v1/betaGroups', {}, 'betaGroups'),
      ];
      for (const operation of operations) {
        let message = '';
        try {
          await operation();
        } catch (error) {
          message = String(error);
        }
        expect(message).toContain('HTTP 400');
        for (const value of privateValues) expect(message).not.toContain(value);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('never exposes a provider-thrown error, cause, identity, or control text', async () => {
    const originalFetch = globalThis.fetch;
    const privateValues = [
      'fetch-private@example.invalid',
      '12065550198',
      'Private Reviewer Name',
      '\u001B[31m',
    ];
    globalThis.fetch = (async () => {
      throw new Error(privateValues.join(' '), {
        cause: new Error('nested-private@example.invalid'),
      });
    }) as unknown as typeof fetch;
    try {
      const operations = [
        () => createHttpClient().list('/v1/apps?limit=1'),
        () =>
          createHttpClient().mutate('POST', '/v1/betaGroups', {}, 'betaGroups'),
      ];
      for (const operation of operations) {
        let rejected: unknown;
        try {
          await operation();
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toBeInstanceOf(Error);
        expect((rejected as Error & { cause?: unknown }).cause).toBeUndefined();
        const inspected = `${String(rejected)}\n${Bun.inspect(rejected)}`;
        for (const value of [
          ...privateValues,
          'nested-private@example.invalid',
        ]) {
          expect(inspected).not.toContain(value);
        }
        expect(inspected).not.toContain('\u001B');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects off-origin URLs before creating an authenticated request', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('{}');
    }) as unknown as typeof fetch;
    try {
      await expect(
        createHttpClient().list('https://example.invalid/v1/apps'),
      ).rejects.toThrow('unexpected URL');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('labels malformed, missing, wrong-type, and non-null relationship mutation responses indeterminate', async () => {
    const originalFetch = globalThis.fetch;
    const client = createHttpClient();
    try {
      globalThis.fetch = (async () =>
        new Response('secret malformed response', {
          status: 200,
        })) as unknown as typeof fetch;
      await expect(
        client.mutate('POST', '/v1/betaGroups', {}, 'betaGroups'),
      ).rejects.toThrow('indeterminate');

      globalThis.fetch = (async () =>
        new Response(null, { status: 204 })) as unknown as typeof fetch;
      await expect(
        client.mutate('POST', '/v1/betaGroups', {}, 'betaGroups'),
      ).rejects.toThrow('indeterminate');

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            data: { id: 'safe-id', type: 'unexpectedResources' },
          }),
          { status: 200 },
        )) as unknown as typeof fetch;
      await expect(
        client.mutate('POST', '/v1/betaGroups', {}, 'betaGroups'),
      ).rejects.toThrow('indeterminate');

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            data: { id: 'unexpected-body', type: 'betaGroups' },
          }),
          { status: 200 },
        )) as unknown as typeof fetch;
      await expect(
        client.mutate(
          'POST',
          '/v1/betaGroups/safe-group/relationships/builds',
          {},
        ),
      ).rejects.toThrow('indeterminate');

      globalThis.fetch = (async () =>
        new Response(null, { status: 204 })) as unknown as typeof fetch;
      expect(
        await client.mutate(
          'POST',
          '/v1/betaGroups/safe-group/relationships/builds',
          {},
        ),
      ).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('cancels a declared oversized Apple response body', async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    globalThis.fetch = (async () =>
      new Response(body, {
        headers: { 'content-length': '2000001' },
        status: 200,
      })) as unknown as typeof fetch;
    try {
      await expect(createHttpClient().list('/v1/apps?limit=1')).rejects.toThrow(
        'unusable response',
      );
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('cancels chunked oversized bodies and sanitizes stream read failures', async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      start: (controller) => {
        controller.enqueue(new Uint8Array(1_100_000));
        controller.enqueue(new Uint8Array(1_100_000));
      },
    });
    try {
      globalThis.fetch = (async () =>
        new Response(oversized, { status: 200 })) as unknown as typeof fetch;
      await expect(createHttpClient().list('/v1/apps?limit=1')).rejects.toThrow(
        'unusable response',
      );
      expect(cancelled).toBe(true);

      globalThis.fetch = (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: (controller) => {
              controller.error(
                new Error('secret@example.invalid\n\u001B[31m stream error'),
              );
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch;
      let message = '';
      try {
        await createHttpClient().list('/v1/apps?limit=1');
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain('unusable response');
      expect(message).not.toContain('secret@example.invalid');
      expect(message).not.toContain('\u001B');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects an off-origin next-page URL before a second authenticated request', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      calls += 1;
      expect(init?.headers).toHaveProperty('Authorization');
      return new Response(
        JSON.stringify(
          paginatedBody(
            input,
            [resource('apps', `repeated-page-${calls}`)],
            'https://attacker.example.invalid/v1/apps?page=2',
            2,
          ),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      await expect(createHttpClient().list('/v1/apps?limit=1')).rejects.toThrow(
        'unsafe pagination',
      );
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects a repeated next-page URL without fetching it twice', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls += 1;
      return new Response(
        JSON.stringify(
          paginatedBody(
            input,
            [resource('apps', `repeated-page-${calls}`)],
            'https://api.appstoreconnect.apple.com/v1/apps?limit=1&cursor=BQ.ALHoGBE',
            3,
          ),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      await expect(createHttpClient().list('/v1/apps?limit=1')).rejects.toThrow(
        'repeated a page URL',
      );
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects sparse non-final and over-limit pages before trusting pagination cost', async () => {
    const originalFetch = globalThis.fetch;
    const next = new URL(
      TRUSTED_PAGINATION_PATH,
      'https://api.appstoreconnect.apple.com',
    );
    next.searchParams.set('cursor', 'BQ.ALHoGBE');
    try {
      let calls = 0;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        calls += 1;
        return new Response(
          JSON.stringify(
            paginatedBody(
              input,
              [resource('betaTesters', 'sparse-page-tester')],
              next.toString(),
              200,
            ),
          ),
          { status: 200 },
        );
      }) as unknown as typeof fetch;
      await expect(
        createHttpClient().list(TRUSTED_PAGINATION_PATH),
      ).rejects.toThrow();
      expect(calls).toBe(1);

      calls = 0;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        calls += 1;
        return new Response(
          JSON.stringify(
            paginatedBody(
              input,
              Array.from({ length: 201 }, (_, index) =>
                resource('betaTesters', `over-limit-page-${index}`),
              ),
            ),
          ),
          { status: 200 },
        );
      }) as unknown as typeof fetch;
      await expect(
        createHttpClient().list(TRUSTED_PAGINATION_PATH),
      ).rejects.toThrow();
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('requires stable complete pagination metadata, including exact terminal totals', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) =>
        new Response(
          JSON.stringify({
            data: [],
            links: paginationLinks(input),
          }),
          { status: 200 },
        )) as unknown as typeof fetch;
      await expect(createHttpClient().list('/v1/apps?limit=1')).rejects.toThrow(
        'malformed pagination metadata',
      );

      for (const drift of ['limit', 'total'] as const) {
        let calls = 0;
        globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
          calls += 1;
          const body = paginatedBody(
            input,
            [resource('apps', `metadata-${drift}-${calls}`)],
            calls === 1 ? '?cursor=metadata-page-2' : null,
            calls === 1 || drift === 'limit' ? 2 : 3,
          ) as {
            meta: { paging: { limit: number; total: number } };
          };
          if (calls === 2 && drift === 'limit') {
            body.meta.paging.limit = 2;
          }
          return new Response(JSON.stringify(body), { status: 200 });
        }) as unknown as typeof fetch;
        await expect(
          createHttpClient().list('/v1/apps?limit=1'),
          drift,
        ).rejects.toThrow(
          drift === 'limit'
            ? 'malformed pagination metadata'
            : 'changed the collection total',
        );
        expect(calls, drift).toBe(2);
      }

      const terminal = Array.from({ length: 200 }, (_, index) =>
        resource('apps', `terminal-${index}`),
      );
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) =>
        new Response(
          JSON.stringify(paginatedBody(input, terminal, null, 201)),
          { status: 200 },
        )) as unknown as typeof fetch;
      await expect(
        createHttpClient().list('/v1/apps?limit=200'),
      ).rejects.toThrow('incomplete collection inventory');

      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) =>
        new Response(
          JSON.stringify(paginatedBody(input, terminal, null, 200)),
          { status: 200 },
        )) as unknown as typeof fetch;
      expect(await createHttpClient().list('/v1/apps?limit=200')).toHaveLength(
        200,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects an initial cursor before creating an authenticated request', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('{}');
    }) as unknown as typeof fetch;
    try {
      await expect(
        createHttpClient().list('/v1/apps?limit=1&cursor=BQ.ALHoGBE'),
      ).rejects.toThrow('canonical bounded page limit');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects hostile pagination continuations before a second fetch with a generic diagnostic', async () => {
    const privateEmail = 'private-pagination@example.invalid';
    const privateUsername = 'private-pagination-user@example.invalid';
    const baseline =
      'fields%5BbetaTesters%5D=email&filter%5Bapps%5D=app-1&filter%5Bapps%5D=app-2&limit=200';
    const attacks = [
      `https://api.appstoreconnect.apple.com/v1/betaTesters?${baseline}&cursor=BQ.ALHoGBE&filter[email]=${privateEmail}`,
      `https://api.appstoreconnect.apple.com/v1/betaTesters?${baseline}&cursor=BQ.ALHoGBE&filter%5Bemail%5D=${encodeURIComponent(privateEmail)}`,
      `https://api.appstoreconnect.apple.com/v1/betaTesters?${baseline}&cursor=BQ.ALHoGBE&filter[username]=${privateUsername}`,
      `https://api.appstoreconnect.apple.com/v1/betaTesters?${baseline}&cursor=BQ.ALHoGBE&filter%5Busername%5D=${encodeURIComponent(privateUsername)}`,
      `https://api.appstoreconnect.apple.com/v1/apps/app-2/betaTesters?${baseline}&cursor=BQ.ALHoGBE`,
      `https://api.appstoreconnect.apple.com/v1/betaTesters?${baseline}&filter%5Bapps%5D=app-3&cursor=BQ.ALHoGBE`,
      'https://api.appstoreconnect.apple.com/v1/betaTesters?limit=200&cursor=BQ.ALHoGBE',
      `https://api.appstoreconnect.apple.com/v1/betaTesters?${baseline.replace('limit=200', 'limit=199')}&cursor=BQ.ALHoGBE`,
      `https://api.appstoreconnect.apple.com/v1/betaTesters?${baseline}&unexpected=true&cursor=BQ.ALHoGBE`,
      `https://api.appstoreconnect.apple.com/v1/betaTesters?${baseline}&limit=200&cursor=BQ.ALHoGBE`,
      `https://api.appstoreconnect.apple.com/v1/betaTesters?${baseline}&cursor=BQ.ALHoGBE&cursor=BQ.ALHoGBF`,
      `https://${encodeURIComponent(privateEmail)}@api.appstoreconnect.apple.com/v1/betaTesters?cursor=BQ.ALHoGBE`,
      `https://api.appstoreconnect.apple.com/v1/betaTesters?cursor=BQ.ALHoGBE#${privateEmail}`,
      '/v1\\betaTesters?cursor=BQ.ALHoGBE',
    ];

    for (const candidate of attacks) {
      const { calls, message } =
        await rejectedPaginationContinuation(candidate);
      expect(calls, candidate).toBe(1);
      expect(message, candidate).toContain('unsafe pagination');
      expect(message, candidate).not.toContain(candidate);
      expect(message, candidate).not.toContain(privateEmail);
      expect(message, candidate).not.toContain(privateUsername);
      expect(message, candidate).not.toContain(
        encodeURIComponent(privateEmail),
      );
      expect(message, candidate).not.toContain(
        encodeURIComponent(privateUsername),
      );
    }
  });

  test('reconstructs legitimate absolute and relative cursor continuations from the original trusted query multimap', async () => {
    const baselineEntries: Array<[string, string]> = [
      ['fields[betaTesters]', 'email'],
      ['filter[apps]', 'app-1'],
      ['filter[apps]', 'app-2'],
      ['limit', '200'],
    ];
    const reorderedBaseline =
      'limit=200&filter%5Bapps%5D=app-2&fields%5BbetaTesters%5D=email&filter%5Bapps%5D=app-1';
    const continuations = [
      'https://api.appstoreconnect.apple.com/v1/betaTesters?cursor=BQ.ALHoGBE',
      `/v1/betaTesters?${reorderedBaseline}&cursor=BQ.ALHoGBE`,
      'betaTesters?cursor=BQ.ALHoGBE',
      '?cursor=BQ.ALHoGBE',
    ];

    for (const next of continuations) {
      const originalFetch = globalThis.fetch;
      const urls: string[] = [];
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        urls.push(String(input));
        const data =
          urls.length === 1
            ? Array.from({ length: 200 }, (_, index) =>
                resource('betaTesters', `continuation-${index}`),
              )
            : [resource('betaTesters', 'continuation-final')];
        return new Response(
          JSON.stringify(
            paginatedBody(input, data, urls.length === 1 ? next : null, 201),
          ),
          { status: 200 },
        );
      }) as unknown as typeof fetch;
      try {
        await createHttpClient().list(TRUSTED_PAGINATION_PATH);
        expect(urls, next).toHaveLength(2);
        const reconstructed = new URL(urls[1] as string);
        expect(reconstructed.pathname, next).toBe('/v1/betaTesters');
        expect([...reconstructed.searchParams.entries()], next).toEqual([
          ...baselineEntries,
          ['cursor', 'BQ.ALHoGBE'],
        ]);
        expect(reconstructed.username, next).toBe('');
        expect(reconstructed.password, next).toBe('');
        expect(reconstructed.hash, next).toBe('');
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test('paginates a bounded relationship with cursor plus limit and rejects limit drift', async () => {
    const relationshipPath =
      '/v1/betaGroups/safe-group/relationships/builds?limit=200';
    const originalFetch = globalThis.fetch;
    const acceptedUrls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      acceptedUrls.push(String(input));
      const data =
        acceptedUrls.length === 1
          ? Array.from({ length: 200 }, (_, index) =>
              resource('builds', `build-page-1-${index}`),
            )
          : [resource('builds', 'build-page-2')];
      return new Response(
        JSON.stringify(
          paginatedBody(
            input,
            data,
            acceptedUrls.length === 1
              ? 'https://api.appstoreconnect.apple.com/v1/betaGroups/safe-group/relationships/builds?cursor=BQ.ALHoGBE&limit=200'
              : null,
            201,
          ),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      const builds = await createHttpClient().list(relationshipPath);
      expect(builds).toHaveLength(201);
      expect(builds[0]?.id).toBe('build-page-1-0');
      expect(builds.at(-1)?.id).toBe('build-page-2');
      expect(acceptedUrls).toHaveLength(2);
      const continuation = new URL(acceptedUrls[1] as string);
      expect(continuation.pathname).toBe(
        '/v1/betaGroups/safe-group/relationships/builds',
      );
      expect([...continuation.searchParams.entries()]).toEqual([
        ['limit', '200'],
        ['cursor', 'BQ.ALHoGBE'],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    let rejectedCalls = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      rejectedCalls += 1;
      return new Response(
        JSON.stringify(
          paginatedBody(
            input,
            [],
            'https://api.appstoreconnect.apple.com/v1/betaGroups/safe-group/relationships/builds?cursor=BQ.ALHoGBE&limit=199',
            200,
          ),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      await expect(createHttpClient().list(relationshipPath)).rejects.toThrow(
        'unsafe pagination',
      );
      expect(rejectedCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects exact dot-segment provider resource IDs before pagination follow-on', async () => {
    const resourceTypes = [
      'apps',
      'users',
      'betaGroups',
      'builds',
      'buildBetaDetails',
      'betaAppLocalizations',
      'betaBuildLocalizations',
      'betaAppReviewSubmissions',
    ] as const;

    for (const type of resourceTypes) {
      for (const id of ['.', '..']) {
        const originalFetch = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
          calls += 1;
          return new Response(
            JSON.stringify(
              paginatedBody(
                input,
                [resource(type, id)],
                '?cursor=BQ.ALHoGBE',
                2,
              ),
            ),
            { status: 200 },
          );
        }) as unknown as typeof fetch;
        try {
          await expect(
            createHttpClient().list(`/v1/${type}?limit=200`),
            `${type}:${id}`,
          ).rejects.toThrow('resource ID was malformed');
          expect(calls, `${type}:${id}`).toBe(1);
        } finally {
          globalThis.fetch = originalFetch;
        }

        const originalMutationFetch = globalThis.fetch;
        let mutationCalls = 0;
        globalThis.fetch = (async () => {
          mutationCalls += 1;
          return new Response(JSON.stringify({ data: resource(type, id) }), {
            status: 201,
          });
        }) as unknown as typeof fetch;
        try {
          await expect(
            createHttpClient().mutate('POST', `/v1/${type}`, {}, type),
            `${type}:${id}`,
          ).rejects.toThrow('indeterminate');
          expect(mutationCalls, `${type}:${id}`).toBe(1);
        } finally {
          globalThis.fetch = originalMutationFetch;
        }
      }
    }
  });

  test('paginates the bounded account collection without putting identities in page URLs', async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    const responseEmails = [
      'first-response-private@example.invalid',
      'second-response-private@example.invalid',
    ];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      const page = urls.length;
      const data =
        page === 1
          ? Array.from({ length: 200 }, (_, index) =>
              resource('betaTesters', `opaque-page-1-tester-${index}`, {
                email:
                  index === 0
                    ? responseEmails[0]
                    : `opaque-page-1-${index}@example.invalid`,
              }),
            )
          : [
              resource('betaTesters', 'opaque-page-2-tester-id', {
                email: responseEmails[1],
              }),
            ];
      return new Response(
        JSON.stringify(
          paginatedBody(
            input,
            data,
            page === 1
              ? 'https://api.appstoreconnect.apple.com/v1/betaTesters?fields%5BbetaTesters%5D=email&limit=200&cursor=opaque-page-2'
              : null,
            201,
          ),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      const result = await createHttpClient().list(
        '/v1/betaTesters?fields%5BbetaTesters%5D=email&limit=200',
      );
      expect(result).toHaveLength(201);
      expect(urls).toHaveLength(2);
      for (const value of urls) {
        const url = new URL(value);
        expect(url.pathname).toBe('/v1/betaTesters');
        expect(url.searchParams.get('fields[betaTesters]')).toBe('email');
        expect(url.searchParams.get('limit')).toBe('200');
        expect(url.searchParams.has('filter[email]')).toBe(false);
        const decoded = decodeURIComponent(value);
        for (const email of responseEmails) {
          expect(decoded).not.toContain(email);
          expect(value).not.toContain(encodeURIComponent(email));
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('stops pagination after 100 pages before issuing request 101', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls += 1;
      return new Response(
        JSON.stringify(
          paginatedBody(
            input,
            [resource('apps', `bounded-page-${calls}`)],
            `?cursor=BQ.ALHoGBE-${calls + 1}`,
            101,
          ),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      await expect(createHttpClient().list('/v1/apps?limit=1')).rejects.toThrow(
        'pagination exceeded its limit',
      );
      expect(calls).toBe(100);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects a continuation beyond an exact 20,000-resource total', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls += 1;
      return new Response(
        JSON.stringify(
          paginatedBody(
            input,
            Array.from({ length: 200 }, (_, index) =>
              resource('apps', `app-${calls}-${index}`),
            ),
            `?cursor=BQ.ALHoGBE-${calls + 1}`,
            20_000,
          ),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      await expect(
        createHttpClient().list('/v1/apps?limit=200'),
      ).rejects.toThrow('beyond its collection total');
      expect(calls).toBe(100);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('controlled input parsing', () => {
  test('parses BOM, RFC 4180 quoting, and Google USER headers', () => {
    const testers = parseTesterCsv(
      '\uFEFFMember Email,Given Name,Family Name,Member Type\r\n' +
        'one@example.invalid,"Synthetic, One",Tester,USER\r\n',
    );
    expect(testers).toEqual([
      {
        email: 'one@example.invalid',
        firstName: 'Synthetic, One',
        lastName: 'Tester',
      },
    ]);
  });

  test('rejects malformed data without echoing the address', () => {
    expect(() => parseTesterCsv('email\nnot-an-email\n')).toThrow('row 2');
    try {
      parseTesterCsv('email\nnot-an-email\n');
    } catch (error) {
      expect(String(error)).not.toContain('not-an-email');
    }
  });

  test('rejects invalid quote transitions, blank user emails, and duplicate identities', () => {
    const invalidCsvInputs = [
      'email,firstName\none@example.invalid,"Synthetic"suffix\n',
      'email,firstName\none@example.invalid,Syn"thetic\n',
      'email,memberType\nvalid@example.invalid,USER\n,USER\n',
      'email\nduplicate@example.invalid\nDUPLICATE@example.invalid\n',
    ];
    for (const input of invalidCsvInputs) {
      expect(() => parseTesterCsv(input)).toThrow();
    }
  });

  test('requires unique semantic headers and exact data-row widths', () => {
    const duplicateSemanticHeaders = [
      'Email,Member Email,Member Type\none@example.invalid,one@example.invalid,USER\n',
      'Email,First Name,Given Name\none@example.invalid,Synthetic,Synthetic\n',
      'Email,Last Name,Surname\none@example.invalid,Tester,Tester\n',
      'Email,Member Type,Type\none@example.invalid,USER,USER\n',
    ];
    for (const input of duplicateSemanticHeaders) {
      expect(() => parseTesterCsv(input)).toThrow('duplicate');
    }

    for (const input of [
      'Email,First Name,Member Type\none@example.invalid,Synthetic\n',
      'Email,Member Type\none@example.invalid,USER,unexpected\n',
    ]) {
      expect(() => parseTesterCsv(input)).toThrow('row 2');
    }
  });

  test('accepts only explicit USER member rows and never returns a partial roster', () => {
    expect(
      parseTesterCsv(
        'Email,Member Type\none@example.invalid,  uSeR  \ntwo@example.invalid,USER\n',
      ),
    ).toEqual([
      { email: 'one@example.invalid' },
      { email: 'two@example.invalid' },
    ]);

    for (const memberType of ['GROUP', 'CUSTOMER', 'EXTERNAL', '', 'USRE']) {
      const sensitiveAddress = `sensitive-${memberType || 'blank'}@example.invalid`;
      const input =
        'Email,Member Type\n' +
        'approved@example.invalid,USER\n' +
        `${sensitiveAddress},${memberType}\n`;
      let message = '';
      try {
        parseTesterCsv(input);
      } catch (error) {
        message = String(error);
      }
      expect(message).not.toBe('');
      expect(message).toContain('row 3');
      expect(message).not.toContain(sensitiveAddress);
    }
  });

  test('accepts only the four supported beta-test fields', () => {
    expect(parseTestInfo(review)).toEqual(review);
    expect(() => parseTestInfo({ ...review, surprise: true })).toThrow(
      'unsupported field',
    );
    for (const removed of [
      'contactEmail',
      'contactFirstName',
      'contactLastName',
      'contactPhone',
      'demoAccountName',
      'demoAccountPassword',
      'demoAccountRequired',
      'notes',
    ]) {
      expect(() => parseTestInfo({ ...review, [removed]: 'anything' })).toThrow(
        'unsupported field',
      );
    }
    expect(() =>
      parseTestInfo({ ...review, feedbackEmail: 'not-an-email' }),
    ).toThrow('valid email address');
  });

  test('accepts exactly the case-sensitive Apple BetaBuildLocalization locale set', () => {
    expect(new Set(supportedBetaBuildLocalizationLocales).size).toBe(
      supportedBetaBuildLocalizationLocales.length,
    );
    for (const locale of supportedBetaBuildLocalizationLocales) {
      expect(parseTestInfo({ ...review, locale }).locale, locale).toBe(locale);
    }
    const omittedLocale: Record<string, unknown> = { ...review };
    delete omittedLocale.locale;
    expect(parseTestInfo(omittedLocale).locale).toBe('en-US');
    expect(parseTestInfo({ ...omittedLocale, locale: undefined }).locale).toBe(
      'en-US',
    );
  });

  test('rejects unsupported or wrongly cased review locales before any Apple read or write', async () => {
    for (const locale of [
      null,
      'xx-YY',
      'en',
      'en-ZZ',
      'fr',
      'zh-CN',
      'EN-us',
      'en-us',
      'de-de',
      'pt-br',
      '',
      '   ',
      ' en-US ',
    ] as const) {
      const label = JSON.stringify(locale);
      const candidate = { ...review, locale };
      expect(() => parseTestInfo(candidate), label).toThrow();
      const client = new StatefulClient();
      await expect(
        syncTestFlight(client, {
          apply: false,
          internalTesters: [],
          testInfo: candidate as unknown as BetaTestInfo,
        }),
        label,
      ).rejects.toThrow();
      expect(client.listPaths, label).toHaveLength(0);
      expect(client.mutations, label).toHaveLength(0);
    }
  });

  test('captures every nested beta-review getter exactly once', () => {
    const reads = new Map<string, number>();
    const getterBackedReview: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(review)) {
      Object.defineProperty(getterBackedReview, key, {
        enumerable: true,
        get: () => {
          const count = (reads.get(key) ?? 0) + 1;
          reads.set(key, count);
          if (key === 'demoAccountRequired' && count > 1) return true;
          return value;
        },
      });
    }

    expect(parseTestInfo(getterBackedReview)).toEqual(review);
    for (const key of Object.keys(review)) {
      expect(reads.get(key), key).toBe(1);
    }
  });

  test('requires bounded nonblank What to Test text', () => {
    for (const whatsNew of [undefined, '', '   ', 'x'.repeat(4_001)]) {
      expect(() => parseTestInfo({ ...review, whatsNew })).toThrow('whatsNew');
    }
    expect(parseTestInfo(review).whatsNew).toBe(review.whatsNew);
  });

  test('recognizes repository-contained paths', () => {
    expect(isPathInside('/repo/private/testers.csv', '/repo')).toBe(true);
    expect(isPathInside('/secure/testers.csv', '/repo')).toBe(false);
  });
});

describe('private operational inputs', () => {
  test('sanitizes malformed beta-review JSON', () => {
    const malformed = '{"contactEmail":"secret@example.invalid",';
    expect(() => parseTestInfoJson(malformed)).toThrow('not valid JSON');
    try {
      parseTestInfoJson(malformed);
    } catch (error) {
      expect(String(error)).not.toContain('secret@example.invalid');
    }
  });

  test('reads one bounded owner-private regular file outside Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'psd-eoc-asc-private-'));
    await chmod(root, 0o700);
    try {
      const path = join(root, 'input.json');
      await writePrivate(path, '{"synthetic":true}\n');
      expect(await readPrivateFile(path, 1_024, 'Synthetic input')).toBe(
        '{"synthetic":true}\n',
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('sanitizes raw filesystem failures without exposing recipient or review paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'psd-eoc-asc-missing-'));
    await chmod(root, 0o700);
    try {
      for (const [label, syntheticAddress] of [
        ['Tester CSV', 'recipient-secret@example.invalid'],
        ['Beta-review input', 'review-secret@example.invalid'],
      ] as const) {
        const hostilePath = join(
          root,
          `missing-${syntheticAddress}\n\u001B[31m-private`,
        );
        let message = '';
        try {
          await readPrivateFile(hostilePath, 1_024, label);
        } catch (error) {
          message = String(error);
        }
        expect(message).toBe(`Error: ${label} could not be read safely.`);
        expect(message).not.toContain(syntheticAddress);
        expect(message).not.toContain(hostilePath);
        expect(message).not.toContain('\n');
        expect(message).not.toContain('\u001B');
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('rejects symlink, FIFO, device, directory, permissive, oversized, and invalid UTF-8 inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'psd-eoc-asc-hazards-'));
    await chmod(root, 0o700);
    try {
      const target = join(root, 'target');
      await writePrivate(target, 'safe');
      const link = join(root, 'link');
      await symlink(target, link);
      await expect(
        readPrivateFile(link, 10, 'Synthetic input'),
      ).rejects.toThrow('regular file');

      const fifo = join(root, 'fifo');
      const fifoResult = Bun.spawnSync(['mkfifo', fifo]);
      expect(fifoResult.exitCode).toBe(0);
      const started = performance.now();
      await expect(
        readPrivateFile(fifo, 10, 'Synthetic input'),
      ).rejects.toThrow('regular file');
      expect(performance.now() - started).toBeLessThan(1_000);

      await expect(
        readPrivateFile('/dev/null', 10, 'Synthetic input'),
      ).rejects.toThrow('regular file');
      await expect(
        readPrivateFile(root, 10, 'Synthetic input'),
      ).rejects.toThrow('regular file');

      const permissive = join(root, 'permissive');
      await writePrivate(permissive, 'safe');
      await chmod(permissive, 0o644);
      await expect(
        readPrivateFile(permissive, 10, 'Synthetic input'),
      ).rejects.toThrow('owner-private');

      const permissiveDirectory = join(root, 'permissive-directory');
      await mkdir(permissiveDirectory, { mode: 0o755 });
      await chmod(permissiveDirectory, 0o755);
      const directoryInput = join(permissiveDirectory, 'input');
      await writePrivate(directoryInput, 'safe');
      await expect(
        readPrivateFile(directoryInput, 10, 'Synthetic input'),
      ).rejects.toThrow('owner-private directory');

      const oversized = join(root, 'oversized');
      await writePrivate(oversized, '01234567890');
      await expect(
        readPrivateFile(oversized, 10, 'Synthetic input'),
      ).rejects.toThrow('size limit');

      const invalidUtf8 = join(root, 'invalid-utf8');
      const invalidHandle = await openFile(invalidUtf8, 'wx', 0o600);
      try {
        await invalidHandle.writeFile(Buffer.from([0xff]));
      } finally {
        await invalidHandle.close();
      }
      await expect(
        readPrivateFile(invalidUtf8, 10, 'Synthetic input'),
      ).rejects.toThrow('valid UTF-8');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('rejects inputs in this worktree and in any other Git repository', async () => {
    const repositoryDirectory = await mkdtemp(
      join(import.meta.dir, '.asc-private-input-'),
    );
    const outsideRoot = await mkdtemp(join(tmpdir(), 'psd-eoc-other-git-'));
    await chmod(repositoryDirectory, 0o700);
    await chmod(outsideRoot, 0o700);
    try {
      const repositoryInput = join(repositoryDirectory, 'input');
      await writePrivate(repositoryInput, 'safe');
      await expect(
        readPrivateFile(repositoryInput, 10, 'Synthetic input'),
      ).rejects.toThrow('outside every Git repository');

      const otherRepository = join(outsideRoot, 'repo');
      await mkdir(join(otherRepository, '.git'), {
        mode: 0o700,
        recursive: true,
      });
      const otherInput = join(otherRepository, 'input');
      await writePrivate(otherInput, 'safe');
      await expect(
        readPrivateFile(otherInput, 10, 'Synthetic input'),
      ).rejects.toThrow('outside every Git repository');
    } finally {
      await rm(repositoryDirectory, { force: true, recursive: true });
      await rm(outsideRoot, { force: true, recursive: true });
    }
  });

  test('rejects a hard-linked private input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'psd-eoc-asc-hard-link-'));
    await chmod(root, 0o700);
    try {
      const original = join(root, 'original');
      const hardLink = join(root, 'hard-link');
      await writePrivate(original, 'synthetic');
      await link(original, hardLink);
      await expect(
        readPrivateFile(hardLink, 100, 'Synthetic input'),
      ).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe('write gates and reconciliation', () => {
  test('core apply rejects a missing prior plan digest before any read or write', async () => {
    const client = new StatefulClient();
    await expect(
      syncTestFlight(client, {
        apply: true,
        internalTesters: [],
      } as never),
    ).rejects.toThrow('prior preview');
    expect(client.listPaths).toHaveLength(0);
    expect(client.mutations).toHaveLength(0);
  });

  test('fails closed on unavailable or insufficient rate budget before any mutation', async () => {
    for (const { budget, internalTesters, label } of [
      {
        budget: null,
        internalTesters: [{ email: 'missing-budget@example.invalid' }],
        label: 'missing budget for one write',
      },
      {
        budget: ONE_WRITE_BUDGET - 1,
        internalTesters: [{ email: 'low-budget@example.invalid' }],
        label: 'one below the one-write threshold',
      },
      {
        budget: ZERO_WRITE_BUDGET - 1,
        internalTesters: [],
        label: 'one below the zero-write final-audit reserve',
      },
    ] as const) {
      const client = new StatefulClient();
      const options = { internalTesters } as const;
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      client.rateLimitBudget = budget;
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        label,
      ).rejects.toThrow('no mutations were attempted');
      expect(client.mutations, label).toHaveLength(0);
    }
  });

  test('accepts the exact rate-budget threshold for zero and one selected tester write', async () => {
    for (const { budget, internalTesters, expectedWrites, label } of [
      {
        budget: ZERO_WRITE_BUDGET,
        internalTesters: [],
        expectedWrites: 0,
        label: 'zero writes',
      },
      {
        budget: ONE_WRITE_BUDGET,
        internalTesters: [{ email: 'exact-budget@example.invalid' }],
        expectedWrites: 1,
        label: 'one write',
      },
    ] as const) {
      const client = new StatefulClient();
      client.rateLimitBudget = budget;
      const result = await previewAndApply(client, { internalTesters });
      expect(result.actions.at(-1), label).toEqual({
        detail: 'Read-back verification passed.',
        kind: 'verification',
        status: 'applied',
      });
      expect(
        client.mutations.filter(
          ({ method, path }) => method === 'POST' && path === '/v1/betaTesters',
        ),
        label,
      ).toHaveLength(expectedWrites);
    }
  });

  test('honors decrementing one-below and adequate budgets across preflight, group setup, and tester links', async () => {
    type BudgetScenario = {
      readonly label: string;
      readonly options: {
        readonly internalTesters: readonly { readonly email: string }[];
      };
      readonly requiredAtPreMutationGuard: number;
      readonly setup: () => ScaleStatefulClient;
    };
    const scenarios: readonly BudgetScenario[] = [
      {
        label: 'existing groups and tester create',
        options: {
          internalTesters: [{ email: 'decrement-create@example.invalid' }],
        },
        requiredAtPreMutationGuard: 738,
        setup: () => new ScaleStatefulClient(),
      },
      {
        label: 'missing groups and tester create',
        options: {
          internalTesters: [
            { email: 'decrement-group-create@example.invalid' },
          ],
        },
        requiredAtPreMutationGuard: 733,
        setup: () => {
          const client = new ScaleStatefulClient();
          client.groups.splice(0, client.groups.length);
          return client;
        },
      },
      {
        label: 'existing account tester link',
        options: {
          internalTesters: [{ email: 'decrement-link@example.invalid' }],
        },
        requiredAtPreMutationGuard: 739,
        setup: () => {
          const client = new ScaleStatefulClient();
          client.accountTesters.push(
            resource('betaTesters', 'decrement-link-tester', {
              email: 'decrement-link@example.invalid',
            }),
          );
          return client;
        },
      },
    ];

    for (const scenario of scenarios) {
      const probe = scenario.setup();
      const probePreview = await syncTestFlight(probe, {
        ...scenario.options,
        apply: false,
      });
      probe.resetScaleCounters();
      probe.rateLimitBudget = 1_000_000;
      await syncTestFlight(probe, {
        ...scenario.options,
        apply: true,
        confirmPlanDigest: probePreview.planDigest,
      });
      expect(probe.rateLimitChecks.length, scenario.label).toBeGreaterThan(1);
      const preMutationRequestCount =
        probe.rateLimitChecks[2]?.providerRequestCount;
      if (preMutationRequestCount === undefined) {
        throw new Error('Missing synthetic pre-mutation budget check.');
      }

      for (const delta of [-1, 0] as const) {
        const client = scenario.setup();
        const preview = await syncTestFlight(client, {
          ...scenario.options,
          apply: false,
        });
        client.resetScaleCounters();
        client.rateLimitBudget =
          preMutationRequestCount +
          scenario.requiredAtPreMutationGuard +
          delta +
          (delta === 0 ? 50 : 0);
        const startingBudget = client.rateLimitBudget;
        const applying = syncTestFlight(client, {
          ...scenario.options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        });
        if (delta < 0) {
          await expect(applying, scenario.label).rejects.toThrow(
            'no mutations were attempted',
          );
          expect(client.mutations, scenario.label).toHaveLength(0);
          expect(client.rateLimitChecks[2]?.remaining, scenario.label).toBe(
            scenario.requiredAtPreMutationGuard - 1,
          );
        } else {
          const result = await applying;
          expect(result.actions.at(-1), scenario.label).toEqual({
            detail: 'Read-back verification passed.',
            kind: 'verification',
            status: 'applied',
          });
          expect(client.rateLimitChecks[2]?.remaining, scenario.label).toBe(
            scenario.requiredAtPreMutationGuard + 50,
          );
          expect(
            startingBudget - (client.rateLimitBudget ?? Number.NaN),
            scenario.label,
          ).toBe(client.providerRequestCount);
          expect(client.rateLimitBudget, scenario.label).toBeGreaterThanOrEqual(
            400,
          );
        }
      }
    }
  });

  test('reserves a topology-derived final audit for many builds and paginated membership', async () => {
    const baseline = new StatefulClient();
    baseline.rateLimitBudget = ONE_WRITE_BUDGET;
    await previewAndApply(baseline, {
      internalTesters: [{ email: 'baseline-audit@example.invalid' }],
    });
    expect(
      baseline.mutations.filter(
        ({ method, path }) => method === 'POST' && path === '/v1/betaTesters',
      ),
    ).toHaveLength(1);

    const client = new StatefulClient();
    const existing = Array.from({ length: 201 }, (_, index) =>
      resource('betaTesters', `audit-member-${index}`, {
        email: `audit-member-${index}@example.invalid`,
      }),
    );
    client.groupTesters.set('external-group', [...existing]);
    client.accountTesters.push(...existing);
    client.appTesters.push(...existing);
    client.appBuilds.splice(0, client.appBuilds.length);
    for (let index = 0; index < 250; index += 1) {
      const build = resource('builds', `audit-build-${index}`, {
        version: String(index),
      });
      client.appBuilds.push(build);
      client.individualTesters.set(build.id, []);
    }
    const options = {
      internalTesters: [{ email: 'topology-audit-new@example.invalid' }],
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    client.rateLimitBudget = ONE_WRITE_BUDGET;
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow('no mutations were attempted');
    expect(client.mutations).toHaveLength(0);
    expect(client.groupTesters.get('external-group')).toHaveLength(201);
    expect(client.appTesters).toHaveLength(201);
  });

  test('rejects additive group and group-build writes at bounded collection caps', async () => {
    const groupCap = new StatefulClient();
    groupCap.groups.splice(0, groupCap.groups.length);
    for (let index = 0; index < 200; index += 1) {
      addTypedGroup(groupCap, `cap-group-${index}`, index % 2 === 0, []);
    }
    await expect(
      syncTestFlight(groupCap, {
        apply: false,
        internalTesters: [],
      }),
    ).rejects.toThrow('no safe capacity for required group creation');
    expect(groupCap.mutations).toHaveLength(0);

    const buildCap = new StatefulClient();
    const groupBuilds = Array.from({ length: 200 }, (_, index) =>
      resource('builds', `cap-build-${index}`, { version: String(index) }),
    );
    buildCap.groupBuilds.set('internal-group', groupBuilds);
    buildCap.appBuilds.push(...groupBuilds);
    for (const build of groupBuilds) {
      buildCap.individualTesters.set(build.id, []);
    }
    await expect(
      syncTestFlight(buildCap, {
        apply: false,
        build: 'build-1',
        internalTesters: [],
        testInfo: review,
      }),
    ).rejects.toThrow('no safe capacity for an additive write');
    expect(buildCap.mutations).toHaveLength(0);
  });

  test('rejects tester links at the maximum group or app relationship count before mutation', async () => {
    for (const relationship of ['betaGroups', 'apps'] as const) {
      const client = new StatefulClient();
      const tester = resource('betaTesters', `cap-${relationship}-tester`, {
        email: `cap-${relationship}@example.invalid`,
      });
      client.accountTesters.push(tester);
      const relationships = Array.from({ length: 1_000 }, (_, index) =>
        resource(
          relationship === 'betaGroups' ? 'betaGroups' : 'apps',
          `cap-${relationship}-${index}`,
          relationship === 'betaGroups' ? { isInternalGroup: false } : {},
        ),
      );
      if (relationship === 'betaGroups') {
        client.testerGroupRelationshipOverrides.set(tester.id, relationships);
      } else {
        client.testerAppRelationshipOverrides.set(tester.id, relationships);
      }
      const options = {
        internalTesters: [{ email: `cap-${relationship}@example.invalid` }],
      } as const;
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        relationship,
      ).rejects.toThrow('no mutations were attempted');
      expect(client.mutations, relationship).toHaveLength(0);
    }
  });

  test('rejects a tester create at the bounded account collection cap before mutation', async () => {
    const client = new StatefulClient();
    client.accountTesters.push(
      ...Array.from({ length: 20_000 }, (_, index) =>
        resource('betaTesters', `account-cap-${index}`, {
          email: `account-cap-${index}@example.invalid`,
        }),
      ),
    );
    await expect(
      syncTestFlight(client, {
        apply: false,
        internalTesters: [{ email: 'account-cap-new@example.invalid' }],
      }),
    ).rejects.toThrow('exceed the safe account tester capacity');
    expect(client.mutations).toHaveLength(0);
  }, 30_000);

  test('rejects live managed-group setting drift before a planned group patch', async () => {
    type GroupSettingDrift =
      'hasAccessToAllBuilds' | 'isInternalGroup' | 'name';

    class LiveGroupSettingDriftClient extends StatefulClient {
      armed = false;
      injected = false;
      liveGroupReads = 0;

      constructor(readonly drift: GroupSettingDrift) {
        super();
        const index = this.groups.findIndex(
          ({ id }) => id === 'internal-group',
        );
        const group = this.groups[index];
        if (group === undefined) throw new Error('Missing fixture group.');
        this.groups.splice(
          index,
          1,
          resource('betaGroups', group.id, {
            ...group.attributes,
            feedbackEnabled: false,
          }),
        );
      }

      arm(): void {
        this.armed = true;
        this.liveGroupReads = 0;
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        if (this.armed && path.startsWith('/v1/apps/app-1/betaGroups?')) {
          this.liveGroupReads += 1;
          if (this.liveGroupReads === 2) {
            const index = this.groups.findIndex(
              ({ id }) => id === 'internal-group',
            );
            const group = this.groups[index];
            if (group === undefined) throw new Error('Missing fixture group.');
            this.injected = true;
            this.groups.splice(
              index,
              1,
              resource('betaGroups', group.id, {
                ...group.attributes,
                ...(this.drift === 'hasAccessToAllBuilds'
                  ? { hasAccessToAllBuilds: true }
                  : {}),
                ...(this.drift === 'isInternalGroup'
                  ? { isInternalGroup: false }
                  : {}),
                ...(this.drift === 'name'
                  ? { name: 'Concurrent Renamed Group' }
                  : {}),
              }),
            );
          }
        }
        return super.list(path);
      }
    }

    const options = {
      internalTesters: [],
    } as const;
    for (const drift of [
      'hasAccessToAllBuilds',
      'isInternalGroup',
      'name',
    ] as const) {
      const client = new LiveGroupSettingDriftClient(drift);
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      client.arm();
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        drift,
      ).rejects.toThrow('no mutations were attempted');
      expect(client.injected, drift).toBe(true);
      expect(client.mutations, drift).toHaveLength(0);
    }
  });

  test('rejects a concurrently appeared empty managed group before duplicate creation', async () => {
    class ConcurrentEmptyGroupClient extends StatefulClient {
      armed = false;
      injected = false;
      liveGroupReads = 0;

      constructor() {
        super();
        const index = this.groups.findIndex(
          ({ id }) => id === 'external-group',
        );
        if (index < 0) throw new Error('Missing fixture group.');
        this.groups.splice(index, 1);
      }

      arm(): void {
        this.armed = true;
        this.liveGroupReads = 0;
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        if (this.armed && path.startsWith('/v1/apps/app-1/betaGroups?')) {
          this.liveGroupReads += 1;
          if (this.liveGroupReads === 2) {
            this.injected = true;
            const group = resource('betaGroups', 'concurrent-external-group', {
              feedbackEnabled: true,
              hasAccessToAllBuilds: false,
              isInternalGroup: false,
              name: 'Concurrent Unmanaged External',
              publicLinkEnabled: false,
            });
            this.groups.push(group);
            this.groupAppIds.set(group.id, this.app.id);
            this.groupTesters.set(group.id, []);
            this.groupBuilds.set(group.id, []);
          }
        }
        return super.list(path);
      }
    }

    const client = new ConcurrentEmptyGroupClient();
    const options = {
      internalTesters: [],
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    client.arm();
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow('no mutations were attempted');
    expect(client.injected).toBe(true);
    expect(client.mutations).toHaveLength(0);
    expect(
      client.groups.filter(
        ({ attributes }) =>
          attributes?.name === 'Concurrent Unmanaged External' &&
          attributes.isInternalGroup === false,
      ),
    ).toHaveLength(1);
  });

  test('never accepts a created tester with an extra group or app reciprocal', async () => {
    class CreatedTesterExtraReciprocalClient extends StatefulClient {
      constructor(readonly drift: 'app' | 'group') {
        super();
        const extraGroup = resource('betaGroups', 'extra-created-group', {
          feedbackEnabled: true,
          hasAccessToAllBuilds: false,
          isInternalGroup: false,
          name: 'Synthetic Extra Group',
          publicLinkEnabled: false,
        });
        this.groups.push(extraGroup);
        this.groupAppIds.set(extraGroup.id, this.app.id);
        this.groupTesters.set(extraGroup.id, []);
        this.groupBuilds.set(extraGroup.id, []);
      }

      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        const result = await super.mutate(method, path, body, expectedType);
        if (method === 'POST' && path === '/v1/betaTesters') {
          if (this.drift === 'group') {
            const target = this.groups.find(
              ({ id }) => id === 'external-group',
            );
            const extra = this.groups.find(
              ({ id }) => id === 'extra-created-group',
            );
            if (target === undefined || extra === undefined) {
              throw new Error('Missing fixture group.');
            }
            this.testerGroupRelationshipOverrides.set('tester-1', [
              target,
              extra,
            ]);
          } else {
            this.testerAppRelationshipOverrides.set('tester-1', [
              this.app,
              resource('apps', 'another-app'),
            ]);
          }
        }
        return result;
      }
    }

    const options = {
      internalTesters: [{ email: 'extra-reciprocal@example.invalid' }],
    } as const;
    for (const drift of ['group', 'app'] as const) {
      const client = new CreatedTesterExtraReciprocalClient(drift);
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        drift,
      ).rejects.toThrow(
        'partial or indeterminate after 1 provider-accepted mutation',
      );
      expect(
        client.mutations.filter(
          ({ method, path }) => method === 'POST' && path === '/v1/betaTesters',
        ),
        drift,
      ).toHaveLength(1);
    }
  });

  test('rejects dense-topology zero-backlog downstream work before its first mutation', async () => {
    const client = new StatefulClient();
    for (let index = 1; index < 500; index += 1) {
      const build = resource('builds', `downstream-build-${index}`, {
        version: String(index),
      });
      client.appBuilds.push(build);
      client.individualTesters.set(build.id, []);
    }
    client.rateLimitBudget = 2_500;
    const options = {
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow('no mutations were attempted');
    expect(client.mutations).toHaveLength(0);
    expect(client.groupBuilds.get('internal-group')).toEqual([]);
    expect(client.groupBuilds.get('external-group')).toEqual([]);
    expect(client.submissions).toHaveLength(0);
  }, 30_000);

  test('captures the confirmed digest exactly once before the first await', async () => {
    const client = new StatefulClient();
    const requested = {
      internalTesters: [],
    } as const;
    const preview = await syncTestFlight(client, {
      ...requested,
      apply: false,
    });
    let digestReads = 0;
    const applyOptions: Record<string, unknown> = {
      ...requested,
      apply: true,
    };
    Object.defineProperty(applyOptions, 'confirmPlanDigest', {
      enumerable: true,
      get: () => {
        digestReads += 1;
        return preview.planDigest;
      },
    });

    const applying = syncTestFlight(
      client,
      applyOptions as unknown as Parameters<typeof syncTestFlight>[1],
    );
    expect(digestReads).toBe(1);
    await applying;
    expect(digestReads).toBe(1);
  });

  test('CLI refuses an unconfirmed apply and every removed external flag', () => {
    expect(() => parseCli(['sync', '--apply'])).toThrow(
      `--confirm-apply ${TEST_APP_CONFIGURATION.bundleId}`,
    );
    expect(() =>
      parseCli([
        'sync',
        '--apply',
        '--confirm-apply',
        TEST_APP_CONFIGURATION.bundleId,
      ]),
    ).toThrow('--confirm-plan');
    for (const removed of [
      ['sync', '--submit-beta-review'],
      ['sync', '--external-testers', '/secure/external.csv'],
      ['sync', '--review-info', '/secure/review.json'],
    ]) {
      expect(() => parseCli(removed), removed.join(' ')).toThrow(
        'Unknown command-line argument',
      );
    }
    expect(
      parseCli([
        'sync',
        '--test-info',
        '/secure/test-info.json',
        '--build',
        'build-1',
      ]).apply,
    ).toBe(false);
  });

  test('plan digests are stable and bind inputs, build, and Apple state', async () => {
    const client = new StatefulClient();
    const base = {
      internalTesters: [],
    } as const;
    const first = await syncTestFlight(client, { ...base, apply: false });
    const second = await syncTestFlight(client, { ...base, apply: false });
    expect(first.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(second.planDigest).toBe(first.planDigest);

    const testerPlan = await syncTestFlight(client, {
      ...base,
      apply: false,
      internalTesters: [{ email: 'internal@example.invalid' }],
    });
    const buildPlan = await syncTestFlight(client, {
      ...base,
      apply: false,
      build: 'build-1',
      testInfo: review,
    });
    expect(
      new Set([first.planDigest, testerPlan.planDigest, buildPlan.planDigest])
        .size,
    ).toBe(3);

    const internalAttributes = client.groups[0]?.attributes as
      Record<string, unknown> | undefined;
    if (internalAttributes === undefined)
      throw new Error('Missing fixture group.');
    internalAttributes.feedbackEnabled = false;
    const changedState = await syncTestFlight(client, {
      ...base,
      apply: false,
    });
    expect(changedState.planDigest).not.toBe(first.planDigest);
  });

  test('semantically identical group inventories have one digest regardless of order', async () => {
    const client = new StatefulClient();
    const otherInternal = resource('betaGroups', 'other-internal-group', {
      feedbackEnabled: true,
      hasAccessToAllBuilds: false,
      isInternalGroup: true,
      name: 'Other Internal',
    });
    client.groups.push(otherInternal);
    client.groupTesters.set(otherInternal.id, []);
    client.groupBuilds.set(otherInternal.id, []);
    const requested = {
      internalTesters: [],
    } as const;

    const first = await syncTestFlight(client, {
      ...requested,
      apply: false,
    });
    client.groups.reverse();
    const reordered = await syncTestFlight(client, {
      ...requested,
      apply: false,
    });
    expect(reordered.planDigest).toBe(first.planDigest);
  });

  test('canonical snapshots preserve own __proto__ data in the digest', async () => {
    const attributesWithMarker = (marker: string): Record<string, unknown> => {
      const attributes = Object.create(null) as Record<string, unknown>;
      Object.defineProperties(attributes, {
        feedbackEnabled: { enumerable: true, value: true },
        hasAccessToAllBuilds: { enumerable: true, value: false },
        isInternalGroup: { enumerable: true, value: true },
        name: {
          enumerable: true,
          value: TEST_APP_CONFIGURATION.internalGroupName,
        },
      });
      Object.defineProperty(attributes, '__proto__', {
        enumerable: true,
        value: { marker },
      });
      return attributes;
    };
    const requested = {
      internalTesters: [],
    } as const;
    const firstClient = new StatefulClient();
    firstClient.groups.splice(
      0,
      1,
      resource('betaGroups', 'internal-group', attributesWithMarker('first')),
    );
    const secondClient = new StatefulClient();
    secondClient.groups.splice(
      0,
      1,
      resource('betaGroups', 'internal-group', attributesWithMarker('second')),
    );

    const first = await syncTestFlight(firstClient, {
      ...requested,
      apply: false,
    });
    const second = await syncTestFlight(secondClient, {
      ...requested,
      apply: false,
    });
    expect(second.planDigest).not.toBe(first.planDigest);

    const staleClient = new StatefulClient();
    staleClient.groups.splice(
      0,
      1,
      resource('betaGroups', 'internal-group', attributesWithMarker('preview')),
    );
    const preview = await syncTestFlight(staleClient, {
      ...requested,
      apply: false,
    });
    staleClient.groups.splice(
      0,
      1,
      resource('betaGroups', 'internal-group', attributesWithMarker('apply')),
    );
    await expect(
      syncTestFlight(staleClient, {
        ...requested,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow('does not match');
    expect(staleClient.mutations).toHaveLength(0);
  });

  test('rejects inherited, accessor, symbol, and non-enumerable provider data before use', async () => {
    const safeAttributes = (): Record<string, unknown> => ({
      feedbackEnabled: true,
      hasAccessToAllBuilds: false,
      isInternalGroup: true,
      name: TEST_APP_CONFIGURATION.internalGroupName,
    });
    let getterReads = 0;
    const inherited = Object.create(safeAttributes()) as Record<
      string,
      unknown
    >;
    const accessor = safeAttributes();
    Object.defineProperty(accessor, 'hostile', {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return 'secret@example.invalid';
      },
    });
    const symbol = safeAttributes();
    symbol[Symbol('hostile') as unknown as string] = 'hidden';
    const nonEnumerable = safeAttributes();
    Object.defineProperty(nonEnumerable, 'hostile', {
      enumerable: false,
      value: 'hidden',
    });

    for (const [label, attributes] of [
      ['inherited', inherited],
      ['accessor', accessor],
      ['symbol', symbol],
      ['non-enumerable', nonEnumerable],
    ] as const) {
      const client = new StatefulClient();
      client.groups.splice(
        0,
        1,
        resource('betaGroups', 'internal-group', attributes),
      );
      await expect(
        syncTestFlight(client, {
          apply: false,
          internalTesters: [],
        }),
        label,
      ).rejects.toThrow();
      expect(client.mutations, label).toHaveLength(0);
    }
    expect(getterReads).toBe(0);
  });

  test('never invokes an overridden tester-array map', async () => {
    const client = new StatefulClient();
    let hostileMapCalls = 0;
    const externalTesters = [{ email: 'approved@example.invalid' }] as Array<{
      email: string;
    }>;
    Object.defineProperty(externalTesters, 'map', {
      configurable: true,
      value: () => {
        hostileMapCalls += 1;
        return [{ email: 'retained@example.invalid' }];
      },
    });
    await expect(
      syncTestFlight(client, {
        apply: false,
        internalTesters: externalTesters,
      }),
    ).rejects.toThrow();
    expect(hostileMapCalls).toBe(0);
    expect(client.listPaths).toHaveLength(0);
    expect(client.mutations).toHaveLength(0);
  });

  test('a stale plan digest fails with zero mutations', async () => {
    const client = new StatefulClient();
    const options = {
      internalTesters: [],
    } as const;
    const preview = await syncTestFlight(client, { ...options, apply: false });
    const attributes = client.groups[0]?.attributes as
      Record<string, unknown> | undefined;
    if (attributes === undefined) throw new Error('Missing fixture group.');
    attributes.feedbackEnabled = false;
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow('does not match');
    expect(client.mutations).toHaveLength(0);
  });

  test('apply uses one immutable decision transcript instead of a second live reconcile', async () => {
    class TranscriptClient extends StatefulClient {
      readonly operations: string[] = [];

      override async first(path: string): Promise<JsonApiResource | null> {
        this.operations.push(`first ${path}`);
        return super.first(path);
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        this.operations.push(`list ${path}`);
        return super.list(path);
      }

      override async pageSummary(path: string): Promise<JsonApiPageSummary> {
        this.operations.push(`pageSummary ${path}`);
        return super.pageSummary(path);
      }

      override async get(
        path: string,
        expectedType: string,
      ): Promise<JsonApiResource> {
        this.operations.push(`get ${path}`);
        return super.get(path, expectedType);
      }

      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        this.operations.push(`mutate ${path}`);
        return super.mutate(method, path, body, expectedType);
      }
    }

    const client = new TranscriptClient();
    client.accountTesters.push(
      resource('betaTesters', 'existing-account-tester', {
        email: 'approved@example.invalid',
      }),
    );
    const requested = {
      internalTesters: [{ email: 'approved@example.invalid' }],
    } as const;
    const preview = await syncTestFlight(client, {
      ...requested,
      apply: false,
    });
    const previewTranscript = [...client.operations];
    client.operations.splice(0);

    await syncTestFlight(client, {
      ...requested,
      apply: true,
      confirmPlanDigest: preview.planDigest,
    });
    const firstMutation = client.operations.findIndex((operation) =>
      operation.startsWith('mutate '),
    );
    expect(firstMutation).toBeGreaterThanOrEqual(0);
    const beforeMutation = client.operations.slice(0, firstMutation);
    expect(beforeMutation.slice(0, previewTranscript.length)).toEqual(
      previewTranscript,
    );
    const assertionReads = beforeMutation.slice(previewTranscript.length);
    expect(assertionReads).toHaveLength(38);
    expect(
      assertionReads.every(
        (operation) =>
          operation.startsWith('list ') ||
          operation.startsWith('pageSummary ') ||
          operation.startsWith('get '),
      ),
    ).toBe(true);
    for (const expected of [
      'list /v1/apps/app-1/betaGroups?',
      'list /v1/betaGroups/internal-group/betaTesters?',
      'list /v1/betaGroups/internal-group/builds?',
      'list /v1/betaGroups/internal-group/relationships/builds?limit=200',
      'list /v1/betaTesters?',
      'list /v1/apps/app-1/builds?',
      'list /v1/apps/app-1/relationships/builds?',
      'list /v1/builds/build-1/individualTesters?',
      'get /v1/betaTesters/existing-account-tester',
    ]) {
      expect(
        assertionReads.some((operation) => operation.startsWith(expected)),
        expected,
      ).toBe(true);
    }
    expect(assertionReads.slice(-8)).toEqual([
      'list /v1/betaTesters/existing-account-tester/relationships/builds?limit=200',
      'get /v1/betaTesters/existing-account-tester?fields%5BbetaTesters%5D=email',
      'get /v1/betaGroups/internal-group?fields%5BbetaGroups%5D=name%2CisInternalGroup%2ChasAccessToAllBuilds%2CfeedbackEnabled%2CpublicLinkEnabled',
      'get /v1/betaGroups/internal-group/app',
      'list /v1/betaGroups/internal-group/builds?fields%5Bbuilds%5D=version%2CuploadedDate&limit=200',
      'list /v1/betaGroups/internal-group/relationships/builds?limit=200',
      'pageSummary /v1/betaGroups/internal-group/betaTesters?fields%5BbetaTesters%5D=email&limit=1',
      'pageSummary /v1/betaGroups/internal-group/relationships/betaTesters?limit=1',
    ]);
  });

  test('build or membership drift at the apply guard causes zero tester writes', async () => {
    for (const drift of ['build', 'membership'] as const) {
      const client = new StatefulClient();
      const requested = {
        internalTesters: [{ email: 'internal@example.invalid' }],
      } as const;
      const preview = await syncTestFlight(client, {
        ...requested,
        apply: false,
      });
      if (drift === 'build') {
        client.groupBuilds.set('internal-group', [client.build]);
      } else {
        client.groupTesters.set('internal-group', [
          resource('betaTesters', 'new-membership', {
            email: 'internal@example.invalid',
          }),
        ]);
      }

      await expect(
        syncTestFlight(client, {
          ...requested,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
      ).rejects.toThrow();
      expect(
        client.mutations.filter(
          ({ path }) =>
            path === '/v1/betaTesters' ||
            path.endsWith('/relationships/betaTesters'),
        ),
      ).toHaveLength(0);
    }
  });

  test('snapshots caller-owned inputs before the first await', async () => {
    class BarrierClient extends StatefulClient {
      pauseEnabled = false;
      readonly reached: Promise<void>;
      readonly #release: Promise<void>;
      #markReached: () => void = () => undefined;
      #resume: () => void = () => undefined;
      #paused = false;

      constructor() {
        super();
        this.reached = new Promise((resolvePromise) => {
          this.#markReached = resolvePromise;
        });
        this.#release = new Promise((resolvePromise) => {
          this.#resume = resolvePromise;
        });
      }

      resume(): void {
        this.#resume();
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        if (
          this.pauseEnabled &&
          !this.#paused &&
          path.startsWith('/v1/apps?')
        ) {
          this.#paused = true;
          this.#markReached();
          await this.#release;
        }
        return super.list(path);
      }
    }

    const client = new BarrierClient();
    const tester = { email: 'original@example.invalid' };
    const requested: RequestedSync = {
      internalTesters: [tester],
    };
    const preview = await syncTestFlight(client, {
      ...requested,
      apply: false,
    });
    client.pauseEnabled = true;
    const applying = syncTestFlight(client, {
      ...requested,
      apply: true,
      confirmPlanDigest: preview.planDigest,
    });
    await client.reached;
    tester.email = 'changed@example.invalid';
    client.resume();
    await applying;
    const mutations = JSON.stringify(client.mutations);
    expect(mutations).toContain('original@example.invalid');
    expect(mutations).not.toContain('changed@example.invalid');
  });

  test('reports a later failure after an accepted write as partial or indeterminate', async () => {
    class SecondMutationFailsClient extends StatefulClient {
      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        if (this.mutations.length >= 1) {
          throw new Error('synthetic provider failure with secret payload');
        }
        return super.mutate(method, path, body, expectedType);
      }
    }

    const client = new SecondMutationFailsClient();
    client.groups.splice(0);
    const requested = {
      internalTesters: [{ email: 'second-mutation@example.invalid' }],
    } as const;
    const preview = await syncTestFlight(client, {
      ...requested,
      apply: false,
    });
    await expect(
      syncTestFlight(client, {
        ...requested,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow('partial or indeterminate after 1 provider-accepted');
    expect(client.mutations).toHaveLength(1);
  });

  test('rejects exact dot-segment app and caller build IDs before follow-on provider activity', async () => {
    for (const id of ['.', '..']) {
      const appClient = new StatefulClient();
      (appClient.app as { id: string }).id = id;
      await expect(
        syncTestFlight(appClient, {
          apply: false,
          internalTesters: [],
        }),
        `app:${id}`,
      ).rejects.toThrow('resource ID was malformed');
      expect(appClient.listPaths, `app:${id}`).toHaveLength(1);
      expect(appClient.getPaths, `app:${id}`).toHaveLength(0);
      expect(appClient.mutations, `app:${id}`).toHaveLength(0);

      const buildClient = new StatefulClient();
      await expect(
        syncTestFlight(buildClient, {
          apply: false,
          build: id,
          internalTesters: [],
        }),
        `build:${id}`,
      ).rejects.toThrow('Build ID was malformed');
      expect(buildClient.listPaths, `build:${id}`).toHaveLength(0);
      expect(buildClient.getPaths, `build:${id}`).toHaveLength(0);
      expect(buildClient.mutations, `build:${id}`).toHaveLength(0);
    }
  });

  test('apply requires the exact build ID from a prior preview', async () => {
    await expect(
      syncTestFlight(new StatefulClient(), {
        apply: true,
        build: 'latest',
        confirmPlanDigest: `sha256:${'0'.repeat(64)}`,
        internalTesters: [],
      }),
    ).rejects.toThrow('exact build ID');
  });

  test('plan mode describes all consequences without a mutation or sensitive values', async () => {
    const client = new PlanClient();
    const result = await syncTestFlight(client, {
      apply: false,
      build: 'build-1',
      internalTesters: [{ email: 'internal@example.invalid' }],
      testInfo: review,
    });
    expect(result.mode).toBe('plan');
    expect(result.actions.filter(({ kind }) => kind === 'group')).toHaveLength(
      1,
    );
    expect(
      result.actions.filter(({ kind }) => kind === 'build-distribution'),
    ).toHaveLength(1);
    expect(
      result.actions.some(({ detail }) =>
        detail.toLocaleLowerCase('en-US').includes('beta app review'),
      ),
    ).toBe(false);
    const output = JSON.stringify(result);
    expect(output).not.toContain('internal@example.invalid');
    expect(result.selectedBuild).toEqual({
      audienceType: 'APP_STORE_ELIGIBLE',
      externalBuildState: 'READY_FOR_BETA_SUBMISSION',
      id: 'build-1',
      internalBuildState: 'READY_FOR_BETA_TESTING',
      platform: 'IOS',
      uploadedDate: '2026-08-08T12:00:00Z',
      usesNonExemptEncryption: false,
      version: '1',
    });
    expect(
      client.listPaths.some(
        (path) =>
          path.startsWith('/v1/builds?') &&
          (path.includes('filter%5BpreReleaseVersion.platform%5D=IOS') ||
            path.includes('filter[preReleaseVersion.platform]=IOS')),
      ),
    ).toBe(true);
  });

  test('latest preview deterministically selects the first sorted build', async () => {
    class MultipleBuildClient extends StatefulClient {
      override async first(path: string): Promise<JsonApiResource | null> {
        expect(path).toContain('limit=1');
        expect(path).toContain('sort=-uploadedDate');
        expect(
          path.includes('filter%5BpreReleaseVersion.platform%5D=IOS') ||
            path.includes('filter[preReleaseVersion.platform]=IOS'),
        ).toBe(true);
        return this.build;
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        if (path.startsWith('/v1/builds?') && path.includes('sort=')) {
          throw new Error('Latest build lookup followed pagination.');
        }
        return super.list(path);
      }
    }

    const result = await syncTestFlight(new MultipleBuildClient(), {
      apply: false,
      build: 'latest',
      internalTesters: [],
    });
    expect(result.selectedBuild?.id).toBe('build-1');
    expect(result.selectedBuild?.platform).toBe('IOS');
  });

  test('rejects exact and latest non-iOS builds before every mutation', async () => {
    for (const build of ['build-1', 'latest'] as const) {
      const client = new StatefulClient();
      client.preReleaseVersion = resource(
        'preReleaseVersions',
        'pre-release-1',
        {
          platform: 'MAC_OS',
          version: '1.0',
        },
      );
      await expect(
        syncTestFlight(client, {
          apply: false,
          build,
          internalTesters: [],
          testInfo: review,
        }),
        build,
      ).rejects.toThrow(/iOS|IOS/u);
      expect(client.mutations, build).toHaveLength(0);
      expect(
        client.listPaths.some(
          (path) =>
            path.startsWith('/v1/builds?') &&
            (path.includes('filter%5BpreReleaseVersion.platform%5D=IOS') ||
              path.includes('filter[preReleaseVersion.platform]=IOS')),
        ),
        build,
      ).toBe(true);
    }
  });

  test('blocks build attachment when the live iOS platform relationship drifts', async () => {
    class PlatformDriftClient extends StatefulClient {
      preReleaseReads = 0;

      override async get(
        path: string,
        expectedType: string,
      ): Promise<JsonApiResource> {
        if (
          path.startsWith('/v1/builds/build-1/preReleaseVersion') &&
          expectedType === 'preReleaseVersions'
        ) {
          this.preReleaseReads += 1;
          if (this.preReleaseReads >= 3) {
            return resource('preReleaseVersions', 'pre-release-1', {
              platform: 'MAC_OS',
              version: '1.0',
            });
          }
        }
        return super.get(path, expectedType);
      }
    }

    const client = new PlatformDriftClient();
    seedMatchingTestMetadata(client);
    const options = {
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow('no mutations were attempted');
    expect(client.preReleaseReads).toBeGreaterThanOrEqual(3);
    expect(
      client.mutations.filter(({ path }) =>
        path.endsWith('/relationships/builds'),
      ),
    ).toHaveLength(0);
  });

  test('rejects a selected build that is not app scoped', async () => {
    class WrongBuildAppClient extends StatefulClient {
      override async get(
        path: string,
        expectedType: string,
      ): Promise<JsonApiResource> {
        if (path === '/v1/builds/build-1/app' && expectedType === 'apps') {
          return resource('apps', 'another-app');
        }
        return super.get(path, expectedType);
      }
    }

    const client = new WrongBuildAppClient();
    await expect(
      syncTestFlight(client, {
        apply: false,
        build: 'build-1',
        internalTesters: [],
        testInfo: review,
      }),
    ).rejects.toThrow('does not belong');
    expect(client.mutations).toHaveLength(0);
  });

  test('binds the prerelease-version platform proof to the exact app and selected build set', async () => {
    const wrongApp = new StatefulClient();
    wrongApp.preReleaseVersionAppIds.set('pre-release-1', 'another-app');

    const omittedBuild = new StatefulClient();
    omittedBuild.preReleaseVersionBuilds.set('pre-release-1', []);

    const duplicateBuild = new StatefulClient();
    duplicateBuild.preReleaseVersionBuilds.set('pre-release-1', [
      duplicateBuild.build,
      duplicateBuild.build,
    ]);

    const wrongType = new StatefulClient();
    wrongType.preReleaseVersionBuilds.set('pre-release-1', [
      resource('users', 'wrong-prerelease-build-type'),
    ]);

    for (const [label, client] of [
      ['wrong app', wrongApp],
      ['omitted selected build', omittedBuild],
      ['duplicate selected build', duplicateBuild],
      ['wrong build type', wrongType],
    ] as const) {
      await expect(
        syncTestFlight(client, {
          apply: false,
          build: 'build-1',
          internalTesters: [],
          testInfo: review,
        }),
        label,
      ).rejects.toThrow();
      expect(client.mutations, label).toHaveLength(0);
    }

    const correct = new StatefulClient();
    await syncTestFlight(correct, {
      apply: false,
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    });
    expect(correct.getPaths).toContain(
      '/v1/preReleaseVersions/pre-release-1/app',
    );
    expect(
      correct.listPaths.some((path) =>
        path.startsWith('/v1/preReleaseVersions/pre-release-1/builds?'),
      ),
    ).toBe(true);
  });

  test('rechecks the complete prerelease-version parent proof before build attachment', async () => {
    class PreReleaseParentDriftClient extends StatefulClient {
      relationshipReads = 0;

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (path.startsWith('/v1/preReleaseVersions/pre-release-1/builds?')) {
          this.relationshipReads += 1;
          if (this.relationshipReads >= 3) return [];
        }
        return current;
      }
    }

    const client = new PreReleaseParentDriftClient();
    seedMatchingTestMetadata(client);
    const options = {
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow('no mutations were attempted');
    expect(client.relationshipReads).toBeGreaterThanOrEqual(3);
    expect(client.mutations).toHaveLength(0);
  });

  test('requires approved beta test info for every exact build', async () => {
    const exactClient = new StatefulClient();
    await expect(
      syncTestFlight(exactClient, {
        apply: false,
        build: 'build-1',
        internalTesters: [],
      }),
    ).rejects.toThrow('approved beta test info, including What to Test');
    expect(exactClient.listPaths).toHaveLength(0);
    expect(exactClient.mutations).toHaveLength(0);
  });

  test('accepts only positive internal beta states and records encryption evidence', async () => {
    for (const internalBuildState of [
      'READY_FOR_BETA_TESTING',
      'IN_BETA_TESTING',
    ]) {
      for (const usesNonExemptEncryption of [false, true]) {
        const client = new StatefulClient();
        client.buildAttributes.usesNonExemptEncryption =
          usesNonExemptEncryption;
        client.buildBetaDetail = resource(
          'buildBetaDetails',
          'build-detail-1',
          {
            autoNotifyEnabled: false,
            externalBuildState: 'READY_FOR_BETA_SUBMISSION',
            internalBuildState,
          },
        );
        const result = await syncTestFlight(client, {
          apply: false,
          build: 'build-1',
          internalTesters: [],
          testInfo: review,
        });
        expect(result.selectedBuild).toMatchObject({
          externalBuildState: 'READY_FOR_BETA_SUBMISSION',
          internalBuildState,
          usesNonExemptEncryption,
        });
      }
    }

    for (const internalBuildState of [
      'PROCESSING',
      'MISSING_EXPORT_COMPLIANCE',
      'FUTURE_UNKNOWN_STATE',
      undefined,
    ]) {
      const client = new StatefulClient();
      client.buildBetaDetail = resource('buildBetaDetails', 'build-detail-1', {
        autoNotifyEnabled: false,
        externalBuildState: 'READY_FOR_BETA_SUBMISSION',
        internalBuildState,
      });
      await expect(
        syncTestFlight(client, {
          apply: false,
          build: 'build-1',
          internalTesters: [],
          testInfo: review,
        }),
      ).rejects.toThrow();
      expect(client.mutations).toHaveLength(0);
    }

    for (const usesNonExemptEncryption of [undefined, 'false']) {
      const client = new StatefulClient();
      client.buildAttributes.usesNonExemptEncryption = usesNonExemptEncryption;
      await expect(
        syncTestFlight(client, {
          apply: false,
          build: 'build-1',
          internalTesters: [],
          testInfo: review,
        }),
      ).rejects.toThrow('malformed selected-build metadata');
      expect(client.mutations).toHaveLength(0);
    }
  });

  test('binds build-beta-detail readiness and notification evidence to the exact build', async () => {
    const wrongParent = new StatefulClient();
    wrongParent.buildBetaDetailBuildId = 'another-build';
    await expect(
      syncTestFlight(wrongParent, {
        apply: false,
        build: 'build-1',
        internalTesters: [],
        testInfo: review,
      }),
    ).rejects.toThrow();
    expect(wrongParent.mutations).toHaveLength(0);

    const correct = new StatefulClient();
    await syncTestFlight(correct, {
      apply: false,
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    });
    expect(correct.getPaths).toContain(
      '/v1/buildBetaDetails/build-detail-1/build',
    );
  });

  test('preflights tester limits across every group in an audience', async () => {
    const client = new StatefulClient();
    client.groups.push(
      resource('betaGroups', 'other-internal-group', {
        hasAccessToAllBuilds: false,
        isInternalGroup: true,
        name: 'Other Internal',
      }),
    );
    const otherInternalTesters = Array.from({ length: 99 }, (_, index) =>
      resource('betaTesters', `existing-${index}`, {
        email: `existing-${index}@example.invalid`,
      }),
    );
    client.groupTesters.set('other-internal-group', otherInternalTesters);
    client.appTesters.push(...otherInternalTesters);
    for (const index of [1, 2]) {
      client.users.push(
        resource('users', `new-user-${index}`, {
          allAppsVisible: true,
          roles: ['APP_MANAGER'],
          username: `new-${index}@example.invalid`,
        }),
      );
    }
    await expect(
      syncTestFlight(client, {
        apply: false,
        internalTesters: [
          { email: 'new-1@example.invalid' },
          { email: 'new-2@example.invalid' },
        ],
      }),
    ).rejects.toThrow('App-wide internal membership');
    expect(client.mutations).toHaveLength(0);
  });

  test('allows same-audience multi-group membership and stays idempotent after linking', async () => {
    const client = new StatefulClient();
    const existing = resource('betaTesters', 'same-audience-tester', {
      email: 'same-audience@example.invalid',
    });
    addTypedGroup(client, 'other-internal-group', true, [existing]);
    client.accountTesters.push(existing);
    client.appTesters.push(existing);
    const options = {
      internalTesters: [{ email: 'same-audience@example.invalid' }],
    } as const;

    const first = await previewAndApply(client, options);
    expect(first.actions.at(-1)?.kind).toBe('verification');
    expect(
      client.groupTesters
        .get('internal-group')
        ?.some(({ id }) => id === existing.id),
    ).toBe(true);
    expect(
      client.groupTesters
        .get('other-internal-group')
        ?.some(({ id }) => id === existing.id),
    ).toBe(true);
    expect(
      client.mutations.filter(
        ({ method, path }) =>
          method === 'POST' &&
          path === '/v1/betaGroups/internal-group/relationships/betaTesters',
      ),
    ).toHaveLength(1);

    const mutationCount = client.mutations.length;
    const second = await previewAndApply(client, options);
    expect(client.mutations).toHaveLength(mutationCount);
    expect(
      second.actions.filter(({ status }) => status === 'planned'),
    ).toHaveLength(0);
  });

  test('still rejects a desired tester classified in the opposite audience', async () => {
    const client = new StatefulClient();
    const internal = resource('betaTesters', 'cross-audience-tester', {
      email: 'cross-audience@example.invalid',
    });
    addTypedGroup(client, 'other-external-group', false, [internal]);
    client.accountTesters.push(internal);
    client.appTesters.push(internal);

    await expect(
      syncTestFlight(client, {
        apply: false,
        internalTesters: [{ email: 'cross-audience@example.invalid' }],
      }),
    ).rejects.toThrow('opposite app audience');
    expect(client.mutations).toHaveLength(0);
  });

  test('correlates an anonymous app tester ID before rejecting an opposite-audience email match', async () => {
    const client = new StatefulClient();
    const anonymousInternal = resource(
      'betaTesters',
      'anonymous-cross-audience-id',
    );
    addTypedGroup(client, 'anonymous-external-classifier', false, [
      anonymousInternal,
    ]);
    client.appTesters.push(anonymousInternal);
    client.accountTesters.push(
      resource('betaTesters', anonymousInternal.id, {
        email: 'anonymous-cross-audience@example.invalid',
      }),
    );
    const options = {
      internalTesters: [{ email: 'anonymous-cross-audience@example.invalid' }],
    } as const;

    let message = '';
    try {
      await syncTestFlight(client, { ...options, apply: false });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/audience|identity/u);
    expect(message).not.toContain('anonymous-cross-audience@example.invalid');
    expect(
      client.listPaths.some((path) =>
        decodeURIComponent(path).includes(
          'anonymous-cross-audience@example.invalid',
        ),
      ),
    ).toBe(false);
    expect(client.mutations).toHaveLength(0);

    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: `sha256:${'0'.repeat(64)}`,
      }),
    ).rejects.toThrow(/audience|identity/u);
    expect(client.mutations).toHaveLength(0);
  });

  test('rejects one account tester ID returned with conflicting desired identities', async () => {
    const client = new StatefulClient();
    client.accountTesters.push(
      resource('betaTesters', 'shared-cross-call-id', {
        email: 'shared-internal@example.invalid',
      }),
      resource('betaTesters', 'shared-cross-call-id', {
        email: 'shared-external@example.invalid',
      }),
    );
    client.users.push(
      resource('users', 'shared-internal-user', {
        allAppsVisible: true,
        roles: ['APP_MANAGER'],
        username: 'shared-internal@example.invalid',
      }),
    );
    const options = {
      internalTesters: [{ email: 'shared-internal@example.invalid' }],
    } as const;

    await expect(
      syncTestFlight(client, { ...options, apply: false }),
    ).rejects.toThrow(/conflicting|duplicate|identity|audience/u);
    expect(client.mutations).toHaveLength(0);
  });

  test('ignores unrelated valid account testers and locally links only the desired identity', async () => {
    const client = new StatefulClient();
    client.accountTesters.push(
      resource('betaTesters', 'requested-account-id', {
        email: 'REQUESTED@example.invalid',
      }),
      resource('betaTesters', 'unrelated-account-id', {
        email: 'unrelated-account@example.invalid',
      }),
    );
    const options = {
      internalTesters: [{ email: 'requested@example.invalid' }],
    } as const;
    await previewAndApply(client, options);
    expect(
      client.mutations.some(({ path }) => path === '/v1/betaTesters'),
    ).toBe(false);
    expect(
      client.mutations.some(({ path }) =>
        path.endsWith('/relationships/betaTesters'),
      ),
    ).toBe(true);
    expect(
      client.groupTesters
        .get('internal-group')
        ?.some(({ id }) => id === 'requested-account-id'),
    ).toBe(true);
    expect(
      client.groupTesters
        .get('internal-group')
        ?.some(({ id }) => id === 'unrelated-account-id'),
    ).toBe(false);
    expect(
      client.listPaths.some((path) =>
        decodeURIComponent(path).includes('unrelated-account@example.invalid'),
      ),
    ).toBe(false);
  });

  test('rejects a provider-created tester ID reused across desired audiences', async () => {
    class ReusedCreatedIdentityClient extends StatefulClient {
      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        if (method === 'POST' && path === '/v1/betaTesters') {
          this.mutations.push({ body, method, path });
          const created = resource(
            'betaTesters',
            'provider-reused-created-id',
            { email: dataAttributes(body).email },
          );
          const groupId = relationshipId(body, 'betaGroups');
          this.accountTesters.push(created);
          this.appTesters.push(created);
          this.groupTesters.get(groupId)?.push(created);
          return created;
        }
        return super.mutate(method, path, body, expectedType);
      }
    }

    const client = new ReusedCreatedIdentityClient();
    client.users.push(
      resource('users', 'created-id-internal-user', {
        allAppsVisible: true,
        roles: ['APP_MANAGER'],
        username: 'created-id-internal@example.invalid',
      }),
    );
    const options = {
      internalTesters: [
        { email: 'created-id-internal@example.invalid' },
        { email: 'created-id-second@example.invalid' },
      ],
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    expect(client.mutations).toHaveLength(0);

    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow(
      'partial or indeterminate after 2 provider-accepted mutation',
    );
    expect(
      client.mutations.filter(
        ({ method, path }) => method === 'POST' && path === '/v1/betaTesters',
      ),
    ).toHaveLength(2);
  });

  test('allows an anonymous tester ID resolved to the same typed audience', async () => {
    const client = new StatefulClient();
    const anonymousInternal = resource(
      'betaTesters',
      'anonymous-same-audience-id',
    );
    addTypedGroup(client, 'anonymous-same-internal-classifier', true, [
      anonymousInternal,
    ]);
    client.appTesters.push(anonymousInternal);
    client.accountTesters.push(
      resource('betaTesters', anonymousInternal.id, {
        email: 'internal@example.invalid',
      }),
    );
    const options = {
      internalTesters: [{ email: 'internal@example.invalid' }],
    } as const;

    await previewAndApply(client, options);
    expect(
      client.groupTesters
        .get('internal-group')
        ?.some(({ id }) => id === anonymousInternal.id),
    ).toBe(true);
    const mutationCount = client.mutations.length;
    await previewAndApply(client, options);
    expect(client.mutations).toHaveLength(mutationCount);
  });

  test('fails closed on an unclassified app-assigned tester', async () => {
    class AppAssignedTesterClient extends StatefulClient {
      readonly assignedToApp = [
        resource('betaTesters', 'app-assigned-1', {
          email: 'app-assigned-1@example.invalid',
        }),
      ];
    }

    const client = new AppAssignedTesterClient();
    client.appTesters.push(...client.assignedToApp);
    await expect(
      syncTestFlight(client, {
        apply: false,
        internalTesters: [{ email: 'new-external@example.invalid' }],
      }),
    ).rejects.toThrow();
    expect(
      client.listPaths.some(
        (path) =>
          path.startsWith('/v1/betaTesters?') &&
          (path.includes('filter%5Bapps%5D=app-1') ||
            path.includes('filter[apps]=app-1')),
      ),
    ).toBe(true);
    expect(client.mutations).toHaveLength(0);
  });

  test('validates typed group, app, all-build, and individual tester inventories', async () => {
    const missingAudience = new StatefulClient();
    missingAudience.groups.push(
      resource('betaGroups', 'untyped-group', { name: 'Untyped' }),
    );
    missingAudience.groupTesters.set('untyped-group', []);
    missingAudience.groupBuilds.set('untyped-group', []);

    const wrongAppTester = new StatefulClient();
    wrongAppTester.appTesters.push(
      resource('users', 'wrong-app-tester', {
        email: 'wrong-app-tester@example.invalid',
      }),
    );

    const wrongBuildInventory = new StatefulClient();
    wrongBuildInventory.appBuilds.splice(
      0,
      wrongBuildInventory.appBuilds.length,
      resource('users', 'wrong-build-inventory'),
    );

    const wrongIndividual = new StatefulClient();
    wrongIndividual.individualTesters.set('build-1', [
      resource('users', 'wrong-individual-tester', {
        email: 'wrong-individual@example.invalid',
      }),
    ]);

    for (const [label, client] of [
      ['untyped group', missingAudience],
      ['app tester type', wrongAppTester],
      ['build type', wrongBuildInventory],
      ['individual tester type', wrongIndividual],
    ] as const) {
      await expect(
        syncTestFlight(client, {
          apply: false,
          internalTesters: [],
        }),
        label,
      ).rejects.toThrow();
      expect(client.mutations, label).toHaveLength(0);
    }
  });

  test('requires forward group and individual-build inventories to match raw relationship linkage', async () => {
    const requested = {
      internalTesters: [],
    } as const;
    const cases: Array<{
      client: StatefulClient;
      label: string;
    }> = [];

    for (const [label, linkage] of [
      ['group linkage omitted', []],
      [
        'group linkage wrong',
        [resource('betaTesters', 'another-group-tester')],
      ],
      [
        'group linkage duplicate',
        [
          resource('betaTesters', 'duplicate-group-tester'),
          resource('betaTesters', 'duplicate-group-tester'),
        ],
      ],
      ['group linkage wrong type', [resource('apps', 'typed-group-tester')]],
    ] as const) {
      const client = new StatefulClient();
      const suffix = label.replaceAll(' ', '-');
      const tester = resource('betaTesters', `tester-${suffix}`, {
        email: `tester-${suffix}@example.invalid`,
      });
      addTypedGroup(client, 'forward-group', false, [tester]);
      client.groupTesterLinkageOverrides.set('forward-group', [...linkage]);
      cases.push({ client, label });
    }

    for (const [label, linkage] of [
      ['build linkage omitted', []],
      [
        'build linkage wrong',
        [resource('betaTesters', 'another-build-tester')],
      ],
      [
        'build linkage duplicate',
        [
          resource('betaTesters', 'duplicate-build-tester'),
          resource('betaTesters', 'duplicate-build-tester'),
        ],
      ],
      ['build linkage wrong type', [resource('apps', 'typed-build-tester')]],
    ] as const) {
      const client = new StatefulClient();
      const suffix = label.replaceAll(' ', '-');
      const tester = resource('betaTesters', `tester-${suffix}`, {
        email: `tester-${suffix}@example.invalid`,
      });
      addTypedGroup(client, 'forward-build-classifier', false, [tester]);
      client.appTesters.push(tester);
      client.individualTesters.set('build-1', [tester]);
      client.individualTesterLinkageOverrides.set('build-1', [...linkage]);
      cases.push({ client, label });
    }

    for (const { client, label } of cases) {
      await expect(
        syncTestFlight(client, { ...requested, apply: false }),
        label,
      ).rejects.toThrow();
      expect(client.mutations, label).toHaveLength(0);
    }

    const correct = new StatefulClient();
    const groupTester = resource('betaTesters', 'correct-group-tester', {
      email: 'correct-group-tester@example.invalid',
    });
    const buildTester = resource('betaTesters', 'correct-build-tester', {
      email: 'correct-build-tester@example.invalid',
    });
    addTypedGroup(correct, 'forward-group', false, [groupTester, buildTester]);
    correct.appTesters.push(groupTester, buildTester);
    correct.individualTesters.set('build-1', [buildTester]);
    const result = await syncTestFlight(correct, {
      ...requested,
      apply: false,
    });
    expect(result.mode).toBe('plan');
    expect(correct.mutations).toHaveLength(0);
  });

  test('bounds every new reciprocal and relationship collection with limit 200', async () => {
    const client = new StatefulClient();
    const inventoryTester = resource(
      'betaTesters',
      'bounded-relationship-tester',
      { email: 'bounded-relationship-tester@example.invalid' },
    );
    addTypedGroup(client, 'bounded-relationship-group', true, [
      inventoryTester,
    ]);
    client.appTesters.push(inventoryTester);
    client.individualTesters.set('build-1', [inventoryTester]);
    client.accountTesters.push(inventoryTester);
    client.users.splice(
      0,
      client.users.length,
      resource('users', 'bounded-relationship-user', {
        allAppsVisible: false,
        roles: ['APP_MANAGER'],
        username: 'bounded-relationship-tester@example.invalid',
      }),
    );
    client.userVisibleApps.set('bounded-relationship-user', [client.app]);

    await previewAndApply(client, {
      internalTesters: [
        { email: 'bounded-relationship-tester@example.invalid' },
      ],
    });

    const boundedPaths = client.listPaths.filter((path) => {
      const pathname = new URL(path, 'https://api.appstoreconnect.apple.com')
        .pathname;
      return (
        /^\/v1\/betaTesters\/[^/]+\/(?:relationships\/)?(?:apps|betaGroups|builds)$/u.test(
          pathname,
        ) ||
        /^\/v1\/betaGroups\/[^/]+\/relationships\/(?:betaTesters|builds)$/u.test(
          pathname,
        ) ||
        /^\/v1\/builds\/[^/]+\/relationships\/individualTesters$/u.test(
          pathname,
        ) ||
        /^\/v1\/users\/[^/]+\/relationships\/visibleApps$/u.test(pathname)
      );
    });
    expect(boundedPaths.length).toBeGreaterThan(0);
    for (const expectedPath of [
      '/v1/betaTesters/bounded-relationship-tester/betaGroups',
      '/v1/betaTesters/bounded-relationship-tester/relationships/betaGroups',
      '/v1/betaTesters/bounded-relationship-tester/apps',
      '/v1/betaTesters/bounded-relationship-tester/relationships/apps',
      '/v1/betaGroups/internal-group/relationships/betaTesters',
      '/v1/betaGroups/internal-group/relationships/builds',
      '/v1/builds/build-1/relationships/individualTesters',
      '/v1/users/bounded-relationship-user/relationships/visibleApps',
    ]) {
      expect(
        boundedPaths.some(
          (path) =>
            new URL(path, 'https://api.appstoreconnect.apple.com').pathname ===
            expectedPath,
        ),
        expectedPath,
      ).toBe(true);
    }
    for (const path of boundedPaths) {
      const url = new URL(path, 'https://api.appstoreconnect.apple.com');
      expect(url.searchParams.getAll('limit'), path).toEqual(['200']);
      expect(url.searchParams.has('cursor'), path).toBe(false);
      const fields = [...url.searchParams.entries()].filter(
        ([key]) => key !== 'limit',
      );
      expect(fields, path).toEqual(
        url.pathname.endsWith('/betaGroups') &&
          !url.pathname.includes('/relationships/')
          ? [['fields[betaGroups]', 'isInternalGroup']]
          : [],
      );
    }
  });

  test('requires app build related resources and relationship linkage to match exactly', async () => {
    class ExtendedBuildInventoryClient extends StatefulClient {
      readonly inventoryBuild = resource('builds', 'inventory-build', {
        version: '2',
      });

      constructor(scenario: 'correct' | 'linkage-omitted' | 'wrong-type') {
        super();
        this.individualTesters.set(this.inventoryBuild.id, []);
        if (scenario === 'wrong-type') {
          this.appBuilds.push(resource('users', this.inventoryBuild.id));
          this.appBuildLinkageOverride = [...this.appBuilds];
        } else {
          this.appBuilds.push(this.inventoryBuild);
          if (scenario === 'linkage-omitted') {
            this.appBuildLinkageOverride = [this.build];
          }
        }
      }
    }

    const requested = {
      apply: false,
      internalTesters: [],
    } as const;
    for (const scenario of ['linkage-omitted', 'wrong-type'] as const) {
      const client = new ExtendedBuildInventoryClient(scenario);
      await expect(
        syncTestFlight(client, requested),
        scenario,
      ).rejects.toThrow();
      expect(client.mutations, scenario).toHaveLength(0);
    }
    const correct = new ExtendedBuildInventoryClient('correct');
    expect((await syncTestFlight(correct, requested)).mode).toBe('plan');
    expect(correct.mutations).toHaveLength(0);
  });

  test('fails closed on unclassified, cross-category, and conflicting tester identities', async () => {
    const appOnly = new StatefulClient();
    appOnly.appTesters.push(
      resource('betaTesters', 'app-only', {
        email: 'app-only@example.invalid',
      }),
    );

    const buildOnly = new StatefulClient();
    buildOnly.individualTesters.set('build-1', [
      resource('betaTesters', 'build-only', {
        email: 'build-only@example.invalid',
      }),
    ]);

    const crossCategoryId = new StatefulClient();
    const crossId = resource('betaTesters', 'cross-category-id', {
      email: 'cross-category-id@example.invalid',
    });
    addTypedGroup(crossCategoryId, 'cross-id-internal', true, [crossId]);
    addTypedGroup(crossCategoryId, 'cross-id-external', false, [crossId]);

    const crossCategoryEmail = new StatefulClient();
    addTypedGroup(crossCategoryEmail, 'cross-email-internal', true, [
      resource('betaTesters', 'cross-email-internal-id', {
        email: 'cross-category-email@example.invalid',
      }),
    ]);
    addTypedGroup(crossCategoryEmail, 'cross-email-external', false, [
      resource('betaTesters', 'cross-email-external-id', {
        email: 'CROSS-CATEGORY-EMAIL@example.invalid',
      }),
    ]);

    const conflictingId = new StatefulClient();
    addTypedGroup(conflictingId, 'conflicting-id-group', true, [
      resource('betaTesters', 'conflicting-id', {
        email: 'first-identity@example.invalid',
      }),
    ]);
    conflictingId.appTesters.push(
      resource('betaTesters', 'conflicting-id', {
        email: 'second-identity@example.invalid',
      }),
    );

    for (const [label, client] of [
      ['app only', appOnly],
      ['build only', buildOnly],
      ['cross-category ID', crossCategoryId],
      ['cross-category email', crossCategoryEmail],
      ['conflicting ID', conflictingId],
    ] as const) {
      await expect(
        syncTestFlight(client, {
          apply: false,
          internalTesters: [],
        }),
        label,
      ).rejects.toThrow();
      expect(client.mutations, label).toHaveLength(0);
    }
  });

  test('rejects anonymous unclassified app-tester assignments', async () => {
    const unclassifiedAnonymous = new StatefulClient();
    unclassifiedAnonymous.appTesters.push(
      resource('betaTesters', 'anonymous-app-only'),
    );
    await expect(
      syncTestFlight(unclassifiedAnonymous, {
        apply: false,
        internalTesters: [],
      }),
    ).rejects.toThrow();
    expect(unclassifiedAnonymous.mutations).toHaveLength(0);
  });

  test('binds individual assignments into the digest and rechecks capacity before tester writes', async () => {
    const digestClient = new StatefulClient();
    const typedIndividual = resource('betaTesters', 'typed-individual', {
      email: 'typed-individual@example.invalid',
    });
    addTypedGroup(digestClient, 'typed-individual-group', false, [
      typedIndividual,
    ]);
    digestClient.appTesters.push(typedIndividual);
    const requested = {
      internalTesters: [],
    } as const;
    const beforeAssignment = await syncTestFlight(digestClient, {
      ...requested,
      apply: false,
    });
    digestClient.individualTesters.set('build-1', [typedIndividual]);
    const afterAssignment = await syncTestFlight(digestClient, {
      ...requested,
      apply: false,
    });
    expect(afterAssignment.planDigest).not.toBe(beforeAssignment.planDigest);

    class CapacityDriftClient extends StatefulClient {
      reads = 0;

      constructor() {
        super();
        addTypedGroup(this, 'drifting-capacity-group', false, []);
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (
          path.startsWith('/v1/betaGroups/drifting-capacity-group/betaTesters?')
        ) {
          this.reads += 1;
          if (this.reads >= 3) {
            return [
              ...current,
              resource('betaTesters', 'late-capacity-member', {
                email: 'late-capacity-member@example.invalid',
              }),
            ];
          }
        }
        return current;
      }
    }

    const driftClient = new CapacityDriftClient();
    const driftRequested = {
      internalTesters: [],
    } as const;
    const preview = await syncTestFlight(driftClient, {
      ...driftRequested,
      apply: false,
    });
    await expect(
      syncTestFlight(driftClient, {
        ...driftRequested,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow('no mutations were attempted');
    expect(
      driftClient.mutations.filter(
        ({ path }) =>
          path === '/v1/betaTesters' ||
          path.endsWith('/relationships/betaTesters'),
      ),
    ).toHaveLength(0);
  });

  test('rejects wrong-type group and tester resources before mutation', async () => {
    const wrongGroupClient = new StatefulClient();
    wrongGroupClient.groups.splice(
      0,
      1,
      resource('users', 'wrong-type-group', {
        isInternalGroup: true,
        name: TEST_APP_CONFIGURATION.internalGroupName,
      }),
    );
    await expect(
      syncTestFlight(wrongGroupClient, {
        apply: false,
        internalTesters: [],
      }),
    ).rejects.toThrow();
    expect(wrongGroupClient.mutations).toHaveLength(0);

    const wrongTesterClient = new StatefulClient();
    wrongTesterClient.groupTesters.set('internal-group', [
      resource('users', 'wrong-type-tester', {
        email: 'internal@example.invalid',
      }),
    ]);
    await expect(
      syncTestFlight(wrongTesterClient, {
        apply: false,
        internalTesters: [{ email: 'internal@example.invalid' }],
      }),
    ).rejects.toThrow();
    expect(wrongTesterClient.mutations).toHaveLength(0);
  });

  test('uses app-scoped groups and bounded sequential provider reads', async () => {
    class SequentialClient extends StatefulClient {
      activeReads = 0;
      peakReads = 0;

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        this.activeReads += 1;
        this.peakReads = Math.max(this.peakReads, this.activeReads);
        try {
          await Bun.sleep(1);
          return await super.list(path);
        } finally {
          this.activeReads -= 1;
        }
      }
    }

    const client = new SequentialClient();
    for (let index = 0; index < 20; index += 1) {
      const id = `bounded-group-${index}`;
      client.groups.push(
        resource('betaGroups', id, {
          hasAccessToAllBuilds: false,
          isInternalGroup: index % 2 === 0,
          name: `Synthetic ${index}`,
        }),
      );
      client.groupTesters.set(id, []);
      client.groupBuilds.set(id, []);
    }
    await syncTestFlight(client, {
      apply: false,
      internalTesters: [],
    });
    expect(client.peakReads).toBe(1);
    expect(
      client.listPaths.some((path) =>
        path.startsWith('/v1/apps/app-1/betaGroups?'),
      ),
    ).toBe(true);
    expect(
      client.listPaths.some((path) => path.startsWith('/v1/betaGroups?')),
    ).toBe(false);
  });

  test('binds every app-scoped beta group to the exact app before planning', async () => {
    const wrongParent = new StatefulClient();
    wrongParent.appGroupLinkageOverride = wrongParent.groups.filter(
      ({ id }) => id !== 'internal-group',
    );
    await expect(
      syncTestFlight(wrongParent, {
        apply: false,
        internalTesters: [],
      }),
    ).rejects.toThrow();
    expect(wrongParent.mutations).toHaveLength(0);

    const correct = new StatefulClient();
    await syncTestFlight(correct, {
      apply: false,
      internalTesters: [],
    });
    expect(
      correct.listPaths.some((path) =>
        path.startsWith('/v1/apps/app-1/betaGroups?'),
      ),
    ).toBe(true);
    expect(
      correct.listPaths.some((path) =>
        path.startsWith('/v1/apps/app-1/relationships/betaGroups?'),
      ),
    ).toBe(true);
  });

  test('verifies a created beta group appears in app relationship linkage before follow-on writes', async () => {
    class MissingCreatedGroupLinkageClient extends StatefulClient {
      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        const created = await super.mutate(method, path, body, expectedType);
        if (
          method === 'POST' &&
          path === '/v1/betaGroups' &&
          created !== null
        ) {
          this.appGroupLinkageOverride = this.groups.filter(
            ({ id }) => id !== created.id,
          );
        }
        return created;
      }
    }

    const client = new MissingCreatedGroupLinkageClient();
    client.groups.splice(0);
    const options = {
      internalTesters: [],
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow(
      'partial or indeterminate after 1 provider-accepted mutation',
    );
    expect(client.mutations).toHaveLength(1);
    expect(client.mutations[0]?.path).toBe('/v1/betaGroups');
  });

  test('rechecks beta-group parents in the live guard before tester writes', async () => {
    class GroupParentGuardDriftClient extends StatefulClient {
      appGroupLinkageReads = 0;
      guardDrift = false;

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (path.startsWith('/v1/apps/app-1/relationships/betaGroups?')) {
          this.appGroupLinkageReads += 1;
          if (this.appGroupLinkageReads >= 3) {
            this.guardDrift = true;
            return current.filter(({ id }) => id !== 'internal-group');
          }
        }
        return current;
      }
    }

    const client = new GroupParentGuardDriftClient();
    const options = {
      internalTesters: [{ email: 'group-parent-guard@example.invalid' }],
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow('no mutations were attempted');
    expect(client.guardDrift).toBe(true);
    expect(client.mutations).toHaveLength(0);
  });

  test('post-write verification rejects beta-group relationship drift after an accepted tester write', async () => {
    class FinalGroupParentDriftClient extends StatefulClient {
      finalDrift = false;

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (
          this.mutations.length > 0 &&
          path.startsWith('/v1/apps/app-1/relationships/betaGroups?')
        ) {
          this.finalDrift = true;
          return current.filter(({ id }) => id !== 'internal-group');
        }
        return current;
      }
    }

    const client = new FinalGroupParentDriftClient();
    const options = {
      internalTesters: [{ email: 'final-group-parent@example.invalid' }],
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow(
      'partial or indeterminate after 1 provider-accepted mutation',
    );
    expect(client.finalDrift).toBe(true);
    expect(
      client.mutations.filter(
        ({ method, path }) => method === 'POST' && path === '/v1/betaTesters',
      ),
    ).toHaveLength(1);
  });

  test('fails closed when an existing managed group is not explicitly build-scoped', async () => {
    for (const unsafeValue of [true, undefined] as const) {
      const client = new StatefulClient();
      const attributes = client.groups[0]?.attributes as
        Record<string, unknown> | undefined;
      if (attributes === undefined) throw new Error('Missing fixture group.');
      if (unsafeValue === undefined) delete attributes.hasAccessToAllBuilds;
      else attributes.hasAccessToAllBuilds = unsafeValue;
      await expect(
        syncTestFlight(client, {
          apply: false,
          internalTesters: [],
        }),
      ).rejects.toThrow('manual build assignment');
      expect(client.mutations).toHaveLength(0);
    }
  });

  test('never uses an untrusted created-group response for tester or build writes', async () => {
    const safeAttributes = {
      feedbackEnabled: true,
      hasAccessToAllBuilds: false,
      isInternalGroup: true,
      name: TEST_APP_CONFIGURATION.internalGroupName,
    };
    const cases = [
      {
        created: resource('users', 'wrong-type-created-group', safeAttributes),
        label: 'wrong type',
        scoped: true,
      },
      {
        created: resource(
          'betaGroups',
          'unscoped-created-group',
          safeAttributes,
        ),
        label: 'not app scoped',
        scoped: false,
      },
      {
        created: resource('betaGroups', 'unsafe-created-group', {
          ...safeAttributes,
          hasAccessToAllBuilds: true,
        }),
        label: 'unsafe attributes',
        scoped: true,
      },
      {
        created: resource(
          'betaGroups',
          '../contaminated-created-group',
          safeAttributes,
        ),
        label: 'contaminated ID',
        scoped: true,
      },
      {
        created: resource('betaGroups', '.', safeAttributes),
        label: 'dot ID',
        scoped: true,
      },
      {
        created: resource('betaGroups', '..', safeAttributes),
        label: 'dot-dot ID',
        scoped: true,
      },
    ] as const;

    for (const scenario of cases) {
      class UntrustedCreateClient extends StatefulClient {
        readsAtGroupCreation: number | undefined;

        constructor() {
          super();
          this.groups.splice(0);
        }

        override async mutate(
          method: 'PATCH' | 'POST',
          path: string,
          body: unknown,
          expectedType?: string,
        ): Promise<JsonApiResource | null> {
          if (
            method === 'POST' &&
            path === '/v1/betaGroups' &&
            dataAttributes(body).isInternalGroup === true
          ) {
            this.readsAtGroupCreation = this.listPaths.length;
            this.mutations.push({ body, method, path });
            if (scenario.scoped) {
              this.groups.push(scenario.created);
              this.groupTesters.set(scenario.created.id, []);
              this.groupBuilds.set(scenario.created.id, []);
            }
            return scenario.created;
          }
          return super.mutate(method, path, body, expectedType);
        }
      }

      const client = new UntrustedCreateClient();
      const requested = {
        internalTesters: [{ email: 'internal@example.invalid' }],
      } as const;
      const preview = await syncTestFlight(client, {
        ...requested,
        apply: false,
      });
      await expect(
        syncTestFlight(client, {
          ...requested,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        scenario.label,
      ).rejects.toThrow();
      expect(
        client.mutations.filter(
          ({ path }) =>
            path === '/v1/betaTesters' ||
            path.endsWith('/relationships/betaTesters') ||
            path.endsWith('/relationships/builds'),
        ),
        scenario.label,
      ).toHaveLength(0);
      if (scenario.label === 'dot ID' || scenario.label === 'dot-dot ID') {
        const readsAtGroupCreation = client.readsAtGroupCreation;
        if (readsAtGroupCreation === undefined) {
          throw new Error('The synthetic group creation was not attempted.');
        }
        expect(client.listPaths.length, scenario.label).toBe(
          readsAtGroupCreation,
        );
      }
    }
  });

  test('never PATCHes the create-only hasAccessToAllBuilds group attribute', async () => {
    const client = new StatefulClient();
    const internalAttributes = client.groups[0]?.attributes as
      Record<string, unknown> | undefined;
    if (internalAttributes === undefined) {
      throw new Error('Missing fixture group.');
    }
    internalAttributes.feedbackEnabled = false;
    await previewAndApply(client, {
      internalTesters: [],
    });
    const patches = client.mutations.filter(
      ({ method, path }) =>
        method === 'PATCH' && path.startsWith('/v1/betaGroups/'),
    );
    expect(patches).toHaveLength(1);
    for (const patch of patches) {
      expect(dataAttributes(patch.body)).not.toHaveProperty(
        'hasAccessToAllBuilds',
      );
    }
  });

  test('rejects a stale, anonymous, or unapproved managed-group audience before build distribution', async () => {
    const cases: JsonApiResource[][] = [
      [
        resource('betaTesters', 'stale-tester', {
          email: 'stale@example.invalid',
        }),
      ],
      [resource('betaTesters', 'anonymous-tester')],
    ];
    for (const current of cases) {
      const client = new StatefulClient();
      client.groupTesters.set('internal-group', current);
      client.appTesters.push(...current);
      await expect(
        syncTestFlight(client, {
          apply: false,
          build: 'build-1',
          internalTesters: [{ email: 'internal@example.invalid' }],
          testInfo: review,
        }),
      ).rejects.toThrow();
      expect(client.mutations).toHaveLength(0);
    }

    const noRosterClient = new StatefulClient();
    noRosterClient.groupTesters.set('internal-group', [
      resource('betaTesters', 'existing-tester', {
        email: 'internal@example.invalid',
      }),
    ]);
    noRosterClient.appTesters.push(
      resource('betaTesters', 'existing-tester', {
        email: 'internal@example.invalid',
      }),
    );
    await expect(
      syncTestFlight(noRosterClient, {
        apply: false,
        build: 'build-1',
        internalTesters: [],
        testInfo: review,
      }),
    ).rejects.toThrow('complete approved roster');
    expect(noRosterClient.mutations).toHaveLength(0);
  });

  test('previews every real invitation consequence before adding a tester', async () => {
    const client = new StatefulClient();
    const result = await syncTestFlight(client, {
      apply: false,
      internalTesters: [{ email: 'internal@example.invalid' }],
    });
    expect(
      result.actions.some(
        ({ detail, kind, status }) =>
          kind === 'tester' &&
          status === 'planned' &&
          detail.includes('real TestFlight invitation email'),
      ),
    ).toBe(true);
    expect(client.mutations).toHaveLength(0);
  });

  test('rechecks group state before every tester write and stops after late build attachment', async () => {
    class TesterWriteDriftClient extends OrderedStatefulClient {
      acceptedTesterCreates = 0;

      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        const result = await super.mutate(method, path, body, expectedType);
        if (method === 'POST' && path === '/v1/betaTesters') {
          this.acceptedTesterCreates += 1;
          if (this.acceptedTesterCreates === 1) {
            this.groupBuilds.set('internal-group', [this.build]);
          }
        }
        return result;
      }
    }

    const client = new TesterWriteDriftClient();
    client.users.push(
      resource('users', 'user-2', {
        allAppsVisible: true,
        roles: ['APP_MANAGER'],
        username: 'second-internal@example.invalid',
      }),
    );
    const options = {
      internalTesters: [
        { email: 'internal@example.invalid' },
        { email: 'second-internal@example.invalid' },
      ],
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    client.operations.splice(0);

    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow(
      'partial or indeterminate after 1 provider-accepted mutation',
    );
    expect(client.acceptedTesterCreates).toBe(1);
    expect(
      client.mutations.filter(
        ({ method, path }) => method === 'POST' && path === '/v1/betaTesters',
      ),
    ).toHaveLength(1);

    const firstWrite = client.operations.indexOf('mutate POST /v1/betaTesters');
    expect(firstWrite).toBeGreaterThanOrEqual(3);
    const beforeFirstWrite = client.operations.slice(0, firstWrite);
    let finalTargetGuardStart = -1;
    for (let index = 0; index < beforeFirstWrite.length; index += 1) {
      if (
        beforeFirstWrite[index]?.startsWith(
          'get /v1/betaGroups/internal-group?fields%5BbetaGroups%5D=',
        )
      ) {
        finalTargetGuardStart = index;
      }
    }
    expect(finalTargetGuardStart).toBeGreaterThanOrEqual(0);
    expect(beforeFirstWrite.at(-1)).toBe(
      'pageSummary /v1/betaGroups/internal-group/relationships/betaTesters?limit=1',
    );
    const finalTargetGuard = beforeFirstWrite.slice(finalTargetGuardStart);
    expect(
      finalTargetGuard.some((operation) =>
        operation.startsWith(
          'pageSummary /v1/betaGroups/internal-group/betaTesters?',
        ),
      ),
    ).toBe(true);
    expect(
      finalTargetGuard.some((operation) =>
        operation.startsWith('list /v1/betaGroups/internal-group/builds?'),
      ),
    ).toBe(true);
    for (const expected of [
      'list /v1/apps/app-1/betaGroups?',
      'list /v1/betaGroups/internal-group/betaTesters?',
      'list /v1/betaTesters?',
      'list /v1/apps/app-1/builds?',
      'list /v1/apps/app-1/relationships/builds?',
      'list /v1/builds/build-1/individualTesters?',
    ]) {
      expect(
        beforeFirstWrite.some((operation) => operation.startsWith(expected)),
        expected,
      ).toBe(true);
    }
    const afterFirstWrite = client.operations.slice(firstWrite + 1);
    for (const expected of [
      'list /v1/betaTesters/tester-1/betaGroups?limit=200',
      'list /v1/betaTesters/tester-1/apps?limit=200',
      'pageSummary /v1/betaGroups/internal-group/betaTesters?',
      'list /v1/betaGroups/internal-group/builds?',
      'list /v1/betaGroups/internal-group/relationships/builds?limit=200',
    ]) {
      expect(
        afterFirstWrite.some((operation) => operation.startsWith(expected)),
        expected,
      ).toBe(true);
    }
    expect(
      afterFirstWrite.some((operation) => operation.startsWith('mutate ')),
    ).toBe(false);
  });

  test('rechecks global identity and capacity in the live pre-mutation guard', async () => {
    type InventoryDrift = 'capacity' | 'cross-audience';

    class PreMutationInventoryDriftClient extends StatefulClient {
      armed = false;
      filteredAppTesterReads = 0;
      injected = false;
      injectionPathIndex = -1;
      readonly existing = resource('betaTesters', 'late-link-tester-id', {
        email: 'late-link@example.invalid',
      });

      constructor(readonly drift: InventoryDrift) {
        super();
        this.accountTesters.push(this.existing);
        addTypedGroup(
          this,
          drift === 'cross-audience'
            ? 'late-internal-classifier'
            : 'late-external-capacity',
          drift === 'cross-audience',
          [],
        );
      }

      arm(): void {
        this.armed = true;
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (
          this.armed &&
          path.startsWith('/v1/betaTesters?') &&
          (path.includes('filter%5Bapps%5D=app-1') ||
            path.includes('filter[apps]=app-1'))
        ) {
          this.filteredAppTesterReads += 1;
          if (this.filteredAppTesterReads === 2) {
            this.injected = true;
            this.injectionPathIndex = this.listPaths.length - 1;
            if (this.drift === 'cross-audience') {
              this.groupTesters.set('late-internal-classifier', [
                this.existing,
              ]);
              this.appTesters.push(this.existing);
            } else {
              const lateCapacity = syntheticTesters(
                'late-external-capacity',
                10_000,
              );
              this.groupTesters.set('late-external-capacity', lateCapacity);
              this.appTesters.push(...lateCapacity);
            }
            return this.appTesters;
          }
        }
        return current;
      }
    }

    const options = {
      internalTesters: [{ email: 'late-link@example.invalid' }],
    } as const;
    for (const drift of ['cross-audience', 'capacity'] as const) {
      const client = new PreMutationInventoryDriftClient(drift);
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      client.arm();
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        drift,
      ).rejects.toThrow('no mutations were attempted');
      expect(client.injected, drift).toBe(true);
      expect(client.filteredAppTesterReads, drift).toBeGreaterThanOrEqual(2);
      expect(client.mutations, drift).toHaveLength(0);
      expect(
        client.listPaths[client.injectionPathIndex]?.startsWith(
          '/v1/betaTesters?',
        ),
        drift,
      ).toBe(true);
      expect(
        client.mutations.filter(
          ({ method, path }) =>
            method === 'POST' &&
            (path === '/v1/betaTesters' ||
              path.endsWith('/relationships/betaTesters')),
        ),
        drift,
      ).toHaveLength(0);
    }
  });

  test('rechecks fixed app identity immediately before tester and app-scoped resource writes', async () => {
    class PreTesterIdentityDriftClient extends StatefulClient {
      armed = false;
      individualTesterReads = 0;
      injected = false;

      constructor(
        readonly drift: FixedAppIdentityDrift,
        linkExisting: boolean,
      ) {
        super();
        if (linkExisting) {
          this.accountTesters.push(
            resource('betaTesters', 'existing-link-tester', {
              email: 'identity-guard@example.invalid',
            }),
          );
        }
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (!this.armed) return current;
        if (path.startsWith('/v1/builds/build-1/individualTesters?')) {
          this.individualTesterReads += 1;
        }
        if (this.individualTesterReads >= 2 && path.startsWith('/v1/apps?')) {
          this.injected = true;
          return [appWithIdentityDrift(this.drift)];
        }
        return current;
      }
    }

    const options = {
      internalTesters: [{ email: 'identity-guard@example.invalid' }],
    } as const;
    for (const linkExisting of [false, true]) {
      for (const drift of ['name', 'bundleId', 'sku', 'id'] as const) {
        const client = new PreTesterIdentityDriftClient(drift, linkExisting);
        const preview = await syncTestFlight(client, {
          ...options,
          apply: false,
        });
        client.armed = true;
        await expect(
          syncTestFlight(client, {
            ...options,
            apply: true,
            confirmPlanDigest: preview.planDigest,
          }),
          `${linkExisting ? 'link' : 'create'}:${drift}`,
        ).rejects.toThrow('no mutations were attempted');
        expect(client.injected, drift).toBe(true);
        expect(client.mutations, drift).toHaveLength(0);
      }
    }

    class PreResourceIdentityDriftClient extends StatefulClient {
      armed = false;
      individualTesterReads = 0;
      injected = false;

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (!this.armed) return current;
        if (path.startsWith('/v1/builds/build-1/individualTesters?')) {
          this.individualTesterReads += 1;
        }
        if (this.individualTesterReads >= 2 && path.startsWith('/v1/apps?')) {
          this.injected = true;
          return [appWithIdentityDrift('sku')];
        }
        return current;
      }
    }

    const resourceScenarios: readonly {
      readonly label: string;
      readonly mutationPath: string;
      readonly options: RequestedSync;
      readonly setup: (client: PreResourceIdentityDriftClient) => void;
    }[] = [
      {
        label: 'group create',
        mutationPath: '/v1/betaGroups',
        options: {
          internalTesters: [],
        },
        setup: (client) => {
          client.groups.splice(
            client.groups.findIndex(({ id }) => id === 'internal-group'),
            1,
          );
        },
      },
      {
        label: 'group update',
        mutationPath: '/v1/betaGroups/internal-group',
        options: {
          internalTesters: [],
        },
        setup: (client) => {
          const groupIndex = client.groups.findIndex(
            ({ id }) => id === 'internal-group',
          );
          const group = client.groups[groupIndex];
          if (group === undefined) throw new Error('Missing synthetic group.');
          client.groups.splice(
            groupIndex,
            1,
            resource('betaGroups', group.id, {
              ...group.attributes,
              feedbackEnabled: false,
            }),
          );
        },
      },
      {
        label: 'review details',
        mutationPath: '/v1/betaAppReviewDetails/review-1',
        options: {
          internalTesters: [],
          testInfo: review,
        },
        setup: (client) => {
          seedMatchingTestMetadata(client);
          client.reviewDetails = resource('betaAppReviewDetails', 'review-1', {
            ...client.reviewDetails.attributes,
            contactFirstName: 'Stale',
          });
        },
      },
      {
        label: 'app localization create',
        mutationPath: '/v1/betaAppLocalizations',
        options: {
          internalTesters: [],
          testInfo: review,
        },
        setup: (client) => {
          seedMatchingTestMetadata(client);
          client.localizations.splice(0);
        },
      },
      {
        label: 'app localization update',
        mutationPath: '/v1/betaAppLocalizations/localization-1',
        options: {
          internalTesters: [],
          testInfo: review,
        },
        setup: (client) => {
          seedMatchingTestMetadata(client);
          client.localizations.splice(
            0,
            1,
            resource('betaAppLocalizations', 'localization-1', {
              description: 'Stale synthetic description.',
              feedbackEmail: review.feedbackEmail,
              locale: review.locale,
            }),
          );
        },
      },
      {
        label: 'build localization create',
        mutationPath: '/v1/betaBuildLocalizations',
        options: {
          build: 'build-1',
          internalTesters: [],
          testInfo: review,
        },
        setup: (client) => {
          seedMatchingTestMetadata(client);
          client.buildLocalizations.splice(0);
        },
      },
      {
        label: 'build localization update',
        mutationPath: '/v1/betaBuildLocalizations/build-localization-1',
        options: {
          build: 'build-1',
          internalTesters: [],
          testInfo: review,
        },
        setup: (client) => {
          seedMatchingTestMetadata(client);
          client.buildLocalizations.splice(
            0,
            1,
            resource('betaBuildLocalizations', 'build-localization-1', {
              locale: review.locale,
              whatsNew: 'Stale What to Test.',
            }),
          );
        },
      },
      {
        label: 'notification update',
        mutationPath: '/v1/buildBetaDetails/build-detail-1',
        options: {
          build: 'build-1',
          internalTesters: [],
          testInfo: review,
        },
        setup: (client) => {
          seedMatchingTestMetadata(client);
          client.buildBetaDetail = resource(
            'buildBetaDetails',
            'build-detail-1',
            { ...client.buildBetaDetail.attributes, autoNotifyEnabled: true },
          );
        },
      },
    ];

    for (const scenario of resourceScenarios) {
      const client = new PreResourceIdentityDriftClient();
      scenario.setup(client);
      const preview = await syncTestFlight(client, {
        ...scenario.options,
        apply: false,
      });
      client.armed = true;
      await expect(
        syncTestFlight(client, {
          ...scenario.options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        scenario.label,
      ).rejects.toThrow('no mutations were attempted');
      expect(client.injected, scenario.label).toBe(true);
      expect(
        client.mutations.some(({ path }) => path === scenario.mutationPath),
        scenario.label,
      ).toBe(false);
      expect(client.mutations, scenario.label).toHaveLength(0);
    }
  });

  test('makes a complete bounded target-group guard the final read before every invitation-capable POST', async () => {
    const existing = new OrderedStatefulClient();
    existing.accountTesters.push(
      resource('betaTesters', 'existing-final-guard-tester', {
        email: 'internal@example.invalid',
      }),
    );
    const create = new OrderedStatefulClient();
    const build = new OrderedStatefulClient();
    seedMatchingTestMetadata(build);

    const cases: Array<{
      client: OrderedStatefulClient;
      label: string;
      mutation: string;
      options: RequestedSync;
    }> = [
      {
        client: existing,
        label: 'existing tester link',
        mutation:
          'mutate POST /v1/betaGroups/internal-group/relationships/betaTesters',
        options: {
          internalTesters: [{ email: 'internal@example.invalid' }],
        },
      },
      {
        client: create,
        label: 'tester create',
        mutation: 'mutate POST /v1/betaTesters',
        options: {
          internalTesters: [{ email: 'internal@example.invalid' }],
        },
      },
      {
        client: build,
        label: 'build relationship',
        mutation:
          'mutate POST /v1/betaGroups/internal-group/relationships/builds',
        options: {
          build: 'build-1',
          internalTesters: [],
          testInfo: review,
        },
      },
    ];

    for (const { client, label, mutation, options } of cases) {
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      client.operations.splice(0);
      await syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      });

      const mutationIndex = client.operations.indexOf(mutation);
      expect(mutationIndex, label).toBeGreaterThan(0);
      const beforeMutation = client.operations.slice(0, mutationIndex);
      const testerWrite = label !== 'build relationship';
      expect(beforeMutation.at(-1), label).toBe(
        testerWrite
          ? 'pageSummary /v1/betaGroups/internal-group/relationships/betaTesters?limit=1'
          : 'list /v1/betaGroups/internal-group/relationships/builds?limit=200',
      );
      let snapshotStart = -1;
      for (let index = 0; index < beforeMutation.length; index += 1) {
        if (
          beforeMutation[index]?.startsWith(
            'get /v1/betaGroups/internal-group?fields%5BbetaGroups%5D=',
          )
        ) {
          snapshotStart = index;
        }
      }
      expect(snapshotStart, label).toBeGreaterThanOrEqual(0);
      const finalSnapshot = beforeMutation.slice(snapshotStart);
      expect(finalSnapshot[0], label).toStartWith(
        'get /v1/betaGroups/internal-group?fields%5BbetaGroups%5D=',
      );
      for (const expected of [
        'get /v1/betaGroups/internal-group/app',
        'list /v1/betaGroups/internal-group/builds?',
        'list /v1/betaGroups/internal-group/relationships/builds?limit=200',
        ...(testerWrite
          ? [
              'pageSummary /v1/betaGroups/internal-group/betaTesters?',
              'pageSummary /v1/betaGroups/internal-group/relationships/betaTesters?',
            ]
          : [
              'list /v1/betaGroups/internal-group/betaTesters?',
              'list /v1/betaGroups/internal-group/relationships/betaTesters?',
            ]),
      ]) {
        expect(
          finalSnapshot.some((operation) => operation.startsWith(expected)),
          `${label}:${expected}`,
        ).toBe(true);
      }
      expect(
        finalSnapshot.some((operation) => operation.startsWith('mutate ')),
        label,
      ).toBe(false);
    }
  });

  test('blocks last-window target settings, roster, and build races before invitation-capable POSTs', async () => {
    type LateRace = 'builds' | 'roster' | 'settings';

    class LateTargetRaceClient extends OrderedStatefulClient {
      applyPhase = false;
      buildExactAppReads = 0;
      injected = false;
      injectionOperationIndex = -1;
      injectionOperation = '';
      sawExactAppAfterUser = false;
      sawExactUser = false;

      constructor(
        readonly race: LateRace,
        readonly buildArmAtExactAppRead = Number.POSITIVE_INFINITY,
      ) {
        super();
      }

      inject(): void {
        if (this.injected) return;
        this.injected = true;
        this.injectionOperationIndex = this.operations.length - 1;
        this.injectionOperation = this.operations.at(-1) ?? '';
        if (this.race === 'settings') {
          const index = this.groups.findIndex(
            ({ id }) => id === 'internal-group',
          );
          const current = this.groups[index];
          if (index < 0 || current === undefined) {
            throw new Error('Missing internal group fixture.');
          }
          this.groups.splice(
            index,
            1,
            resource('betaGroups', current.id, {
              ...(current.attributes ?? {}),
              hasAccessToAllBuilds: true,
            }),
          );
        } else if (this.race === 'roster') {
          this.groupTesters.get('internal-group')?.push(
            resource('betaTesters', 'late-unapproved-internal-tester', {
              email: 'late-unapproved-internal-tester@example.invalid',
            }),
          );
        } else {
          this.groupBuilds
            .get('internal-group')
            ?.push(resource('builds', 'late-unapproved-build'));
        }
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (!this.applyPhase) return current;
        if (this.race === 'roster' && this.sawExactUser) {
          if (path.startsWith('/v1/apps?')) {
            this.sawExactAppAfterUser = true;
          }
        }
        if (this.race === 'builds' && path.startsWith('/v1/apps?')) {
          this.buildExactAppReads += 1;
          if (this.buildExactAppReads === this.buildArmAtExactAppRead) {
            this.inject();
          }
        }
        return current;
      }

      override async get(
        path: string,
        expectedType: string,
      ): Promise<JsonApiResource> {
        const current = await super.get(path, expectedType);
        if (!this.applyPhase) return current;
        if (
          this.race === 'settings' &&
          path.startsWith('/v1/betaTesters/existing-final-guard-tester')
        ) {
          this.inject();
        }
        if (this.race === 'roster' && path.startsWith('/v1/users/user-1?')) {
          this.sawExactUser = true;
        } else if (
          this.race === 'roster' &&
          this.sawExactAppAfterUser &&
          path === '/v1/betaGroups/internal-group/app'
        ) {
          this.inject();
        }
        return current;
      }
    }

    const calibration = new OrderedStatefulClient();
    seedMatchingTestMetadata(calibration);
    const buildOptions = {
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    } as const;
    const calibrationPreview = await syncTestFlight(calibration, {
      ...buildOptions,
      apply: false,
    });
    calibration.operations.splice(0);
    await syncTestFlight(calibration, {
      ...buildOptions,
      apply: true,
      confirmPlanDigest: calibrationPreview.planDigest,
    });
    const buildMutationIndex = calibration.operations.indexOf(
      'mutate POST /v1/betaGroups/internal-group/relationships/builds',
    );
    expect(buildMutationIndex).toBeGreaterThan(0);
    const buildArmAtExactAppRead = calibration.operations
      .slice(0, buildMutationIndex)
      .filter((operation) => operation.startsWith('list /v1/apps?')).length;
    expect(buildArmAtExactAppRead).toBeGreaterThan(0);

    const settings = new LateTargetRaceClient('settings');
    settings.accountTesters.push(
      resource('betaTesters', 'existing-final-guard-tester', {
        email: 'internal@example.invalid',
      }),
    );
    const roster = new LateTargetRaceClient('roster');
    const builds = new LateTargetRaceClient('builds', buildArmAtExactAppRead);
    seedMatchingTestMetadata(builds);
    const cases: Array<{
      client: LateTargetRaceClient;
      label: LateRace;
      marker: string;
      options: RequestedSync;
    }> = [
      {
        client: settings,
        label: 'settings',
        marker: 'get /v1/betaTesters/existing-final-guard-tester',
        options: {
          internalTesters: [{ email: 'internal@example.invalid' }],
        },
      },
      {
        client: roster,
        label: 'roster',
        marker: 'get /v1/betaGroups/internal-group/app',
        options: {
          internalTesters: [{ email: 'internal@example.invalid' }],
        },
      },
      {
        client: builds,
        label: 'builds',
        marker: 'list /v1/apps?',
        options: buildOptions,
      },
    ];

    for (const { client, label, marker, options } of cases) {
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      client.operations.splice(0);
      client.applyPhase = true;
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        label,
      ).rejects.toThrow();
      expect(client.injected, label).toBe(true);
      expect(client.injectionOperationIndex, label).toBeGreaterThanOrEqual(0);
      expect(client.injectionOperation, label).toStartWith(marker);
      expect(client.mutations, label).toHaveLength(0);
      expect(
        client.operations.some((operation) => operation.startsWith('mutate ')),
        label,
      ).toBe(false);
      const beforeInjection = client.operations.slice(
        0,
        client.injectionOperationIndex + 1,
      );
      if (label !== 'builds') {
        for (const expected of [
          'get /v1/users/user-1?',
          'list /v1/apps?',
          'list /v1/apps/app-1/builds?',
          'list /v1/apps/app-1/relationships/builds?',
          'list /v1/builds/build-1/individualTesters?',
        ]) {
          expect(
            beforeInjection.some((operation) => operation.startsWith(expected)),
            `${label}:${expected}`,
          ).toBe(true);
        }
      } else {
        for (const expected of [
          '/v1/builds/build-1/buildBetaDetail?',
          '/v1/builds/build-1/betaBuildLocalizations?',
          '/v1/builds/build-1/individualTesters?',
        ]) {
          expect(
            beforeInjection.some((operation) => operation.includes(expected)),
            expected,
          ).toBe(true);
        }
      }
    }
  });

  test('treats provider over-application of a build relationship as partial', async () => {
    class OverApplyingBuildClient extends StatefulClient {
      readonly extraBuild = resource('builds', 'unconfirmed-extra-build');

      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        const result = await super.mutate(method, path, body, expectedType);
        if (method === 'POST' && path.endsWith('/relationships/builds')) {
          const match =
            /^\/v1\/betaGroups\/([^/]+)\/relationships\/builds$/u.exec(path);
          if (match?.[1] !== undefined) {
            this.groupBuilds.get(match[1])?.push(this.extraBuild);
          }
        }
        return result;
      }
    }

    const client = new OverApplyingBuildClient();
    seedMatchingTestMetadata(client);
    const options = {
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow(
      'partial or indeterminate after 1 provider-accepted mutation',
    );
    expect(
      client.mutations.filter(
        ({ method, path }) =>
          method === 'POST' && path.endsWith('/relationships/builds'),
      ),
    ).toHaveLength(1);
    expect(
      client.groupBuilds.get('internal-group')?.map(({ id }) => id),
    ).toEqual(['build-1', 'unconfirmed-extra-build']);
  });

  test('requires related group builds and relationship linkage to be one exact typed ID set', async () => {
    const requested = {
      apply: false,
      internalTesters: [],
    } as const;
    const scenarios: Array<{
      linkage: JsonApiResource[];
      related: JsonApiResource[];
      label: string;
    }> = [
      {
        label: 'omitted',
        linkage: [],
        related: [resource('builds', 'build-1')],
      },
      {
        label: 'extra',
        linkage: [resource('builds', 'build-1')],
        related: [],
      },
      {
        label: 'wrong ID',
        linkage: [resource('builds', 'another-build')],
        related: [resource('builds', 'build-1')],
      },
      {
        label: 'duplicate',
        linkage: [resource('builds', 'build-1'), resource('builds', 'build-1')],
        related: [resource('builds', 'build-1')],
      },
      {
        label: 'wrong type',
        linkage: [resource('apps', 'build-1')],
        related: [resource('builds', 'build-1')],
      },
    ];
    for (const { label, linkage, related } of scenarios) {
      const client = new StatefulClient();
      client.groupBuilds.set('internal-group', related);
      client.groupBuildLinkageOverrides.set('internal-group', linkage);
      await expect(syncTestFlight(client, requested), label).rejects.toThrow();
      expect(client.mutations, label).toHaveLength(0);
    }

    const correct = new StatefulClient();
    correct.groupBuilds.set('internal-group', [correct.build]);
    const result = await syncTestFlight(correct, requested);
    expect(result.mode).toBe('plan');
    expect(correct.mutations).toHaveLength(0);
  });

  test('reads back group build linkage immediately and again after an accepted POST', async () => {
    class GroupBuildLinkageDriftClient extends StatefulClient {
      acceptedBuildWrite = false;
      postWriteLinkageReads = 0;

      constructor(readonly drift: 'immediate' | 'later') {
        super();
        seedMatchingTestMetadata(this);
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (
          this.acceptedBuildWrite &&
          path.startsWith('/v1/betaGroups/internal-group/relationships/builds')
        ) {
          this.postWriteLinkageReads += 1;
          if (
            this.drift === 'immediate' ||
            (this.drift === 'later' && this.postWriteLinkageReads >= 2)
          ) {
            return [];
          }
        }
        return current;
      }

      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        const result = await super.mutate(method, path, body, expectedType);
        if (
          method === 'POST' &&
          path === '/v1/betaGroups/internal-group/relationships/builds'
        ) {
          this.acceptedBuildWrite = true;
        }
        return result;
      }
    }

    const options = {
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    } as const;
    for (const drift of ['immediate', 'later'] as const) {
      const client = new GroupBuildLinkageDriftClient(drift);
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        drift,
      ).rejects.toThrow(
        'partial or indeterminate after 1 provider-accepted mutation',
      );
      expect(client.acceptedBuildWrite, drift).toBe(true);
      expect(client.postWriteLinkageReads, drift).toBeGreaterThanOrEqual(
        drift === 'immediate' ? 1 : 2,
      );
      expect(
        client.mutations.filter(
          ({ method, path }) =>
            method === 'POST' && path.endsWith('/relationships/builds'),
        ),
        drift,
      ).toHaveLength(1);
    }
  });

  test('accepts a reordered managed-group build inventory through immediate and final verification', async () => {
    type BuildReadPhase = 'final' | 'immediate' | 'preview';

    class ReorderedGroupBuildClient extends StatefulClient {
      readonly buildReads: Array<{
        groupId: string;
        ids: readonly string[];
        phase: BuildReadPhase;
      }> = [];
      readonly postWriteReads = new Map<string, number>();

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = [...(await super.list(path))];
        const match = /^\/v1\/betaGroups\/([^/]+)\/builds\?/u.exec(path);
        const groupId = match?.[1];
        if (groupId === undefined || current.length < 2) return current;

        const buildAccepted = this.mutations.some(
          ({ method, path: mutationPath }) =>
            method === 'POST' &&
            mutationPath === `/v1/betaGroups/${groupId}/relationships/builds`,
        );
        let phase: BuildReadPhase = 'preview';
        if (buildAccepted) {
          const seen = (this.postWriteReads.get(groupId) ?? 0) + 1;
          this.postWriteReads.set(groupId, seen);
          phase = seen === 1 ? 'immediate' : 'final';
        }
        const reordered =
          phase === 'immediate'
            ? current.reverse()
            : [...current.slice(1), current[0] as JsonApiResource];
        this.buildReads.push({
          groupId,
          ids: reordered.map(({ id }) => id),
          phase,
        });
        return reordered;
      }
    }

    const client = new ReorderedGroupBuildClient();
    seedMatchingTestMetadata(client);
    client.groupBuilds.set('internal-group', [
      resource('builds', 'existing-internal-a'),
      resource('builds', 'existing-internal-b'),
    ]);
    const options = {
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    } as const;
    const first = await previewAndApply(client, options);
    expect(first.actions.at(-1)?.kind).toBe('verification');
    expect(
      client.mutations.filter(
        ({ method, path }) =>
          method === 'POST' && path.endsWith('/relationships/builds'),
      ),
    ).toHaveLength(1);

    for (const [groupId, expectedIds] of [
      [
        'internal-group',
        ['build-1', 'existing-internal-a', 'existing-internal-b'],
      ],
    ] as const) {
      const immediate = client.buildReads.find(
        (read) => read.groupId === groupId && read.phase === 'immediate',
      );
      const final = client.buildReads.find(
        (read) => read.groupId === groupId && read.phase === 'final',
      );
      expect(immediate, `${groupId}:immediate`).toBeDefined();
      expect(final, `${groupId}:final`).toBeDefined();
      expect(immediate?.ids, groupId).not.toEqual(final?.ids);
      expect(
        [...(immediate?.ids ?? [])].sort(),
        `${groupId}:immediate`,
      ).toEqual([...expectedIds].sort());
      expect([...(final?.ids ?? [])].sort(), `${groupId}:final`).toEqual(
        [...expectedIds].sort(),
      );
    }

    const mutationCount = client.mutations.length;
    const second = await previewAndApply(client, options);
    expect(client.mutations).toHaveLength(mutationCount);
    expect(
      second.actions.filter(({ status }) => status === 'planned'),
    ).toHaveLength(0);
    expect(second.actions.at(-1)?.kind).toBe('verification');
  });

  test('final verification rejects a late extra build in the managed group', async () => {
    class LateInternalBuildClient extends StatefulClient {
      injected = false;
      readonly extraBuild = resource('builds', 'late-internal-extra-build');

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = [...(await super.list(path))];
        const internalBuildWasAccepted = this.mutations.some(
          ({ method, path: mutationPath }) =>
            method === 'POST' &&
            mutationPath ===
              '/v1/betaGroups/internal-group/relationships/builds',
        );
        if (
          !this.injected &&
          internalBuildWasAccepted &&
          path.startsWith('/v1/betaGroups/internal-group/builds?')
        ) {
          this.injected = true;
          this.groupBuilds.set('internal-group', [
            ...(this.groupBuilds.get('internal-group') ?? []),
            this.extraBuild,
          ]);
        }
        return current;
      }
    }

    const internal = new LateInternalBuildClient();
    seedMatchingTestMetadata(internal);
    const internalOptions = {
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    } as const;
    const internalPreview = await syncTestFlight(internal, {
      ...internalOptions,
      apply: false,
    });
    await expect(
      syncTestFlight(internal, {
        ...internalOptions,
        apply: true,
        confirmPlanDigest: internalPreview.planDigest,
      }),
    ).rejects.toThrow(
      'partial or indeterminate after 1 provider-accepted mutation',
    );
    expect(internal.injected).toBe(true);
  });

  test('tester-only apply exact-verifies the managed group build set', async () => {
    class TesterOnlyBuildInventoryClient extends StatefulClient {
      readonly operations: string[] = [];

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        this.operations.push(`list ${path}`);
        return super.list(path);
      }

      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        this.operations.push(`mutate ${method} ${path}`);
        return super.mutate(method, path, body, expectedType);
      }
    }

    const control = new TesterOnlyBuildInventoryClient();
    control.groupBuilds.set('internal-group', [control.build]);
    const options = {
      internalTesters: [{ email: 'tester-only-build-check@example.invalid' }],
    } as const;
    const preview = await syncTestFlight(control, {
      ...options,
      apply: false,
    });
    control.operations.splice(0);
    const applied = await syncTestFlight(control, {
      ...options,
      apply: true,
      confirmPlanDigest: preview.planDigest,
    });
    expect(applied.actions.at(-1)?.kind).toBe('verification');
    const testerWrite = control.operations.indexOf(
      'mutate POST /v1/betaTesters',
    );
    expect(testerWrite).toBeGreaterThanOrEqual(0);
    const afterTesterWrite = control.operations.slice(testerWrite + 1);
    expect(
      afterTesterWrite.some((operation) =>
        operation.startsWith('list /v1/betaGroups/internal-group/builds?'),
      ),
    ).toBe(true);

    class TesterOnlyLateBuildDriftClient extends StatefulClient {
      injected = false;
      readonly extraBuild = resource('builds', 'tester-only-late-build');

      constructor(readonly target: 'internal-group') {
        super();
        this.groupBuilds.set('internal-group', [this.build]);
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = [...(await super.list(path))];
        if (
          !this.injected &&
          this.mutations.some(
            ({ method, path: mutationPath }) =>
              method === 'POST' && mutationPath === '/v1/betaTesters',
          ) &&
          path.startsWith('/v1/betaGroups/internal-group/betaTesters?')
        ) {
          this.injected = true;
          this.groupBuilds.set(this.target, [
            ...(this.groupBuilds.get(this.target) ?? []),
            this.extraBuild,
          ]);
        }
        return current;
      }
    }

    for (const target of ['internal-group'] as const) {
      const client = new TesterOnlyLateBuildDriftClient(target);
      const driftPreview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: driftPreview.planDigest,
        }),
        target,
      ).rejects.toThrow(
        'partial or indeterminate after 1 provider-accepted mutation',
      );
      expect(client.injected, target).toBe(true);
    }
  });

  test('final verification rejects fixed app identity drift after an accepted tester write', async () => {
    class FinalAppIdentityDriftClient extends StatefulClient {
      injected = false;

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (this.mutations.length > 0 && path.startsWith('/v1/apps?')) {
          this.injected = true;
          return [appWithIdentityDrift('name')];
        }
        return current;
      }
    }

    const client = new FinalAppIdentityDriftClient();
    const options = {
      internalTesters: [{ email: 'final-identity@example.invalid' }],
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow(
      'partial or indeterminate after 1 provider-accepted mutation',
    );
    expect(client.injected).toBe(true);
    expect(
      client.mutations.filter(
        ({ method, path }) => method === 'POST' && path === '/v1/betaTesters',
      ),
    ).toHaveLength(1);
  });

  test('final verification rejects same-audience app-assignment drift after the last tester write', async () => {
    class FinalGlobalInventoryDriftClient extends StatefulClient {
      finalAppTesterAuditReads = 0;
      injected = false;
      readonly lateSameAudience = resource(
        'betaTesters',
        'late-same-audience-id',
        { email: 'late-same-audience@example.invalid' },
      );

      constructor() {
        super();
        addTypedGroup(this, 'late-same-audience-group', false, []);
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        if (
          this.mutations.length > 0 &&
          path.startsWith('/v1/betaTesters?') &&
          (path.includes('filter%5Bapps%5D=app-1') ||
            path.includes('filter[apps]=app-1'))
        ) {
          this.finalAppTesterAuditReads += 1;
          if (!this.injected) {
            this.injected = true;
            this.groupTesters.set('late-same-audience-group', [
              this.lateSameAudience,
            ]);
            this.appTesters.push(this.lateSameAudience);
          }
        }
        return super.list(path);
      }
    }

    const client = new FinalGlobalInventoryDriftClient();
    const options = {
      internalTesters: [{ email: 'approved-final-create@example.invalid' }],
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow(
      'partial or indeterminate after 1 provider-accepted mutation',
    );
    expect(client.injected).toBe(true);
    expect(client.finalAppTesterAuditReads).toBeGreaterThanOrEqual(1);
    expect(
      client.mutations.filter(
        ({ method, path }) => method === 'POST' && path === '/v1/betaTesters',
      ),
    ).toHaveLength(1);
    expect(
      client.mutations.filter(({ path }) =>
        path.endsWith('/relationships/betaTesters'),
      ),
    ).toHaveLength(0);
  });

  test('verifies created and updated app-localization parents before success', async () => {
    class WrongCreatedLocalizationParentClient extends StatefulClient {
      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        const result = await super.mutate(method, path, body, expectedType);
        if (
          method === 'POST' &&
          path === '/v1/betaAppLocalizations' &&
          result !== null
        ) {
          this.appLocalizationAppIds.set(result.id, 'another-app');
        }
        return result;
      }
    }

    class WrongUpdatedLocalizationParentClient extends StatefulClient {
      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        const result = await super.mutate(method, path, body, expectedType);
        if (
          method === 'PATCH' &&
          path === '/v1/betaAppLocalizations/localization-1'
        ) {
          this.appLocalizationAppIds.set('localization-1', 'another-app');
        }
        return result;
      }
    }

    const createClient = new WrongCreatedLocalizationParentClient();
    seedMatchingTestMetadata(createClient);
    createClient.localizations.splice(0);
    createClient.appLocalizationAppIds.delete('localization-1');

    const updateClient = new WrongUpdatedLocalizationParentClient();
    seedMatchingTestMetadata(updateClient);
    updateClient.localizations.splice(
      0,
      1,
      resource('betaAppLocalizations', 'localization-1', {
        description: 'Outdated synthetic beta description.',
        feedbackEmail: review.feedbackEmail,
        locale: review.locale,
      }),
    );

    for (const [label, client, expectedPath] of [
      ['create', createClient, '/v1/betaAppLocalizations'],
      ['update', updateClient, '/v1/betaAppLocalizations/localization-1'],
    ] as const) {
      const options = {
        internalTesters: [],
        testInfo: review,
      } as const;
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        label,
      ).rejects.toThrow(
        'partial or indeterminate after 1 provider-accepted mutation',
      );
      expect(
        client.mutations.filter(({ path }) => path === expectedPath),
        label,
      ).toHaveLength(1);
    }
  });

  test('final verification rejects app-localization parent drift after an accepted metadata write', async () => {
    class FinalAppLocalizationParentDriftClient extends StatefulClient {
      override async get(
        path: string,
        expectedType: string,
      ): Promise<JsonApiResource> {
        if (
          this.mutations.length > 0 &&
          path === '/v1/betaAppLocalizations/localization-1/app' &&
          expectedType === 'apps'
        ) {
          return resource('apps', 'another-app');
        }
        return super.get(path, expectedType);
      }
    }

    const client = new FinalAppLocalizationParentDriftClient();
    seedMatchingTestMetadata(client);
    client.localizations.splice(
      0,
      client.localizations.length,
      resource('betaAppLocalizations', 'localization-1', {
        description: 'Outdated synthetic beta description.',
        feedbackEmail: review.feedbackEmail,
        locale: review.locale,
      }),
    );
    const options = {
      internalTesters: [],
      testInfo: review,
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow(
      'partial or indeterminate after 1 provider-accepted mutation',
    );
    expect(client.mutations).toHaveLength(1);
    expect(client.mutations[0]?.path).toBe(
      '/v1/betaAppLocalizations/localization-1',
    );
  });

  test('rejects wrong-type beta localizations during planning and verification', async () => {
    const localizationAttributes = {
      description: review.betaDescription,
      feedbackEmail: review.feedbackEmail,
      locale: review.locale,
    };
    const planningClient = new StatefulClient();
    planningClient.localizations.push(
      resource('users', 'wrong-type-localization', localizationAttributes),
    );
    await expect(
      syncTestFlight(planningClient, {
        apply: false,
        internalTesters: [],
        testInfo: review,
      }),
    ).rejects.toThrow();
    expect(planningClient.mutations).toHaveLength(0);

    class WrongVerificationLocalizationClient extends StatefulClient {
      verificationStarted = false;

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        if (
          this.mutations.length > 0 &&
          path.startsWith('/v1/apps/app-1/betaGroups?')
        ) {
          this.verificationStarted = true;
        }
        if (
          this.verificationStarted &&
          path.startsWith('/v1/apps/app-1/betaAppLocalizations?')
        ) {
          this.listPaths.push(path);
          return [
            resource(
              'users',
              'wrong-type-verification-localization',
              localizationAttributes,
            ),
          ];
        }
        return super.list(path);
      }
    }

    const verificationClient = new WrongVerificationLocalizationClient();
    verificationClient.localizations.push(
      resource('betaAppLocalizations', 'existing-localization', {
        ...localizationAttributes,
        description: 'Outdated synthetic beta description.',
      }),
    );
    await expect(
      previewAndApply(verificationClient, {
        internalTesters: [],
        testInfo: review,
      }),
    ).rejects.toThrow();
  });

  test('binds complete localization IDs, locales, membership, and build relationships before invitations', async () => {
    type SetDrift =
      | 'app-add'
      | 'app-duplicate'
      | 'app-id'
      | 'app-locale'
      | 'app-remove'
      | 'build-add'
      | 'build-duplicate'
      | 'build-id'
      | 'build-locale'
      | 'build-relationship'
      | 'build-remove';

    class CompleteLocalizationSetDriftClient extends StatefulClient {
      armed = false;
      appLocalizationReads = 0;
      buildLocalizationReads = 0;
      frenchRelationshipReads = 0;

      constructor(readonly drift: SetDrift) {
        super();
        seedMatchingTestMetadata(this);
        seedMatchingFrenchLocalizations(this);
        this.buildLocalizationBuildIds.set(
          'changed-build-localization-fr-FR',
          this.build.id,
        );
        this.buildLocalizationBuildIds.set(
          'added-build-localization-fr-CA',
          this.build.id,
        );
        this.buildLocalizationBuildIds.set(
          'duplicate-build-localization-fr-FR',
          this.build.id,
        );
      }

      arm(): void {
        this.armed = true;
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (!this.armed) return current;
        if (path.startsWith('/v1/apps/app-1/betaAppLocalizations?')) {
          this.appLocalizationReads += 1;
          if (this.appLocalizationReads < 2) return current;
          const french = current.find(({ id }) => id === 'localization-fr-FR');
          if (french === undefined) throw new Error('Missing French fixture.');
          if (this.drift === 'app-add') {
            return [
              ...current,
              resource('betaAppLocalizations', 'added-localization-fr-CA', {
                description: 'Description canadienne synthétique.',
                feedbackEmail: review.feedbackEmail,
                locale: 'fr-CA',
              }),
            ];
          }
          if (this.drift === 'app-duplicate') {
            return [
              ...current,
              resource(
                'betaAppLocalizations',
                'duplicate-localization-fr-FR',
                french.attributes,
              ),
            ];
          }
          if (this.drift === 'app-id') {
            return current.map((localization) =>
              localization.id === french.id
                ? resource(
                    'betaAppLocalizations',
                    'changed-localization-fr-FR',
                    localization.attributes,
                  )
                : localization,
            );
          }
          if (this.drift === 'app-locale') {
            return current.map((localization) =>
              localization.id === french.id
                ? resource('betaAppLocalizations', localization.id, {
                    ...localization.attributes,
                    locale: 'fr-CA',
                  })
                : localization,
            );
          }
          if (this.drift === 'app-remove') {
            return current.filter(({ id }) => id !== french.id);
          }
        }
        if (path.startsWith('/v1/builds/build-1/betaBuildLocalizations?')) {
          this.buildLocalizationReads += 1;
          if (this.buildLocalizationReads < 3) return current;
          const french = current.find(
            ({ id }) => id === 'build-localization-fr-FR',
          );
          if (french === undefined) {
            throw new Error('Missing French build fixture.');
          }
          if (this.drift === 'build-add') {
            return [
              ...current,
              resource(
                'betaBuildLocalizations',
                'added-build-localization-fr-CA',
                {
                  locale: 'fr-CA',
                  whatsNew: 'Instructions canadiennes synthétiques.',
                },
              ),
            ];
          }
          if (this.drift === 'build-duplicate') {
            return [
              ...current,
              resource(
                'betaBuildLocalizations',
                'duplicate-build-localization-fr-FR',
                french.attributes,
              ),
            ];
          }
          if (this.drift === 'build-id') {
            return current.map((localization) =>
              localization.id === french.id
                ? resource(
                    'betaBuildLocalizations',
                    'changed-build-localization-fr-FR',
                    localization.attributes,
                  )
                : localization,
            );
          }
          if (this.drift === 'build-locale') {
            return current.map((localization) =>
              localization.id === french.id
                ? resource('betaBuildLocalizations', localization.id, {
                    ...localization.attributes,
                    locale: 'fr-CA',
                  })
                : localization,
            );
          }
          if (this.drift === 'build-remove') {
            return current.filter(({ id }) => id !== french.id);
          }
        }
        return current;
      }

      override async get(
        path: string,
        expectedType: string,
      ): Promise<JsonApiResource> {
        const current = await super.get(path, expectedType);
        if (
          this.armed &&
          this.drift === 'build-relationship' &&
          path === '/v1/betaBuildLocalizations/build-localization-fr-FR/build'
        ) {
          this.frenchRelationshipReads += 1;
          if (this.frenchRelationshipReads >= 2) {
            return resource('builds', 'another-build');
          }
        }
        return current;
      }
    }

    const options = {
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    } as const;
    for (const drift of [
      'app-add',
      'app-duplicate',
      'app-id',
      'app-locale',
      'app-remove',
      'build-add',
      'build-duplicate',
      'build-id',
      'build-locale',
      'build-relationship',
      'build-remove',
    ] as const) {
      const client = new CompleteLocalizationSetDriftClient(drift);
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      client.arm();
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        drift,
      ).rejects.toThrow();
      expect(client.mutations, drift).toHaveLength(0);
      expect(
        client.mutations.filter(
          ({ method, path }) =>
            method === 'POST' &&
            (path.endsWith('/relationships/builds') ||
              path === '/v1/betaAppReviewSubmissions'),
        ),
        drift,
      ).toHaveLength(0);
    }
  });

  test('treats reordered unchanged localization multisets as idempotent', async () => {
    const client = new StatefulClient();
    seedMatchingTestMetadata(client);
    seedMatchingFrenchLocalizations(client);
    client.groupBuilds.set('internal-group', [client.build]);
    const options = {
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    client.localizations.reverse();
    client.buildLocalizations.reverse();
    await syncTestFlight(client, {
      ...options,
      apply: true,
      confirmPlanDigest: preview.planDigest,
    });
    expect(client.mutations).toHaveLength(0);

    const second = await previewAndApply(client, options);
    expect(client.mutations).toHaveLength(0);
    expect(
      second.actions.filter(({ status }) => status === 'planned'),
    ).toHaveLength(0);
  });

  test('binds What to Test to the digest and creates or patches the exact-build localization idempotently', async () => {
    const digestClient = new StatefulClient();
    const base = await syncTestFlight(digestClient, {
      apply: false,
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    });
    const changed = await syncTestFlight(digestClient, {
      apply: false,
      build: 'build-1',
      internalTesters: [],
      testInfo: { ...review, whatsNew: 'Changed synthetic release notes.' },
    });
    expect(changed.planDigest).not.toBe(base.planDigest);

    const createClient = new StatefulClient();
    const options = {
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    } as const;
    await previewAndApply(createClient, options);
    const creates = createClient.mutations.filter(
      ({ method, path }) =>
        method === 'POST' && path === '/v1/betaBuildLocalizations',
    );
    expect(creates).toHaveLength(1);
    expect(dataAttributes(creates[0]?.body)).toMatchObject({
      locale: review.locale,
      whatsNew: review.whatsNew,
    });
    expect(relationshipId(creates[0]?.body, 'build')).toBe('build-1');
    const createMutationCount = createClient.mutations.length;
    await previewAndApply(createClient, options);
    expect(createClient.mutations).toHaveLength(createMutationCount);

    const patchClient = new StatefulClient();
    seedMatchingTestMetadata(patchClient);
    const existing = patchClient.buildLocalizations[0];
    if (existing === undefined) throw new Error('Missing seeded localization.');
    patchClient.buildLocalizations.splice(
      0,
      1,
      resource('betaBuildLocalizations', existing.id, {
        locale: review.locale,
        whatsNew: 'Old synthetic release notes.',
      }),
    );
    await previewAndApply(patchClient, options);
    const patches = patchClient.mutations.filter(
      ({ method, path }) =>
        method === 'PATCH' &&
        path === '/v1/betaBuildLocalizations/build-localization-1',
    );
    expect(patches).toHaveLength(1);
    expect(dataAttributes(patches[0]?.body).whatsNew).toBe(review.whatsNew);
    const patchMutationCount = patchClient.mutations.length;
    await previewAndApply(patchClient, options);
    expect(patchClient.mutations).toHaveLength(patchMutationCount);
  });

  test('rechecks an existing build localization parent immediately before PATCH', async () => {
    class PrePatchBuildLocalizationParentDriftClient extends StatefulClient {
      armed = false;
      liveParentReads = 0;

      override async get(
        path: string,
        expectedType: string,
      ): Promise<JsonApiResource> {
        const current = await super.get(path, expectedType);
        if (
          this.armed &&
          path === '/v1/betaBuildLocalizations/build-localization-1/build' &&
          expectedType === 'builds'
        ) {
          this.liveParentReads += 1;
          return resource('builds', 'another-build');
        }
        return current;
      }
    }

    const client = new PrePatchBuildLocalizationParentDriftClient();
    seedMatchingTestMetadata(client);
    client.buildLocalizations.splice(
      0,
      client.buildLocalizations.length,
      resource('betaBuildLocalizations', 'build-localization-1', {
        locale: review.locale,
        whatsNew: 'Stale synthetic What to Test.',
      }),
    );
    const options = {
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    client.armed = true;
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow();
    expect(client.liveParentReads).toBeGreaterThanOrEqual(1);
    expect(
      client.mutations.filter(
        ({ method, path }) =>
          method === 'PATCH' &&
          path === '/v1/betaBuildLocalizations/build-localization-1',
      ),
    ).toHaveLength(0);
    expect(client.mutations).toHaveLength(0);
  });

  test('treats a wrong build-localization parent after PATCH as partial', async () => {
    class PostPatchBuildLocalizationParentDriftClient extends StatefulClient {
      postPatchParentReads = 0;

      override async get(
        path: string,
        expectedType: string,
      ): Promise<JsonApiResource> {
        const current = await super.get(path, expectedType);
        if (
          path === '/v1/betaBuildLocalizations/build-localization-1/build' &&
          this.mutations.some(
            ({ method, path: mutationPath }) =>
              method === 'PATCH' &&
              mutationPath ===
                '/v1/betaBuildLocalizations/build-localization-1',
          )
        ) {
          this.postPatchParentReads += 1;
        }
        return current;
      }

      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        const result = await super.mutate(method, path, body, expectedType);
        if (
          method === 'PATCH' &&
          path === '/v1/betaBuildLocalizations/build-localization-1'
        ) {
          this.buildLocalizationBuildIds.set(
            'build-localization-1',
            'another-build',
          );
        }
        return result;
      }
    }

    const client = new PostPatchBuildLocalizationParentDriftClient();
    seedMatchingTestMetadata(client);
    client.buildLocalizations.splice(
      0,
      client.buildLocalizations.length,
      resource('betaBuildLocalizations', 'build-localization-1', {
        locale: review.locale,
        whatsNew: 'Stale synthetic What to Test.',
      }),
    );
    const options = {
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow(
      'partial or indeterminate after 1 provider-accepted mutation',
    );
    expect(
      client.mutations.filter(
        ({ method, path }) =>
          method === 'PATCH' &&
          path === '/v1/betaBuildLocalizations/build-localization-1',
      ),
    ).toHaveLength(1);
    expect(client.postPatchParentReads).toBeGreaterThanOrEqual(1);
  });

  test('rejects wrong-type, duplicate, wrong-build, and final-drift build localizations', async () => {
    const wrongType = new StatefulClient();
    wrongType.buildLocalizations.push(
      resource('betaAppLocalizations', 'wrong-build-localization-type', {
        locale: review.locale,
        whatsNew: review.whatsNew,
      }),
    );

    const duplicate = new StatefulClient();
    for (const id of [
      'duplicate-build-localization-1',
      'duplicate-build-localization-2',
    ]) {
      duplicate.buildLocalizations.push(
        resource('betaBuildLocalizations', id, {
          locale: review.locale,
          whatsNew: review.whatsNew,
        }),
      );
      duplicate.buildLocalizationBuildIds.set(id, 'build-1');
    }

    const wrongBuild = new StatefulClient();
    seedMatchingTestMetadata(wrongBuild);
    wrongBuild.buildLocalizationBuildIds.set(
      'build-localization-1',
      'another-build',
    );

    for (const [label, client] of [
      ['wrong type', wrongType],
      ['duplicate locale', duplicate],
      ['wrong build', wrongBuild],
    ] as const) {
      await expect(
        syncTestFlight(client, {
          apply: false,
          build: 'build-1',
          internalTesters: [],
          testInfo: review,
        }),
        label,
      ).rejects.toThrow();
      expect(client.mutations, label).toHaveLength(0);
    }

    class FinalLocalizationDriftClient extends StatefulClient {
      localizationReads = 0;

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (path.startsWith('/v1/builds/build-1/betaBuildLocalizations?')) {
          this.localizationReads += 1;
          if (this.localizationReads >= 3) {
            return [
              resource('betaBuildLocalizations', 'build-localization-1', {
                locale: review.locale,
                whatsNew: 'Late unreviewed drift.',
              }),
            ];
          }
        }
        return current;
      }
    }
    const driftClient = new FinalLocalizationDriftClient();
    seedMatchingTestMetadata(driftClient);
    driftClient.groupBuilds.set('internal-group', [driftClient.build]);
    const driftOptions = {
      build: 'build-1',
      internalTesters: [],
      testInfo: review,
    } as const;
    const preview = await syncTestFlight(driftClient, {
      ...driftOptions,
      apply: false,
    });
    await expect(
      syncTestFlight(driftClient, {
        ...driftOptions,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow('no mutations were attempted');
    expect(driftClient.mutations).toHaveLength(0);
  });

  test('rechecks readiness and What to Test before an invitation-producing build attachment', async () => {
    class PreDistributionLocalizationDriftClient extends StatefulClient {
      localizationReads = 0;

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (path.startsWith('/v1/builds/build-1/betaBuildLocalizations?')) {
          this.localizationReads += 1;
          if (this.localizationReads >= 3) {
            return [
              resource('betaBuildLocalizations', 'build-localization-1', {
                locale: review.locale,
                whatsNew: 'Unreviewed pre-distribution drift.',
              }),
            ];
          }
        }
        return current;
      }
    }

    class PreDistributionStateDriftClient extends StatefulClient {
      betaDetailReads = 0;

      override async get(
        path: string,
        expectedType: string,
      ): Promise<JsonApiResource> {
        const current = await super.get(path, expectedType);
        if (path.startsWith('/v1/builds/build-1/buildBetaDetail?')) {
          this.betaDetailReads += 1;
          if (this.betaDetailReads >= 3) {
            return resource('buildBetaDetails', 'build-detail-1', {
              ...this.buildBetaDetail.attributes,
              internalBuildState: 'PROCESSING',
            });
          }
        }
        return current;
      }
    }

    for (const client of [
      new PreDistributionLocalizationDriftClient(),
      new PreDistributionStateDriftClient(),
    ]) {
      seedMatchingTestMetadata(client);
      const options = {
        build: 'build-1',
        internalTesters: [],
        testInfo: review,
      } as const;
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
      ).rejects.toThrow('no mutations were attempted');
      expect(client.mutations).toHaveLength(0);
    }
  });

  test('rejects Customer Support users before any mutation', async () => {
    const client = new StatefulClient();
    client.users.push(
      resource('users', 'customer-support-user', {
        allAppsVisible: true,
        roles: ['CUSTOMER_SUPPORT'],
        username: 'support@example.invalid',
      }),
    );
    await expect(
      syncTestFlight(client, {
        apply: false,
        internalTesters: [{ email: 'support@example.invalid' }],
      }),
    ).rejects.toThrow('not eligible');
    expect(client.mutations).toHaveLength(0);
  });

  test('locally matches internal users and verifies restricted app access by opaque ID', async () => {
    const client = new StatefulClient();
    client.users.splice(
      0,
      client.users.length,
      resource('users', 'restricted-internal-user-id', {
        allAppsVisible: false,
        roles: ['APP_MANAGER'],
        username: 'RESTRICTED-INTERNAL@example.invalid',
      }),
      resource('users', 'unrelated-customer-support-id', {
        allAppsVisible: true,
        roles: ['CUSTOMER_SUPPORT'],
        username: 'unrelated-support@example.invalid',
      }),
    );
    client.userVisibleApps.set('restricted-internal-user-id', [client.app]);
    client.accountTesters.push(
      resource('betaTesters', 'restricted-internal-tester-id', {
        email: 'restricted-internal@example.invalid',
      }),
      resource('betaTesters', 'unrelated-internal-tester-id', {
        email: 'unrelated-internal@example.invalid',
      }),
    );
    const options = {
      internalTesters: [{ email: 'restricted-internal@example.invalid' }],
    } as const;
    await previewAndApply(client, options);
    const userCollectionReads = client.listPaths.filter((path) =>
      path.startsWith('/v1/users?'),
    );
    expect(userCollectionReads).toHaveLength(3);
    expect(
      userCollectionReads.every(
        (path) =>
          path ===
          '/v1/users?fields%5Busers%5D=username%2Croles%2CallAppsVisible&limit=200',
      ),
    ).toBe(true);
    expect(
      client.listPaths.some(
        (path) =>
          path ===
          '/v1/users/restricted-internal-user-id/visibleApps?limit=200',
      ),
    ).toBe(true);
    expect(
      client.listPaths.some((path) =>
        decodeURIComponent(path).includes(
          'restricted-internal@example.invalid',
        ),
      ),
    ).toBe(false);
    expect(
      client.mutations.some(({ path }) => path === '/v1/betaTesters'),
    ).toBe(false);
    expect(
      client.groupTesters
        .get('internal-group')
        ?.some(({ id }) => id === 'restricted-internal-tester-id'),
    ).toBe(true);
    expect(
      client.groupTesters
        .get('internal-group')
        ?.some(({ id }) => id === 'unrelated-internal-tester-id'),
    ).toBe(false);

    const noAccess = new StatefulClient();
    noAccess.users.splice(
      0,
      noAccess.users.length,
      resource('users', 'no-access-user-id', {
        allAppsVisible: false,
        roles: ['APP_MANAGER'],
        username: 'no-access@example.invalid',
      }),
    );
    await expect(
      syncTestFlight(noAccess, {
        apply: false,
        internalTesters: [{ email: 'no-access@example.invalid' }],
      }),
    ).rejects.toThrow('lacks access');
    expect(noAccess.mutations).toHaveLength(0);
    expect(
      noAccess.listPaths.some((path) =>
        decodeURIComponent(path).includes('no-access@example.invalid'),
      ),
    ).toBe(false);
  });

  test('requires restricted-user visible apps and relationship linkage to match exactly', async () => {
    const requested = {
      apply: false,
      internalTesters: [{ email: 'restricted@example.invalid' }],
    } as const;
    for (const [label, linkage] of [
      ['omitted', []],
      ['wrong ID', [resource('apps', 'another-app')]],
      ['duplicate', [resource('apps', 'app-1'), resource('apps', 'app-1')]],
      ['wrong type', [resource('builds', 'app-1')]],
    ] as const) {
      const client = new StatefulClient();
      client.users.splice(
        0,
        client.users.length,
        resource('users', 'restricted-user', {
          allAppsVisible: false,
          roles: ['APP_MANAGER'],
          username: 'restricted@example.invalid',
        }),
      );
      client.userVisibleApps.set('restricted-user', [client.app]);
      client.userVisibleAppLinkageOverrides.set('restricted-user', [
        ...linkage,
      ]);
      await expect(syncTestFlight(client, requested), label).rejects.toThrow();
      expect(client.mutations, label).toHaveLength(0);
    }

    const correct = new StatefulClient();
    correct.users.splice(
      0,
      correct.users.length,
      resource('users', 'restricted-user', {
        allAppsVisible: false,
        roles: ['APP_MANAGER'],
        username: 'restricted@example.invalid',
      }),
    );
    correct.userVisibleApps.set('restricted-user', [correct.app]);
    expect((await syncTestFlight(correct, requested)).mode).toBe('plan');
    expect(correct.mutations).toHaveLength(0);
  });

  test('revalidates internal user role and exact app access before tester link or create', async () => {
    class LiveUserAccessDriftClient extends StatefulClient {
      armed = false;

      constructor(
        readonly drift: 'access' | 'role',
        linkExisting: boolean,
      ) {
        super();
        this.users.splice(
          0,
          this.users.length,
          resource('users', 'restricted-user', {
            allAppsVisible: false,
            roles: ['APP_MANAGER'],
            username: 'internal-drift@example.invalid',
          }),
        );
        this.userVisibleApps.set('restricted-user', [this.app]);
        if (linkExisting) {
          this.accountTesters.push(
            resource('betaTesters', 'existing-internal-tester', {
              email: 'internal-drift@example.invalid',
            }),
          );
        }
      }

      override async get(
        path: string,
        expectedType: string,
      ): Promise<JsonApiResource> {
        const current = await super.get(path, expectedType);
        if (
          this.armed &&
          path.startsWith('/v1/users/restricted-user') &&
          expectedType === 'users'
        ) {
          return resource('users', current.id, {
            allAppsVisible: false,
            roles:
              this.drift === 'role' ? ['CUSTOMER_SUPPORT'] : ['APP_MANAGER'],
            username: 'internal-drift@example.invalid',
          });
        }
        return current;
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (
          this.armed &&
          this.drift === 'access' &&
          path.startsWith('/v1/users/restricted-user/') &&
          (path.includes('/visibleApps') ||
            path.includes('/relationships/visibleApps'))
        ) {
          return [];
        }
        return current;
      }
    }

    const requested = {
      internalTesters: [{ email: 'internal-drift@example.invalid' }],
    } as const;
    for (const linkExisting of [false, true]) {
      for (const drift of ['role', 'access'] as const) {
        const client = new LiveUserAccessDriftClient(drift, linkExisting);
        const preview = await syncTestFlight(client, {
          ...requested,
          apply: false,
        });
        const exactUserReadsBefore = client.getPaths.filter((path) =>
          path.startsWith('/v1/users/restricted-user'),
        ).length;
        client.armed = true;
        await expect(
          syncTestFlight(client, {
            ...requested,
            apply: true,
            confirmPlanDigest: preview.planDigest,
          }),
          `${linkExisting ? 'link' : 'create'}:${drift}`,
        ).rejects.toThrow();
        expect(
          client.getPaths.filter((path) =>
            path.startsWith('/v1/users/restricted-user'),
          ).length,
          `${linkExisting ? 'link' : 'create'}:${drift}`,
        ).toBeGreaterThan(exactUserReadsBefore);
        expect(client.mutations).toHaveLength(0);
      }
    }
  });

  test('validates every unfiltered account user and tester without exposing malformed identities', async () => {
    const userCases = [
      {
        label: 'wrong user type',
        resources: [
          resource('betaTesters', 'wrong-user-type-id', {
            email: 'wrong-user-type-private@example.invalid',
          }),
        ],
        secrets: ['wrong-user-type-private@example.invalid'],
      },
      {
        label: 'malformed username',
        resources: [
          resource('users', 'malformed-user-id', {
            allAppsVisible: true,
            roles: ['APP_MANAGER'],
            username: 'malformed-private-user-token',
          }),
        ],
        secrets: ['malformed-private-user-token'],
      },
      {
        label: 'duplicate user ID',
        resources: [
          resource('users', 'duplicate-private-user-id', {
            allAppsVisible: true,
            roles: ['APP_MANAGER'],
            username: 'first-private-user@example.invalid',
          }),
          resource('users', 'duplicate-private-user-id', {
            allAppsVisible: true,
            roles: ['DEVELOPER'],
            username: 'second-private-user@example.invalid',
          }),
        ],
        secrets: [
          'first-private-user@example.invalid',
          'second-private-user@example.invalid',
        ],
      },
      {
        label: 'duplicate normalized username',
        resources: [
          resource('users', 'first-private-user-id', {
            allAppsVisible: true,
            roles: ['APP_MANAGER'],
            username: 'duplicate-private-user@example.invalid',
          }),
          resource('users', 'second-private-user-id', {
            allAppsVisible: true,
            roles: ['DEVELOPER'],
            username: 'DUPLICATE-PRIVATE-USER@example.invalid',
          }),
        ],
        secrets: ['duplicate-private-user@example.invalid'],
      },
    ] as const;
    for (const scenario of userCases) {
      const client = new StatefulClient();
      client.users.push(...scenario.resources);
      let message: string | undefined;
      try {
        await syncTestFlight(client, {
          apply: false,
          internalTesters: [{ email: 'internal@example.invalid' }],
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, scenario.label).toBeDefined();
      for (const secret of scenario.secrets) {
        expect(
          message?.toLocaleLowerCase('en-US'),
          scenario.label,
        ).not.toContain(secret.toLocaleLowerCase('en-US'));
        expect(
          client.listPaths
            .map((path) => decodeURIComponent(path))
            .join('\n')
            .toLocaleLowerCase('en-US'),
          scenario.label,
        ).not.toContain(secret.toLocaleLowerCase('en-US'));
      }
      expect(client.mutations, scenario.label).toHaveLength(0);
    }

    const testerCases = [
      {
        label: 'wrong tester type',
        resources: [
          resource('users', 'wrong-tester-type-id', {
            username: 'wrong-tester-type-private@example.invalid',
          }),
        ],
        secrets: ['wrong-tester-type-private@example.invalid'],
      },
      {
        label: 'malformed tester email',
        resources: [
          resource('betaTesters', 'malformed-tester-id', {
            email: 'malformed-private-tester-token',
          }),
        ],
        secrets: ['malformed-private-tester-token'],
      },
      {
        label: 'duplicate tester ID',
        resources: [
          resource('betaTesters', 'duplicate-private-tester-id', {
            email: 'first-private-tester@example.invalid',
          }),
          resource('betaTesters', 'duplicate-private-tester-id', {
            email: 'second-private-tester@example.invalid',
          }),
        ],
        secrets: [
          'first-private-tester@example.invalid',
          'second-private-tester@example.invalid',
        ],
      },
      {
        label: 'duplicate normalized tester email',
        resources: [
          resource('betaTesters', 'first-private-tester-id', {
            email: 'duplicate-private-tester@example.invalid',
          }),
          resource('betaTesters', 'second-private-tester-id', {
            email: 'DUPLICATE-PRIVATE-TESTER@example.invalid',
          }),
        ],
        secrets: ['duplicate-private-tester@example.invalid'],
      },
    ] as const;
    for (const scenario of testerCases) {
      const client = new StatefulClient();
      client.accountTesters.push(
        resource('betaTesters', 'desired-private-tester-id', {
          email: 'desired-private-tester@example.invalid',
        }),
        ...scenario.resources,
      );
      let message: string | undefined;
      try {
        await syncTestFlight(client, {
          apply: false,
          internalTesters: [
            { email: 'desired-private-tester@example.invalid' },
          ],
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, scenario.label).toBeDefined();
      for (const secret of scenario.secrets) {
        expect(
          message?.toLocaleLowerCase('en-US'),
          scenario.label,
        ).not.toContain(secret.toLocaleLowerCase('en-US'));
        expect(
          client.listPaths
            .map((path) => decodeURIComponent(path))
            .join('\n')
            .toLocaleLowerCase('en-US'),
          scenario.label,
        ).not.toContain(secret.toLocaleLowerCase('en-US'));
      }
      expect(client.mutations, scenario.label).toHaveLength(0);
    }
  });

  test('apply creates both required groups with private explicit-build settings', async () => {
    const client = new StatefulClient();
    client.groups.splice(0);
    const result = await previewAndApply(client, {
      internalTesters: [],
    });
    const groupCreates = client.mutations.filter(
      ({ method, path }) => method === 'POST' && path === '/v1/betaGroups',
    );
    expect(groupCreates).toHaveLength(1);
    expect(dataAttributes(groupCreates[0]?.body)).toMatchObject({
      hasAccessToAllBuilds: false,
      isInternalGroup: true,
      name: TEST_APP_CONFIGURATION.internalGroupName,
    });
    expect(result.actions.at(-1)?.kind).toBe('verification');
  });

  test('keeps staff identity and review PII out of every provider path and result', async () => {
    const client = new StatefulClient();
    const internalEmail = 'privacy-internal@example.invalid';
    const externalEmail = 'privacy-external@example.invalid';
    const unrelatedUserEmail = 'unrelated-user@example.invalid';
    const unrelatedTesterEmail = 'unrelated-tester@example.invalid';
    client.users.push(
      resource('users', 'privacy-internal-user-id', {
        allAppsVisible: true,
        roles: ['APP_MANAGER'],
        username: internalEmail.toLocaleUpperCase('en-US'),
      }),
      resource('users', 'unrelated-user-id', {
        allAppsVisible: true,
        roles: ['DEVELOPER'],
        username: unrelatedUserEmail,
      }),
    );
    client.accountTesters.push(
      resource('betaTesters', 'privacy-internal-tester-id', {
        email: internalEmail,
      }),
      resource('betaTesters', 'privacy-external-tester-id', {
        email: externalEmail.toLocaleUpperCase('en-US'),
      }),
      resource('betaTesters', 'unrelated-tester-id', {
        email: unrelatedTesterEmail,
      }),
    );
    const privateReview: BetaTestInfo = {
      betaDescription: 'Private description token 9372.',
      feedbackEmail: 'private-feedback@example.invalid',
      locale: 'en-US',
      whatsNew: 'Private What to Test token 9372.',
    };
    const result = await previewAndApply(client, {
      internalTesters: [
        {
          email: internalEmail,
          firstName: 'InternalFirst9372',
          lastName: 'InternalLast9372',
        },
      ],
      testInfo: privateReview,
    });

    const paths = [
      ...client.listPaths,
      ...client.getPaths,
      ...client.mutations.map(({ path }) => path),
    ];
    const forbiddenValues = [
      internalEmail,
      externalEmail,
      unrelatedUserEmail,
      unrelatedTesterEmail,
      'InternalFirst9372',
      'InternalLast9372',
      privateReview.feedbackEmail,
    ];
    for (const path of paths) {
      const decoded = decodeURIComponent(path.replaceAll('+', ' '));
      expect(decoded).not.toContain('filter[email]');
      expect(decoded).not.toContain('filter[username]');
      for (const value of forbiddenValues) {
        expect(decoded.toLocaleLowerCase('en-US')).not.toContain(
          value.toLocaleLowerCase('en-US'),
        );
        expect(path.toLocaleLowerCase('en-US')).not.toContain(
          encodeURIComponent(value).toLocaleLowerCase('en-US'),
        );
      }
    }
    const serializedResult = JSON.stringify(result).toLocaleLowerCase('en-US');
    for (const value of forbiddenValues) {
      expect(serializedResult).not.toContain(value.toLocaleLowerCase('en-US'));
    }

    const userCollections = client.listPaths.filter((path) =>
      path.startsWith('/v1/users?'),
    );
    expect(userCollections).toHaveLength(3);
    const userCollection = new URL(
      userCollections[0] as string,
      'https://api.appstoreconnect.apple.com',
    );
    expect([...userCollection.searchParams.keys()].sort()).toEqual([
      'fields[users]',
      'limit',
    ]);
    expect(userCollection.searchParams.get('fields[users]')).toBe(
      'username,roles,allAppsVisible',
    );
    expect(userCollection.searchParams.get('limit')).toBe('200');

    const accountTesterCollections = client.listPaths.filter((path) => {
      if (!path.startsWith('/v1/betaTesters?')) return false;
      const url = new URL(path, 'https://api.appstoreconnect.apple.com');
      return !url.searchParams.has('filter[apps]');
    });
    expect(accountTesterCollections.length).toBeGreaterThanOrEqual(1);
    for (const path of accountTesterCollections) {
      const url = new URL(path, 'https://api.appstoreconnect.apple.com');
      expect([...url.searchParams.keys()].sort()).toEqual([
        'fields[betaTesters]',
        'limit',
      ]);
      expect(url.searchParams.get('fields[betaTesters]')).toBe('email');
      expect(url.searchParams.get('limit')).toBe('200');
    }
    expect(client.mutations.length).toBeGreaterThan(0);
  });

  test('large approved rosters use one bounded identity-free account collection read', async () => {
    const client = new StatefulClient();
    const approvedTesters = Array.from({ length: 100 }, (_, index) => ({
      email: `tester-${index}@example.invalid`,
    }));
    await syncTestFlight(client, {
      apply: false,
      internalTesters: approvedTesters,
    });
    const accountCollections = client.listPaths.filter((path) => {
      if (!path.startsWith('/v1/betaTesters?')) return false;
      const url = new URL(path, 'https://api.appstoreconnect.apple.com');
      return !url.searchParams.has('filter[apps]');
    });
    expect(accountCollections).toHaveLength(1);
    const collection = new URL(
      accountCollections[0] as string,
      'https://api.appstoreconnect.apple.com',
    );
    expect([...collection.searchParams.keys()].sort()).toEqual([
      'fields[betaTesters]',
      'limit',
    ]);
    expect(collection.searchParams.get('fields[betaTesters]')).toBe('email');
    expect(collection.searchParams.get('limit')).toBe('200');
    const decodedPaths = client.listPaths
      .map((path) => decodeURIComponent(path))
      .join('\n');
    expect(decodedPaths).not.toContain('filter[email]');
    for (const { email } of approvedTesters) {
      expect(decodedPaths).not.toContain(email);
    }
  });

  test('applies 100 internal links through weighted fresh-digest chunks with exact prefixes', async () => {
    const testerCount = 100;
    const weightedChunkSize = 9;
    const chunkCount = Math.ceil(testerCount / weightedChunkSize);
    const perApplyOperationCeiling = 1_500;
    const perApplyProviderRequestCeiling = 1_500;
    const maximumFullRosterCollections = 2 * (Math.ceil(testerCount / 100) + 9);
    const client = new ScaleStatefulClient();
    const desired = Array.from({ length: testerCount }, (_, index) => ({
      email: `scale-internal-${index}@example.invalid`,
    }));
    const testerIdToUserId = new Map<string, string>();
    client.users.splice(0, client.users.length);
    for (let index = 0; index < testerCount; index += 1) {
      const email = desired[index]?.email;
      if (email === undefined) throw new Error('Missing synthetic tester.');
      const testerId = `scale-internal-tester-${index}`;
      const userId = `scale-internal-user-${index}`;
      testerIdToUserId.set(testerId, userId);
      client.users.push(
        resource('users', userId, {
          allAppsVisible: true,
          roles: ['APP_MANAGER'],
          username: email,
        }),
      );
      client.accountTesters.push(resource('betaTesters', testerId, { email }));
    }
    const options = {
      internalTesters: desired,
    } as const;
    const relationshipPath =
      '/v1/betaGroups/internal-group/relationships/betaTesters';
    const expectedEmails = desired.map(({ email }) => email).sort();
    const testerIdByEmail = new Map(
      client.accountTesters.map((tester) => [
        String(tester.attributes?.email),
        tester.id,
      ]),
    );
    const deterministicTesterIds = expectedEmails.map((email) => {
      const testerId = testerIdByEmail.get(email);
      if (testerId === undefined) {
        throw new Error('Missing synthetic tester identity.');
      }
      return testerId;
    });
    const confirmedDigests = new Set<string>();
    const allLinkedIds: string[] = [];
    let maximumProviderRequests = 0;
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const chunkLabel = `chunk ${chunkIndex + 1}`;
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      expect(confirmedDigests.has(preview.planDigest), chunkLabel).toBe(false);
      confirmedDigests.add(preview.planDigest);
      const mutationStart = client.mutations.length;
      client.resetScaleCounters();
      client.operationCeiling = perApplyOperationCeiling;
      client.providerRequestCeiling = perApplyProviderRequestCeiling;
      const result = await syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      });
      maximumProviderRequests = Math.max(
        maximumProviderRequests,
        client.providerRequestCount,
      );
      expect(result.actions.at(-1), chunkLabel).toEqual({
        detail: 'Read-back verification passed.',
        kind: 'verification',
        status: 'applied',
      });
      expect(client.operations.length, chunkLabel).toBeLessThanOrEqual(
        perApplyOperationCeiling,
      );
      expect(client.providerRequestCount, chunkLabel).toBeLessThanOrEqual(
        perApplyProviderRequestCeiling,
      );

      const chunkStart = chunkIndex * weightedChunkSize;
      const expectedChunkSize = Math.min(
        weightedChunkSize,
        testerCount - chunkStart,
      );
      const remainingAfterChunk = testerCount - chunkStart - expectedChunkSize;
      expect(
        result.actions.some(
          ({ detail, kind, status }) =>
            kind === 'tester' &&
            status === 'applied' &&
            detail.startsWith(
              `Add ${expectedChunkSize} approved existing tester(s)`,
            ),
        ),
        chunkLabel,
      ).toBe(true);
      const testerDeferrals = result.actions.filter(
        ({ kind, status }) => kind === 'tester' && status === 'deferred',
      );
      if (remainingAfterChunk === 0) {
        expect(testerDeferrals, chunkLabel).toHaveLength(0);
      } else {
        expect(testerDeferrals, chunkLabel).toHaveLength(1);
        expect(testerDeferrals[0]?.detail, chunkLabel).toStartWith(
          `Defer ${remainingAfterChunk} approved tester write(s)`,
        );
      }

      const writes = client.mutations
        .slice(mutationStart)
        .filter(
          ({ method, path }) => method === 'POST' && path === relationshipPath,
        );
      expect(writes, chunkLabel).toHaveLength(expectedChunkSize);
      const linkedIds = writes.flatMap(({ body }) =>
        relationshipLinkageIds(body),
      );
      expect(linkedIds, chunkLabel).toEqual(
        deterministicTesterIds.slice(
          chunkStart,
          chunkStart + expectedChunkSize,
        ),
      );
      allLinkedIds.push(...linkedIds);

      const operationWrites = client.operations.flatMap((operation, index) =>
        operation === `mutate POST ${relationshipPath}` ? [index] : [],
      );
      expect(operationWrites, chunkLabel).toHaveLength(expectedChunkSize);
      for (let index = 0; index < operationWrites.length; index += 1) {
        const writeIndex = operationWrites[index] as number;
        const priorWriteIndex = operationWrites[index - 1] ?? -1;
        const nextWriteIndex =
          operationWrites[index + 1] ?? client.operations.length;
        const before = client.operations.slice(priorWriteIndex + 1, writeIndex);
        const after = client.operations.slice(writeIndex + 1, nextWriteIndex);
        const testerId = linkedIds[index];
        const userId =
          testerId === undefined ? undefined : testerIdToUserId.get(testerId);
        if (testerId === undefined || userId === undefined) {
          throw new Error('Missing synthetic link identity.');
        }
        expect(
          before.some((operation) =>
            operation.startsWith(`get /v1/users/${userId}?`),
          ),
          testerId,
        ).toBe(true);
        expect(
          before.some((operation) =>
            operation.startsWith(`get /v1/betaTesters/${testerId}?`),
          ),
          testerId,
        ).toBe(true);
        expect(
          before.some((operation) => operation.startsWith('list /v1/apps?')),
          testerId,
        ).toBe(true);
        for (const path of [
          '/v1/betaGroups/internal-group/betaTesters?',
          '/v1/betaGroups/internal-group/relationships/betaTesters?',
        ]) {
          expect(
            before.some(
              (operation) =>
                operation.startsWith(`pageSummary ${path}`) &&
                operation.includes('limit=1'),
            ),
            `${testerId}:pre:${path}`,
          ).toBe(true);
          expect(
            after.some(
              (operation) =>
                operation.startsWith(`pageSummary ${path}`) &&
                operation.includes('limit=1'),
            ),
            `${testerId}:post:${path}`,
          ).toBe(true);
        }
        expect(client.operations[writeIndex - 1], testerId).toBe(
          'pageSummary /v1/betaGroups/internal-group/relationships/betaTesters?limit=1',
        );
        for (const path of [
          '/v1/betaGroups/internal-group/builds?',
          '/v1/betaGroups/internal-group/relationships/builds?',
        ]) {
          expect(
            before.some((operation) => operation.startsWith(`list ${path}`)),
            `${testerId}:${path}`,
          ).toBe(true);
        }
        expect(
          after.some((operation) =>
            operation.startsWith(`get /v1/betaTesters/${testerId}?`),
          ),
          testerId,
        ).toBe(true);
        for (const relationship of ['betaGroups', 'apps'] as const) {
          expect(
            after.some((operation) =>
              operation.startsWith(
                `list /v1/betaTesters/${testerId}/${relationship}?`,
              ),
            ),
            `${testerId}:${relationship}:related`,
          ).toBe(true);
          expect(
            after.some((operation) =>
              operation.startsWith(
                `list /v1/betaTesters/${testerId}/relationships/${relationship}?`,
              ),
            ),
            `${testerId}:${relationship}:linkage`,
          ).toBe(true);
        }
      }

      const globalInventoryPasses = client.operations.filter((operation) => {
        if (!operation.startsWith('list /v1/betaTesters?')) return false;
        return new URL(
          operation.slice('list '.length),
          'https://api.appstoreconnect.apple.com',
        ).searchParams.has('filter[apps]');
      });
      expect(globalInventoryPasses.length, chunkLabel).toBeGreaterThanOrEqual(
        3,
      );
      expect(globalInventoryPasses.length, chunkLabel).toBeLessThanOrEqual(8);
      const fullRosterCollections = client.providerRequests.filter(
        ({ operation }) =>
          operation.startsWith(
            'list /v1/betaGroups/internal-group/betaTesters?',
          ) ||
          operation.startsWith(
            'list /v1/betaGroups/internal-group/relationships/betaTesters?',
          ),
      );
      expect(fullRosterCollections.length, chunkLabel).toBeLessThanOrEqual(
        maximumFullRosterCollections,
      );
      expect(
        fullRosterCollections.reduce((total, { cost }) => total + cost, 0),
        chunkLabel,
      ).toBeLessThanOrEqual(maximumFullRosterCollections);

      const expectedPrefix = expectedEmails.slice(
        0,
        chunkStart + expectedChunkSize,
      );
      expect(
        sortedTesterEmails(client.groupTesters.get('internal-group') ?? []),
        chunkLabel,
      ).toEqual(expectedPrefix);
      expect(sortedTesterEmails(client.appTesters), chunkLabel).toEqual(
        expectedPrefix,
      );
    }

    expect(confirmedDigests.size).toBe(chunkCount);
    expect(allLinkedIds).toEqual(deterministicTesterIds);
    expect(
      sortedTesterEmails(client.groupTesters.get('internal-group') ?? []),
    ).toEqual(expectedEmails);
    expect(sortedTesterEmails(client.appTesters)).toEqual(expectedEmails);
    expect(sortedTesterEmails(client.accountTesters)).toEqual(expectedEmails);
    expect(client.groupTesters.get('external-group')).toEqual([]);

    const mutationCount = client.mutations.length;
    const idempotentPreview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    expect(confirmedDigests.has(idempotentPreview.planDigest)).toBe(false);
    client.resetScaleCounters();
    const second = await syncTestFlight(client, {
      ...options,
      apply: true,
      confirmPlanDigest: idempotentPreview.planDigest,
    });
    expect(client.mutations).toHaveLength(mutationCount);
    expect(
      second.actions.filter(
        ({ status }) => status === 'planned' || status === 'deferred',
      ),
    ).toHaveLength(0);
    expect(client.providerRequestCount).toBeLessThanOrEqual(
      perApplyProviderRequestCeiling,
    );
    expect(maximumProviderRequests).toBeLessThanOrEqual(
      perApplyProviderRequestCeiling,
    );
    expect(
      sortedTesterEmails(client.groupTesters.get('internal-group') ?? []),
    ).toEqual(expectedEmails);
  }, 60_000);

  test('fails closed on related/linkage roster-total mismatch before and after a tester write', async () => {
    type CountDrift = 'post-related' | 'pre-linkage';

    class RosterCountDriftClient extends StatefulClient {
      armed = false;
      acceptedTesterCreates = 0;

      constructor(readonly drift: CountDrift) {
        super();
      }

      override async pageSummary(path: string): Promise<JsonApiPageSummary> {
        const current = await super.pageSummary(path);
        if (!this.armed || !path.startsWith('/v1/betaGroups/internal-group/')) {
          return current;
        }
        if (
          this.drift === 'pre-linkage' &&
          this.acceptedTesterCreates === 0 &&
          path.includes('/relationships/betaTesters?')
        ) {
          return {
            resources: [
              resource('betaTesters', 'concurrent-linkage-tester', {
                email: 'concurrent-linkage@example.invalid',
              }),
            ],
            total: 1,
          };
        }
        if (
          this.drift === 'post-related' &&
          this.acceptedTesterCreates === 1 &&
          !path.includes('/relationships/')
        ) {
          return { resources: [], total: 0 };
        }
        return current;
      }

      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        const result = await super.mutate(method, path, body, expectedType);
        if (method === 'POST' && path === '/v1/betaTesters') {
          this.acceptedTesterCreates += 1;
        }
        return result;
      }
    }

    const options = {
      internalTesters: [{ email: 'count-drift@example.invalid' }],
    } as const;
    for (const drift of ['pre-linkage', 'post-related'] as const) {
      const client = new RosterCountDriftClient(drift);
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      client.armed = true;
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        drift,
      ).rejects.toThrow(
        drift === 'pre-linkage'
          ? 'no mutations were attempted'
          : 'partial or indeterminate after 1 provider-accepted mutation',
      );
      expect(client.acceptedTesterCreates, drift).toBe(
        drift === 'pre-linkage' ? 0 : 1,
      );
      expect(
        client.mutations.filter(
          ({ method, path }) => method === 'POST' && path === '/v1/betaTesters',
        ),
        drift,
      ).toHaveLength(drift === 'pre-linkage' ? 0 : 1);
    }
  });

  test('catches a same-count roster substitution in the exact final audit', async () => {
    class SameCountFinalAuditDriftClient extends StatefulClient {
      acceptedTesterCreates = 0;
      injected = false;

      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        const result = await super.mutate(method, path, body, expectedType);
        if (method === 'POST' && path === '/v1/betaTesters') {
          this.acceptedTesterCreates += 1;
          if (this.acceptedTesterCreates === 5) {
            const target = this.groupTesters.get('internal-group');
            if (target === undefined || target.length !== 5) {
              throw new Error('Missing synthetic final-audit roster.');
            }
            target.splice(
              0,
              1,
              resource('betaTesters', 'same-count-outsider', {
                email: 'same-count-outsider@example.invalid',
              }),
            );
            this.injected = true;
          }
        }
        return result;
      }
    }

    const client = new SameCountFinalAuditDriftClient();
    const options = {
      internalTesters: Array.from({ length: 5 }, (_, index) => ({
        email: `final-audit-${index}@example.invalid`,
      })),
    } as const;
    const preview = await syncTestFlight(client, {
      ...options,
      apply: false,
    });
    await expect(
      syncTestFlight(client, {
        ...options,
        apply: true,
        confirmPlanDigest: preview.planDigest,
      }),
    ).rejects.toThrow(
      'partial or indeterminate after 5 provider-accepted mutation',
    );
    expect(client.injected).toBe(true);
    expect(client.acceptedTesterCreates).toBe(5);
    expect(
      client.mutations.filter(
        ({ method, path }) => method === 'POST' && path === '/v1/betaTesters',
      ),
    ).toHaveLength(5);
  }, 30_000);

  test('keeps opposite-audience and capacity drift in phase baseline and final global audits', async () => {
    class BaselineOppositeAudienceDriftClient extends OrderedStatefulClient {
      armed = false;
      buildLinkageReads = 0;
      injected = false;
      readonly existing = resource('betaTesters', 'baseline-opposite-tester', {
        email: 'baseline-opposite@example.invalid',
      });

      constructor() {
        super();
        this.accountTesters.push(this.existing);
        addTypedGroup(this, 'late-external-audience', false, []);
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (
          this.armed &&
          path ===
            '/v1/betaGroups/internal-group/relationships/builds?limit=200'
        ) {
          this.buildLinkageReads += 1;
          if (this.buildLinkageReads === 2) {
            this.groupTesters.set('late-external-audience', [this.existing]);
            this.appTesters.push(this.existing);
            this.injected = true;
          }
        }
        return current;
      }
    }

    const baselineClient = new BaselineOppositeAudienceDriftClient();
    const baselineOptions = {
      internalTesters: [{ email: 'baseline-opposite@example.invalid' }],
    } as const;
    const baselinePreview = await syncTestFlight(baselineClient, {
      ...baselineOptions,
      apply: false,
    });
    baselineClient.operations.splice(0);
    baselineClient.armed = true;
    await expect(
      syncTestFlight(baselineClient, {
        ...baselineOptions,
        apply: true,
        confirmPlanDigest: baselinePreview.planDigest,
      }),
    ).rejects.toThrow('no mutations were attempted');
    expect(baselineClient.injected).toBe(true);
    expect(baselineClient.mutations).toHaveLength(0);
    expect(
      baselineClient.operations.some((operation) =>
        operation.startsWith(
          'list /v1/betaGroups/late-external-audience/betaTesters?',
        ),
      ),
    ).toBe(true);

    class FinalCapacityDriftClient extends OrderedStatefulClient {
      acceptedTesterCreates = 0;
      injected = false;

      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        const result = await super.mutate(method, path, body, expectedType);
        if (method === 'POST' && path === '/v1/betaTesters') {
          this.acceptedTesterCreates += 1;
          if (this.acceptedTesterCreates === 2) {
            const lateCapacity = syntheticTesters('late-final-capacity', 9_999);
            addTypedGroup(
              this,
              'late-final-capacity-group',
              false,
              lateCapacity,
            );
            this.appTesters.push(...lateCapacity);
            this.injected = true;
          }
        }
        return result;
      }
    }

    const finalClient = new FinalCapacityDriftClient();
    const finalOptions = {
      internalTesters: [
        { email: 'final-capacity-1@example.invalid' },
        { email: 'final-capacity-2@example.invalid' },
      ],
    } as const;
    const finalPreview = await syncTestFlight(finalClient, {
      ...finalOptions,
      apply: false,
    });
    finalClient.operations.splice(0);
    await expect(
      syncTestFlight(finalClient, {
        ...finalOptions,
        apply: true,
        confirmPlanDigest: finalPreview.planDigest,
      }),
    ).rejects.toThrow(
      'partial or indeterminate after 2 provider-accepted mutation',
    );
    expect(finalClient.injected).toBe(true);
    expect(finalClient.acceptedTesterCreates).toBe(2);
    expect(
      finalClient.mutations.filter(
        ({ method, path }) => method === 'POST' && path === '/v1/betaTesters',
      ),
    ).toHaveLength(2);
    expect(
      finalClient.operations.some((operation) =>
        operation.startsWith(
          'list /v1/betaGroups/late-final-capacity-group/betaTesters?',
        ),
      ),
    ).toBe(true);
  }, 30_000);

  test('freshly revalidates an existing account tester identity before relationship POST', async () => {
    class ExistingTesterIdentityDriftClient extends StatefulClient {
      constructor(readonly drift: 'email' | 'id') {
        super();
      }

      override async get(
        path: string,
        expectedType: string,
      ): Promise<JsonApiResource> {
        const current = await super.get(path, expectedType);
        if (
          path.startsWith('/v1/betaTesters/existing-account-tester') &&
          expectedType === 'betaTesters'
        ) {
          return resource(
            'betaTesters',
            this.drift === 'id' ? 'different-account-tester' : current.id,
            {
              email:
                this.drift === 'email'
                  ? 'changed-existing@example.invalid'
                  : 'existing@example.invalid',
            },
          );
        }
        return current;
      }
    }

    for (const drift of ['email', 'id'] as const) {
      const client = new ExistingTesterIdentityDriftClient(drift);
      client.accountTesters.push(
        resource('betaTesters', 'existing-account-tester', {
          email: 'existing@example.invalid',
        }),
      );
      const options = {
        internalTesters: [{ email: 'existing@example.invalid' }],
      } as const;
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        drift,
      ).rejects.toThrow('no mutations were attempted');
      expect(
        client.mutations.filter(({ path }) =>
          path.endsWith('/relationships/betaTesters'),
        ),
        drift,
      ).toHaveLength(0);
    }
  });

  test('treats a freshly mismatched created tester identity as partial', async () => {
    class CreatedTesterIdentityDriftClient extends StatefulClient {
      constructor(readonly drift: 'email' | 'id') {
        super();
      }

      override async get(
        path: string,
        expectedType: string,
      ): Promise<JsonApiResource> {
        const current = await super.get(path, expectedType);
        if (
          path.startsWith('/v1/betaTesters/tester-1') &&
          expectedType === 'betaTesters'
        ) {
          return resource(
            'betaTesters',
            this.drift === 'id' ? 'different-created-tester' : current.id,
            {
              email:
                this.drift === 'email'
                  ? 'changed-created@example.invalid'
                  : 'created@example.invalid',
            },
          );
        }
        return current;
      }
    }

    for (const drift of ['email', 'id'] as const) {
      const client = new CreatedTesterIdentityDriftClient(drift);
      const options = {
        internalTesters: [{ email: 'created@example.invalid' }],
      } as const;
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        drift,
      ).rejects.toThrow(
        'partial or indeterminate after 1 provider-accepted mutation',
      );
      expect(
        client.mutations.filter(
          ({ method, path }) => method === 'POST' && path === '/v1/betaTesters',
        ),
        drift,
      ).toHaveLength(1);
    }
  });

  test('treats missing immediate created-tester related or linkage reciprocals as partial', async () => {
    type ReciprocalDrift =
      'app-linkage' | 'app-related' | 'group-linkage' | 'group-related';

    class CreatedTesterReciprocalDriftClient extends StatefulClient {
      accepted = false;
      reciprocalDriftObserved = false;

      constructor(readonly drift: ReciprocalDrift) {
        super();
      }

      override async list(path: string): Promise<readonly JsonApiResource[]> {
        const current = await super.list(path);
        if (!this.accepted) return current;
        const route =
          this.drift === 'group-related'
            ? '/v1/betaTesters/tester-1/betaGroups?'
            : this.drift === 'group-linkage'
              ? '/v1/betaTesters/tester-1/relationships/betaGroups?'
              : this.drift === 'app-related'
                ? '/v1/betaTesters/tester-1/apps?'
                : '/v1/betaTesters/tester-1/relationships/apps?';
        if (path.startsWith(route)) {
          this.reciprocalDriftObserved = true;
          return [];
        }
        return current;
      }

      override async mutate(
        method: 'PATCH' | 'POST',
        path: string,
        body: unknown,
        expectedType?: string,
      ): Promise<JsonApiResource | null> {
        const result = await super.mutate(method, path, body, expectedType);
        if (method === 'POST' && path === '/v1/betaTesters') {
          this.accepted = true;
        }
        return result;
      }
    }

    const options = {
      internalTesters: [{ email: 'reciprocal@example.invalid' }],
    } as const;
    for (const drift of [
      'group-related',
      'group-linkage',
      'app-related',
      'app-linkage',
    ] as const) {
      const client = new CreatedTesterReciprocalDriftClient(drift);
      const preview = await syncTestFlight(client, {
        ...options,
        apply: false,
      });
      await expect(
        syncTestFlight(client, {
          ...options,
          apply: true,
          confirmPlanDigest: preview.planDigest,
        }),
        drift,
      ).rejects.toThrow(
        'partial or indeterminate after 1 provider-accepted mutation',
      );
      expect(client.accepted, drift).toBe(true);
      expect(
        client.mutations.filter(
          ({ method, path }) => method === 'POST' && path === '/v1/betaTesters',
        ),
        drift,
      ).toHaveLength(1);
      expect(client.reciprocalDriftObserved, drift).toBe(true);
    }
  });

  test('links an account-level tester instead of recreating it', async () => {
    const client = new StatefulClient();
    client.accountTesters.push(
      resource('betaTesters', 'existing-account-tester', {
        email: 'existing@example.invalid',
      }),
    );
    await previewAndApply(client, {
      internalTesters: [{ email: 'existing@example.invalid' }],
    });
    expect(
      client.mutations.some(({ path }) => path === '/v1/betaTesters'),
    ).toBe(false);
    expect(
      client.mutations.some(({ path }) =>
        path.endsWith('/relationships/betaTesters'),
      ),
    ).toBe(true);
  });

  test('apply is additive, verifies read-back, and becomes idempotent', async () => {
    const client = new StatefulClient();
    const options = {
      build: 'build-1',
      internalTesters: [{ email: 'internal@example.invalid' }],
      testInfo: review,
    } as const;
    const first = await previewAndApply(client, options);
    expect(first.actions.at(-1)).toEqual({
      detail: 'Read-back verification passed.',
      kind: 'verification',
      status: 'applied',
    });
    expect(
      client.mutations.some(({ path }) => path === '/v1/betaTesters'),
    ).toBe(true);
    expect(first.actions.some(({ status }) => status === 'deferred')).toBe(
      true,
    );
    expect(client.mutations.every(({ method }) => method !== 'DELETE')).toBe(
      true,
    );

    const testerMutationCount = client.mutations.length;
    const second = await previewAndApply(client, options);
    expect(client.mutations.length).toBeGreaterThan(testerMutationCount);
    expect(
      client.mutations.some(({ path }) =>
        path.endsWith('/relationships/builds'),
      ),
    ).toBe(true);
    expect(
      second.actions.filter(({ status }) => status === 'deferred'),
    ).toHaveLength(0);

    const mutationCount = client.mutations.length;
    const third = await previewAndApply(client, options);
    expect(client.mutations).toHaveLength(mutationCount);
    expect(
      third.actions.filter(({ status }) => status === 'planned'),
    ).toHaveLength(0);
  });
});

describe('operator documentation and reproducibility', () => {
  test('preserves the stable operator import surface', () => {
    expect(ascEntry.createAscJwt).toBe(createAscJwt);
    expect(ascEntry.parseCli).toBe(parseConfiguredCli);
    expect(ascEntry.syncTestFlight).toBe(syncConfiguredTestFlight);
    expect(ascEntry.AppStoreConnectClient).toBe(AppStoreConnectClient);
  });

  test('locks the production-writing fastlane toolchain', async () => {
    const rubyVersion = await Bun.file(
      join(import.meta.dir, '.ruby-version'),
    ).text();
    const lock = await Bun.file(join(import.meta.dir, 'Gemfile.lock')).text();
    expect(rubyVersion.trim()).toBe('3.3.12');
    expect(lock).toContain('fastlane (2.237.0)');
    expect(lock).toMatch(
      /CHECKSUMS[\s\S]*fastlane \(2\.237\.0\) sha256=[0-9a-f]{64}/u,
    );
    expect(lock).toMatch(/BUNDLED WITH\s+2\.6\.9\s*$/u);
  });
});
