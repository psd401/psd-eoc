import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertActiveGcloudAccount,
  assertApplicationDefaultIdentity,
  assertDefaultTerraformWorkspace,
  gcpRoot,
  requireExactConfirmation,
  runCommand,
  runCommandForStatus,
  runInteractive,
} from './runtime';
import { parseUserManagedKeyIds, ROSTER_READER_EMAIL } from './groups-contract';
import {
  TERRAFORM_ADMIN,
  validateProjectIamPolicy,
  validateRosterReaderResourcePolicy,
} from './project-policy';

const PROJECT_ID = 'psd401-eoc';
const PROJECT_NAME = 'PSD EOC';
const ORGANIZATION_ID = '482073499306';
const BILLING_ACCOUNT = '<billing-account>';
const STATE_BUCKET = 'psd401-eoc-terraform-state';
const ROSTER_READER_ADDRESS = 'google_service_account.roster_reader';
const ROSTER_READER_RESOURCE = `projects/${PROJECT_ID}/serviceAccounts/${ROSTER_READER_EMAIL}`;
const ROSTER_READER_DISPLAY_NAME = 'PSD EOC roster sync reader';
const ROSTER_READER_DESCRIPTION =
  'Reads configured staff Google Groups for roster snapshots; never writes Groups or sends notifications.';
const bootstrapRoot = join(gcpRoot, 'bootstrap');
const bootstrapPlan = join(bootstrapRoot, '.terraform', 'bootstrap.tfplan');
const mainPlan = join(gcpRoot, '.terraform', 'apply.tfplan');

const expectedLabels = {
  application: 'psd-eoc',
  environment: 'single',
  'goog-terraform-provisioned': 'true',
  'managed-by': 'terraform',
  purpose: 'staff-identity',
} as const;

const bootstrapResources = [
  'google_project.psd_eoc',
  'google_project_service.service_usage',
  'google_project_service.storage',
  'google_project_service.cloud_resource_manager',
  'google_project_service.cloud_billing',
  'google_storage_bucket.terraform_state',
  'google_storage_bucket_iam_policy.terraform_state',
] as const;

const mainImports = [
  ['google_project.psd_eoc', PROJECT_ID],
  [
    'google_project_service.service_usage',
    `${PROJECT_ID}/serviceusage.googleapis.com`,
  ],
  [
    'google_project_service.required["storage.googleapis.com"]',
    `${PROJECT_ID}/storage.googleapis.com`,
  ],
  [
    'google_project_service.required["cloudresourcemanager.googleapis.com"]',
    `${PROJECT_ID}/cloudresourcemanager.googleapis.com`,
  ],
  [
    'google_project_service.required["cloudbilling.googleapis.com"]',
    `${PROJECT_ID}/cloudbilling.googleapis.com`,
  ],
  ['google_storage_bucket.terraform_state', STATE_BUCKET],
  ['google_storage_bucket_iam_policy.terraform_state', `b/${STATE_BUCKET}`],
] as const;

const bootstrapServiceImports = [
  ['google_project_service.service_usage', 'serviceusage.googleapis.com'],
  ['google_project_service.storage', 'storage.googleapis.com'],
  [
    'google_project_service.cloud_resource_manager',
    'cloudresourcemanager.googleapis.com',
  ],
  ['google_project_service.cloud_billing', 'cloudbilling.googleapis.com'],
] as const;

export const BOOTSTRAP_SERVICES = new Set(
  bootstrapServiceImports.map(([, service]) => service),
);

const bootstrapApiRepairServices = [
  'cloudresourcemanager.googleapis.com',
  'cloudbilling.googleapis.com',
] as const;

const bootstrapApiRepairTrustServices = [
  'serviceusage.googleapis.com',
  'storage.googleapis.com',
] as const;

const bootstrapBucketImports = [
  ['google_storage_bucket.terraform_state', STATE_BUCKET],
  ['google_storage_bucket_iam_policy.terraform_state', `b/${STATE_BUCKET}`],
] as const;

export type StateBucketStatus =
  | 'absent'
  | 'bootstrap-policy'
  | 'managed-policy';

export interface StateBucketInspection {
  readonly projectNumber: string;
  readonly status: Exclude<StateBucketStatus, 'absent'>;
}

export interface EnabledProjectServicesInspection {
  readonly projectNumber: string;
  readonly services: ReadonlySet<string>;
}

