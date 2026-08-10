import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertActiveGcloudAccount,
  assertApplicationDefaultIdentity,
  gcpRoot,
  requireExactConfirmation,
  runCommand,
  runInteractive,
  sanitizedGcloudEnvironment,
  sanitizedTerraformEnvironment,
} from './runtime';

const PROJECT_ID = 'psd401-eoc';
const PROJECT_NAME = 'PSD EOC';
const ORGANIZATION_ID = '482073499306';
const BILLING_ACCOUNT = '<billing-account>';
const TERRAFORM_ADMIN = 'kjh_admin@psd401.net';
const STATE_BUCKET = 'psd401-eoc-terraform-state';
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
  'google_storage_bucket.terraform_state',
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
  ['google_storage_bucket.terraform_state', STATE_BUCKET],
] as const;

const bootstrapServiceImports = [
  ['google_project_service.service_usage', 'serviceusage.googleapis.com'],
  ['google_project_service.storage', 'storage.googleapis.com'],
] as const;

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
  const labelsMatch = Object.entries(expectedLabels).every(
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
): void {
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

  const expectedBindings = new Map<string, ReadonlySet<string>>([
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
  if (!Array.isArray(bindings) || bindings.length !== expectedBindings.size) {
    throw new Error(
      'Existing state bucket IAM does not match the project-only backend contract.',
    );
  }
  const seenRoles = new Set<string>();
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
      seenRoles.has(role) ||
      !Array.isArray(members) ||
      members.some((member) => typeof member !== 'string')
    ) {
      throw new Error('Existing state bucket IAM contains an invalid binding.');
    }
    const expectedMembers = expectedBindings.get(role);
    const actualMembers = new Set(members as string[]);
    if (
      expectedMembers === undefined ||
      actualMembers.size !== expectedMembers.size ||
      [...actualMembers].some((member) => !expectedMembers.has(member))
    ) {
      throw new Error(
        'Existing state bucket IAM does not match the project-only backend contract.',
      );
    }
    seenRoles.add(role);
  }
}

function inspectProject(): Readonly<Record<string, unknown>> | null {
  const result = spawnSync(
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
    {
      cwd: gcpRoot,
      encoding: 'utf8',
      env: sanitizedGcloudEnvironment(),
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error !== undefined) {
    throw new Error(`gcloud could not start: ${result.error.message}`);
  }
  return parseProjectDescribeResult(
    result.status,
    result.stdout,
    result.stderr,
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

function stateBucketExists(): boolean {
  const result = spawnSync(
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
    {
      cwd: gcpRoot,
      encoding: 'utf8',
      env: sanitizedGcloudEnvironment(),
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error !== undefined) {
    throw new Error(`gcloud could not start: ${result.error.message}`);
  }
  const bucket = parseBucketDescribeResult(
    result.status,
    result.stdout,
    result.stderr,
  );
  if (bucket === null) {
    return false;
  }
  const project = inspectProject();
  if (project === null) {
    throw new Error(
      'The state bucket exists but the expected PSD EOC project cannot be inspected.',
    );
  }
  validateExistingProject(project);
  const projectBucketNames = runCommand('gcloud', [
    'storage',
    'buckets',
    'list',
    '--project',
    PROJECT_ID,
    '--filter',
    `name=${STATE_BUCKET}`,
    '--format=value(name)',
  ])
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
    runCommand('gcloud', [
      'storage',
      'buckets',
      'get-iam-policy',
      `gs://${STATE_BUCKET}`,
      '--project',
      PROJECT_ID,
      '--format=json',
      '--quiet',
    ]),
    'State bucket IAM policy',
  );
  validateStateBucket(bucket, policy);
  return true;
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

export function validateTerraformWorkspace(workspace: string): void {
  if (workspace !== 'default') {
    throw new Error(
      `Terraform workspace must be default; refusing to use ${JSON.stringify(workspace)}.`,
    );
  }
}

function assertDefaultTerraformWorkspace(cwd = gcpRoot): void {
  validateTerraformWorkspace(
    runCommand('terraform', ['workspace', 'show'], { cwd }),
  );
}

function runTerraformInteractive(args: readonly string[], cwd = gcpRoot): void {
  assertDefaultTerraformWorkspace(cwd);
  runInteractive('terraform', args, cwd);
}

function stateResources(cwd = gcpRoot): Set<string> {
  assertDefaultTerraformWorkspace(cwd);
  const result = spawnSync('terraform', ['state', 'list'], {
    cwd,
    encoding: 'utf8',
    env: sanitizedTerraformEnvironment(),
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new Error(`terraform could not start: ${result.error.message}`);
  }
  return parseStateListResult(result.status, result.stdout, result.stderr);
}

function enabledProjectServices(): Set<string> {
  return new Set(
    runCommand('gcloud', [
      'services',
      'list',
      '--enabled',
      '--project',
      PROJECT_ID,
      '--format=value(config.name)',
    ])
      .split('\n')
      .filter((service) => service.length > 0),
  );
}

function recoverBootstrapState(): void {
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

  const bucketExists = stateBucketExists();
  if (!bucketExists) {
    runInteractive('terraform', ['init', '-input=false'], bootstrapRoot);
    assertDefaultTerraformWorkspace(bootstrapRoot);
    recoverBootstrapState();
    await applySavedPlan({
      confirmation: 'create-psd401-eoc-bootstrap',
      cwd: bootstrapRoot,
      planPath: bootstrapPlan,
      preview:
        'Bootstrap consequence preview: create or adopt the billed psd401-eoc project directly under the district organization, enable Service Usage and Storage, and create a private versioned state bucket. No Groups data, OAuth credential, or notification path is touched.',
    });
    if (!stateBucketExists()) {
      throw new Error(
        'Bootstrap apply did not produce the exact private Terraform state bucket.',
      );
    }
  }

  runInteractive('terraform', ['init', '-reconfigure', '-input=false']);
  assertDefaultTerraformWorkspace();

  const managedResources = stateResources();
  for (const [address, importId] of mainImports) {
    if (!managedResources.has(address)) {
      runTerraformInteractive(['import', '-input=false', address, importId]);
    }
  }

  await applySavedPlan({
    confirmation: 'apply-psd401-eoc-gcp',
    cwd: gcpRoot,
    planPath: mainPlan,
    preview:
      'Apply consequence preview: enable only the declared identity/IAM APIs, grant the named district Terraform administrator roles, and create one protected service account with no project IAM roles. This does not authorize Workspace access, create OAuth clients, read Groups, or send notifications.',
  });
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
