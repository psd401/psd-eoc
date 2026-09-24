import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
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
  TERRAFORM_ADMIN_ROLES,
  validateProjectIamPolicy,
  validateRosterReaderResourcePolicy,
} from './project-policy';
import { tenantGcpBillingAccount } from '../../src/tenant-context';

const PROJECT_ID = 'psd401-eoc';
const PROJECT_NAME = 'PSD EOC';
const ORGANIZATION_ID = '482073499306';
/** From infra/cdk.local.json; refuses to run without it. */
const BILLING_ACCOUNT = tenantGcpBillingAccount();
const STATE_BUCKET = 'psd401-eoc-terraform-state';
const ROSTER_READER_ADDRESS = 'google_service_account.roster_reader';
const ROSTER_READER_RESOURCE = `projects/${PROJECT_ID}/serviceAccounts/${ROSTER_READER_EMAIL}`;
const ROSTER_READER_DISPLAY_NAME = 'PSD EOC roster sync reader';
const ROSTER_READER_DESCRIPTION =
  'Reads configured staff Google Groups for roster snapshots; never writes Groups or sends notifications.';
const bootstrapRoot = join(gcpRoot, 'bootstrap');
const savedPlanRoot = realpathSync('/tmp');
const POLICY_DATA_SOURCE_ADDRESS = 'data.google_iam_policy.terraform_state';

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

const mainBoundaryServices = new Set([
  ...BOOTSTRAP_SERVICES,
  'admin.googleapis.com',
  'cloudidentity.googleapis.com',
  'iam.googleapis.com',
]);

const bootstrapBucketImports = [
  ['google_storage_bucket.terraform_state', STATE_BUCKET],
  ['google_storage_bucket_iam_policy.terraform_state', `b/${STATE_BUCKET}`],
] as const;

const interruptedBootstrapRequiredResources = new Set([
  'google_project.psd_eoc',
  'google_project_service.service_usage',
  'google_project_service.storage',
]);

const interruptedBootstrapAllowedResources = new Set([
  ...interruptedBootstrapRequiredResources,
  'google_project_service.cloud_resource_manager',
  'google_project_service.cloud_billing',
  POLICY_DATA_SOURCE_ADDRESS,
]);

const bootstrapStateAllowedResources = new Set([
  ...bootstrapResources,
  POLICY_DATA_SOURCE_ADDRESS,
]);

const mainStateAllowedResources = new Set([
  'google_project.psd_eoc',
  'google_project_service.service_usage',
  ...[...mainBoundaryServices]
    .filter((service) => service !== 'serviceusage.googleapis.com')
    .map((service) => `google_project_service.required["${service}"]`),
  ...TERRAFORM_ADMIN_ROLES.map(
    (role) => `google_project_iam_member.terraform_admin["${role}"]`,
  ),
  'google_project_iam_member_remove.terraform_admin_owner',
  'google_project_iam_member_remove.google_apis_service_agent_editor',
  'google_storage_bucket.terraform_state',
  POLICY_DATA_SOURCE_ADDRESS,
  'google_storage_bucket_iam_policy.terraform_state',
  ROSTER_READER_ADDRESS,
]);

export type StateBucketStatus =
  'absent' | 'bootstrap-policy' | 'managed-policy';

export interface StateBucketInspection {
  readonly projectNumber: string;
  readonly revision?: string;
  readonly status: Exclude<StateBucketStatus, 'absent'>;
}