export interface BootstrapApiRepairOperations {
  readonly assertOperatorIdentity: () => Promise<void>;
  readonly confirm: (preview: string, confirmation: string) => Promise<void>;
  readonly enableServices: (services: readonly string[]) => void;
  readonly inspectBucket: () => StateBucketInspection | null;
  readonly inspectServices: () => EnabledProjectServicesInspection;
}

function parseJsonObject(
  value: string,
  description: string,
): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${description} was not one JSON object.`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export function parseBucketDescribeResult(
  status: number | null,
  stdout: string,
  stderr: string,
): Readonly<Record<string, unknown>> | null {
  if (status === 0) {
    return parseJsonObject(stdout, 'State bucket metadata');
  }
  const detail = stderr || stdout;
  if (
    /(?:\b404\b|not found|does not exist|matched no)/iu.test(detail) &&
    !/(?:permission|forbidden|unauthorized)/iu.test(detail)
  ) {
    return null;
  }
  throw new Error(
    `State bucket inspection exited with status ${status}: ${detail.trim().slice(0, 2_000)}`,
  );
}

export function parseProjectDescribeResult(
  status: number | null,
  stdout: string,
  stderr: string,
): Readonly<Record<string, unknown>> | null {
  if (status === 0) {
    return parseJsonObject(stdout, 'Project metadata');
  }
  const detail = stderr || stdout;
  if (
    /(?:\b404\b|not found|could not find|does not exist)/iu.test(detail) ||
    (/does not have permission to access projects instance/iu.test(detail) &&
      /or it may not exist/iu.test(detail))
  ) {
    return null;
  }
  throw new Error(
    `Project inspection exited with status ${status}: ${detail.trim().slice(0, 2_000)}`,
  );
}

export function parseEnabledProjectServices(
  output: string,
): EnabledProjectServicesInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(
      'Enabled project services did not contain valid structured JSON.',
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      'Enabled project services did not contain one non-empty service array.',
    );
  }

  let projectNumber: string | undefined;
  const services = new Set<string>();
  for (const value of parsed) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Enabled project service metadata is malformed.');
    }
    const service = value as Readonly<Record<string, unknown>>;
    const config = service.config;
    if (
      Object.keys(service).sort().join(',') !== 'config,name,state' ||
      typeof config !== 'object' ||
      config === null ||
      Array.isArray(config) ||
      Object.keys(config).join(',') !== 'name'
    ) {
      throw new Error('Enabled project service metadata is malformed.');
    }
    const configuredName = (config as Readonly<Record<string, unknown>>).name;
    const match =
      typeof service.name === 'string'
        ? /^projects\/([1-9]\d*)\/services\/([a-z][a-z0-9.-]*\.googleapis\.com)$/u.exec(
            service.name,
          )
        : null;
    if (
      match === null ||
      configuredName !== match[2] ||
      service.state !== 'ENABLED' ||
      services.has(match[2] as string)
    ) {
      throw new Error('Enabled project service metadata is malformed.');
    }
    const observedProjectNumber = match[1] as string;
    if (
      projectNumber !== undefined &&
      projectNumber !== observedProjectNumber
    ) {
      throw new Error(
        'Enabled project services identify more than one Google project.',
      );
    }
    projectNumber = observedProjectNumber;
    services.add(match[2] as string);
  }
  if (projectNumber === undefined) {
    throw new Error('Enabled project services omitted the Google project.');
  }
  return { projectNumber, services };
}

export function parseServiceAccountListResult(
  status: number | null,
  stdout: string,
  stderr: string,
): Readonly<Record<string, unknown>> | null {
  if (status !== 0) {
    const detail = stderr || stdout;
    throw new Error(
      `Roster-reader service-account listing exited with status ${status}: ${detail.trim().slice(0, 2_000)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      'Roster-reader service-account listing did not contain valid JSON.',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      'Roster-reader service-account listing was not one JSON array.',
    );
  }
  if (parsed.length === 0) {
    return null;
  }
  const matches: Readonly<Record<string, unknown>>[] = [];
  for (const value of parsed) {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as Readonly<Record<string, unknown>>).email !== 'string'
    ) {
      throw new Error(
        'Roster-reader service-account listing contained malformed metadata.',
      );
    }
    const serviceAccount = value as Readonly<Record<string, unknown>>;
    if (serviceAccount.email === ROSTER_READER_EMAIL) {
      matches.push(serviceAccount);
    }
  }
  if (matches.length === 0) {
    return null;
  }
  if (
    matches.length !== 1 ||
    typeof matches[0]?.uniqueId !== 'string' ||
    !/^\d+$/u.test(matches[0].uniqueId) ||
    typeof matches[0].oauth2ClientId !== 'string' ||
    !/^\d+$/u.test(matches[0].oauth2ClientId)
  ) {
    throw new Error(
      'Roster-reader service-account listing did not contain exactly the fixed account.',
    );
  }
  return matches[0];
}

