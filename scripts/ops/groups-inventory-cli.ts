import { resolve } from 'node:path';

import {
  MAX_FACILITY_INPUT_BYTES,
  MAX_DRAFT_FILE_BYTES,
  type GroupsInventoryConfiguration,
  requireString,
  normalizeText,
} from './groups-inventory-model';

import {
  inventoryAllGroups,
  createCloudIdentityFetcher,
  obtainImpersonatedToken,
} from './groups-inventory-google';

import { buildDraft } from './groups-inventory-report';

import {
  readPrivateJson,
  createDefaultOutputPath,
  writePrivateDraft,
} from './groups-inventory-files';

import {
  parseFacilities,
  validateDraftForDomain,
} from './groups-inventory-input';
interface InventoryCli extends GroupsInventoryConfiguration {
  readonly command: 'inventory';
  readonly customerId: string;
  readonly facilitiesPath: string;
  readonly outputPath?: string;
  readonly quotaProject: string;
  readonly serviceAccount: string;
}

interface ValidateCli extends GroupsInventoryConfiguration {
  readonly command: 'validate';
  readonly draftPath: string;
}

type CliOptions = InventoryCli | ValidateCli;

const usage = `Usage:
  bun scripts/ops/groups-inventory.ts inventory \\
    --facilities /private/facilities.page.json \\
    --customer-id C01234567 \\
    --service-account groups-reader@PROJECT.iam.gserviceaccount.com \\
    --quota-project PROJECT \\
    --hosted-domain district.example \\
    --academic-time-zone Area/City \\
    --organization-prefixes district,example \\
    [--output /private/groups-mapping.draft.json]

  bun scripts/ops/groups-inventory.ts validate \\
    --draft /private/groups-mapping.draft.json \\
    --hosted-domain district.example \\
    --academic-time-zone Area/City \\
    --organization-prefixes district,example

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

const CONFIGURATION_OPTIONS = [
  '--academic-time-zone',
  '--hosted-domain',
  '--organization-prefixes',
] as const;

const parseConfiguration = (
  options: ReadonlyMap<string, string>,
): GroupsInventoryConfiguration => {
  const hostedDomain = requireOption(options, '--hosted-domain')
    .toLocaleLowerCase('en-US')
    .replace(/\.$/u, '');
  if (
    hostedDomain.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      hostedDomain,
    )
  ) {
    throw new Error('--hosted-domain must be a canonical DNS domain.');
  }

  const academicTimeZone = requireOption(options, '--academic-time-zone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: academicTimeZone }).format(0);
  } catch (error) {
    throw new Error('--academic-time-zone must be an IANA time zone.', {
      cause: error,
    });
  }

  const organizationPrefixes = requireOption(options, '--organization-prefixes')
    .split(',')
    .map((prefix) => normalizeText(prefix));
  if (
    organizationPrefixes.length > 32 ||
    organizationPrefixes.some(
      (prefix) => prefix === '' || !/^[a-z0-9]{1,64}$/u.test(prefix),
    ) ||
    new Set(organizationPrefixes).size !== organizationPrefixes.length
  ) {
    throw new Error(
      '--organization-prefixes must be a unique comma-separated list of normalized identifiers.',
    );
  }
  return Object.freeze({
    academicTimeZone,
    hostedDomain,
    organizationPrefixes: Object.freeze(organizationPrefixes),
  });
};

export const parseCli = (arguments_: readonly string[]): CliOptions => {
  const command = arguments_[0];
  if (command === 'validate') {
    const options = parseOptionPairs(
      arguments_.slice(1),
      new Set(['--draft', ...CONFIGURATION_OPTIONS]),
    );
    return {
      command,
      draftPath: requireOption(options, '--draft'),
      ...parseConfiguration(options),
    };
  }
  if (command !== 'inventory') throw new Error(usage);
  const options = parseOptionPairs(
    arguments_.slice(1),
    new Set([
      '--customer-id',
      '--facilities',
      ...CONFIGURATION_OPTIONS,
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
    ...parseConfiguration(options),
    ...(outputPath === undefined
      ? {}
      : { outputPath: requireString(outputPath, '--output', 4_096) }),
  };
};

export const runGroupsInventoryCli = async (
  arguments_: readonly string[],
): Promise<void> => {
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
    console.log(
      JSON.stringify(validateDraftForDomain(draft, options), null, 2),
    );
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
    options.hostedDomain,
  );
  const draft = buildDraft(
    facilities,
    inventory.groups,
    inventory.pageCount,
    new Date().toISOString(),
    options,
  );
  validateDraftForDomain(draft, options);
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
