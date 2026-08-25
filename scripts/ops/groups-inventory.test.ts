import { describe, test } from 'bun:test';
import {
  CreateGroupSourceInputSchema,
  type Facility,
  FacilitySchema,
} from '@psd-eoc/contracts';
import { chmod, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLOUD_IDENTITY_ORIGIN,
  CLOUD_IDENTITY_SCOPE,
  type CloudGroup,
  type DraftDerivationMetrics,
  type DraftGroupRef,
  type GcloudPathMetadata,
  HIGH_CONFIDENCE_EMBEDDED_POPULATION_MARKERS,
  INCIDENTAL_POPULATION_WORDS,
  type JsonObject,
  MAX_DRAFT_FILE_BYTES,
  MAX_FACILITIES,
  MAX_FACILITY_CONTEXTS_PER_IDENTITY_FIELD,
  MAX_FACILITY_INPUT_BYTES,
  MAX_GROUPS,
  MAX_GROUPS_PER_PAGE,
  MAX_NEIGHBORHOOD_FACILITIES,
  MAX_RESPONSE_BYTES,
  type MappingDraft,
  type NeighborhoodProposal,
  OPERATIONAL_K_SAFE_WORDS,
  SHORT_GRADE_POPULATION_MARKERS,
  SPELLED_GRADE_CARDINALS,
  SPELLED_GRADE_ORDINALS,
  SPELLED_GRADE_ORDINAL_MARKERS,
  SYNTHETIC_TEST_GROUP_DOMAIN,
  UNSAFE_AUTH_ENVIRONMENT_KEYS,
  type ValidationSummary,
  academicStartYearAt,
  assertSafeAuthenticationEnvironment,
  buildDraft,
  classifyPopulationGroup,
  compactPopulationPrefixes,
  compareText,
  createCloudIdentityFetcher,
  createHumanAdcEnvironment,
  createIsolatedGcloudConfigPath,
  facilityContextsForTokens,
  gcloudTokenArguments,
  groupRef,
  groupTokenFields,
  hasIndexedExactWholeBuildingIdentity,
  hasStaffIdentityEvidence,
  hasUnsupportedIdentityContent,
  inventoryAllGroups,
  isExactWholeBuildingIdentity,
  isHostedGroupEmail,
  isRecord,
  isTrustedGcloudAncestorMetadata,
  isTrustedGcloudExecutableMetadata,
  normalizeText,
  parseCli,
  parseCloudGroupForDomain,
  parseDraftGroupRef,
  parseFacilities,
  parseGroupPage,
  parseGroupSourceFromDraft,
  parseInteractiveUserAdc,
  parseNeighborhoodFromDraft,
  readBoundedResponseJson,
  readBoundedStream,
  readPrivateJson,
  retainBest,
  scanWrittenGradeEndpoints,
  serializeDraft,
  siteSpecificFacilityNameTokens,
  validateDraftForDomain,
  writePrivateDraft,
  writtenGradeEvidenceForField,
} from './groups-inventory';

const CLI_PATH = new URL('groups-inventory.ts', import.meta.url).pathname;

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
  const broadCollisionDraft = buildDraft(
    collisionFacilities,
    collisionGroups,
    1,
    generatedAt,
    collisionMetrics,
  );
  const broadCollisionValidation = validateDraft(broadCollisionDraft);
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
      broadCollisionDraft.inventoryGroups.length === collisionGroups.length &&
      broadCollisionDraft.report.omittedUnverifiedGroupIdentityCount === 0 &&
      broadCollisionDraft.report.ambiguousStaffScopeGroups.length ===
        collisionGroups.length &&
      broadCollisionDraft.report.unassignedBuildingLikeGroups.length ===
        collisionGroups.length &&
      broadCollisionDraft.buildingMappings.every(
        ({ assessment, createGroupSource }) =>
          assessment.outcome === 'missing' &&
          assessment.candidates.length === 0 &&
          createGroupSource === null,
      ) &&
      broadCollisionValidation.structuralValidationPassed,
    'broadly ambiguous aliases remain visible without scoring or retaining their facility cross-product',
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

  expectSelfTestThrow(
    () => parseCli(['self-test']),
    'self-test is owned by ordinary test discovery instead of the production CLI',
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
      [Bun.argv[0]!, CLI_PATH, 'validate', '--draft', fifoInputPath],
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

describe('Google Groups inventory', () => {
  // This preserves the complete former command-line self-test in ordinary
  // discovery. A two-core CI runner needs just over one minute for the bounded
  // subprocess, filesystem, and mapping cases together.
  test('passes the complete synthetic safety and mapping suite', async () => {
    await runSelfTest();
  }, 120_000);
});