export function validateRecoverableRosterReaderServiceAccount(
  value: unknown,
  resourcePolicy: unknown,
  userManagedKeyOutput: string,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      'Existing roster-reader service-account metadata is invalid.',
    );
  }
  const serviceAccount = value as Readonly<Record<string, unknown>>;
  if (
    serviceAccount.name !== ROSTER_READER_RESOURCE ||
    serviceAccount.projectId !== PROJECT_ID ||
    serviceAccount.email !== ROSTER_READER_EMAIL ||
    serviceAccount.displayName !== ROSTER_READER_DISPLAY_NAME ||
    serviceAccount.description !== ROSTER_READER_DESCRIPTION ||
    typeof serviceAccount.uniqueId !== 'string' ||
    !/^\d+$/u.test(serviceAccount.uniqueId) ||
    typeof serviceAccount.oauth2ClientId !== 'string' ||
    !/^\d+$/u.test(serviceAccount.oauth2ClientId) ||
    (serviceAccount.disabled !== undefined && serviceAccount.disabled !== false)
  ) {
    throw new Error(
      'Existing roster-reader service account does not match the exact Terraform identity and metadata contract.',
    );
  }
  validateRosterReaderResourcePolicy(resourcePolicy);
  if (parseUserManagedKeyIds(userManagedKeyOutput).size !== 0) {
    throw new Error(
      'Existing roster-reader service account has a user-managed key and cannot be adopted.',
    );
  }
}

function recordField(
  value: Readonly<Record<string, unknown>>,
  field: string,
  description: string,
): Readonly<Record<string, unknown>> {
  const fieldValue = value[field];
  if (
    typeof fieldValue !== 'object' ||
    fieldValue === null ||
    Array.isArray(fieldValue)
  ) {
    throw new Error(`${description} is invalid.`);
  }
  return fieldValue as Readonly<Record<string, unknown>>;
}

export function validateBootstrapProject(
  project: Readonly<Record<string, unknown>>,
  billing: Readonly<Record<string, unknown>>,
): void {
  const parent = recordField(project, 'parent', 'Project parent');
  const labels = recordField(project, 'labels', 'Project labels');
  const labelsMatch =
    Object.keys(labels).length === Object.keys(expectedLabels).length &&
    Object.entries(expectedLabels).every(
      ([name, expected]) => labels[name] === expected,
    );
  if (
    project.projectId !== PROJECT_ID ||
    project.name !== PROJECT_NAME ||
    project.lifecycleState !== 'ACTIVE' ||
    typeof project.projectNumber !== 'string' ||
    !/^\d+$/u.test(project.projectNumber) ||
    parent.type !== 'organization' ||
    parent.id !== ORGANIZATION_ID ||
    !labelsMatch ||
    billing.projectId !== PROJECT_ID ||
    billing.billingAccountName !== `billingAccounts/${BILLING_ACCOUNT}` ||
    billing.billingEnabled !== true
  ) {
    throw new Error(
      'Existing project metadata does not match the fixed PSD EOC organization, billing, and label contract.',
    );
  }
}