export interface StateBucketOwnerInspection {
  readonly name: string;
  readonly projectNumber: string;
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

export interface InterruptedBootstrapStateInspection {
  readonly fingerprint: string;
  readonly lineage: string;
  readonly projectNumber: string;
  readonly resources: ReadonlySet<string>;
  readonly serial: number;
}

export interface InterruptedBootstrapApiRepairOperations extends BootstrapApiRepairOperations {
  readonly inspectState: () => InterruptedBootstrapStateInspection | null;
  readonly validateProject: (expectedProjectNumber: string) => void;
}

export interface ConfirmedPlanOperations {
  readonly apply: () => void;
  readonly captureBoundary: () => string;
  readonly cleanup: () => void;
  readonly confirm: () => Promise<void>;
  readonly plan: () => void;
  readonly readPlanSeal: () => string;
  readonly revalidate: () => Promise<void>;
}

export interface ApplyBoundaryOperations {
  readonly inspectBucket: () => StateBucketInspection | null;
  readonly inspectProject: () => Readonly<Record<string, unknown>> | null;
  readonly validateExistingProject: (
    project: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
  readonly inspectProjectIamPolicy: () => Readonly<Record<string, unknown>>;
  readonly inspectServices: () => EnabledProjectServicesInspection;
  readonly inspectRosterReader: () => Readonly<Record<string, unknown>> | null;
  readonly validateRosterReader: (
    serviceAccount: Readonly<Record<string, unknown>>,
  ) => string;
}

export interface OrphanedRosterReaderRecoveryOperations {
  readonly inspectEnabledServices: () => ReadonlySet<string>;
  readonly inspectRosterReader: () => Readonly<Record<string, unknown>> | null;
  readonly validateRosterReader: (
    serviceAccount: Readonly<Record<string, unknown>>,
  ) => string;
  readonly importResource: (address: string, importId: string) => void;
}

export interface BootstrapStateRecoveryOperations {
  readonly inspectBucketStatus: () => StateBucketStatus;
  readonly inspectInterruptedState: () => InterruptedBootstrapStateInspection | null;
  readonly inspectStateResources: () => ReadonlySet<string>;
  readonly inspectProject: () => Readonly<Record<string, unknown>> | null;
  readonly validateExistingProject: (
    project: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
  readonly inspectProjectIamPolicy: () => Readonly<Record<string, unknown>>;
  readonly inspectEnabledServices: () => ReadonlySet<string>;
  readonly importResource: (address: string, importId: string) => void;
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

function canonicalJson(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).sort().join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface ApplyBoundaryEvidence {
  readonly billing: unknown;
  readonly bucket: unknown;
  readonly policy: unknown;
  readonly project: unknown;
  readonly rosterReader: unknown;
  readonly serviceProjectNumber: string | null;
  readonly serviceStates: readonly Readonly<{
    enabled: boolean;
    service: string;
  }>[];
}

export function buildApplyBoundary(evidence: ApplyBoundaryEvidence): string {
  return canonicalJson(evidence);
}

export interface SavedPlanWorkspace {
  readonly cleanup: () => void;
  readonly planPath: string;
}

export function createSavedPlanWorkspace(): SavedPlanWorkspace {
  const directory = mkdtempSync(join(savedPlanRoot, 'psd-eoc-terraform-plan-'));
  const planPath = join(directory, 'saved.tfplan');
  try {
    chmodSync(directory, 0o700);
    const directoryMetadata = lstatSync(directory);
    if (
      !directoryMetadata.isDirectory() ||
      (directoryMetadata.mode & 0o777) !== 0o700 ||
      realpathSync(directory) !== directory
    ) {
      throw new Error(
        'Saved Terraform plan workspace must be one private canonical directory.',
      );
    }

    const descriptor = openSync(
      planPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const metadata = fstatSync(descriptor);
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.size !== 0 ||
        (metadata.mode & 0o777) !== 0o600
      ) {
        throw new Error(
          'Saved Terraform plan placeholder must be one empty private unlinked file.',
        );
      }
    } finally {
      closeSync(descriptor);
    }

    return {
      cleanup: () => {
        rmSync(planPath, { force: true });
        rmdirSync(directory);
      },
      planPath,
    };
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

export function readSavedPlanSeal(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      before.size <= 0 ||
      before.size > 16 * 1024 * 1024
    ) {
      throw new Error(
        'Saved Terraform plan must be one private bounded regular file with no hard or symbolic links.',
      );
    }
    const content = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      content.byteLength !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.nlink !== before.nlink ||
      after.size !== before.size ||
      after.ctimeMs !== before.ctimeMs ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error(
        'Saved Terraform plan changed while it was being sealed.',
      );
    }
    return canonicalJson({
      ctimeMs: before.ctimeMs,
      device: before.dev,
      digest: createHash('sha256').update(content).digest('hex'),
      inode: before.ino,
      mode: before.mode,
      mtimeMs: before.mtimeMs,
      size: before.size,
    });
  } finally {
    closeSync(descriptor);
  }
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

function exactExpectedLabels(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const labels = value as Readonly<Record<string, unknown>>;
  return (
    Object.keys(labels).length === Object.keys(expectedLabels).length &&
    Object.entries(expectedLabels).every(
      ([name, expected]) => labels[name] === expected,
    )
  );
}

function interruptedStateResource(value: unknown): Readonly<{
  address: string;
  attributes: Readonly<Record<string, unknown>>;
}> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      'Interrupted bootstrap state contains a malformed resource.',
    );
  }
  const resource = value as Readonly<Record<string, unknown>>;
  const mode = resource.mode;
  const type = resource.type;
  const name = resource.name;
  if (
    (mode !== 'managed' && mode !== 'data') ||
    typeof type !== 'string' ||
    typeof name !== 'string' ||
    resource.module !== undefined ||
    resource.provider !==
      'provider["registry.terraform.io/hashicorp/google"]' ||
    !Array.isArray(resource.instances) ||
    resource.instances.length !== 1
  ) {
    throw new Error(
      'Interrupted bootstrap state does not contain one exact root Google resource instance.',
    );
  }
  const instance = resource.instances[0];
  if (
    typeof instance !== 'object' ||
    instance === null ||
    Array.isArray(instance)
  ) {
    throw new Error(
      'Interrupted bootstrap state contains a malformed instance.',
    );
  }
  const instanceRecord = instance as Readonly<Record<string, unknown>>;
  const sensitive = instanceRecord.sensitive_attributes;
  if (
    instanceRecord.deposed !== undefined ||
    instanceRecord.index_key !== undefined ||
    instanceRecord.status !== undefined ||
    (sensitive !== undefined &&
      (!Array.isArray(sensitive) || sensitive.length !== 0)) ||
    !Number.isSafeInteger(instanceRecord.schema_version) ||
    (instanceRecord.schema_version as number) < 0 ||
    typeof instanceRecord.attributes !== 'object' ||
    instanceRecord.attributes === null ||
    Array.isArray(instanceRecord.attributes)
  ) {
    throw new Error(
      'Interrupted bootstrap state contains a deposed, indexed, tainted, sensitive, or malformed instance.',
    );
  }
  return {
    address: `${mode === 'data' ? 'data.' : ''}${type}.${name}`,
    attributes: instanceRecord.attributes as Readonly<Record<string, unknown>>,
  };
}