export function validateStateBucket(
  bucket: Readonly<Record<string, unknown>>,
  policy: Readonly<Record<string, unknown>>,
  allowBootstrapPolicy = false,
): Exclude<StateBucketStatus, 'absent'> {
  const labels = recordField(bucket, 'labels', 'State bucket labels');
  const labelsMatch =
    Object.keys(labels).length === Object.keys(expectedLabels).length &&
    Object.entries(expectedLabels).every(
      ([name, expected]) => labels[name] === expected,
    );
  const lifecycle = recordField(
    bucket,
    'lifecycle_config',
    'State bucket lifecycle',
  );
  const rules = lifecycle.rule;
  const rule =
    Array.isArray(rules) && rules.length === 1 ? rules[0] : undefined;
  const ruleRecord =
    typeof rule === 'object' && rule !== null && !Array.isArray(rule)
      ? (rule as Readonly<Record<string, unknown>>)
      : undefined;
  const action =
    ruleRecord === undefined
      ? undefined
      : recordField(ruleRecord, 'action', 'State bucket lifecycle action');
  const condition =
    ruleRecord === undefined
      ? undefined
      : recordField(
          ruleRecord,
          'condition',
          'State bucket lifecycle condition',
        );
  if (
    bucket.name !== STATE_BUCKET ||
    bucket.storage_url !== `gs://${STATE_BUCKET}/` ||
    bucket.location !== 'US-WEST1' ||
    bucket.location_type !== 'region' ||
    bucket.default_storage_class !== 'STANDARD' ||
    bucket.public_access_prevention !== 'enforced' ||
    bucket.uniform_bucket_level_access !== true ||
    (bucket.requester_pays !== undefined && bucket.requester_pays !== false) ||
    bucket.versioning_enabled !== true ||
    bucket.default_event_based_hold === true ||
    (bucket.retention_policy !== undefined &&
      bucket.retention_policy !== null) ||
    !labelsMatch ||
    action?.type !== 'Delete' ||
    condition?.daysSinceNoncurrentTime !== 90 ||
    condition?.age !== undefined ||
    condition?.isLive !== false
  ) {
    throw new Error(
      'Existing state bucket does not match the complete private, versioned Terraform backend contract.',
    );
  }

  const managedBindings = new Map<string, ReadonlySet<string>>([
    ['roles/storage.objectAdmin', new Set([`user:${TERRAFORM_ADMIN}`])],
  ]);
  const bootstrapBindings = new Map<string, ReadonlySet<string>>([
    [
      'roles/storage.legacyBucketOwner',
      new Set([`projectEditor:${PROJECT_ID}`, `projectOwner:${PROJECT_ID}`]),
    ],
    [
      'roles/storage.legacyBucketReader',
      new Set([`projectViewer:${PROJECT_ID}`]),
    ],
    [
      'roles/storage.legacyObjectOwner',
      new Set([`projectEditor:${PROJECT_ID}`, `projectOwner:${PROJECT_ID}`]),
    ],
    [
      'roles/storage.legacyObjectReader',
      new Set([`projectViewer:${PROJECT_ID}`]),
    ],
  ]);
  const bindings = policy.bindings;
  if (!Array.isArray(bindings)) {
    throw new Error('Existing state bucket IAM contains invalid bindings.');
  }
  const actualBindings = new Map<string, ReadonlySet<string>>();
  for (const binding of bindings) {
    if (
      typeof binding !== 'object' ||
      binding === null ||
      Array.isArray(binding)
    ) {
      throw new Error('Existing state bucket IAM contains an invalid binding.');
    }
    const record = binding as Readonly<Record<string, unknown>>;
    const role = record.role;
    const members = record.members;
    if (
      typeof role !== 'string' ||
      actualBindings.has(role) ||
      record.condition !== undefined ||
      !Array.isArray(members) ||
      members.some((member) => typeof member !== 'string')
    ) {
      throw new Error('Existing state bucket IAM contains an invalid binding.');
    }
    const actualMembers = new Set(members as string[]);
    if (actualMembers.size !== members.length) {
      throw new Error('Existing state bucket IAM contains a duplicate member.');
    }
    actualBindings.set(role, actualMembers);
  }

  const matches = (
    expected: ReadonlyMap<string, ReadonlySet<string>>,
  ): boolean =>
    actualBindings.size === expected.size &&
    [...actualBindings].every(([role, actualMembers]) => {
      const expectedMembers = expected.get(role);
      return (
        expectedMembers !== undefined &&
        actualMembers.size === expectedMembers.size &&
        [...actualMembers].every((member) => expectedMembers.has(member))
      );
    });

  if (matches(managedBindings)) {
    return 'managed-policy';
  }
  if (allowBootstrapPolicy && matches(bootstrapBindings)) {
    return 'bootstrap-policy';
  }
  throw new Error(
    'Existing state bucket IAM does not match the single-administrator least-privilege backend contract.',
  );
}

export function stateBucketProjectNumber(
  bucket: Readonly<Record<string, unknown>>,
): string {
  const value = bucket.project_number;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^[1-9]\d*$/u.test(value)) {
    return value;
  }
  throw new Error(
    'Existing state bucket does not identify one valid owning Google project.',
  );
}

export function missingRecoverableBootstrapApis(
  bucketStatus: StateBucketStatus,
  enabledServices: ReadonlySet<string>,
): readonly string[] {
  if (bucketStatus === 'absent') {
    return [];
  }
  for (const service of bootstrapApiRepairTrustServices) {
    if (!enabledServices.has(service)) {
      throw new Error(
        'Service Usage and Storage must remain enabled for safe bootstrap API recovery.',
      );
    }
  }
  return bootstrapApiRepairServices.filter(
    (service) => !enabledServices.has(service),
  );
}

function sameStateBucketInspection(
  left: StateBucketInspection | null,
  right: StateBucketInspection | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.projectNumber === right.projectNumber &&
    left.status === right.status
  );
}

function assertServiceInspectionMatchesBucket(
  bucket: StateBucketInspection,
  services: EnabledProjectServicesInspection,
): void {
  if (services.projectNumber !== bucket.projectNumber) {
    throw new Error(
      'The state bucket and enabled services identify different Google projects.',
    );
  }
}

export async function repairMissingBootstrapApis(
  operations: BootstrapApiRepairOperations,
): Promise<void> {
  const initialBucket = operations.inspectBucket();
  if (initialBucket === null) {
    return;
  }
  const initialServices = operations.inspectServices();
  assertServiceInspectionMatchesBucket(initialBucket, initialServices);
  const initiallyMissing = missingRecoverableBootstrapApis(
    initialBucket.status,
    initialServices.services,
  );
  if (initiallyMissing.length === 0) {
    return;
  }

  await operations.confirm(
    `Bootstrap API repair consequence preview: the fixed ${PROJECT_ID} project (numeric ID ${initialBucket.projectNumber}) owns the exact ${STATE_BUCKET} bucket with ${initialBucket.status}. Persistently enable only ${initiallyMissing.join(', ')} so the helper can inspect the district organization, billing association, and complete project IAM policy before any Terraform backend is initialized. API enablement can permit billable API use. If the post-repair project contract is wrong, the helper stops and leaves these inspection APIs enabled for explicit reconciliation.`,
    'repair-psd401-eoc-bootstrap-apis',
  );

  await operations.assertOperatorIdentity();
  const confirmedBucket = operations.inspectBucket();
  if (!sameStateBucketInspection(initialBucket, confirmedBucket)) {
    throw new Error(
      'The state bucket identity or policy changed during bootstrap API repair confirmation; rerun for a fresh preview.',
    );
  }
  const confirmedServices = operations.inspectServices();
  assertServiceInspectionMatchesBucket(initialBucket, confirmedServices);
  const confirmedMissing = missingRecoverableBootstrapApis(
    initialBucket.status,
    confirmedServices.services,
  );
  if (confirmedMissing.some((service) => !initiallyMissing.includes(service))) {
    throw new Error(
      'The missing bootstrap API set expanded during confirmation; rerun for a fresh preview.',
    );
  }
  if (confirmedMissing.length === 0) {
    return;
  }

  operations.enableServices(confirmedMissing);
  const repairedServices = operations.inspectServices();
  assertServiceInspectionMatchesBucket(initialBucket, repairedServices);
  if (
    missingRecoverableBootstrapApis(
      initialBucket.status,
      repairedServices.services,
    ).length > 0
  ) {
    throw new Error(
      'Google did not enable the exact bootstrap inspection APIs; no Terraform backend was initialized.',
    );
  }
}

function inspectProject(): Readonly<Record<string, unknown>> | null {
  const result = runCommandForStatus(
    'gcloud',
    [
      'projects',
      'describe',
      PROJECT_ID,
      '--project',
      PROJECT_ID,
      '--format=json',
      '--quiet',
    ],
    { cwd: gcpRoot },
  );
  return parseProjectDescribeResult(
    result.status,
    result.stdout,
    result.stderr,
  );
}

function inspectRosterReaderServiceAccount(): Readonly<
  Record<string, unknown>
> | null {
  const result = runCommandForStatus(
    'gcloud',
    [
      'iam',
      'service-accounts',
      'list',
      '--project',
      PROJECT_ID,
      '--format=json',
      '--quiet',
    ],
    { cwd: gcpRoot },
  );
  const listed = parseServiceAccountListResult(
    result.status,
    result.stdout,
    result.stderr,
  );
  if (listed === null) {
    return null;
  }
  const described = parseJsonObject(
    runCommand(
      'gcloud',
      [
        'iam',
        'service-accounts',
        'describe',
        ROSTER_READER_EMAIL,
        '--project',
        PROJECT_ID,
        '--format=json',
        '--quiet',
      ],
      { redactFailureOutput: true },
    ),
    'Roster-reader service-account metadata',
  );
  if (
    described.uniqueId !== listed.uniqueId ||
    described.oauth2ClientId !== listed.oauth2ClientId
  ) {
    throw new Error(
      'Roster-reader service-account identity changed between list and describe.',
    );
  }
  return described;
}