function validateInterruptedProjectState(
  attributes: Readonly<Record<string, unknown>>,
): string {
  const projectNumber = attributes.number;
  if (
    attributes.id !== `projects/${PROJECT_ID}` ||
    attributes.project_id !== PROJECT_ID ||
    attributes.name !== PROJECT_NAME ||
    attributes.org_id !== ORGANIZATION_ID ||
    attributes.billing_account !== BILLING_ACCOUNT ||
    attributes.auto_create_network !== false ||
    attributes.deletion_policy !== 'PREVENT' ||
    typeof projectNumber !== 'string' ||
    !/^[1-9]\d*$/u.test(projectNumber) ||
    !exactExpectedLabels(attributes.labels)
  ) {
    throw new Error(
      'Interrupted bootstrap state does not contain the exact fixed project contract.',
    );
  }
  return projectNumber;
}

function validateInterruptedServiceState(
  attributes: Readonly<Record<string, unknown>>,
  service: string,
): void {
  if (
    attributes.id !== `${PROJECT_ID}/${service}` ||
    attributes.project !== PROJECT_ID ||
    attributes.service !== service ||
    attributes.disable_on_destroy !== false ||
    attributes.disable_dependent_services !== false ||
    attributes.deletion_policy !== 'PREVENT'
  ) {
    throw new Error(
      `Interrupted bootstrap state does not contain the exact ${service} contract.`,
    );
  }
}

function validateInterruptedPolicyData(
  attributes: Readonly<Record<string, unknown>>,
): void {
  if (typeof attributes.policy_data !== 'string') {
    throw new Error(
      'Interrupted bootstrap state contains malformed bucket-policy data.',
    );
  }
  const policy = parseJsonObject(
    attributes.policy_data,
    'Interrupted bootstrap bucket-policy data',
  );
  const bindings = policy.bindings;
  const binding =
    Array.isArray(bindings) && bindings.length === 1 ? bindings[0] : undefined;
  if (
    typeof binding !== 'object' ||
    binding === null ||
    Array.isArray(binding) ||
    (binding as Readonly<Record<string, unknown>>).role !==
      'roles/storage.objectAdmin' ||
    !Array.isArray((binding as Readonly<Record<string, unknown>>).members) ||
    ((binding as Readonly<Record<string, unknown>>).members as unknown[])
      .length !== 1 ||
    ((binding as Readonly<Record<string, unknown>>).members as unknown[])[0] !==
      `user:${TERRAFORM_ADMIN}` ||
    (binding as Readonly<Record<string, unknown>>).condition !== undefined ||
    (policy.auditConfigs !== undefined &&
      (!Array.isArray(policy.auditConfigs) || policy.auditConfigs.length !== 0))
  ) {
    throw new Error(
      'Interrupted bootstrap state contains unexpected bucket-policy data.',
    );
  }
}

export function parseInterruptedBootstrapStateResult(
  status: number | null,
  stdout: string,
  stderr: string,
): InterruptedBootstrapStateInspection | null {
  if (status !== 0) {
    const detail = stderr || stdout;
    if (detail.includes('No state file was found')) {
      return null;
    }
    throw new Error(
      `Interrupted bootstrap state inspection exited with status ${status}: ${detail.trim().slice(0, 2_000)}`,
    );
  }
  const raw = stdout.trim();
  if (raw.length === 0) {
    return null;
  }
  const state = parseJsonObject(raw, 'Interrupted bootstrap state');
  const resources = state.resources;
  if (
    state.version !== 4 ||
    !Number.isSafeInteger(state.serial) ||
    (state.serial as number) < 0 ||
    typeof state.lineage !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      state.lineage,
    ) ||
    typeof state.outputs !== 'object' ||
    state.outputs === null ||
    Array.isArray(state.outputs) ||
    Object.keys(state.outputs as Readonly<Record<string, unknown>>).length !==
      0 ||
    !Array.isArray(resources)
  ) {
    throw new Error(
      'Interrupted bootstrap state does not have the expected bounded state envelope.',
    );
  }
  if (resources.length === 0) {
    return null;
  }

  const attributesByAddress = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  for (const value of resources) {
    const resource = interruptedStateResource(value);
    if (
      !interruptedBootstrapAllowedResources.has(resource.address) ||
      attributesByAddress.has(resource.address)
    ) {
      throw new Error(
        'Interrupted bootstrap state contains an unexpected or duplicate resource.',
      );
    }
    attributesByAddress.set(resource.address, resource.attributes);
  }
  for (const address of interruptedBootstrapRequiredResources) {
    if (!attributesByAddress.has(address)) {
      throw new Error(
        'Interrupted bootstrap state is missing the project, Service Usage, or Storage trust resource.',
      );
    }
  }

  const projectNumber = validateInterruptedProjectState(
    attributesByAddress.get('google_project.psd_eoc') as Readonly<
      Record<string, unknown>
    >,
  );
  for (const [address, service] of bootstrapServiceImports) {
    const attributes = attributesByAddress.get(address);
    if (attributes !== undefined) {
      validateInterruptedServiceState(attributes, service);
    }
  }
  const policyData = attributesByAddress.get(POLICY_DATA_SOURCE_ADDRESS);
  if (policyData !== undefined) {
    validateInterruptedPolicyData(policyData);
  }

  return {
    fingerprint: createHash('sha256').update(raw).digest('hex'),
    lineage: state.lineage,
    projectNumber,
    resources: new Set(attributesByAddress.keys()),
    serial: state.serial as number,
  };
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