function validateLiveRecoverableRosterReader(
  serviceAccount: Readonly<Record<string, unknown>>,
): void {
  const resourcePolicy = parseJsonObject(
    runCommand(
      'gcloud',
      [
        'iam',
        'service-accounts',
        'get-iam-policy',
        ROSTER_READER_EMAIL,
        '--project',
        PROJECT_ID,
        '--format=json',
        '--quiet',
      ],
      { redactFailureOutput: true },
    ),
    'Roster-reader service-account IAM policy',
  );
  const userManagedKeyOutput = runCommand(
    'gcloud',
    [
      'iam',
      'service-accounts',
      'keys',
      'list',
      '--iam-account',
      ROSTER_READER_EMAIL,
      '--project',
      PROJECT_ID,
      '--managed-by',
      'user',
      '--format=value(name)',
    ],
    { redactFailureOutput: true },
  );
  validateRecoverableRosterReaderServiceAccount(
    serviceAccount,
    resourcePolicy,
    userManagedKeyOutput,
  );
}

function validateExistingProject(
  project: Readonly<Record<string, unknown>>,
): void {
  const billing = parseJsonObject(
    runCommand('gcloud', [
      'billing',
      'projects',
      'describe',
      PROJECT_ID,
      '--project',
      PROJECT_ID,
      '--format=json',
      '--quiet',
    ]),
    'Project billing metadata',
  );
  validateBootstrapProject(project, billing);
}

function projectIamPolicy(): Readonly<Record<string, unknown>> {
  return parseJsonObject(
    runCommand(
      'gcloud',
      [
        'projects',
        'get-iam-policy',
        PROJECT_ID,
        '--project',
        PROJECT_ID,
        '--format=json',
        '--quiet',
      ],
      { redactFailureOutput: true },
    ),
    'Project IAM policy',
  );
}

function inspectStateBucketForApiRepair(
  allowBootstrapPolicy: boolean,
): StateBucketInspection | null {
  const result = runCommandForStatus(
    'gcloud',
    [
      'storage',
      'buckets',
      'describe',
      `gs://${STATE_BUCKET}`,
      '--project',
      PROJECT_ID,
      '--format=json',
    ],
    { cwd: gcpRoot },
  );
  const bucket = parseBucketDescribeResult(
    result.status,
    result.stdout,
    result.stderr,
  );
  if (bucket === null) {
    return null;
  }
  const projectNumber = stateBucketProjectNumber(bucket);
  const projectBucketNames = runCommand(
    'gcloud',
    [
      'storage',
      'buckets',
      'list',
      '--project',
      PROJECT_ID,
      '--filter',
      `name=${STATE_BUCKET}`,
      '--format=value(name)',
    ],
    { redactFailureOutput: true },
  )
    .split('\n')
    .filter((name) => name.length > 0);
  if (
    projectBucketNames.length !== 1 ||
    projectBucketNames[0] !== STATE_BUCKET
  ) {
    throw new Error(
      'The globally named state bucket is not owned by the expected PSD EOC project.',
    );
  }
  const policy = parseJsonObject(
    runCommand(
      'gcloud',
      [
        'storage',
        'buckets',
        'get-iam-policy',
        `gs://${STATE_BUCKET}`,
        '--project',
        PROJECT_ID,
        '--format=json',
        '--quiet',
      ],
      { redactFailureOutput: true },
    ),
    'State bucket IAM policy',
  );
  return {
    projectNumber,
    status: validateStateBucket(bucket, policy, allowBootstrapPolicy),
  };
}

function stateBucketStatus(allowBootstrapPolicy: boolean): StateBucketStatus {
  const bucket = inspectStateBucketForApiRepair(allowBootstrapPolicy);
  if (bucket === null) {
    return 'absent';
  }
  const project = inspectProject();
  if (project === null) {
    throw new Error(
      'The state bucket exists but the expected PSD EOC project cannot be inspected.',
    );
  }
  validateExistingProject(project);
  if (project.projectNumber !== bucket.projectNumber) {
    throw new Error(
      'The expected PSD EOC project and state bucket identify different Google projects.',
    );
  }
  validateProjectIamPolicy(
    projectIamPolicy(),
    bucket.projectNumber,
    'recovery',
  );
  return bucket.status;
}

export function parseStateListResult(
  status: number | null,
  stdout: string,
  stderr: string,
): Set<string> {
  if (status === 0) {
    return new Set(
      stdout.split('\n').filter((resource) => resource.length > 0),
    );
  }
  const detail = stderr || stdout;
  if (detail.includes('No state file was found')) {
    return new Set();
  }
  throw new Error(
    `terraform state list exited with status ${status}: ${detail.trim().slice(0, 2_000)}`,
  );
}

function runTerraformInteractive(args: readonly string[], cwd = gcpRoot): void {
  assertDefaultTerraformWorkspace(cwd);
  runInteractive('terraform', args, cwd);
}

function stateResources(cwd = gcpRoot): Set<string> {
  assertDefaultTerraformWorkspace(cwd);
  const result = runCommandForStatus('terraform', ['state', 'list'], { cwd });
  return parseStateListResult(result.status, result.stdout, result.stderr);
}

function enabledProjectServiceInspection(): EnabledProjectServicesInspection {
  return parseEnabledProjectServices(
    runCommand(
      'gcloud',
      [
        'services',
        'list',
        '--enabled',
        '--project',
        PROJECT_ID,
        '--format=json(name,config.name,state)',
        '--quiet',
      ],
      { redactFailureOutput: true },
    ),
  );
}

function enabledProjectServices(): Set<string> {
  return new Set(enabledProjectServiceInspection().services);
}

function recoverOrphanedRosterReader(resources: Set<string>): void {
  if (
    resources.has(ROSTER_READER_ADDRESS) ||
    !enabledProjectServices().has('iam.googleapis.com')
  ) {
    return;
  }
  const serviceAccount = inspectRosterReaderServiceAccount();
  if (serviceAccount === null) {
    return;
  }
  validateLiveRecoverableRosterReader(serviceAccount);
  const expectedUniqueId = serviceAccount.uniqueId;
  const expectedOauth2ClientId = serviceAccount.oauth2ClientId;
  runTerraformInteractive([
    'import',
    '-input=false',
    ROSTER_READER_ADDRESS,
    ROSTER_READER_RESOURCE,
  ]);
  resources.add(ROSTER_READER_ADDRESS);

  const importedServiceAccount = inspectRosterReaderServiceAccount();
  if (importedServiceAccount === null) {
    throw new Error(
      'The roster-reader service account disappeared immediately after import.',
    );
  }
  validateLiveRecoverableRosterReader(importedServiceAccount);
  if (
    importedServiceAccount.uniqueId !== expectedUniqueId ||
    importedServiceAccount.oauth2ClientId !== expectedOauth2ClientId
  ) {
    throw new Error(
      'Roster-reader service-account identity changed during import.',
    );
  }
}

export function bootstrapPrerequisitesReady(
  bucketStatus: StateBucketStatus,
  enabledServices: ReadonlySet<string>,
): boolean {
  return (
    bucketStatus === 'managed-policy' &&
    [...BOOTSTRAP_SERVICES].every((service) => enabledServices.has(service))
  );
}

function recoverBootstrapState(bucketStatus: StateBucketStatus): void {
  const resources = stateResources(bootstrapRoot);
  const project = inspectProject();
  if (project === null) {
    if (resources.has('google_project.psd_eoc')) {
      throw new Error(
        'Bootstrap state contains the project but Google cannot verify it; refusing to plan a replacement.',
      );
    }
    return;
  }

  validateExistingProject(project);
  validateProjectIamPolicy(
    projectIamPolicy(),
    project.projectNumber as string,
    'recovery',
  );
  if (!resources.has('google_project.psd_eoc')) {
    runTerraformInteractive(
      ['import', '-input=false', 'google_project.psd_eoc', PROJECT_ID],
      bootstrapRoot,
    );
    resources.add('google_project.psd_eoc');
  }

  const services = enabledProjectServices();
  for (const [address, service] of bootstrapServiceImports) {
    if (services.has(service) && !resources.has(address)) {
      runTerraformInteractive(
        ['import', '-input=false', address, `${PROJECT_ID}/${service}`],
        bootstrapRoot,
      );
      resources.add(address);
    }
  }

  if (bucketStatus !== 'absent') {
    for (const [address, importId] of bootstrapBucketImports) {
      if (!resources.has(address)) {
        runTerraformInteractive(
          ['import', '-input=false', address, importId],
          bootstrapRoot,
        );
        resources.add(address);
      }
    }
  }
}