export function validateManagedRosterReaderServiceAccount(
  value: unknown,
  resourcePolicy: unknown,
  userManagedKeyOutput: string,
): ReadonlySet<string> {
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
  const userManagedKeyIds = parseUserManagedKeyIds(userManagedKeyOutput);
  if (userManagedKeyIds.size > 1) {
    throw new Error(
      'Managed roster-reader service account has more than one user-managed key.',
    );
  }
  return userManagedKeyIds;
}

export interface ManagedRosterReaderBoundary {
  readonly seal: string;
  readonly userManagedKeyIds: ReadonlySet<string>;
}

export function validateManagedRosterReaderBoundary(
  value: unknown,
  resourcePolicy: unknown,
  userManagedKeyOutput: string,
): ManagedRosterReaderBoundary {
  const userManagedKeyIds = validateManagedRosterReaderServiceAccount(
    value,
    resourcePolicy,
    userManagedKeyOutput,
  );
  return {
    seal: canonicalJson({
      resourcePolicy,
      serviceAccount: value,
      userManagedKeyIds: [...userManagedKeyIds].sort(),
    }),
    userManagedKeyIds,
  };
}

export function validateRecoverableRosterReaderServiceAccount(
  value: unknown,
  resourcePolicy: unknown,
  userManagedKeyOutput: string,
): void {
  if (
    validateManagedRosterReaderServiceAccount(
      value,
      resourcePolicy,
      userManagedKeyOutput,
    ).size !== 0
  ) {
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
    (bucket.default_event_based_hold !== undefined &&
      bucket.default_event_based_hold !== false) ||
    (bucket.default_kms_key !== undefined && bucket.default_kms_key !== null) ||
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

export function parseStateBucketOwner(
  output: string,
): StateBucketOwnerInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(
      'Expected-project state bucket listing did not contain valid JSON.',
    );
  }
  const owner = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  if (
    typeof owner !== 'object' ||
    owner === null ||
    Array.isArray(owner) ||
    Object.keys(owner).sort().join(',') !== 'name,projectNumber'
  ) {
    throw new Error(
      'The globally named state bucket is not owned by the expected PSD EOC project.',
    );
  }
  const record = owner as Readonly<Record<string, unknown>>;
  const value = record.projectNumber;
  let projectNumber: string;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    projectNumber = String(value);
  } else if (typeof value === 'string' && /^[1-9]\d*$/u.test(value)) {
    projectNumber = value;
  } else {
    throw new Error(
      'Existing state bucket does not identify one valid owning Google project.',
    );
  }
  if (record.name !== STATE_BUCKET) {
    throw new Error(
      'The globally named state bucket is not owned by the expected PSD EOC project.',
    );
  }
  return { name: STATE_BUCKET, projectNumber };
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
    left.revision === right.revision &&
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

function sameInterruptedBootstrapState(
  left: InterruptedBootstrapStateInspection,
  right: InterruptedBootstrapStateInspection | null,
): boolean {
  return (
    right !== null &&
    left.fingerprint === right.fingerprint &&
    left.lineage === right.lineage &&
    left.projectNumber === right.projectNumber &&
    left.serial === right.serial
  );
}

function sameStringSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function managedBootstrapResourceSet(
  resources: ReadonlySet<string>,
): ReadonlySet<string> {
  const managedResources = new Set(resources);
  managedResources.delete(POLICY_DATA_SOURCE_ADDRESS);
  return managedResources;
}