async function applySavedPlan(options: {
  readonly confirmation: string;
  readonly cwd: string;
  readonly planPath: string;
  readonly preview: string;
}): Promise<void> {
  runTerraformInteractive(
    ['plan', '-input=false', `-out=${options.planPath}`],
    options.cwd,
  );
  try {
    await requireExactConfirmation(options.preview, options.confirmation);
    runTerraformInteractive(
      ['apply', '-input=false', options.planPath],
      options.cwd,
    );
  } finally {
    rmSync(options.planPath, { force: true });
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 0) {
    throw new Error('This helper accepts no command-line options.');
  }

  assertActiveGcloudAccount(TERRAFORM_ADMIN);
  await assertApplicationDefaultIdentity(TERRAFORM_ADMIN);

  await repairMissingBootstrapApis({
    assertOperatorIdentity: async () => {
      assertActiveGcloudAccount(TERRAFORM_ADMIN);
      await assertApplicationDefaultIdentity(TERRAFORM_ADMIN);
    },
    confirm: requireExactConfirmation,
    enableServices: (services) => {
      runCommand(
        'gcloud',
        ['services', 'enable', ...services, '--project', PROJECT_ID, '--quiet'],
        { redactFailureOutput: true },
      );
    },
    inspectBucket: () => inspectStateBucketForApiRepair(true),
    inspectServices: enabledProjectServiceInspection,
  });

  const initialBucketStatus = stateBucketStatus(true);
  const initialServices =
    initialBucketStatus === 'managed-policy'
      ? enabledProjectServices()
      : new Set<string>();
  if (!bootstrapPrerequisitesReady(initialBucketStatus, initialServices)) {
    runInteractive('terraform', ['init', '-input=false'], bootstrapRoot);
    assertDefaultTerraformWorkspace(bootstrapRoot);
    recoverBootstrapState(initialBucketStatus);
    await applySavedPlan({
      confirmation: 'create-psd401-eoc-bootstrap',
      cwd: bootstrapRoot,
      planPath: bootstrapPlan,
      preview:
        'Bootstrap consequence preview: create or adopt the billed psd401-eoc project directly under the district organization, enable Service Usage, Storage, Cloud Resource Manager, and Cloud Billing before quota is charged to the new project, and create a private versioned state bucket whose authoritative policy grants only the fixed human Terraform administrator Object Admin. No Groups data, OAuth credential, or notification path is touched.',
    });
    const repairedBucketStatus = stateBucketStatus(false);
    if (
      !bootstrapPrerequisitesReady(
        repairedBucketStatus,
        enabledProjectServices(),
      )
    ) {
      throw new Error(
        'Bootstrap apply did not produce the exact private, single-administrator Terraform state bucket with every main-provider API prerequisite enabled.',
      );
    }
  }

  runInteractive('terraform', ['init', '-reconfigure', '-input=false']);
  assertDefaultTerraformWorkspace();

  const managedResources = stateResources();
  for (const [address, importId] of mainImports) {
    if (!managedResources.has(address)) {
      runTerraformInteractive(['import', '-input=false', address, importId]);
      managedResources.add(address);
    }
  }
  recoverOrphanedRosterReader(managedResources);

  await applySavedPlan({
    confirmation: 'apply-psd401-eoc-gcp',
    cwd: gcpRoot,
    planPath: mainPlan,
    preview:
      "Apply consequence preview: enable only the declared identity/IAM APIs, retain the single-administrator state-bucket policy, replace the project creator's automatic Owner grant with the named narrower Terraform administrator roles, and create one protected service account with no project IAM roles. This does not authorize Workspace access, create OAuth clients, read Groups, or send notifications.",
  });
  const finalProject = inspectProject();
  if (finalProject === null) {
    throw new Error('Main apply did not leave the expected project readable.');
  }
  validateExistingProject(finalProject);
  validateProjectIamPolicy(
    projectIamPolicy(),
    finalProject.projectNumber as string,
    'steady-state',
  );
  if (stateBucketStatus(false) !== 'managed-policy') {
    throw new Error(
      'Main apply did not preserve the exact private, single-administrator Terraform state bucket.',
    );
  }
  runTerraformInteractive(['plan', '-detailed-exitcode', '-input=false']);

  const finalResources = stateResources();
  if (
    existsSync(join(bootstrapRoot, 'terraform.tfstate')) &&
    mainImports.every(([address]) => finalResources.has(address))
  ) {
    const bootstrapState = stateResources(bootstrapRoot);
    const duplicateResources = bootstrapResources.filter((address) =>
      bootstrapState.has(address),
    );
    if (duplicateResources.length > 0) {
      runTerraformInteractive(
        ['state', 'rm', ...duplicateResources],
        bootstrapRoot,
      );
    }
  }
}

if (import.meta.main) {
  await main();
}