export function validateRecoveredInterruptedBootstrapState(
  initial: InterruptedBootstrapStateInspection | null,
  final: InterruptedBootstrapStateInspection | null,
  expectedResources: ReadonlySet<string>,
): void {
  const finalResources = final?.resources ?? new Set<string>();
  if (
    !sameStringSet(
      managedBootstrapResourceSet(expectedResources),
      managedBootstrapResourceSet(finalResources),
    ) ||
    (initial !== null &&
      (final === null ||
        final.lineage !== initial.lineage ||
        final.projectNumber !== initial.projectNumber ||
        final.serial < initial.serial))
  ) {
    throw new Error(
      'Local bootstrap state changed after recovery; rerun before creating a saved plan.',
    );
  }
}

export async function repairInterruptedBootstrapApis(
  operations: InterruptedBootstrapApiRepairOperations,
): Promise<void> {
  const initialState = operations.inspectState();
  if (initialState === null) {
    return;
  }
  if (operations.inspectBucket() !== null) {
    throw new Error(
      'The state bucket appeared before interrupted-bootstrap recovery; rerun for a bucket-backed preview.',
    );
  }
  const initialServices = operations.inspectServices();
  if (initialServices.projectNumber !== initialState.projectNumber) {
    throw new Error(
      'Interrupted bootstrap state and enabled services identify different Google projects.',
    );
  }
  const initiallyMissing = missingRecoverableBootstrapApis(
    'bootstrap-policy',
    initialServices.services,
  );
  if (initiallyMissing.length === 0) {
    return;
  }

  await operations.confirm(
    `Interrupted-bootstrap API repair consequence preview: the fixed ${PROJECT_ID} project (numeric ID ${initialState.projectNumber}) is anchored by exact local Terraform state and live Service Usage, but ${STATE_BUCKET} does not exist yet. Persistently enable only ${initiallyMissing.join(', ')} so the helper can validate the district organization, billing association, and complete project IAM policy before any import or saved plan. API enablement can permit billable API use. If later validation fails, the helper stops and leaves these inspection APIs enabled for explicit reconciliation.`,
    'repair-psd401-eoc-interrupted-bootstrap-apis',
  );

  await operations.assertOperatorIdentity();
  if (operations.inspectBucket() !== null) {
    throw new Error(
      'The state bucket appeared during interrupted-bootstrap confirmation; rerun for a bucket-backed preview.',
    );
  }
  if (!sameInterruptedBootstrapState(initialState, operations.inspectState())) {
    throw new Error(
      'Local bootstrap state changed during interrupted-bootstrap confirmation; rerun for a fresh preview.',
    );
  }
  const confirmedServices = operations.inspectServices();
  if (confirmedServices.projectNumber !== initialState.projectNumber) {
    throw new Error(
      'Interrupted bootstrap state and enabled services identify different Google projects.',
    );
  }
  const confirmedMissing = missingRecoverableBootstrapApis(
    'bootstrap-policy',
    confirmedServices.services,
  );
  if (confirmedMissing.some((service) => !initiallyMissing.includes(service))) {
    throw new Error(
      'The missing interrupted-bootstrap API set expanded during confirmation; rerun for a fresh preview.',
    );
  }

  if (confirmedMissing.length > 0) {
    operations.enableServices(confirmedMissing);
    const repairedServices = operations.inspectServices();
    if (repairedServices.projectNumber !== initialState.projectNumber) {
      throw new Error(
        'Interrupted bootstrap state and repaired services identify different Google projects.',
      );
    }
    if (
      missingRecoverableBootstrapApis(
        'bootstrap-policy',
        repairedServices.services,
      ).length > 0
    ) {
      throw new Error(
        'Google did not enable the exact interrupted-bootstrap inspection APIs; no import or saved plan was started.',
      );
    }
  }

  if (!sameInterruptedBootstrapState(initialState, operations.inspectState())) {
    throw new Error(
      'Local bootstrap state changed during interrupted-bootstrap API repair; no import or saved plan was started.',
    );
  }
  operations.validateProject(initialState.projectNumber);
  if (operations.inspectBucket() !== null) {
    throw new Error(
      'The state bucket appeared during interrupted-bootstrap API repair; rerun before any import or saved plan.',
    );
  }
  if (!sameInterruptedBootstrapState(initialState, operations.inspectState())) {
    throw new Error(
      'Local bootstrap state changed during live project validation; no import or saved plan was started.',
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

function inspectLiveRosterReaderBoundary(
  serviceAccount: Readonly<Record<string, unknown>>,
): ManagedRosterReaderBoundary {
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
  return validateManagedRosterReaderBoundary(
    serviceAccount,
    resourcePolicy,
    userManagedKeyOutput,
  );
}

function validateLiveManagedRosterReader(
  serviceAccount: Readonly<Record<string, unknown>>,
): string {
  return inspectLiveRosterReaderBoundary(serviceAccount).seal;
}

function validateLiveRecoverableRosterReader(
  serviceAccount: Readonly<Record<string, unknown>>,
): string {
  const boundary = inspectLiveRosterReaderBoundary(serviceAccount);
  if (boundary.userManagedKeyIds.size !== 0) {
    throw new Error(
      'Existing roster-reader service account has a user-managed key and cannot be adopted.',
    );
  }
  return boundary.seal;
}

function validateExistingProject(
  project: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
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
  return billing;
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
  const bucketOwner = parseStateBucketOwner(
    runCommand(
      'gcloud',
      [
        'storage',
        'buckets',
        'list',
        '--project',
        PROJECT_ID,
        '--filter',
        `name=${STATE_BUCKET}`,
        '--raw',
        '--format=json(name,projectNumber)',
      ],
      { redactFailureOutput: true },
    ),
  );
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
    projectNumber: bucketOwner.projectNumber,
    revision: canonicalJson({ bucket, bucketOwner, policy }),
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
  // Both roots declare billing_account without a default. plan and import
  // evaluate the configuration and need it; apply consumes a saved plan,
  // which refuses -var, and state commands never read variables.
  const [command] = args;
  const withVariables =
    command === 'plan' || command === 'import'
      ? [...args, `-var=billing_account=${BILLING_ACCOUNT}`]
      : args;
  runInteractive('terraform', withVariables, cwd);
}

function stateResources(cwd = gcpRoot): Set<string> {
  assertDefaultTerraformWorkspace(cwd);
  const result = runCommandForStatus('terraform', ['state', 'list'], { cwd });
  return parseStateListResult(result.status, result.stdout, result.stderr);
}

function inspectInterruptedBootstrapState(): InterruptedBootstrapStateInspection | null {
  assertDefaultTerraformWorkspace(bootstrapRoot);
  const result = runCommandForStatus('terraform', ['state', 'pull'], {
    cwd: bootstrapRoot,
  });
  return parseInterruptedBootstrapStateResult(
    result.status,
    result.stdout,
    result.stderr,
  );
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

export function captureApplyBoundary(
  includeRosterReader: boolean,
  operations: ApplyBoundaryOperations,
): string {
  const bucket = operations.inspectBucket();
  const project = operations.inspectProject();
  if (project === null) {
    if (bucket !== null) {
      throw new Error(
        'The state bucket exists but the expected PSD EOC project cannot be inspected.',
      );
    }
    return buildApplyBoundary({
      billing: null,
      bucket: null,
      policy: null,
      project: null,
      rosterReader: 'not-applicable',
      serviceProjectNumber: null,
      serviceStates: [],
    });
  }

  const billing = operations.validateExistingProject(project);
  const projectNumber = project.projectNumber as string;
  if (bucket !== null && bucket.projectNumber !== projectNumber) {
    throw new Error(
      'The expected PSD EOC project and state bucket identify different Google projects.',
    );
  }
  const policy = operations.inspectProjectIamPolicy();
  validateProjectIamPolicy(policy, projectNumber, 'recovery');
  const serviceInspection = operations.inspectServices();
  if (serviceInspection.projectNumber !== projectNumber) {
    throw new Error(
      'The live project and enabled services identify different Google projects.',
    );
  }
  const expectedServices = includeRosterReader
    ? mainBoundaryServices
    : BOOTSTRAP_SERVICES;
  const serviceStates = [...expectedServices].sort().map((service) => ({
    enabled: serviceInspection.services.has(service),
    service,
  }));

  let rosterReader: string | null | 'iam-api-disabled' = 'iam-api-disabled';
  if (
    includeRosterReader &&
    serviceInspection.services.has('iam.googleapis.com')
  ) {
    const serviceAccount = operations.inspectRosterReader();
    rosterReader =
      serviceAccount === null
        ? null
        : operations.validateRosterReader(serviceAccount);
  }

  return buildApplyBoundary({
    billing,
    bucket,
    policy,
    project,
    rosterReader,
    serviceProjectNumber: serviceInspection.projectNumber,
    serviceStates,
  });
}

export function recoverOrphanedRosterReader(
  resources: Set<string>,
  operations: OrphanedRosterReaderRecoveryOperations,
): void {
  if (
    resources.has(ROSTER_READER_ADDRESS) ||
    !operations.inspectEnabledServices().has('iam.googleapis.com')
  ) {
    return;
  }
  const serviceAccount = operations.inspectRosterReader();
  if (serviceAccount === null) {
    return;
  }
  operations.validateRosterReader(serviceAccount);
  const expectedUniqueId = serviceAccount.uniqueId;
  const expectedOauth2ClientId = serviceAccount.oauth2ClientId;
  operations.importResource(ROSTER_READER_ADDRESS, ROSTER_READER_RESOURCE);
  resources.add(ROSTER_READER_ADDRESS);

  const importedServiceAccount = operations.inspectRosterReader();
  if (importedServiceAccount === null) {
    throw new Error(
      'The roster-reader service account disappeared immediately after import.',
    );
  }
  operations.validateRosterReader(importedServiceAccount);
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

function validateRecoveryProject(expectedProjectNumber: string): void {
  const project = inspectProject();
  if (project === null) {
    throw new Error(
      'Interrupted bootstrap state identifies the project but Google cannot verify it after API repair.',
    );
  }
  validateExistingProject(project);
  if (project.projectNumber !== expectedProjectNumber) {
    throw new Error(
      'Interrupted bootstrap state and the live project identify different Google projects.',
    );
  }
  validateProjectIamPolicy(
    projectIamPolicy(),
    expectedProjectNumber,
    'recovery',
  );
}

function validateBootstrapStateAddresses(
  resources: ReadonlySet<string>,
  bucketStatus: StateBucketStatus,
): void {
  for (const address of resources) {
    if (!bootstrapStateAllowedResources.has(address)) {
      throw new Error(
        'Bootstrap state contains an unexpected resource; refusing every import and saved plan.',
      );
    }
  }
  if (
    bucketStatus === 'absent' &&
    bootstrapBucketImports.some(([address]) => resources.has(address))
  ) {
    throw new Error(
      'Bootstrap state records a state bucket that Google reports absent; refusing every import and saved plan.',
    );
  }
}

function validateRecoveredBucketBackedBootstrapState(
  expectedResources: ReadonlySet<string>,
  finalResources: ReadonlySet<string>,
): void {
  if (
    !sameStringSet(
      managedBootstrapResourceSet(expectedResources),
      managedBootstrapResourceSet(finalResources),
    )
  ) {
    throw new Error(
      'Bucket-backed bootstrap state changed after recovery; rerun before creating a saved plan.',
    );
  }
}

export function validateMainStateAddresses(
  resources: ReadonlySet<string>,
  requireComplete = false,
): void {
  if (
    [...resources].some((address) => !mainStateAllowedResources.has(address))
  ) {
    throw new Error(
      'Main state contains an unexpected resource; refusing every import and saved plan.',
    );
  }
  if (
    requireComplete &&
    (resources.size !== mainStateAllowedResources.size ||
      [...mainStateAllowedResources].some((address) => !resources.has(address)))
  ) {
    throw new Error(
      'Main state does not contain the complete reviewed resource set.',
    );
  }
}

export function recoverBootstrapState(
  operations: BootstrapStateRecoveryOperations,
): void {
  const bucketStatus = operations.inspectBucketStatus();
  const interruptedState =
    bucketStatus === 'absent' ? operations.inspectInterruptedState() : null;
  const resources =
    bucketStatus === 'absent'
      ? new Set(interruptedState?.resources ?? [])
      : new Set(operations.inspectStateResources());
  validateBootstrapStateAddresses(resources, bucketStatus);
  const project = operations.inspectProject();
  if (project === null) {
    if (resources.has('google_project.psd_eoc')) {
      throw new Error(
        'Bootstrap state contains the project but Google cannot verify it; refusing to plan a replacement.',
      );
    }
    return;
  }

  operations.validateExistingProject(project);
  validateProjectIamPolicy(
    operations.inspectProjectIamPolicy(),
    project.projectNumber as string,
    'recovery',
  );
  if (!resources.has('google_project.psd_eoc')) {
    operations.importResource('google_project.psd_eoc', PROJECT_ID);
    resources.add('google_project.psd_eoc');
  }

  const services = operations.inspectEnabledServices();
  for (const [address, service] of bootstrapServiceImports) {
    if (services.has(service) && !resources.has(address)) {
      operations.importResource(address, `${PROJECT_ID}/${service}`);
      resources.add(address);
    }
  }

  if (bucketStatus !== 'absent') {
    for (const [address, importId] of bootstrapBucketImports) {
      if (!resources.has(address)) {
        operations.importResource(address, importId);
        resources.add(address);
      }
    }
  }

  const finalBucketStatus = operations.inspectBucketStatus();
  if (finalBucketStatus !== bucketStatus) {
    throw new Error(
      'The state bucket changed during bootstrap recovery; rerun before creating a saved plan.',
    );
  }
  const finalResources = operations.inspectStateResources();
  validateBootstrapStateAddresses(finalResources, finalBucketStatus);
  if (finalBucketStatus === 'absent') {
    const finalState = operations.inspectInterruptedState();
    validateRecoveredInterruptedBootstrapState(
      interruptedState,
      finalState,
      resources,
    );
  } else {
    validateRecoveredBucketBackedBootstrapState(resources, finalResources);
  }
}

const liveApplyBoundaryOperations = {
  inspectBucket: () => inspectStateBucketForApiRepair(true),
  inspectProject,
  validateExistingProject,
  inspectProjectIamPolicy: projectIamPolicy,
  inspectServices: enabledProjectServiceInspection,
  inspectRosterReader: inspectRosterReaderServiceAccount,
  validateRosterReader: validateLiveManagedRosterReader,
} as const satisfies ApplyBoundaryOperations;

const liveOrphanedRosterReaderRecoveryOperations = {
  inspectEnabledServices: enabledProjectServices,
  inspectRosterReader: inspectRosterReaderServiceAccount,
  validateRosterReader: validateLiveRecoverableRosterReader,
  importResource: (address: string, importId: string) => {
    runTerraformInteractive(['import', '-input=false', address, importId]);
  },
} as const satisfies OrphanedRosterReaderRecoveryOperations;

const liveBootstrapStateRecoveryOperations = {
  inspectBucketStatus: () => stateBucketStatus(true),
  inspectInterruptedState: inspectInterruptedBootstrapState,
  inspectStateResources: () => stateResources(bootstrapRoot),
  inspectProject,
  validateExistingProject,
  inspectProjectIamPolicy: projectIamPolicy,
  inspectEnabledServices: enabledProjectServices,
  importResource: (address: string, importId: string) => {
    runTerraformInteractive(
      ['import', '-input=false', address, importId],
      bootstrapRoot,
    );
  },
} as const satisfies BootstrapStateRecoveryOperations;

export async function executeConfirmedPlan(
  operations: ConfirmedPlanOperations,
): Promise<void> {
  try {
    const initialBoundary = operations.captureBoundary();
    operations.plan();
    const planSeal = operations.readPlanSeal();
    const plannedBoundary = operations.captureBoundary();
    if (plannedBoundary !== initialBoundary) {
      throw new Error(
        'The validated GCP boundary changed while Terraform planned; rerun for a fresh plan.',
      );
    }
    await operations.confirm();
    if (operations.readPlanSeal() !== planSeal) {
      throw new Error(
        'The saved Terraform plan changed during confirmation; rerun and review a fresh plan.',
      );
    }
    await operations.revalidate();
    if (operations.captureBoundary() !== plannedBoundary) {
      throw new Error(
        'The validated GCP boundary changed during confirmation; rerun and review a fresh plan.',
      );
    }
    await operations.revalidate();
    if (operations.readPlanSeal() !== planSeal) {
      throw new Error(
        'The saved Terraform plan changed before apply; rerun and review a fresh plan.',
      );
    }
    operations.apply();
  } finally {
    operations.cleanup();
  }
}

async function applySavedPlan(options: {
  readonly captureBoundary: () => string;
  readonly confirmation: string;
  readonly cwd: string;
  readonly preview: string;
}): Promise<void> {
  const savedPlan = createSavedPlanWorkspace();
  await executeConfirmedPlan({
    apply: () => {
      runTerraformInteractive(
        ['apply', '-input=false', savedPlan.planPath],
        options.cwd,
      );
    },
    captureBoundary: options.captureBoundary,
    cleanup: savedPlan.cleanup,
    confirm: () =>
      requireExactConfirmation(options.preview, options.confirmation),
    plan: () => {
      runTerraformInteractive(
        ['plan', '-input=false', `-out=${savedPlan.planPath}`],
        options.cwd,
      );
    },
    readPlanSeal: () => readSavedPlanSeal(savedPlan.planPath),
    revalidate: async () => {
      assertDefaultTerraformWorkspace(options.cwd);
      assertActiveGcloudAccount(TERRAFORM_ADMIN);
      await assertApplicationDefaultIdentity(TERRAFORM_ADMIN);
    },
  });
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
    runInteractive(
      'terraform',
      ['init', '-reconfigure', '-input=false'],
      bootstrapRoot,
    );
    assertDefaultTerraformWorkspace(bootstrapRoot);
    if (initialBucketStatus === 'absent') {
      await repairInterruptedBootstrapApis({
        assertOperatorIdentity: async () => {
          assertActiveGcloudAccount(TERRAFORM_ADMIN);
          await assertApplicationDefaultIdentity(TERRAFORM_ADMIN);
        },
        confirm: requireExactConfirmation,
        enableServices: (services) => {
          runCommand(
            'gcloud',
            [
              'services',
              'enable',
              ...services,
              '--project',
              PROJECT_ID,
              '--quiet',
            ],
            { redactFailureOutput: true },
          );
        },
        inspectBucket: () => inspectStateBucketForApiRepair(true),
        inspectServices: enabledProjectServiceInspection,
        inspectState: inspectInterruptedBootstrapState,
        validateProject: validateRecoveryProject,
      });
    }
    recoverBootstrapState(liveBootstrapStateRecoveryOperations);
    await applySavedPlan({
      captureBoundary: () =>
        captureApplyBoundary(false, liveApplyBoundaryOperations),
      confirmation: 'create-psd401-eoc-bootstrap',
      cwd: bootstrapRoot,
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
  validateMainStateAddresses(managedResources);
  for (const [address, importId] of mainImports) {
    if (!managedResources.has(address)) {
      runTerraformInteractive(['import', '-input=false', address, importId]);
      managedResources.add(address);
    }
  }
  recoverOrphanedRosterReader(
    managedResources,
    liveOrphanedRosterReaderRecoveryOperations,
  );
  validateMainStateAddresses(stateResources());

  await applySavedPlan({
    captureBoundary: () =>
      captureApplyBoundary(true, liveApplyBoundaryOperations),
    confirmation: 'apply-psd401-eoc-gcp',
    cwd: gcpRoot,
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
  validateMainStateAddresses(finalResources, true);
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
