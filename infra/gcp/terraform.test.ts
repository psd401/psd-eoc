import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  BOOTSTRAP_SERVICES,
  bootstrapPrerequisitesReady,
  buildApplyBoundary,
  captureApplyBoundary,
  createSavedPlanWorkspace,
  executeConfirmedPlan,
  missingRecoverableBootstrapApis,
  parseBucketDescribeResult,
  parseEnabledProjectServices,
  parseInterruptedBootstrapStateResult,
  parseProjectDescribeResult,
  parseServiceAccountListResult,
  parseStateBucketOwner,
  parseStateListResult,
  repairInterruptedBootstrapApis,
  repairMissingBootstrapApis,
  readSavedPlanSeal,
  recoverBootstrapState,
  recoverOrphanedRosterReader,
  validateBootstrapProject,
  validateMainStateAddresses,
  validateManagedRosterReaderBoundary,
  validateManagedRosterReaderServiceAccount,
  validateRecoverableRosterReaderServiceAccount,
  validateRecoveredInterruptedBootstrapState,
  validateStateBucket,
} from './scripts/apply';
import {
  assertNoUserManagedKeysBeforeRoleAssignment,
  findExactAssignment,
  selectGroupsReaderRole,
} from './scripts/configure-workspace-role';
import {
  approvedStaffGroupHash,
  GROUPS_READER_ROLE,
  normalizeApprovedStaffGroup,
  parseGroupsReaderContract,
  parseUserManagedKeyIds,
  policyCouldGrantServiceAccountAccess,
  READONLY_GROUPS_SCOPE,
  ROSTER_READER_EMAIL,
  selectUserManagedKeyMetadata,
  validateLiveGroupsReaderServiceAccount,
  validateRevocableUserManagedKeyMetadata,
  validateUserManagedKeyMetadata,
} from './scripts/groups-contract';
import {
  TERRAFORM_ADMIN_ROLES,
  validateProjectIamPolicy,
  validateRosterReaderResourcePolicy,
} from './scripts/project-policy';
import {
  validateWorkspaceAdminClient,
  withValidatedWorkspaceClientCopy,
} from './scripts/operator-access';
import {
  assertCurrentStoredCredentialEvidence,
  cleanupCredentialArtifacts,
  createdKeyIsVisible,
  parseCreatedCredential,
  parseCreatedKeyId,
} from './scripts/provision-groups-credential';
import {
  APPLICATION_DEFAULT_IDENTITY_SCOPES,
  assertNoAmbientTransportOverrides,
  assertTrustedHome,
  boundedGoogleJsonObject,
  gcpRoot,
  guardedGoogleFetch,
  isPathOutsideDirectory,
  MAX_GOOGLE_RESPONSE_BYTES,
  parseCurrentSecretVersionMetadata,
  reconcileIdempotentSecretWrite,
  sanitizedAwsEnvironment,
  sanitizedGcloudEnvironment,
  sanitizedTerraformEnvironment,
  validateAwsSecretMetadata,
  validateAwsSecretResourcePolicy,
  validateAwsSsoConfigurationFiles,
  validateAwsSsoIdentity,
  validateAwsSsoProfile,
  validateApplicationDefaultCredentialMetadata,
  validateGcloudConfiguration,
  validateGcloudLocalConfiguration,
  validateGcloudTransportConfiguration,
  validateGuardedBunInvocation,
  validateGoogleUserIdentity,
  validateTerraformWorkspace,
} from './scripts/runtime';
import {
  parsePlistStrings,
  readSecureFile,
  readSecureFileBytes,
  readWebClientDownload,
  terraformProjectNumber,
} from './scripts/store-oauth-client';
import {
  assertVerifiedStoredCredentialUnchanged,
  readVerifiedStoredCredentialEvidence,
  redactedFetch,
  sameVerifiedStoredCredential,
  validateStoredCredential,
} from './scripts/verify-groups-readonly';

const root = new URL('.', import.meta.url);
const read = (path: string): string =>
  readFileSync(new URL(path, root), 'utf8');
const policyDataSourceAddress = 'data.google_iam_policy.terraform_state';

function terraformFiles(directory = root): URL[] {
  const files: URL[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const path = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      files.push(...terraformFiles(new URL(`${entry.name}/`, directory)));
    } else if (entry.name.endsWith('.tf')) {
      files.push(path);
    }
  }
  return files;
}

const validGroupsOutput = {
  application_writes_google_groups: false,
  domain_wide_delegation: false,
  email: ROSTER_READER_EMAIL,
  oauth_scopes: [READONLY_GROUPS_SCOPE],
  project_id: 'psd401-eoc',
  project_number: '123456789',
  project_iam_roles: [],
  service_account_unique_id: '123456789012345678901',
  workspace_admin_role: GROUPS_READER_ROLE,
  workspace_grant_api_managed: true,
} as const;

const validLiveGroupsReader = {
  description:
    'Reads configured staff Google Groups for roster snapshots; never writes Groups or sends notifications.',
  disabled: false,
  displayName: 'PSD EOC roster sync reader',
  email: ROSTER_READER_EMAIL,
  name: `projects/psd401-eoc/serviceAccounts/${ROSTER_READER_EMAIL}`,
  oauth2ClientId: '987654321098765432109',
  projectId: 'psd401-eoc',
  uniqueId: validGroupsOutput.service_account_unique_id,
} as const;

function validGroupsReaderContract() {
  return validateLiveGroupsReaderServiceAccount(
    validLiveGroupsReader,
    parseGroupsReaderContract(validGroupsOutput),
  );
}

const validProject = {
  labels: {
    application: 'psd-eoc',
    environment: 'single',
    'goog-terraform-provisioned': 'true',
    'managed-by': 'terraform',
    purpose: 'staff-identity',
  },
  lifecycleState: 'ACTIVE',
  name: 'PSD EOC',
  parent: { id: '482073499306', type: 'organization' },
  projectId: 'psd401-eoc',
  projectNumber: '123456789',
} as const;

const validBilling = {
  billingAccountName: 'billingAccounts/<billing-account>',
  billingEnabled: true,
  projectId: 'psd401-eoc',
} as const;

const validBucket = {
  default_event_based_hold: false,
  default_storage_class: 'STANDARD',
  labels: validProject.labels,
  lifecycle_config: {
    rule: [
      {
        action: { type: 'Delete' },
        condition: { daysSinceNoncurrentTime: 90, isLive: false },
      },
    ],
  },
  location: 'US-WEST1',
  location_type: 'region',
  name: 'psd401-eoc-terraform-state',
  public_access_prevention: 'enforced',
  requester_pays: false,
  storage_url: 'gs://psd401-eoc-terraform-state/',
  uniform_bucket_level_access: true,
  versioning_enabled: true,
} as const;

const validBucketPolicy = {
  bindings: [
    {
      members: ['user:kjh_admin@psd401.net'],
      role: 'roles/storage.objectAdmin',
    },
  ],
} as const;

const bootstrapBucketPolicy = {
  bindings: [
    {
      members: ['projectEditor:psd401-eoc', 'projectOwner:psd401-eoc'],
      role: 'roles/storage.legacyBucketOwner',
    },
    {
      members: ['projectViewer:psd401-eoc'],
      role: 'roles/storage.legacyBucketReader',
    },
    {
      members: ['projectEditor:psd401-eoc', 'projectOwner:psd401-eoc'],
      role: 'roles/storage.legacyObjectOwner',
    },
    {
      members: ['projectViewer:psd401-eoc'],
      role: 'roles/storage.legacyObjectReader',
    },
  ],
} as const;

function interruptedBootstrapState(
  options: {
    readonly includeBilling?: boolean;
    readonly includeResourceManager?: boolean;
    readonly projectNumber?: string;
    readonly resources?: readonly Readonly<Record<string, unknown>>[];
    readonly serial?: number;
  } = {},
): Readonly<Record<string, unknown>> {
  const projectNumber = options.projectNumber ?? '123456789';
  const instance = (
    attributes: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> => ({
    instances: [
      {
        attributes,
        schema_version: 0,
        sensitive_attributes: [],
      },
    ],
    mode: 'managed',
    provider: 'provider["registry.terraform.io/hashicorp/google"]',
  });
  const service = (
    name: string,
    serviceName: string,
  ): Readonly<Record<string, unknown>> => ({
    ...instance({
      deletion_policy: 'PREVENT',
      disable_dependent_services: false,
      disable_on_destroy: false,
      id: `psd401-eoc/${serviceName}`,
      project: 'psd401-eoc',
      service: serviceName,
    }),
    name,
    type: 'google_project_service',
  });
  const resources = options.resources ?? [
    {
      ...instance({
        auto_create_network: false,
        billing_account: '<billing-account>',
        deletion_policy: 'PREVENT',
        id: 'projects/psd401-eoc',
        labels: validProject.labels,
        name: 'PSD EOC',
        number: projectNumber,
        org_id: '482073499306',
        project_id: 'psd401-eoc',
      }),
      name: 'psd_eoc',
      type: 'google_project',
    },
    service('service_usage', 'serviceusage.googleapis.com'),
    service('storage', 'storage.googleapis.com'),
    ...(options.includeResourceManager === true
      ? [
          service(
            'cloud_resource_manager',
            'cloudresourcemanager.googleapis.com',
          ),
        ]
      : []),
    ...(options.includeBilling === true
      ? [service('cloud_billing', 'cloudbilling.googleapis.com')]
      : []),
  ];
  return {
    lineage: '123e4567-e89b-42d3-a456-426614174000',
    outputs: {},
    resources,
    serial: options.serial ?? 7,
    terraform_version: '1.14.5',
    version: 4,
  };
}

describe('PSD EOC GCP Terraform safety boundary', () => {
  test('binds the project to the district organization and prevents deletion', () => {
    const variables = read('variables.tf');
    const main = read('main.tf');
    const bootstrap = read('bootstrap/main.tf');
    const provider = read('providers.tf');

    expect(variables).toContain('default     = "psd401-eoc"');
    expect(variables).toContain('default     = "482073499306"');
    expect(variables).toContain('default     = "<billing-account>"');
    expect(main).toContain('auto_create_network = false');
    expect(main).toContain('deletion_policy     = "PREVENT"');
    expect(main.match(/prevent_destroy = true/gu)).toHaveLength(7);
    expect(main).toContain('deletion_policy             = "PREVENT"');
    expect(bootstrap).toMatch(
      /provider "google" \{[\s\S]*deletion_policy\s+= "PREVENT"[\s\S]*\}/u,
    );
    expect(provider).toMatch(
      /provider "google" \{[\s\S]*deletion_policy\s+= "PREVENT"[\s\S]*\}/u,
    );
  });

  test('removes the automatic creator Owner only after narrower grants exist', () => {
    const main = read('main.tf');
    const readme = read('README.md');
    const rolesStart = main.indexOf('terraform_admin_roles = toset([');
    const rolesEnd = main.indexOf('])', rolesStart);
    const adminRoles = main.slice(rolesStart, rolesEnd);
    const terraformRoles = new Set(
      [...adminRoles.matchAll(/"(roles\/[^"]+)"/gu)].map((match) => match[1]),
    );

    expect(adminRoles).not.toContain('roles/owner');
    expect(terraformRoles).toEqual(new Set(TERRAFORM_ADMIN_ROLES));
    expect(main).toContain(
      'resource "google_project_iam_member_remove" "terraform_admin_owner"',
    );
    expect(main).toMatch(
      /resource "google_project_iam_member_remove" "terraform_admin_owner"[\s\S]*role\s+= "roles\/owner"[\s\S]*depends_on = \[google_project_iam_member\.terraform_admin\][\s\S]*prevent_destroy = true/u,
    );
    expect(main).toMatch(
      /resource "google_project_iam_member_remove" "google_apis_service_agent_editor"[\s\S]*role\s+= "roles\/editor"[\s\S]*cloudservices\.gserviceaccount\.com[\s\S]*depends_on = \[google_project_iam_member\.terraform_admin\]/u,
    );
    expect(readme.replace(/\s+/gu, ' ')).toContain(
      'The final live policy read requires no direct Owner binding',
    );
    expect(readme).not.toContain('Retaining protected `roles/owner`');
  });

  test('pins quota billing to the dedicated project after bootstrap', () => {
    const provider = read('providers.tf');
    const bootstrap = read('bootstrap/main.tf');
    const apply = read('scripts/apply.ts');
    const groups = read('scripts/groups-contract.ts');
    const operatorAccess = read('scripts/operator-access.ts');

    expect(provider).toContain('billing_project       = var.project_id');
    expect(provider).toContain('project               = var.project_id');
    expect(provider).toContain('user_project_override = true');
    expect(bootstrap).not.toContain('billing_project');
    expect(bootstrap).not.toContain('user_project_override');
    expect(operatorAccess).toMatch(
      /'application-default',\s*'login',\s*ADMIN_EMAIL,\s*'--disable-quota-project'/u,
    );
    expect(apply).toMatch(
      /'projects',\s*'describe',\s*PROJECT_ID,\s*'--project',\s*PROJECT_ID/gu,
    );
    expect(apply).toMatch(
      /'billing',\s*'projects',\s*'describe',\s*PROJECT_ID,\s*'--project',\s*PROJECT_ID/gu,
    );
    expect(apply).toMatch(
      /'get-iam-policy',\s*`gs:\/\/\$\{STATE_BUCKET\}`,\s*'--project',\s*PROJECT_ID/gu,
    );
    expect(groups).toMatch(
      /'get-iam-policy',\s*PROJECT_ID,\s*'--project',\s*PROJECT_ID/gu,
    );
  });

  test('inherits the fixed provider project for the imported state bucket', () => {
    const provider = read('providers.tf');
    const main = read('main.tf');
    const bucketStart = main.indexOf(
      'resource "google_storage_bucket" "terraform_state"',
    );
    const bucketEnd = main.indexOf(
      'data "google_iam_policy" "terraform_state"',
      bucketStart,
    );
    const bucket = main.slice(bucketStart, bucketEnd);

    expect(provider).toContain('project               = var.project_id');
    expect(bucketStart).toBeGreaterThan(-1);
    expect(bucketEnd).toBeGreaterThan(bucketStart);
    expect(bucket).not.toMatch(/^\s*project\s+=/mu);
    expect(bucket).toContain(
      'depends_on = [google_project_service.required["storage.googleapis.com"]]',
    );
  });

  test('does not place an object-retention lock on Terraform lock files', () => {
    for (const path of ['main.tf', 'bootstrap/main.tf']) {
      const terraform = read(path);
      expect(terraform).not.toContain('retention_policy');
      expect(terraform).toContain('versioning');
      expect(terraform).toContain('days_since_noncurrent_time = 90');
      expect(terraform).toContain('send_age_if_zero           = false');
      expect(terraform).toContain('with_state                 = "ARCHIVED"');
      expect(terraform).not.toMatch(/^\s*age\s+=/mu);
    }
  });

  test('enables the fixed identity API allow-list without disabling APIs', () => {
    const variables = read('variables.tf');
    const allTerraform = terraformFiles()
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    for (const service of [
      'admin.googleapis.com',
      'cloudbilling.googleapis.com',
      'cloudidentity.googleapis.com',
      'cloudresourcemanager.googleapis.com',
      'iam.googleapis.com',
      'serviceusage.googleapis.com',
      'storage.googleapis.com',
    ]) {
      expect(variables).toContain(`"${service}"`);
    }
    expect(variables).not.toContain('iamcredentials.googleapis.com');
    expect(allTerraform).not.toContain('disable_on_destroy         = true');
    expect(allTerraform).not.toContain('disable_dependent_services = true');
    expect(allTerraform).not.toContain('deletion_policy            = "DELETE"');
    expect(allTerraform.match(/deletion_policy\s+= "PREVENT"/gu)).toHaveLength(
      13,
    );
  });

  test('gives the roster reader no project role and never puts a key in state', () => {
    const allTerraform = terraformFiles()
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    expect(allTerraform).toContain(
      'resource "google_service_account" "roster_reader"',
    );
    expect(allTerraform).not.toMatch(
      /resource "google_(?:project|service_account)_iam_(?:binding|member|policy)"[^}]*roster_reader/u,
    );
    expect(allTerraform).not.toContain('google_service_account_key');
    expect(allTerraform).not.toContain('private_key');
    expect(read('outputs.tf')).toContain('project_iam_roles');
    expect(read('outputs.tf')).toContain('= []');
  });

  test('uses direct Groups Reader without domain-wide delegation', () => {
    const output = read('outputs.tf');
    const roleHelper = read('scripts/configure-workspace-role.ts');
    const verifier = read('scripts/verify-groups-readonly.ts');

    expect(output).toContain('domain_wide_delegation           = false');
    expect(output).toContain('"_GROUPS_READER_ROLE"');
    expect(roleHelper).toContain(
      'https://www.googleapis.com/auth/admin.directory.rolemanagement',
    );
    expect(roleHelper.match(/method: 'POST'/gu)).toHaveLength(1);
    expect(roleHelper).not.toMatch(/method: '(?:DELETE|PATCH|PUT)'/u);
    expect(verifier).not.toContain('sub:');
  });

  test('documents the roster runtime mismatch as a fail-closed blocker', () => {
    const readme = read('README.md');
    const operatorAccess = read('scripts/operator-access.ts');
    const normalizedReadme = readme.replace(/\s+/gu, ' ');

    for (const evidence of [
      'admin.directory.group.member.readonly',
      'GOOGLE_ROSTER_DELEGATED_SUBJECT',
      '/psd-eoc/google-groups',
      'https://github.com/psd401/psd-eoc/issues/68',
      'end-to-end Google Groups roster integration',
      'is `blocked`',
      'Do not add domain-wide delegation',
      'does not prove that the application can sync a roster',
    ]) {
      expect(normalizedReadme).toContain(evidence);
    }
    expect(readme).toContain('./scripts/run-guarded.sh restore-adc');
    expect(operatorAccess).toMatch(
      /'application-default',\s*'revoke',\s*'--quiet'[\s\S]*ordinaryAdcLogin\(\)/u,
    );
    expect(operatorAccess).toContain(
      "`--scopes=${APPLICATION_DEFAULT_IDENTITY_SCOPES.join(',')}`",
    );
    expect(readme).not.toContain(
      'Google Groups moves to `configured-unverified` only after',
    );
    expect(readme).not.toContain('Re-enable roster sync only after it passes.');
    for (const oidcEvidence of [
      'https://github.com/psd401/psd-eoc/issues/69',
      'Google OIDC is `blocked`, not `configured-unverified`',
      'exact wiring and readback support `configured-unverified`',
    ]) {
      expect(normalizedReadme).toContain(oidcEvidence);
    }
  });

  test('authorizes role-management ADC before credential rotation', () => {
    const readme = read('README.md');
    const rotation = readme.slice(
      readme.indexOf('### Credential rotation and revocation'),
      readme.indexOf('## Google Auth Platform residual steps'),
    );
    const authorize = rotation.indexOf(
      'Temporarily authorize the role-management ADC',
    );
    const revoke = rotation.indexOf(
      './scripts/run-guarded.sh revoke-groups-credential',
    );
    const provision = rotation.indexOf(
      './scripts/run-guarded.sh provision-groups-credential',
    );
    const verify = rotation.indexOf(
      './scripts/run-guarded.sh verify-groups-readonly',
    );
    const restore = rotation.indexOf(
      'Explicitly revoke the role-management ADC',
    );

    expect(authorize).toBeGreaterThan(-1);
    expect(authorize).toBeLessThan(revoke);
    expect(revoke).toBeLessThan(provision);
    expect(provision).toBeLessThan(verify);
    expect(verify).toBeLessThan(restore);
  });

  test('makes only read-only Groups calls and requests no member fields', () => {
    const verifier = read('scripts/verify-groups-readonly.ts');
    const contract = read('scripts/groups-contract.ts');

    expect(contract).toContain(READONLY_GROUPS_SCOPE);
    expect(verifier.match(/method: 'GET'/gu)).toHaveLength(2);
    expect(verifier).not.toMatch(/method: '(?:DELETE|PATCH|PUT)'/u);
    expect(verifier).not.toContain(':create');
    expect(verifier).not.toContain(':delete');
    expect(verifier).not.toContain(':modifyMembershipRoles');
    expect(verifier).toContain("set('fields', 'nextPageToken')");
    expect(verifier).not.toContain('arrayBuffer()');
  });

  test('keeps local state, credentials, and downloaded configs ignored', () => {
    const ignore = read('.gitignore');

    for (const pattern of [
      '.terraform/',
      '*.tfstate',
      '*.tfplan',
      '*.tfvars',
      'credentials/',
      'client_secret_*.json',
      'client_secret_*.plist',
      'google-services.json',
      'GoogleService-Info.plist',
    ]) {
      expect(ignore).toContain(pattern);
    }
  });

  test('uses saved plans and helper-owned confirmations for both applies', () => {
    const apply = read('scripts/apply.ts');

    expect(apply).toContain(
      "['plan', '-input=false', `-out=${savedPlan.planPath}`]",
    );
    expect(apply).toContain("['apply', '-input=false', savedPlan.planPath]");
    expect(apply).toContain('cleanup: savedPlan.cleanup');
    expect(apply).not.toContain('bootstrapPlan');
    expect(apply).not.toContain('mainPlan');
    expect(apply).not.toContain('options.planPath');
    expect(apply).toContain('requireExactConfirmation');
    expect(apply).not.toContain('auto-approve');
    expect(read('scripts/provision-groups-credential.ts')).toContain(
      'store-psd-eoc-readonly-groups-key',
    );
    expect(read('scripts/store-oauth-client.ts')).toContain(
      'store-psd-eoc-google-oauth',
    );
  });

  test('creates saved plans in private fixed-root workspaces before planning', () => {
    const ambientDirectory = mkdtempSync(
      join(tmpdir(), 'psd-eoc-ambient-plan-root-'),
    );
    const sentinel = join(ambientDirectory, 'sentinel.txt');
    writeFileSync(sentinel, 'KEEP', { mode: 0o600 });
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = gcpRoot;
    const first = createSavedPlanWorkspace();
    const second = createSavedPlanWorkspace();
    const firstDirectory = dirname(first.planPath);
    const secondDirectory = dirname(second.planPath);
    try {
      expect(firstDirectory).not.toBe(secondDirectory);
      expect(dirname(firstDirectory)).toBe(realpathSync('/tmp'));
      expect(dirname(secondDirectory)).toBe(realpathSync('/tmp'));
      expect(first.planPath.startsWith(gcpRoot)).toBe(false);
      expect(second.planPath.startsWith(gcpRoot)).toBe(false);

      for (const workspace of [first, second]) {
        const directoryMetadata = lstatSync(dirname(workspace.planPath));
        const planMetadata = lstatSync(workspace.planPath);
        expect(directoryMetadata.isDirectory()).toBe(true);
        expect(directoryMetadata.mode & 0o777).toBe(0o700);
        expect(realpathSync(dirname(workspace.planPath))).toBe(
          dirname(workspace.planPath),
        );
        expect(planMetadata.isFile()).toBe(true);
        expect(planMetadata.mode & 0o777).toBe(0o600);
        expect(planMetadata.nlink).toBe(1);
        expect(planMetadata.size).toBe(0);
      }

      expect(() => symlinkSync(sentinel, first.planPath)).toThrow();
      expect(() => linkSync(sentinel, second.planPath)).toThrow();
      writeFileSync(first.planPath, 'synthetic-plan-one');
      writeFileSync(second.planPath, 'synthetic-plan-two');
      expect(readSavedPlanSeal(first.planPath)).not.toBe(
        readSavedPlanSeal(second.planPath),
      );
      expect(readFileSync(sentinel, 'utf8')).toBe('KEEP');
    } finally {
      first.cleanup();
      second.cleanup();
      if (previousTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpdir;
      }
      rmSync(ambientDirectory, { force: true, recursive: true });
    }
    expect(() => lstatSync(firstDirectory)).toThrow();
    expect(() => lstatSync(secondDirectory)).toThrow();
  });

  test('revalidates the sealed plan, live boundary, and identities before apply', async () => {
    const apply = read('scripts/apply.ts');
    const trace: string[] = [];
    const captureBoundary = (): string => {
      trace.push('boundary');
      return 'boundary';
    };
    const readPlanSeal = (): string => {
      trace.push('seal');
      return 'seal';
    };

    await executeConfirmedPlan({
      apply: () => trace.push('apply'),
      captureBoundary,
      cleanup: () => trace.push('cleanup'),
      confirm: async () => {
        trace.push('confirm');
      },
      plan: () => trace.push('plan'),
      readPlanSeal,
      revalidate: async () => {
        trace.push('revalidate');
      },
    });
    expect(trace).toEqual([
      'boundary',
      'plan',
      'seal',
      'boundary',
      'confirm',
      'seal',
      'revalidate',
      'boundary',
      'revalidate',
      'seal',
      'apply',
      'cleanup',
    ]);

    trace.length = 0;
    await expect(
      executeConfirmedPlan({
        apply: () => trace.push('apply'),
        captureBoundary,
        cleanup: () => trace.push('cleanup'),
        confirm: async () => {
          trace.push('confirm');
          throw new Error('confirmation rejected');
        },
        plan: () => trace.push('plan'),
        readPlanSeal,
        revalidate: async () => {
          trace.push('revalidate');
        },
      }),
    ).rejects.toThrow('confirmation rejected');
    expect(trace).toEqual([
      'boundary',
      'plan',
      'seal',
      'boundary',
      'confirm',
      'cleanup',
    ]);

    trace.length = 0;
    await expect(
      executeConfirmedPlan({
        apply: () => trace.push('apply'),
        captureBoundary,
        cleanup: () => trace.push('cleanup'),
        confirm: async () => {
          trace.push('confirm');
        },
        plan: () => trace.push('plan'),
        readPlanSeal,
        revalidate: async () => {
          trace.push('revalidate');
          throw new Error('credential changed');
        },
      }),
    ).rejects.toThrow('credential changed');
    expect(trace).toEqual([
      'boundary',
      'plan',
      'seal',
      'boundary',
      'confirm',
      'seal',
      'revalidate',
      'cleanup',
    ]);

    trace.length = 0;
    await expect(
      executeConfirmedPlan({
        apply: () => trace.push('apply'),
        captureBoundary,
        cleanup: () => trace.push('cleanup'),
        confirm: async () => {
          trace.push('confirm');
        },
        plan: () => {
          trace.push('plan');
          throw new Error('plan failed');
        },
        readPlanSeal,
        revalidate: async () => {
          trace.push('revalidate');
        },
      }),
    ).rejects.toThrow('plan failed');
    expect(trace).toEqual(['boundary', 'plan', 'cleanup']);

    trace.length = 0;
    await expect(
      executeConfirmedPlan({
        apply: () => {
          trace.push('apply');
          throw new Error('apply failed');
        },
        captureBoundary,
        cleanup: () => trace.push('cleanup'),
        confirm: async () => {
          trace.push('confirm');
        },
        plan: () => trace.push('plan'),
        readPlanSeal,
        revalidate: async () => {
          trace.push('revalidate');
        },
      }),
    ).rejects.toThrow('apply failed');
    expect(trace).toEqual([
      'boundary',
      'plan',
      'seal',
      'boundary',
      'confirm',
      'seal',
      'revalidate',
      'boundary',
      'revalidate',
      'seal',
      'apply',
      'cleanup',
    ]);

    const applySavedPlan = apply.slice(
      apply.indexOf('async function applySavedPlan'),
      apply.indexOf('async function main'),
    );
    expect(applySavedPlan).toMatch(
      /const savedPlan = createSavedPlanWorkspace\(\);[\s\S]*captureBoundary: options\.captureBoundary,[\s\S]*cleanup: savedPlan\.cleanup,[\s\S]*readPlanSeal: \(\) => readSavedPlanSeal\(savedPlan\.planPath\),[\s\S]*revalidate: async \(\) => \{\s*assertDefaultTerraformWorkspace\(options\.cwd\);\s*assertActiveGcloudAccount\(TERRAFORM_ADMIN\);\s*await assertApplicationDefaultIdentity\(TERRAFORM_ADMIN\);\s*\},/u,
    );
  });

  test('discards a plan when its bytes or validated GCP boundary change', async () => {
    const events: string[] = [];
    const base = {
      apply: () => events.push('apply'),
      cleanup: () => events.push('cleanup'),
      confirm: async () => {
        events.push('confirm');
      },
      plan: () => events.push('plan'),
      revalidate: async () => {
        events.push('revalidate');
      },
    };

    let boundaryReads = 0;
    await expect(
      executeConfirmedPlan({
        ...base,
        captureBoundary: () => {
          boundaryReads += 1;
          return boundaryReads === 1 ? 'before' : 'after';
        },
        readPlanSeal: () => 'seal',
      }),
    ).rejects.toThrow('changed while Terraform planned');
    expect(events).toEqual(['plan', 'cleanup']);

    events.length = 0;
    boundaryReads = 0;
    await expect(
      executeConfirmedPlan({
        ...base,
        captureBoundary: () => {
          boundaryReads += 1;
          return boundaryReads < 3 ? 'planned' : 'changed';
        },
        readPlanSeal: () => 'seal',
      }),
    ).rejects.toThrow('changed during confirmation');
    expect(events).toEqual(['plan', 'confirm', 'revalidate', 'cleanup']);

    events.length = 0;
    let sealReads = 0;
    await expect(
      executeConfirmedPlan({
        ...base,
        captureBoundary: () => 'boundary',
        readPlanSeal: () => {
          sealReads += 1;
          return sealReads === 1 ? 'planned' : 'replaced';
        },
      }),
    ).rejects.toThrow('changed during confirmation');
    expect(events).toEqual(['plan', 'confirm', 'cleanup']);

    events.length = 0;
    sealReads = 0;
    await expect(
      executeConfirmedPlan({
        ...base,
        captureBoundary: () => 'boundary',
        readPlanSeal: () => {
          sealReads += 1;
          return sealReads < 3 ? 'planned' : 'replaced';
        },
      }),
    ).rejects.toThrow('changed before apply');
    expect(events).toEqual([
      'plan',
      'confirm',
      'revalidate',
      'revalidate',
      'cleanup',
    ]);
  });

  test('binds every security-relevant live category into the apply boundary', () => {
    const evidence = {
      billing: { billingAccountName: 'billingAccounts/fixed' },
      bucket: { projectNumber: '123', revision: 'bucket-and-policy' },
      policy: { bindings: [{ members: ['user:admin'], role: 'roles/viewer' }] },
      project: { parent: { id: 'organization' }, projectNumber: '123' },
      rosterReader: 'service-account-policy-and-keys',
      serviceProjectNumber: '123',
      serviceStates: [
        { enabled: true, service: 'serviceusage.googleapis.com' },
      ],
    } as const;
    const baseline = buildApplyBoundary(evidence);
    for (const changed of [
      { ...evidence, billing: { billingAccountName: 'billingAccounts/other' } },
      { ...evidence, bucket: { projectNumber: '123', revision: 'changed' } },
      { ...evidence, policy: { bindings: [] } },
      {
        ...evidence,
        project: { parent: { id: 'other' }, projectNumber: '123' },
      },
      { ...evidence, rosterReader: 'changed-key-policy' },
      { ...evidence, serviceProjectNumber: '456' },
      {
        ...evidence,
        serviceStates: [
          { enabled: false, service: 'serviceusage.googleapis.com' },
        ],
      },
    ]) {
      expect(buildApplyBoundary(changed)).not.toBe(baseline);
    }

    const apply = read('scripts/apply.ts');
    const capture = apply.slice(
      apply.indexOf('function captureApplyBoundary'),
      apply.indexOf('function recoverOrphanedRosterReader'),
    );
    for (const evidenceName of [
      'billing',
      'bucket',
      'policy',
      'project',
      'rosterReader',
      'serviceProjectNumber',
      'serviceStates',
    ]) {
      expect(capture).toContain(evidenceName);
    }
    expect(capture).toContain('operations.validateRosterReader');
    expect(apply).toContain(
      'validateRosterReader: validateLiveManagedRosterReader',
    );
    expect(apply).toMatch(
      /const liveOrphanedRosterReaderRecoveryOperations =[\s\S]*validateRosterReader: validateLiveRecoverableRosterReader/u,
    );
    expect(capture).toContain('validateProjectIamPolicy');
  });

  test('captures the apply boundary through injected, ordered live evidence', () => {
    const trace: string[] = [];
    const operations: Parameters<typeof captureApplyBoundary>[1] = {
      inspectBucket: () => {
        trace.push('bucket');
        return {
          projectNumber: validProject.projectNumber,
          revision: 'synthetic-bucket-revision',
          status: 'managed-policy',
        };
      },
      inspectProject: () => {
        trace.push('project');
        return validProject;
      },
      validateExistingProject: (project) => {
        trace.push('billing');
        expect(project).toBe(validProject);
        return validBilling;
      },
      inspectProjectIamPolicy: () => {
        trace.push('iam');
        return { bindings: [] };
      },
      inspectServices: () => {
        trace.push('services');
        return {
          projectNumber: validProject.projectNumber,
          services: new Set([
            ...BOOTSTRAP_SERVICES,
            'admin.googleapis.com',
            'cloudidentity.googleapis.com',
            'iam.googleapis.com',
          ]),
        };
      },
      inspectRosterReader: () => {
        trace.push('roster');
        return validLiveGroupsReader;
      },
      validateRosterReader: (serviceAccount) => {
        trace.push('validate-roster');
        expect(serviceAccount).toBe(validLiveGroupsReader);
        return 'synthetic-roster-reader-seal';
      },
    };

    const bootstrapBoundary = JSON.parse(
      captureApplyBoundary(false, operations),
    ) as Readonly<Record<string, unknown>>;
    expect(trace).toEqual(['bucket', 'project', 'billing', 'iam', 'services']);
    expect(bootstrapBoundary.rosterReader).toBe('iam-api-disabled');
    expect(
      (
        bootstrapBoundary.serviceStates as readonly Readonly<{
          enabled: boolean;
          service: string;
        }>[]
      ).map(({ service }) => service),
    ).toEqual([...BOOTSTRAP_SERVICES].sort());

    trace.length = 0;
    const mainBoundary = JSON.parse(
      captureApplyBoundary(true, operations),
    ) as Readonly<Record<string, unknown>>;
    expect(trace).toEqual([
      'bucket',
      'project',
      'billing',
      'iam',
      'services',
      'roster',
      'validate-roster',
    ]);
    expect(mainBoundary.rosterReader).toBe('synthetic-roster-reader-seal');
    expect(
      (
        mainBoundary.serviceStates as readonly Readonly<{
          enabled: boolean;
          service: string;
        }>[]
      ).map(({ service }) => service),
    ).toEqual(
      [
        ...BOOTSTRAP_SERVICES,
        'admin.googleapis.com',
        'cloudidentity.googleapis.com',
        'iam.googleapis.com',
      ].sort(),
    );

    trace.length = 0;
    const withoutRoster = captureApplyBoundary(true, {
      ...operations,
      inspectRosterReader: () => {
        trace.push('roster');
        return null;
      },
    });
    expect(
      (JSON.parse(withoutRoster) as Readonly<Record<string, unknown>>)
        .rosterReader,
    ).toBeNull();

    trace.length = 0;
    const withoutIam = captureApplyBoundary(true, {
      ...operations,
      inspectServices: () => {
        trace.push('services');
        return {
          projectNumber: validProject.projectNumber,
          services: new Set(BOOTSTRAP_SERVICES),
        };
      },
      inspectRosterReader: () => {
        throw new Error(
          'Roster inspection must not run while IAM is disabled.',
        );
      },
    });
    expect(
      (JSON.parse(withoutIam) as Readonly<Record<string, unknown>>)
        .rosterReader,
    ).toBe('iam-api-disabled');
  });

  test('fails apply-boundary capture closed on absent or mismatched anchors', () => {
    const forbidden = (): never => {
      throw new Error('Unexpected late boundary operation.');
    };
    const absentOperations: Parameters<typeof captureApplyBoundary>[1] = {
      inspectBucket: () => null,
      inspectProject: () => null,
      validateExistingProject: forbidden,
      inspectProjectIamPolicy: forbidden,
      inspectServices: forbidden,
      inspectRosterReader: forbidden,
      validateRosterReader: forbidden,
    };
    expect(captureApplyBoundary(false, absentOperations)).toBe(
      buildApplyBoundary({
        billing: null,
        bucket: null,
        policy: null,
        project: null,
        rosterReader: 'not-applicable',
        serviceProjectNumber: null,
        serviceStates: [],
      }),
    );
    expect(() =>
      captureApplyBoundary(false, {
        ...absentOperations,
        inspectBucket: () => ({
          projectNumber: validProject.projectNumber,
          status: 'managed-policy',
        }),
      }),
    ).toThrow('state bucket exists');

    const anchoredOperations: Parameters<typeof captureApplyBoundary>[1] = {
      inspectBucket: () => ({
        projectNumber: validProject.projectNumber,
        status: 'managed-policy',
      }),
      inspectProject: () => validProject,
      validateExistingProject: () => validBilling,
      inspectProjectIamPolicy: () => ({ bindings: [] }),
      inspectServices: () => ({
        projectNumber: validProject.projectNumber,
        services: new Set(BOOTSTRAP_SERVICES),
      }),
      inspectRosterReader: () => null,
      validateRosterReader: () => 'synthetic-roster-reader-seal',
    };
    expect(() =>
      captureApplyBoundary(false, {
        ...anchoredOperations,
        inspectBucket: () => ({
          projectNumber: '987654321',
          status: 'managed-policy',
        }),
      }),
    ).toThrow('different Google projects');
    expect(() =>
      captureApplyBoundary(false, {
        ...anchoredOperations,
        inspectServices: () => ({
          projectNumber: '987654321',
          services: new Set(BOOTSTRAP_SERVICES),
        }),
      }),
    ).toThrow('different Google projects');
  });

  test('seals only one nonempty unlinked saved-plan inode and its exact bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'psd-eoc-plan-seal-'));
    const plan = join(directory, 'apply.tfplan');
    const link = join(directory, 'linked.tfplan');
    const symbolic = join(directory, 'symbolic.tfplan');
    try {
      writeFileSync(plan, 'synthetic-plan-one', { mode: 0o600 });
      const initialSeal = readSavedPlanSeal(plan);
      expect(initialSeal).toMatch(/[a-f0-9]{64}/u);
      writeFileSync(plan, 'synthetic-plan-two', { mode: 0o600 });
      expect(readSavedPlanSeal(plan)).not.toBe(initialSeal);

      writeFileSync(plan, '', { mode: 0o600 });
      expect(() => readSavedPlanSeal(plan)).toThrow('bounded regular file');

      writeFileSync(plan, 'synthetic-plan-three', { mode: 0o600 });
      chmodSync(plan, 0o644);
      expect(() => readSavedPlanSeal(plan)).toThrow('private bounded');
      chmodSync(plan, 0o600);
      symlinkSync(plan, symbolic);
      expect(() => readSavedPlanSeal(symbolic)).toThrow();

      linkSync(plan, link);
      expect(() => readSavedPlanSeal(plan)).toThrow(
        'no hard or symbolic links',
      );
      expect(() => readSavedPlanSeal(link)).toThrow(
        'no hard or symbolic links',
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test('breaks the new-bucket backend cycle with a non-secret bootstrap root', () => {
    const bootstrap = read('bootstrap/main.tf');
    const main = read('main.tf');
    const apply = read('scripts/apply.ts');

    expect(bootstrap).not.toContain('backend "gcs"');
    expect(bootstrap).not.toContain('google_service_account');
    expect(bootstrap).not.toContain('private_key');
    for (const prerequisite of [
      'serviceusage.googleapis.com',
      'storage.googleapis.com',
      'cloudresourcemanager.googleapis.com',
      'cloudbilling.googleapis.com',
    ]) {
      expect(bootstrap).toContain(prerequisite);
    }
    expect(bootstrap).toMatch(
      /resource "google_storage_bucket" "terraform_state"[\s\S]*depends_on = \[[\s\S]*google_project_service\.cloud_billing,[\s\S]*google_project_service\.cloud_resource_manager,[\s\S]*google_project_service\.storage,[\s\S]*\]/u,
    );
    expect(apply).toContain(
      'google_project_service.required["cloudresourcemanager.googleapis.com"]',
    );
    expect(apply).toContain(
      'google_project_service.required["cloudbilling.googleapis.com"]',
    );
    for (const terraform of [bootstrap, main]) {
      expect(terraform).toContain(
        'resource "google_storage_bucket_iam_policy" "terraform_state"',
      );
      expect(terraform).toContain('role    = "roles/storage.objectAdmin"');
      expect(terraform).toContain('prevent_destroy = true');
      expect(terraform).not.toContain('roles/storage.legacyBucketOwner');
      expect(terraform).not.toContain('projectViewer:');
    }
    expect(apply).toContain(
      "'google_storage_bucket_iam_policy.terraform_state'",
    );
    expect(apply).toContain('`b/${STATE_BUCKET}`');
    expect(apply).toContain("bucketStatus !== 'absent'");
    expect(apply).toContain("['init', '-reconfigure', '-input=false']");
    expect(apply).toContain("'import'");
    expect(apply).toContain("['state', 'rm', ...duplicateResources]");
  });
});

describe('fail-closed bootstrap and process behavior', () => {
  test('allowlists the entire project IAM policy across recovery and steady state', () => {
    const administratorBindings = TERRAFORM_ADMIN_ROLES.map((role) => ({
      members: ['user:kjh_admin@psd401.net'],
      role,
    }));
    const steadyPolicy = { bindings: administratorBindings } as const;
    const recoveryPolicy = {
      bindings: [
        {
          members: ['user:kjh_admin@psd401.net'],
          role: 'roles/owner',
        },
        {
          members: ['user:kjh_admin@psd401.net'],
          role: 'roles/viewer',
        },
        {
          members: [
            'serviceAccount:123456789@cloudservices.gserviceaccount.com',
          ],
          role: 'roles/editor',
        },
      ],
    } as const;

    expect(() =>
      validateProjectIamPolicy(recoveryPolicy, '123456789', 'recovery'),
    ).not.toThrow();
    expect(() =>
      validateProjectIamPolicy(steadyPolicy, '123456789', 'steady-state'),
    ).not.toThrow();
    expect(() =>
      validateProjectIamPolicy(recoveryPolicy, '123456789', 'steady-state'),
    ).toThrow('unexpected role or principal');
    expect(() =>
      validateProjectIamPolicy(
        { bindings: administratorBindings.slice(1) },
        '123456789',
        'steady-state',
      ),
    ).toThrow('missing one or more required');

    for (const binding of [
      {
        members: ['user:outsider@psd401.net'],
        role: 'roles/storage.objectViewer',
      },
      {
        members: ['group:cloud-admins@psd401.net'],
        role: 'roles/storage.admin',
      },
      {
        members: ['user:outsider@psd401.net'],
        role: 'roles/iam.serviceAccountTokenCreator',
      },
      {
        members: ['user:outsider@psd401.net'],
        role: 'projects/psd401-eoc/roles/customStateReader',
      },
      {
        members: [
          'serviceAccount:service-123456789@gcp-sa-firebase.iam.gserviceaccount.com',
        ],
        role: 'roles/firebase.managementServiceAgent',
      },
      {
        members: ['serviceAccount:987654321@cloudservices.gserviceaccount.com'],
        role: 'roles/editor',
      },
    ]) {
      expect(() =>
        validateProjectIamPolicy(
          { bindings: [binding] },
          '123456789',
          'recovery',
        ),
      ).toThrow();
    }

    expect(() =>
      validateProjectIamPolicy(
        {
          bindings: [
            {
              condition: { expression: 'true' },
              members: ['user:kjh_admin@psd401.net'],
              role: 'roles/viewer',
            },
          ],
        },
        '123456789',
        'recovery',
      ),
    ).toThrow('conditional, duplicate, or malformed');
    expect(() =>
      validateProjectIamPolicy(
        {
          bindings: [
            ...administratorBindings,
            {
              members: ['user:kjh_admin@psd401.net'],
              role: 'roles/viewer',
            },
          ],
        },
        '123456789',
        'steady-state',
      ),
    ).toThrow('conditional, duplicate, or malformed');
  });

  test('classifies only fixed recoverable bootstrap API gaps', () => {
    const allServices = new Set<string>(BOOTSTRAP_SERVICES);
    expect(bootstrapPrerequisitesReady('managed-policy', allServices)).toBe(
      true,
    );
    expect(
      bootstrapPrerequisitesReady(
        'managed-policy',
        new Set([...allServices, 'iam.googleapis.com']),
      ),
    ).toBe(true);
    for (const status of ['absent', 'bootstrap-policy'] as const) {
      expect(bootstrapPrerequisitesReady(status, allServices)).toBe(false);
    }
    for (const missing of [
      'cloudresourcemanager.googleapis.com',
      'cloudbilling.googleapis.com',
    ]) {
      const incomplete = new Set<string>(allServices);
      incomplete.delete(missing);
      expect(bootstrapPrerequisitesReady('managed-policy', incomplete)).toBe(
        false,
      );
    }

    const missingResourceManager = new Set(allServices);
    missingResourceManager.delete('cloudresourcemanager.googleapis.com');
    expect(
      missingRecoverableBootstrapApis('managed-policy', missingResourceManager),
    ).toEqual(['cloudresourcemanager.googleapis.com']);

    const missingBilling = new Set(allServices);
    missingBilling.delete('cloudbilling.googleapis.com');
    expect(
      missingRecoverableBootstrapApis('bootstrap-policy', missingBilling),
    ).toEqual(['cloudbilling.googleapis.com']);

    const missingBoth = new Set(allServices);
    missingBoth.delete('cloudresourcemanager.googleapis.com');
    missingBoth.delete('cloudbilling.googleapis.com');
    expect(
      missingRecoverableBootstrapApis('managed-policy', missingBoth),
    ).toEqual([
      'cloudresourcemanager.googleapis.com',
      'cloudbilling.googleapis.com',
    ]);
    expect(
      missingRecoverableBootstrapApis(
        'managed-policy',
        new Set([...allServices, 'iam.googleapis.com']),
      ),
    ).toEqual([]);
    expect(missingRecoverableBootstrapApis('absent', new Set())).toEqual([]);

    for (const trustService of [
      'serviceusage.googleapis.com',
      'storage.googleapis.com',
    ]) {
      const unavailableTrustRoot = new Set(allServices);
      unavailableTrustRoot.delete(trustService);
      expect(() =>
        missingRecoverableBootstrapApis('managed-policy', unavailableTrustRoot),
      ).toThrow('Service Usage and Storage');
    }
  });

  test('parses enabled services and raw bucket ownership from one numeric project', () => {
    const projectNumber = '123456789';
    const serviceNames = [...BOOTSTRAP_SERVICES, 'iam.googleapis.com'];
    const serviceOutput = JSON.stringify(
      serviceNames.map((name) => ({
        config: { name },
        name: `projects/${projectNumber}/services/${name}`,
        state: 'ENABLED',
      })),
    );
    const parsed = parseEnabledProjectServices(serviceOutput);
    expect(parsed.projectNumber).toBe(projectNumber);
    expect(parsed.services).toEqual(new Set(serviceNames));
    expect(
      parseStateBucketOwner(
        JSON.stringify([
          {
            name: 'psd401-eoc-terraform-state',
            projectNumber,
          },
        ]),
      ),
    ).toEqual({ name: 'psd401-eoc-terraform-state', projectNumber });
    expect(
      parseStateBucketOwner(
        JSON.stringify([
          {
            name: 'psd401-eoc-terraform-state',
            projectNumber: 123456789,
          },
        ]),
      ),
    ).toEqual({ name: 'psd401-eoc-terraform-state', projectNumber });

    for (const invalid of [
      'not-json',
      '[]',
      JSON.stringify([
        {
          config: { name: 'storage.googleapis.com' },
          name: 'projects/123456789/services/storage.googleapis.com',
          state: 'DISABLED',
        },
      ]),
      JSON.stringify([
        {
          config: { name: 'storage.googleapis.com' },
          name: 'projects/123456789/services/storage.googleapis.com',
          state: 'ENABLED',
        },
        {
          config: { name: 'serviceusage.googleapis.com' },
          name: 'projects/987654321/services/serviceusage.googleapis.com',
          state: 'ENABLED',
        },
      ]),
    ]) {
      expect(() => parseEnabledProjectServices(invalid)).toThrow();
    }
    for (const invalidOwner of [
      'not-json',
      '[]',
      JSON.stringify([
        {
          name: 'other-bucket',
          projectNumber,
        },
      ]),
      JSON.stringify([
        {
          name: 'psd401-eoc-terraform-state',
          projectNumber,
          unexpected: true,
        },
      ]),
      ...[0, -1, 1.5, '0', 'abc', null].map((invalidProjectNumber) =>
        JSON.stringify([
          {
            name: 'psd401-eoc-terraform-state',
            projectNumber: invalidProjectNumber,
          },
        ]),
      ),
    ]) {
      expect(() => parseStateBucketOwner(invalidOwner)).toThrow();
    }
  });

  test('accepts only exact interrupted local bootstrap state as a repair anchor', () => {
    const state = interruptedBootstrapState({ includeResourceManager: true });
    const inspection = parseInterruptedBootstrapStateResult(
      0,
      JSON.stringify(state),
      '',
    );
    expect(inspection).toMatchObject({
      lineage: '123e4567-e89b-42d3-a456-426614174000',
      projectNumber: '123456789',
      serial: 7,
    });
    expect(inspection?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      parseInterruptedBootstrapStateResult(1, '', 'No state file was found!'),
    ).toBeNull();
    expect(parseInterruptedBootstrapStateResult(0, '', '')).toBeNull();
    expect(
      parseInterruptedBootstrapStateResult(
        0,
        JSON.stringify({ ...state, resources: [] }),
        '',
      ),
    ).toBeNull();

    const resources = state.resources as readonly Readonly<
      Record<string, unknown>
    >[];
    const withoutStorage = resources.filter(
      (resource) => resource.name !== 'storage',
    );
    expect(() =>
      parseInterruptedBootstrapStateResult(
        0,
        JSON.stringify({ ...state, resources: withoutStorage }),
        '',
      ),
    ).toThrow('missing the project, Service Usage, or Storage');

    const project = resources[0] as Readonly<Record<string, unknown>>;
    const projectInstances = project.instances as readonly Readonly<
      Record<string, unknown>
    >[];
    const projectInstance = projectInstances[0] as Readonly<
      Record<string, unknown>
    >;
    const projectAttributes = projectInstance.attributes as Readonly<
      Record<string, unknown>
    >;
    expect(() =>
      parseInterruptedBootstrapStateResult(
        0,
        JSON.stringify({
          ...state,
          resources: [
            {
              ...project,
              instances: [
                {
                  ...projectInstance,
                  attributes: {
                    ...projectAttributes,
                    id: 'psd401-eoc',
                    number: undefined,
                    project_number: '123456789',
                  },
                },
              ],
            },
            ...resources.slice(1),
          ],
        }),
        '',
      ),
    ).toThrow('exact fixed project contract');

    const importedService = resources[1] as Readonly<Record<string, unknown>>;
    const importedServiceInstances =
      importedService.instances as readonly Readonly<Record<string, unknown>>[];
    const importedServiceInstance = importedServiceInstances[0] as Readonly<
      Record<string, unknown>
    >;
    const importedServiceAttributes =
      importedServiceInstance.attributes as Readonly<Record<string, unknown>>;
    expect(() =>
      parseInterruptedBootstrapStateResult(
        0,
        JSON.stringify({
          ...state,
          resources: [
            resources[0],
            {
              ...importedService,
              instances: [
                {
                  ...importedServiceInstance,
                  attributes: {
                    ...importedServiceAttributes,
                    deletion_policy: 'DELETE',
                  },
                },
              ],
            },
            ...resources.slice(2),
          ],
        }),
        '',
      ),
    ).toThrow('exact serviceusage.googleapis.com contract');

    expect(() =>
      parseInterruptedBootstrapStateResult(
        0,
        JSON.stringify({
          ...state,
          resources: [
            {
              ...project,
              instances: [
                { ...projectInstance, sensitive_attributes: [['labels']] },
              ],
            },
            ...resources.slice(1),
          ],
        }),
        '',
      ),
    ).toThrow('deposed, indexed, tainted, sensitive, or malformed');

    expect(() =>
      parseInterruptedBootstrapStateResult(
        0,
        JSON.stringify({
          ...state,
          resources: [
            ...resources,
            {
              instances: [
                {
                  attributes: {},
                  schema_version: 0,
                  sensitive_attributes: [],
                },
              ],
              mode: 'managed',
              name: 'terraform_state',
              provider: 'provider["registry.terraform.io/hashicorp/google"]',
              type: 'google_storage_bucket',
            },
          ],
        }),
        '',
      ),
    ).toThrow('unexpected or duplicate resource');
    expect(() =>
      parseInterruptedBootstrapStateResult(
        1,
        '',
        'Permission denied while reading state',
      ),
    ).toThrow('Permission denied');
  });

  test('accepts only the exact state constructed by bucketless recovery imports', () => {
    const managedState = interruptedBootstrapState({
      includeBilling: true,
      includeResourceManager: true,
    });
    const managedResources = managedState.resources;
    if (!Array.isArray(managedResources)) {
      throw new Error('Synthetic interrupted bootstrap resources were absent.');
    }
    const finalState = parseInterruptedBootstrapStateResult(
      0,
      JSON.stringify({
        ...managedState,
        resources: [
          ...managedResources,
          {
            instances: [
              {
                attributes: {
                  policy_data: JSON.stringify({
                    bindings: [
                      {
                        members: ['user:kjh_admin@psd401.net'],
                        role: 'roles/storage.objectAdmin',
                      },
                    ],
                  }),
                },
                schema_version: 0,
                sensitive_attributes: [],
              },
            ],
            mode: 'data',
            name: 'terraform_state',
            provider: 'provider["registry.terraform.io/hashicorp/google"]',
            type: 'google_iam_policy',
          },
        ],
      }),
      '',
    );
    if (finalState === null) {
      throw new Error('Synthetic interrupted bootstrap state was empty.');
    }
    const expectedManagedResources = new Set(finalState.resources);
    expectedManagedResources.delete(policyDataSourceAddress);
    expect(() =>
      validateRecoveredInterruptedBootstrapState(
        null,
        finalState,
        expectedManagedResources,
      ),
    ).not.toThrow();
    expect(() =>
      validateRecoveredInterruptedBootstrapState(
        null,
        finalState,
        new Set([
          ...expectedManagedResources,
          'google_storage_bucket.unexpected',
        ]),
      ),
    ).toThrow('changed after recovery');

    const earlier = parseInterruptedBootstrapStateResult(
      0,
      JSON.stringify(interruptedBootstrapState({ serial: 9 })),
      '',
    );
    const rolledBack = parseInterruptedBootstrapStateResult(
      0,
      JSON.stringify(interruptedBootstrapState({ serial: 8 })),
      '',
    );
    if (earlier === null || rolledBack === null) {
      throw new Error('Synthetic interrupted bootstrap state was empty.');
    }
    expect(() =>
      validateRecoveredInterruptedBootstrapState(
        earlier,
        rolledBack,
        rolledBack.resources,
      ),
    ).toThrow('changed after recovery');
    expect(() =>
      validateRecoveredInterruptedBootstrapState(
        finalState,
        {
          ...finalState,
          lineage: '223e4567-e89b-42d3-a456-426614174000',
        },
        expectedManagedResources,
      ),
    ).toThrow('changed after recovery');
    expect(() =>
      validateRecoveredInterruptedBootstrapState(
        finalState,
        { ...finalState, projectNumber: '987654321' },
        expectedManagedResources,
      ),
    ).toThrow('changed after recovery');
  });

  test('repairs an exact bucketless interrupted bootstrap before any import or plan', async () => {
    const inspection = parseInterruptedBootstrapStateResult(
      0,
      JSON.stringify(interruptedBootstrapState()),
      '',
    );
    if (inspection === null) {
      throw new Error('Synthetic interrupted bootstrap state was empty.');
    }
    const services = new Set<string>(BOOTSTRAP_SERVICES);
    services.delete('cloudresourcemanager.googleapis.com');
    services.delete('cloudbilling.googleapis.com');
    const trace: string[] = [];
    let preview = '';
    let confirmation = '';

    await repairInterruptedBootstrapApis({
      assertOperatorIdentity: async () => {
        trace.push('identity');
      },
      confirm: async (value, phrase) => {
        trace.push('confirm');
        preview = value;
        confirmation = phrase;
      },
      enableServices: (missing) => {
        trace.push(`enable:${missing.join(',')}`);
        for (const service of missing) {
          services.add(service);
        }
      },
      inspectBucket: () => {
        trace.push('bucket');
        return null;
      },
      inspectServices: () => {
        trace.push('services');
        return {
          projectNumber: inspection.projectNumber,
          services: new Set(services),
        };
      },
      inspectState: () => {
        trace.push('state');
        return inspection;
      },
      validateProject: (projectNumber) => {
        trace.push(`project:${projectNumber}`);
      },
    });

    expect(trace).toEqual([
      'state',
      'bucket',
      'services',
      'confirm',
      'identity',
      'bucket',
      'state',
      'services',
      'enable:cloudresourcemanager.googleapis.com,cloudbilling.googleapis.com',
      'services',
      'state',
      'project:123456789',
      'bucket',
      'state',
    ]);
    expect(preview).toContain('does not exist yet');
    expect(preview).toContain('billable API use');
    expect(confirmation).toBe('repair-psd401-eoc-interrupted-bootstrap-apis');
  });

  test('bucketless interrupted-bootstrap repair fails closed on changed trust evidence', async () => {
    const initial = parseInterruptedBootstrapStateResult(
      0,
      JSON.stringify(interruptedBootstrapState()),
      '',
    );
    const changed = parseInterruptedBootstrapStateResult(
      0,
      JSON.stringify(interruptedBootstrapState({ serial: 8 })),
      '',
    );
    if (initial === null || changed === null) {
      throw new Error('Synthetic interrupted bootstrap state was empty.');
    }
    const services = new Set<string>(BOOTSTRAP_SERVICES);
    services.delete('cloudbilling.googleapis.com');
    const calls: string[] = [];
    let stateReads = 0;
    await expect(
      repairInterruptedBootstrapApis({
        assertOperatorIdentity: async () => {
          calls.push('identity');
        },
        confirm: async () => {
          calls.push('confirm');
        },
        enableServices: () => calls.push('enable'),
        inspectBucket: () => null,
        inspectServices: () => ({
          projectNumber: initial.projectNumber,
          services,
        }),
        inspectState: () => {
          stateReads += 1;
          return stateReads === 1 ? initial : changed;
        },
        validateProject: () => calls.push('project'),
      }),
    ).rejects.toThrow('Local bootstrap state changed');
    expect(calls).toEqual(['confirm', 'identity']);

    let bucketReads = 0;
    await expect(
      repairInterruptedBootstrapApis({
        assertOperatorIdentity: async () => {},
        confirm: async () => {},
        enableServices: () => calls.push('enable'),
        inspectBucket: () => {
          bucketReads += 1;
          return bucketReads === 1
            ? null
            : {
                projectNumber: initial.projectNumber,
                status: 'managed-policy',
              };
        },
        inspectServices: () => ({
          projectNumber: initial.projectNumber,
          services,
        }),
        inspectState: () => initial,
        validateProject: () => calls.push('project'),
      }),
    ).rejects.toThrow('appeared during interrupted-bootstrap confirmation');
    expect(calls).not.toContain('enable');

    const repairServices = new Set<string>(BOOTSTRAP_SERVICES);
    repairServices.delete('cloudbilling.googleapis.com');
    let currentState = initial;
    await expect(
      repairInterruptedBootstrapApis({
        assertOperatorIdentity: async () => {},
        confirm: async () => {},
        enableServices: (missing) => {
          for (const service of missing) {
            repairServices.add(service);
          }
        },
        inspectBucket: () => null,
        inspectServices: () => ({
          projectNumber: initial.projectNumber,
          services: new Set(repairServices),
        }),
        inspectState: () => currentState,
        validateProject: () => {
          currentState = changed;
        },
      }),
    ).rejects.toThrow('changed during live project validation');
  });

  test('concurrent bucketless API repair skips mutation but completes validation', async () => {
    const inspection = parseInterruptedBootstrapStateResult(
      0,
      JSON.stringify(interruptedBootstrapState()),
      '',
    );
    if (inspection === null) {
      throw new Error('Synthetic interrupted bootstrap state was empty.');
    }
    const missingBilling = new Set<string>(BOOTSTRAP_SERVICES);
    missingBilling.delete('cloudbilling.googleapis.com');
    const trace: string[] = [];
    let serviceReads = 0;
    await repairInterruptedBootstrapApis({
      assertOperatorIdentity: async () => {
        trace.push('identity');
      },
      confirm: async () => {
        trace.push('confirm');
      },
      enableServices: () => trace.push('enable'),
      inspectBucket: () => {
        trace.push('bucket');
        return null;
      },
      inspectServices: () => {
        trace.push('services');
        serviceReads += 1;
        return {
          projectNumber: inspection.projectNumber,
          services:
            serviceReads === 1
              ? new Set(missingBilling)
              : new Set(BOOTSTRAP_SERVICES),
        };
      },
      inspectState: () => {
        trace.push('state');
        return inspection;
      },
      validateProject: () => trace.push('project'),
    });
    expect(trace).toEqual([
      'state',
      'bucket',
      'services',
      'confirm',
      'identity',
      'bucket',
      'state',
      'services',
      'state',
      'project',
      'bucket',
      'state',
    ]);
    expect(trace).not.toContain('enable');
  });

  test('bucketless recovery is a no-op only for genuinely fresh state', async () => {
    const trace: string[] = [];
    await repairInterruptedBootstrapApis({
      assertOperatorIdentity: async () => {
        trace.push('identity');
      },
      confirm: async () => {
        trace.push('confirm');
      },
      enableServices: () => trace.push('enable'),
      inspectBucket: () => {
        trace.push('bucket');
        return null;
      },
      inspectServices: () => {
        trace.push('services');
        return { projectNumber: '123456789', services: BOOTSTRAP_SERVICES };
      },
      inspectState: () => {
        trace.push('state');
        return null;
      },
      validateProject: () => trace.push('project'),
    });
    expect(trace).toEqual(['state']);
  });

  test('repairs one missing API only after confirmation and revalidation', async () => {
    const projectNumber = '123456789';
    const bucket = {
      projectNumber,
      status: 'managed-policy' as const,
    };
    const services = new Set<string>(BOOTSTRAP_SERVICES);
    services.delete('cloudresourcemanager.googleapis.com');
    const trace: string[] = [];
    let preview = '';
    let confirmation = '';

    await repairMissingBootstrapApis({
      assertOperatorIdentity: async () => {
        trace.push('identity');
      },
      confirm: async (value, phrase) => {
        trace.push('confirm');
        preview = value;
        confirmation = phrase;
      },
      enableServices: (missing) => {
        trace.push(`enable:${missing.join(',')}`);
        expect(missing).toEqual(['cloudresourcemanager.googleapis.com']);
        for (const service of missing) {
          services.add(service);
        }
      },
      inspectBucket: () => {
        trace.push('bucket');
        return bucket;
      },
      inspectServices: () => {
        trace.push('services');
        return { projectNumber, services: new Set(services) };
      },
    });

    expect(trace).toEqual([
      'bucket',
      'services',
      'confirm',
      'identity',
      'bucket',
      'services',
      'enable:cloudresourcemanager.googleapis.com',
      'services',
    ]);
    expect(preview).toContain('psd401-eoc');
    expect(preview).toContain(projectNumber);
    expect(preview).toContain('cloudresourcemanager.googleapis.com');
    expect(preview).toContain('billable API use');
    expect(confirmation).toBe('repair-psd401-eoc-bootstrap-apis');
  });

  test('aborts API repair when post-confirmation evidence changes', async () => {
    const projectNumber = '123456789';
    const bucket = {
      projectNumber,
      status: 'managed-policy' as const,
    };
    const initialServices = new Set(BOOTSTRAP_SERVICES);
    initialServices.delete('cloudresourcemanager.googleapis.com');
    let bucketReads = 0;
    const enabled: string[][] = [];

    await expect(
      repairMissingBootstrapApis({
        assertOperatorIdentity: async () => {},
        confirm: async () => {},
        enableServices: (services) => enabled.push([...services]),
        inspectBucket: () => {
          bucketReads += 1;
          return bucketReads === 1
            ? bucket
            : { ...bucket, status: 'bootstrap-policy' };
        },
        inspectServices: () => ({
          projectNumber,
          services: new Set(initialServices),
        }),
      }),
    ).rejects.toThrow('changed during bootstrap API repair confirmation');
    expect(enabled).toEqual([]);

    let serviceReads = 0;
    await expect(
      repairMissingBootstrapApis({
        assertOperatorIdentity: async () => {},
        confirm: async () => {},
        enableServices: (services) => enabled.push([...services]),
        inspectBucket: () => bucket,
        inspectServices: () => {
          serviceReads += 1;
          const services = new Set(initialServices);
          if (serviceReads > 1) {
            services.delete('cloudbilling.googleapis.com');
          }
          return { projectNumber, services };
        },
      }),
    ).rejects.toThrow('expanded during confirmation');
    expect(enabled).toEqual([]);
  });

  test('rejects untrusted repair evidence before confirmation or enable', async () => {
    const calls: string[] = [];
    const bucket = {
      projectNumber: '123456789',
      status: 'managed-policy' as const,
    };
    const missingStorage = new Set(BOOTSTRAP_SERVICES);
    missingStorage.delete('storage.googleapis.com');
    const operations = {
      assertOperatorIdentity: async () => {
        calls.push('identity');
      },
      confirm: async () => {
        calls.push('confirm');
      },
      enableServices: () => calls.push('enable'),
      inspectBucket: () => bucket,
    };

    await expect(
      repairMissingBootstrapApis({
        ...operations,
        inspectServices: () => ({
          projectNumber: bucket.projectNumber,
          services: missingStorage,
        }),
      }),
    ).rejects.toThrow('Service Usage and Storage');
    expect(calls).toEqual([]);

    await expect(
      repairMissingBootstrapApis({
        ...operations,
        inspectServices: () => ({
          projectNumber: '987654321',
          services: BOOTSTRAP_SERVICES,
        }),
      }),
    ).rejects.toThrow('different Google projects');
    expect(calls).toEqual([]);
  });

  test('API repair is a no-op when absent or concurrently repaired', async () => {
    const trace: string[] = [];
    await repairMissingBootstrapApis({
      assertOperatorIdentity: async () => {
        trace.push('identity');
      },
      confirm: async () => {
        trace.push('confirm');
      },
      enableServices: () => trace.push('enable'),
      inspectBucket: () => {
        trace.push('bucket');
        return null;
      },
      inspectServices: () => {
        trace.push('services');
        return { projectNumber: '123456789', services: BOOTSTRAP_SERVICES };
      },
    });
    expect(trace).toEqual(['bucket']);

    const projectNumber = '123456789';
    let serviceReads = 0;
    const concurrentTrace: string[] = [];
    const initiallyMissing = new Set(BOOTSTRAP_SERVICES);
    initiallyMissing.delete('cloudbilling.googleapis.com');
    await repairMissingBootstrapApis({
      assertOperatorIdentity: async () => {
        concurrentTrace.push('identity');
      },
      confirm: async () => {
        concurrentTrace.push('confirm');
      },
      enableServices: () => concurrentTrace.push('enable'),
      inspectBucket: () => {
        concurrentTrace.push('bucket');
        return {
          projectNumber,
          status: 'managed-policy',
        };
      },
      inspectServices: () => {
        concurrentTrace.push('services');
        serviceReads += 1;
        return {
          projectNumber,
          services:
            serviceReads === 1
              ? new Set(initiallyMissing)
              : new Set(BOOTSTRAP_SERVICES),
        };
      },
    });
    expect(concurrentTrace).toEqual([
      'bucket',
      'services',
      'confirm',
      'identity',
      'bucket',
      'services',
    ]);
  });

  test('partially completed API repair retries only the remaining service', async () => {
    const projectNumber = '123456789';
    const services = new Set<string>(BOOTSTRAP_SERVICES);
    services.delete('cloudresourcemanager.googleapis.com');
    services.delete('cloudbilling.googleapis.com');
    const enabled: string[][] = [];
    const operations = {
      assertOperatorIdentity: async () => {},
      confirm: async () => {},
      enableServices: (missing: readonly string[]) => {
        enabled.push([...missing]);
        const firstMissing = missing[0];
        if (firstMissing !== undefined) {
          services.add(firstMissing);
        }
      },
      inspectBucket: () => ({
        projectNumber,
        status: 'managed-policy' as const,
      }),
      inspectServices: () => ({
        projectNumber,
        services: new Set(services),
      }),
    };

    await expect(repairMissingBootstrapApis(operations)).rejects.toThrow(
      'did not enable the exact bootstrap inspection APIs',
    );
    await repairMissingBootstrapApis(operations);
    expect(enabled).toEqual([
      ['cloudresourcemanager.googleapis.com', 'cloudbilling.googleapis.com'],
      ['cloudbilling.googleapis.com'],
    ]);
  });

  test('recovers bucket-backed bootstrap state through exact ordered imports', () => {
    const persistedResources = new Set<string>();
    const imports: [string, string][] = [];
    let bucketReads = 0;
    let stateReads = 0;
    const operations: Parameters<typeof recoverBootstrapState>[0] = {
      inspectBucketStatus: () => {
        bucketReads += 1;
        return 'managed-policy';
      },
      inspectInterruptedState: () => {
        throw new Error(
          'Local interrupted state must not anchor bucket-backed recovery.',
        );
      },
      inspectStateResources: () => {
        stateReads += 1;
        return new Set([
          ...persistedResources,
          ...(stateReads === 2
            ? ['data.google_iam_policy.terraform_state']
            : []),
        ]);
      },
      inspectProject: () => validProject,
      validateExistingProject: (project) => {
        expect(project).toBe(validProject);
        return validBilling;
      },
      inspectProjectIamPolicy: () => ({ bindings: [] }),
      inspectEnabledServices: () => new Set(BOOTSTRAP_SERVICES),
      importResource: (address, importId) => {
        imports.push([address, importId]);
        persistedResources.add(address);
      },
    };

    recoverBootstrapState(operations);
    expect(imports).toEqual([
      ['google_project.psd_eoc', 'psd401-eoc'],
      [
        'google_project_service.service_usage',
        'psd401-eoc/serviceusage.googleapis.com',
      ],
      ['google_project_service.storage', 'psd401-eoc/storage.googleapis.com'],
      [
        'google_project_service.cloud_resource_manager',
        'psd401-eoc/cloudresourcemanager.googleapis.com',
      ],
      [
        'google_project_service.cloud_billing',
        'psd401-eoc/cloudbilling.googleapis.com',
      ],
      ['google_storage_bucket.terraform_state', 'psd401-eoc-terraform-state'],
      [
        'google_storage_bucket_iam_policy.terraform_state',
        'b/psd401-eoc-terraform-state',
      ],
    ]);
    expect(bucketReads).toBe(2);
    expect(stateReads).toBe(2);
    expect(persistedResources).toEqual(
      new Set(imports.map(([address]) => address)),
    );
  });

  test('recovers bucketless bootstrap state without importing bucket resources', () => {
    const persistedResources = new Set<string>();
    const imports: [string, string][] = [];
    let interruptedStateReads = 0;
    let stateResourceReads = 0;
    const operations: Parameters<typeof recoverBootstrapState>[0] = {
      inspectBucketStatus: () => 'absent',
      inspectInterruptedState: () => {
        interruptedStateReads += 1;
        if (interruptedStateReads === 1) {
          return null;
        }
        return {
          fingerprint: 'synthetic-final-fingerprint',
          lineage: '123e4567-e89b-42d3-a456-426614174000',
          projectNumber: validProject.projectNumber,
          resources: new Set([...persistedResources, policyDataSourceAddress]),
          serial: 1,
        };
      },
      inspectStateResources: () => {
        stateResourceReads += 1;
        return new Set([...persistedResources, policyDataSourceAddress]);
      },
      inspectProject: () => validProject,
      validateExistingProject: () => validBilling,
      inspectProjectIamPolicy: () => ({ bindings: [] }),
      inspectEnabledServices: () => new Set(BOOTSTRAP_SERVICES),
      importResource: (address, importId) => {
        imports.push([address, importId]);
        persistedResources.add(address);
      },
    };

    recoverBootstrapState(operations);
    expect(imports.map(([address]) => address)).toEqual([
      'google_project.psd_eoc',
      'google_project_service.service_usage',
      'google_project_service.storage',
      'google_project_service.cloud_resource_manager',
      'google_project_service.cloud_billing',
    ]);
    expect(
      imports.some(([address]) => address.includes('storage_bucket')),
    ).toBe(false);
    expect(interruptedStateReads).toBe(2);
    expect(stateResourceReads).toBe(1);
  });

  test('fails bootstrap-state recovery closed on anchor and final-state drift', () => {
    const forbiddenImport = (): never => {
      throw new Error('No import was expected.');
    };
    const base: Parameters<typeof recoverBootstrapState>[0] = {
      inspectBucketStatus: () => 'managed-policy',
      inspectInterruptedState: () => null,
      inspectStateResources: () => new Set(),
      inspectProject: () => validProject,
      validateExistingProject: () => validBilling,
      inspectProjectIamPolicy: () => ({ bindings: [] }),
      inspectEnabledServices: () => new Set(BOOTSTRAP_SERVICES),
      importResource: forbiddenImport,
    };

    expect(() =>
      recoverBootstrapState({
        ...base,
        inspectStateResources: () =>
          new Set(['google_storage_bucket.unreviewed']),
      }),
    ).toThrow('unexpected resource');
    expect(() =>
      recoverBootstrapState({
        ...base,
        inspectStateResources: () => new Set(['google_project.psd_eoc']),
        inspectProject: () => null,
      }),
    ).toThrow('contains the project but Google cannot verify it');

    let bucketReads = 0;
    const importedDuringBucketDrift = new Set<string>();
    expect(() =>
      recoverBootstrapState({
        ...base,
        inspectBucketStatus: () => {
          bucketReads += 1;
          return bucketReads === 1 ? 'managed-policy' : 'bootstrap-policy';
        },
        importResource: (address) => {
          importedDuringBucketDrift.add(address);
        },
      }),
    ).toThrow('state bucket changed during bootstrap recovery');
    expect(bucketReads).toBe(2);

    let lossyStateReads = 0;
    const importedBeforeLoss = new Set<string>();
    expect(() =>
      recoverBootstrapState({
        ...base,
        inspectStateResources: () => {
          lossyStateReads += 1;
          return lossyStateReads === 1
            ? new Set()
            : new Set(
                [...importedBeforeLoss].filter(
                  (address) =>
                    address !== 'google_project_service.cloud_billing',
                ),
              );
        },
        importResource: (address) => {
          importedBeforeLoss.add(address);
        },
      }),
    ).toThrow('Bucket-backed bootstrap state changed after recovery');
    expect(importedBeforeLoss.has('google_project_service.cloud_billing')).toBe(
      true,
    );
    expect(lossyStateReads).toBe(2);

    let concurrentStateReads = 0;
    const importedBeforeConcurrentChange = new Set<string>();
    expect(() =>
      recoverBootstrapState({
        ...base,
        inspectEnabledServices: () => new Set(),
        inspectStateResources: () => {
          concurrentStateReads += 1;
          return concurrentStateReads === 1
            ? new Set()
            : new Set([
                ...importedBeforeConcurrentChange,
                'google_project_service.storage',
              ]);
        },
        importResource: (address) => {
          importedBeforeConcurrentChange.add(address);
        },
      }),
    ).toThrow('Bucket-backed bootstrap state changed after recovery');
    expect(concurrentStateReads).toBe(2);

    const persistedResources = new Set<string>();
    let interruptedStateReads = 0;
    expect(() =>
      recoverBootstrapState({
        ...base,
        inspectBucketStatus: () => 'absent',
        inspectInterruptedState: () => {
          interruptedStateReads += 1;
          return interruptedStateReads === 1
            ? null
            : {
                fingerprint: 'synthetic-final-fingerprint',
                lineage: '123e4567-e89b-42d3-a456-426614174000',
                projectNumber: validProject.projectNumber,
                resources: new Set([
                  ...[...persistedResources].filter(
                    (address) =>
                      address !== 'google_project_service.cloud_billing',
                  ),
                  policyDataSourceAddress,
                ]),
                serial: 1,
              };
        },
        inspectStateResources: () => new Set(persistedResources),
        importResource: (address) => {
          persistedResources.add(address);
        },
      }),
    ).toThrow('Local bootstrap state changed after recovery');
    expect(interruptedStateReads).toBe(2);
  });

  test('repairs APIs before full validation or Terraform initialization', () => {
    const apply = read('scripts/apply.ts');
    const inspection = apply.slice(
      apply.indexOf('function inspectStateBucketForApiRepair'),
      apply.indexOf('function stateBucketStatus'),
    );
    expect(inspection).toContain("'storage'");
    expect(inspection).toContain('parseStateBucketOwner(');
    expect(inspection).toContain('validateStateBucket(');
    expect(inspection).toMatch(
      /'buckets',[\s\S]*'list',[\s\S]*'--project',[\s\S]*PROJECT_ID/u,
    );
    expect(inspection).toContain("'--raw'");
    expect(inspection).toContain("'--format=json(name,projectNumber)'");
    expect(inspection).toContain("'get-iam-policy'");
    expect(inspection).toContain('`gs://${STATE_BUCKET}`');
    expect(inspection).not.toContain('inspectProject()');
    expect(inspection).not.toContain('validateExistingProject(');
    expect(inspection).not.toContain('projectIamPolicy()');

    const fullValidation = apply.slice(
      apply.indexOf('function stateBucketStatus'),
      apply.indexOf('export function parseStateListResult'),
    );
    expect(fullValidation).toContain('inspectStateBucketForApiRepair(');
    expect(fullValidation).toContain('inspectProject()');
    expect(fullValidation).toContain('validateExistingProject(project)');
    expect(fullValidation).toContain('projectIamPolicy()');

    const main = apply.slice(apply.indexOf('async function main'));
    const repair = main.indexOf('await repairMissingBootstrapApis');
    const fullStateValidation = main.indexOf(
      'const initialBucketStatus = stateBucketStatus(true)',
    );
    const bootstrapInit = main.indexOf(
      "['init', '-reconfigure', '-input=false']",
    );
    const interruptedRepair = main.indexOf(
      'await repairInterruptedBootstrapApis',
    );
    const remoteInit = main.indexOf(
      "runInteractive('terraform', ['init', '-reconfigure', '-input=false'])",
    );
    expect(repair).toBeGreaterThan(-1);
    expect(repair).toBeLessThan(fullStateValidation);
    expect(main).toContain(
      "['services', 'enable', ...services, '--project', PROJECT_ID, '--quiet']",
    );
    expect(fullStateValidation).toBeLessThan(bootstrapInit);
    expect(bootstrapInit).toBeLessThan(remoteInit);
    const recovery = main.indexOf(
      'recoverBootstrapState(liveBootstrapStateRecoveryOperations)',
    );
    expect(interruptedRepair).toBeGreaterThan(bootstrapInit);
    expect(interruptedRepair).toBeLessThan(recovery);
    expect(recovery).toBeGreaterThan(bootstrapInit);
    expect(recovery).toBeLessThan(remoteInit);
    expect(apply).toContain("if (bucketStatus !== 'absent')");
  });

  test('refuses every persisted non-default Terraform workspace', () => {
    expect(() => validateTerraformWorkspace('default')).not.toThrow();
    expect(() => validateTerraformWorkspace('production-shadow')).toThrow(
      'Terraform workspace must be default',
    );

    const runtime = read('scripts/runtime.ts');
    expect(runtime).toContain("runCommand('terraform', ['workspace', 'show']");
    const apply = read('scripts/apply.ts');
    expect(apply).toContain('assertDefaultTerraformWorkspace(bootstrapRoot)');
    expect(apply).toContain('assertDefaultTerraformWorkspace();');

    for (const path of [
      'scripts/groups-contract.ts',
      'scripts/store-oauth-client.ts',
    ]) {
      const helper = read(path);
      expect(helper).toMatch(
        /assertDefaultTerraformWorkspace\(\);[\s\S]*runCommand\('terraform', \['output'/u,
      );
    }
  });

  test('imports into a genuinely empty remote backend without hiding errors', () => {
    expect(
      parseStateListResult(
        1,
        '',
        'No state file was found! State management commands require a state file.',
      ),
    ).toEqual(new Set());
    expect(parseStateListResult(0, 'google_project.psd_eoc\n', '')).toEqual(
      new Set(['google_project.psd_eoc']),
    );
    expect(() =>
      parseStateListResult(1, '', 'Error acquiring the state lock'),
    ).toThrow('Error acquiring the state lock');
  });

  test('allowlists every main-state address before planning and after apply', () => {
    const complete = new Set([
      'google_project.psd_eoc',
      'google_project_service.service_usage',
      ...[
        'admin.googleapis.com',
        'cloudbilling.googleapis.com',
        'cloudidentity.googleapis.com',
        'cloudresourcemanager.googleapis.com',
        'iam.googleapis.com',
        'storage.googleapis.com',
      ].map((service) => `google_project_service.required["${service}"]`),
      ...TERRAFORM_ADMIN_ROLES.map(
        (role) => `google_project_iam_member.terraform_admin["${role}"]`,
      ),
      'google_project_iam_member_remove.terraform_admin_owner',
      'google_project_iam_member_remove.google_apis_service_agent_editor',
      'google_storage_bucket.terraform_state',
      'data.google_iam_policy.terraform_state',
      'google_storage_bucket_iam_policy.terraform_state',
      'google_service_account.roster_reader',
    ]);
    expect(complete.size).toBe(23);
    expect(() => validateMainStateAddresses(complete, true)).not.toThrow();
    expect(() =>
      validateMainStateAddresses(
        new Set([...complete, 'google_storage_bucket.unreviewed']),
      ),
    ).toThrow('unexpected resource');
    const incomplete = new Set(complete);
    incomplete.delete('google_service_account.roster_reader');
    expect(() => validateMainStateAddresses(incomplete)).not.toThrow();
    expect(() => validateMainStateAddresses(incomplete, true)).toThrow(
      'complete reviewed resource set',
    );

    const main = read('scripts/apply.ts').slice(
      read('scripts/apply.ts').indexOf('async function main'),
    );
    expect(main).toMatch(
      /const managedResources = stateResources\(\);\s*validateMainStateAddresses\(managedResources\)/u,
    );
    expect(main).toMatch(
      /recoverOrphanedRosterReader\(\s*managedResources,\s*liveOrphanedRosterReaderRecoveryOperations,\s*\);\s*validateMainStateAddresses\(stateResources\(\)\);\s*await applySavedPlan/u,
    );
    expect(main).toMatch(
      /const finalResources = stateResources\(\);\s*validateMainStateAddresses\(finalResources, true\)/u,
    );
  });

  test('recovers only the exact harmless orphaned roster-reader account', () => {
    expect(parseServiceAccountListResult(0, '[]', '')).toBeNull();
    expect(
      parseServiceAccountListResult(
        0,
        JSON.stringify([
          {
            email: 'unrelated@psd401-eoc.iam.gserviceaccount.com',
          },
          validLiveGroupsReader,
        ]),
        '',
      ),
    ).toEqual(validLiveGroupsReader);
    expect(() =>
      parseServiceAccountListResult(
        1,
        '',
        'PERMISSION_DENIED: caller cannot list service accounts',
      ),
    ).toThrow('PERMISSION_DENIED');
    expect(() =>
      parseServiceAccountListResult(
        0,
        JSON.stringify([{ displayName: 'missing email' }]),
        '',
      ),
    ).toThrow('malformed metadata');
    expect(() =>
      parseServiceAccountListResult(0, JSON.stringify({}), ''),
    ).toThrow('one JSON array');
    expect(() =>
      parseServiceAccountListResult(
        0,
        JSON.stringify([validLiveGroupsReader, validLiveGroupsReader]),
        '',
      ),
    ).toThrow('exactly the fixed account');

    expect(() =>
      validateRecoverableRosterReaderServiceAccount(
        validLiveGroupsReader,
        {},
        '',
      ),
    ).not.toThrow();
    const firstManagedKey = `projects/psd401-eoc/serviceAccounts/${ROSTER_READER_EMAIL}/keys/${'a'.repeat(40)}`;
    const secondManagedKey = `projects/psd401-eoc/serviceAccounts/${ROSTER_READER_EMAIL}/keys/${'b'.repeat(40)}`;
    expect(
      validateManagedRosterReaderServiceAccount(
        validLiveGroupsReader,
        {},
        firstManagedKey,
      ),
    ).toEqual(new Set(['a'.repeat(40)]));
    const zeroKeyBoundary = validateManagedRosterReaderBoundary(
      validLiveGroupsReader,
      {},
      '',
    );
    const firstKeyBoundary = validateManagedRosterReaderBoundary(
      validLiveGroupsReader,
      {},
      firstManagedKey,
    );
    const secondKeyBoundary = validateManagedRosterReaderBoundary(
      validLiveGroupsReader,
      {},
      secondManagedKey,
    );
    expect(zeroKeyBoundary.userManagedKeyIds).toEqual(new Set());
    expect(firstKeyBoundary.userManagedKeyIds).toEqual(
      new Set(['a'.repeat(40)]),
    );
    expect(zeroKeyBoundary.seal).not.toBe(firstKeyBoundary.seal);
    expect(firstKeyBoundary.seal).not.toBe(secondKeyBoundary.seal);
    expect(
      validateManagedRosterReaderBoundary(
        { ...validLiveGroupsReader },
        {},
        firstManagedKey,
      ).seal,
    ).toBe(firstKeyBoundary.seal);
    expect(() =>
      validateManagedRosterReaderServiceAccount(
        validLiveGroupsReader,
        {},
        `${firstManagedKey}\n${secondManagedKey}`,
      ),
    ).toThrow('more than one user-managed key');
    expect(() =>
      validateManagedRosterReaderServiceAccount(
        validLiveGroupsReader,
        {},
        'malformed-key-response',
      ),
    ).toThrow('invalid service-account key');
    expect(() =>
      validateManagedRosterReaderServiceAccount(
        validLiveGroupsReader,
        {},
        `projects/wrong/serviceAccounts/${ROSTER_READER_EMAIL}/keys/${'a'.repeat(40)}`,
      ),
    ).toThrow('invalid service-account key resource name');
    expect(() =>
      validateManagedRosterReaderServiceAccount(
        validLiveGroupsReader,
        {},
        `${firstManagedKey}\n${firstManagedKey}`,
      ),
    ).toThrow('duplicate service-account key record');
    expect(() =>
      validateRecoverableRosterReaderServiceAccount(
        validLiveGroupsReader,
        {},
        firstManagedKey,
      ),
    ).toThrow('cannot be adopted');
    for (const invalid of [
      { ...validLiveGroupsReader, name: 'projects/wrong/serviceAccounts/fake' },
      { ...validLiveGroupsReader, email: 'lookalike@example.invalid' },
      { ...validLiveGroupsReader, projectId: 'wrong-project' },
      { ...validLiveGroupsReader, displayName: 'Lookalike reader' },
      { ...validLiveGroupsReader, description: 'Unexpected purpose' },
      { ...validLiveGroupsReader, disabled: true },
      { ...validLiveGroupsReader, uniqueId: 'not-numeric' },
      { ...validLiveGroupsReader, oauth2ClientId: 'not-numeric' },
    ]) {
      expect(() =>
        validateRecoverableRosterReaderServiceAccount(invalid, {}, ''),
      ).toThrow('exact Terraform identity');
    }
    expect(() =>
      validateRecoverableRosterReaderServiceAccount(
        validLiveGroupsReader,
        {
          bindings: [
            {
              members: ['user:attacker@example.invalid'],
              role: 'roles/iam.serviceAccountTokenCreator',
            },
          ],
        },
        '',
      ),
    ).toThrow('direct resource IAM binding');
    expect(() =>
      validateRecoverableRosterReaderServiceAccount(
        validLiveGroupsReader,
        {},
        `projects/psd401-eoc/serviceAccounts/${ROSTER_READER_EMAIL}/keys/${'a'.repeat(40)}`,
      ),
    ).toThrow('user-managed key');

    const apply = read('scripts/apply.ts');
    const recoveryCall = apply.lastIndexOf('recoverOrphanedRosterReader(');
    expect(recoveryCall).toBeGreaterThan(-1);
    expect(recoveryCall).toBeLessThan(
      apply.indexOf("confirmation: 'apply-psd401-eoc-gcp'"),
    );
    expect(apply).toContain(
      '`projects/${PROJECT_ID}/serviceAccounts/${ROSTER_READER_EMAIL}`',
    );
    expect(apply).not.toContain('create_ignore_already_exists');
  });

  test('adopts an orphaned roster reader only through the exact injected identity', () => {
    const address = 'google_service_account.roster_reader';
    const resources = new Set<string>();
    const trace: string[] = [];
    const operations: Parameters<typeof recoverOrphanedRosterReader>[1] = {
      inspectEnabledServices: () => {
        trace.push('services');
        return new Set(['iam.googleapis.com']);
      },
      inspectRosterReader: () => {
        trace.push('roster');
        return validLiveGroupsReader;
      },
      validateRosterReader: (serviceAccount) => {
        trace.push('validate');
        expect(serviceAccount).toBe(validLiveGroupsReader);
        return 'synthetic-roster-reader-seal';
      },
      importResource: (resourceAddress, importId) => {
        trace.push(`import:${resourceAddress}:${importId}`);
        expect(resources.has(address)).toBe(false);
      },
    };

    recoverOrphanedRosterReader(resources, operations);
    expect(resources).toEqual(new Set([address]));
    expect(trace).toEqual([
      'services',
      'roster',
      'validate',
      `import:${address}:projects/psd401-eoc/serviceAccounts/${ROSTER_READER_EMAIL}`,
      'roster',
      'validate',
    ]);

    trace.length = 0;
    recoverOrphanedRosterReader(resources, {
      ...operations,
      inspectEnabledServices: () => {
        throw new Error('A managed account must not be inspected again.');
      },
    });
    expect(trace).toEqual([]);

    const disabledTrace: string[] = [];
    recoverOrphanedRosterReader(new Set(), {
      ...operations,
      inspectEnabledServices: () => {
        disabledTrace.push('services');
        return new Set();
      },
      inspectRosterReader: () => {
        throw new Error(
          'Roster inspection must not run while IAM is disabled.',
        );
      },
    });
    expect(disabledTrace).toEqual(['services']);

    const absentTrace: string[] = [];
    recoverOrphanedRosterReader(new Set(), {
      ...operations,
      inspectEnabledServices: () => {
        absentTrace.push('services');
        return new Set(['iam.googleapis.com']);
      },
      inspectRosterReader: () => {
        absentTrace.push('roster');
        return null;
      },
    });
    expect(absentTrace).toEqual(['services', 'roster']);
  });

  test('fails orphaned roster-reader recovery closed after an import race', () => {
    const address = 'google_service_account.roster_reader';
    for (const postImportAccount of [
      null,
      { ...validLiveGroupsReader, uniqueId: '111111111111111111111' },
      { ...validLiveGroupsReader, oauth2ClientId: '222222222222222222222' },
    ]) {
      const resources = new Set<string>();
      let rosterReads = 0;
      expect(() =>
        recoverOrphanedRosterReader(resources, {
          inspectEnabledServices: () => new Set(['iam.googleapis.com']),
          inspectRosterReader: () => {
            rosterReads += 1;
            return rosterReads === 1
              ? validLiveGroupsReader
              : postImportAccount;
          },
          validateRosterReader: () => 'synthetic-roster-reader-seal',
          importResource: (resourceAddress, importId) => {
            expect(resourceAddress).toBe(address);
            expect(importId).toBe(
              `projects/psd401-eoc/serviceAccounts/${ROSTER_READER_EMAIL}`,
            );
          },
        }),
      ).toThrow(
        postImportAccount === null
          ? 'disappeared immediately after import'
          : 'identity changed during import',
      );
      expect(resources).toEqual(new Set([address]));
      expect(rosterReads).toBe(2);
    }
  });

  test('bootstraps only on confirmed bucket absence', () => {
    expect(
      parseBucketDescribeResult(
        0,
        JSON.stringify({
          labels: { application: 'psd-eoc', 'managed-by': 'terraform' },
          name: 'psd401-eoc-terraform-state',
          projectNumber: '123',
        }),
        '',
      ),
    ).not.toBeNull();
    expect(parseBucketDescribeResult(1, '', 'HTTP 404: not found')).toBeNull();
    expect(() =>
      parseBucketDescribeResult(
        1,
        '',
        '403: does not have permission to inspect this bucket',
      ),
    ).toThrow('does not have permission');
  });

  test('treats ambiguous absent-project errors as safe create attempts only', () => {
    expect(
      parseProjectDescribeResult(
        1,
        '',
        'does not have permission to access projects instance [psd401-eoc] (or it may not exist)',
      ),
    ).toBeNull();
    expect(() =>
      parseProjectDescribeResult(1, '', 'PERMISSION_DENIED by organization'),
    ).toThrow('PERMISSION_DENIED');
  });

  test('adopts only the exact organization, billing, and labels', () => {
    expect(() =>
      validateBootstrapProject(validProject, validBilling),
    ).not.toThrow();
    expect(() =>
      validateBootstrapProject(
        {
          ...validProject,
          parent: { id: 'wrong-organization', type: 'organization' },
        },
        validBilling,
      ),
    ).toThrow('does not match');
    expect(() =>
      validateBootstrapProject(validProject, {
        ...validBilling,
        billingEnabled: false,
      }),
    ).toThrow('does not match');
    expect(() =>
      validateBootstrapProject(
        {
          ...validProject,
          labels: { ...validProject.labels, unexpected: 'out-of-band' },
        },
        validBilling,
      ),
    ).toThrow('does not match');
  });

  test('adopts only a fully private project-owned state backend', () => {
    expect(validateStateBucket(validBucket, validBucketPolicy)).toBe(
      'managed-policy',
    );
    const {
      default_event_based_hold: defaultEventBasedHold,
      requester_pays: requesterPays,
      ...withoutExplicitFalseValues
    } = validBucket;
    expect(defaultEventBasedHold).toBe(false);
    expect(requesterPays).toBe(false);
    expect(
      validateStateBucket(withoutExplicitFalseValues, validBucketPolicy),
    ).toBe('managed-policy');
    expect(
      validateStateBucket(
        { ...validBucket, default_kms_key: null },
        validBucketPolicy,
      ),
    ).toBe('managed-policy');
    expect(validateStateBucket(validBucket, bootstrapBucketPolicy, true)).toBe(
      'bootstrap-policy',
    );
    expect(() =>
      validateStateBucket(validBucket, bootstrapBucketPolicy),
    ).toThrow('single-administrator');
    expect(() =>
      validateStateBucket(
        { ...validBucket, public_access_prevention: 'inherited' },
        validBucketPolicy,
      ),
    ).toThrow('private, versioned');
    expect(() =>
      validateStateBucket(
        { ...validBucket, retention_policy: { retentionPeriod: '3600' } },
        validBucketPolicy,
      ),
    ).toThrow('private, versioned');
    for (const requester_pays of [true, null, 0, 'false']) {
      expect(() =>
        validateStateBucket(
          { ...validBucket, requester_pays },
          validBucketPolicy,
        ),
      ).toThrow('private, versioned');
    }
    for (const default_event_based_hold of [true, null, 0, 'false', {}, []]) {
      expect(() =>
        validateStateBucket(
          { ...validBucket, default_event_based_hold },
          validBucketPolicy,
        ),
      ).toThrow('private, versioned');
    }
    for (const default_kms_key of [
      'projects/example/locations/us-west1/keyRings/example/cryptoKeys/example',
      '',
      false,
      0,
      {},
      [],
    ]) {
      expect(() =>
        validateStateBucket(
          { ...validBucket, default_kms_key },
          validBucketPolicy,
        ),
      ).toThrow('private, versioned');
    }
    for (const path of ['main.tf', 'bootstrap/main.tf']) {
      expect(read(path)).toMatch(/requester_pays\s+= false/u);
      expect(read(path)).toMatch(/default_event_based_hold\s+= false/u);
    }
    for (const condition of [
      { age: 90, isLive: false },
      { daysSinceNoncurrentTime: 89, isLive: false },
      { age: 90, daysSinceNoncurrentTime: 90, isLive: false },
    ]) {
      expect(() =>
        validateStateBucket(
          {
            ...validBucket,
            lifecycle_config: {
              rule: [{ action: { type: 'Delete' }, condition }],
            },
          },
          validBucketPolicy,
        ),
      ).toThrow('private, versioned');
    }
    expect(() =>
      validateStateBucket(validBucket, {
        bindings: [
          ...validBucketPolicy.bindings,
          { members: ['allUsers'], role: 'roles/storage.objectViewer' },
        ],
      }),
    ).toThrow('single-administrator');
    expect(() =>
      validateStateBucket(validBucket, {
        bindings: [
          {
            condition: {
              expression: 'request.time < timestamp("2030-01-01T00:00:00Z")',
              title: 'temporary',
            },
            members: ['user:kjh_admin@psd401.net'],
            role: 'roles/storage.objectAdmin',
          },
        ],
      }),
    ).toThrow('invalid binding');
    expect(() =>
      validateStateBucket(validBucket, {
        bindings: [
          {
            members: [
              'user:kjh_admin@psd401.net',
              'group:cloud-admins@psd401.net',
            ],
            role: 'roles/storage.objectAdmin',
          },
        ],
      }),
    ).toThrow('single-administrator');
  });

  test('removes inherited Terraform bypasses and credential overrides', () => {
    const environment = sanitizedTerraformEnvironment({
      CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:
        'attacker@wrong.iam.gserviceaccount.com',
      CLOUDSDK_CONFIG: '/tmp/wrong-gcloud',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/wrong.json',
      GOOGLE_BACKEND_ACCESS_TOKEN: 'wrong-backend-token',
      GOOGLE_BILLING_PROJECT: 'wrong-billing-project',
      GOOGLE_CLOUD_PROJECT: 'wrong-project',
      GOOGLE_CLOUD_QUOTA_PROJECT: 'wrong-quota-project',
      GOOGLE_CLOUD_UNIVERSE_DOMAIN: 'attacker.invalid',
      GOOGLE_STORAGE_CUSTOM_ENDPOINT: 'https://attacker.invalid',
      GOOGLE_OAUTH_ACCESS_TOKEN: 'wrong-token',
      PATH: '/usr/bin',
      PSD_EOC_APPROVED_TEST_GROUP: 'staff-group@psd401.net',
      PSD_EOC_CONFIRM_WORKSPACE_ROLE_ASSIGNMENT: 'wrong-confirmation',
      PSD_EOC_GUARDED_LAUNCHER: '1',
      TF_CLI_ARGS: '-auto-approve',
      TF_CLI_ARGS_apply: '-auto-approve',
      TF_DATA_DIR: '/tmp/wrong-plugins',
      TF_VAR_project_id: 'wrong-project',
      TF_WORKSPACE: 'wrong',
    });

    expect(environment.HOME).toBe('/Users/hagelk');
    expect(environment.PATH).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    );
    expect(
      environment.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT,
    ).toBeUndefined();
    expect(environment.CLOUDSDK_CONFIG).toBeUndefined();
    expect(environment.TF_CLI_ARGS).toBeUndefined();
    expect(environment.TF_CLI_ARGS_apply).toBeUndefined();
    expect(environment.TF_CLI_CONFIG_FILE).toBe(
      join(gcpRoot, 'terraform.tfrc'),
    );
    expect(environment.TF_DATA_DIR).toBeUndefined();
    expect(environment.TF_VAR_project_id).toBeUndefined();
    expect(environment.TF_WORKSPACE).toBeUndefined();
    expect(environment.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(environment.GOOGLE_BACKEND_ACCESS_TOKEN).toBeUndefined();
    expect(environment.GOOGLE_BILLING_PROJECT).toBeUndefined();
    expect(environment.GOOGLE_CLOUD_PROJECT).toBeUndefined();
    expect(environment.GOOGLE_CLOUD_QUOTA_PROJECT).toBeUndefined();
    expect(environment.GOOGLE_CLOUD_UNIVERSE_DOMAIN).toBeUndefined();
    expect(environment.GOOGLE_STORAGE_CUSTOM_ENDPOINT).toBeUndefined();
    expect(environment.GOOGLE_OAUTH_ACCESS_TOKEN).toBeUndefined();
    expect(environment.PSD_EOC_APPROVED_TEST_GROUP).toBeUndefined();
    expect(
      environment.PSD_EOC_CONFIRM_WORKSPACE_ROLE_ASSIGNMENT,
    ).toBeUndefined();
    expect(environment.PSD_EOC_GUARDED_LAUNCHER).toBeUndefined();
    expect(environment.CLOUDSDK_CORE_LOG_HTTP).toBe('0');
    expect(environment.NO_PROXY).toBe('*');
    expect(environment.no_proxy).toBe('*');

    const gcloudEnvironment = sanitizedGcloudEnvironment({
      CLOUDSDK_ACTIVE_CONFIG_NAME: 'wrong',
      CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT:
        'attacker@wrong.iam.gserviceaccount.com',
      CLOUDSDK_API_ENDPOINT_OVERRIDES_STORAGE: 'https://attacker.invalid',
      CLOUDSDK_CONFIG: '/tmp/wrong-gcloud',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/wrong.json',
      GOOGLE_BILLING_PROJECT: 'wrong-billing-project',
      GOOGLE_CLOUD_QUOTA_PROJECT: 'wrong-quota-project',
      GOOGLE_CLOUD_UNIVERSE_DOMAIN: 'attacker.invalid',
      PATH: '/usr/bin',
    });
    expect(gcloudEnvironment.HOME).toBe('/Users/hagelk');
    expect(gcloudEnvironment.PATH).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    );
    expect(gcloudEnvironment.CLOUDSDK_CONFIG).toBeUndefined();
    expect(gcloudEnvironment.CLOUDSDK_ACTIVE_CONFIG_NAME).toBeUndefined();
    expect(
      gcloudEnvironment.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT,
    ).toBeUndefined();
    expect(
      gcloudEnvironment.CLOUDSDK_API_ENDPOINT_OVERRIDES_STORAGE,
    ).toBeUndefined();
    expect(gcloudEnvironment.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(gcloudEnvironment.GOOGLE_BILLING_PROJECT).toBeUndefined();
    expect(gcloudEnvironment.GOOGLE_CLOUD_QUOTA_PROJECT).toBeUndefined();
    expect(gcloudEnvironment.GOOGLE_CLOUD_UNIVERSE_DOMAIN).toBeUndefined();
    expect(gcloudEnvironment.CLOUDSDK_CORE_LOG_HTTP).toBe('0');
    expect(gcloudEnvironment.CLOUDSDK_PYTHON).toBe('/opt/homebrew/bin/python3');
    expect(gcloudEnvironment.CLOUDSDK_PYTHON_ARGS).toBe('-I -S');
    expect(gcloudEnvironment.NO_PROXY).toBe('*');
    expect(gcloudEnvironment.no_proxy).toBe('*');

    const awsEnvironment = sanitizedAwsEnvironment({
      AWS_ACCESS_KEY_ID: 'wrong-key',
      AWS_CONFIG_FILE: '/tmp/wrong-config',
      AWS_ENDPOINT_URL_SECRETS_MANAGER: 'https://attacker.invalid',
      PATH: '/usr/bin',
      PSD_EOC_APPROVED_TEST_GROUP: 'staff-group@psd401.net',
    });
    expect(awsEnvironment.HOME).toBe('/Users/hagelk');
    expect(awsEnvironment.PATH).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    );
    expect(awsEnvironment.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(awsEnvironment.AWS_CONFIG_FILE).toBe(join(gcpRoot, 'aws.config'));
    expect(awsEnvironment.AWS_ENDPOINT_URL_SECRETS_MANAGER).toBeUndefined();
    expect(awsEnvironment.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS).toBe('true');
    expect(awsEnvironment.AWS_CLI_AUTO_PROMPT).toBe('off');
    expect(awsEnvironment.AWS_SHARED_CREDENTIALS_FILE).toBe('/dev/null');
    expect(awsEnvironment.AWS_EC2_METADATA_DISABLED).toBe('true');
    expect(awsEnvironment.AWS_PAGER).toBe('');
    expect(awsEnvironment.PSD_EOC_APPROVED_TEST_GROUP).toBeUndefined();
    expect(awsEnvironment.NO_PROXY).toBe('*');
    expect(awsEnvironment.no_proxy).toBe('*');
  });

  test('bounds untrusted Google JSON and rejects credential redirects', async () => {
    await expect(
      boundedGoogleJsonObject(
        new Response(JSON.stringify({ result: 'synthetic' }), {
          status: 200,
        }),
        'Synthetic Google read',
      ),
    ).resolves.toEqual({ result: 'synthetic' });

    let declaredBodyCancelled = false;
    const declaredOversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('provider-secret'));
        controller.close();
      },
      cancel() {
        declaredBodyCancelled = true;
      },
    });
    await expect(
      boundedGoogleJsonObject(
        new Response(declaredOversizedBody, {
          headers: {
            'Content-Length': String(MAX_GOOGLE_RESPONSE_BYTES + 1),
          },
          status: 200,
        }),
        'Synthetic Google read',
      ),
    ).rejects.toThrow('invalid or oversized');
    expect(declaredBodyCancelled).toBe(true);

    let streamedBodyCancelled = false;
    let streamedChunk = 0;
    const streamedOversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (streamedChunk === 0) {
          streamedChunk += 1;
          controller.enqueue(new Uint8Array(MAX_GOOGLE_RESPONSE_BYTES));
          return;
        }
        controller.enqueue(new TextEncoder().encode('provider-secret'));
      },
      cancel() {
        streamedBodyCancelled = true;
      },
    });
    await expect(
      boundedGoogleJsonObject(
        new Response(streamedOversizedBody, { status: 200 }),
        'Synthetic Google read',
      ),
    ).rejects.toThrow('invalid or oversized');
    expect(streamedBodyCancelled).toBe(true);

    let errorBodyCancelled = false;
    const errorBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('provider-secret'));
        controller.close();
      },
      cancel() {
        errorBodyCancelled = true;
      },
    });
    await expect(
      boundedGoogleJsonObject(
        new Response(errorBody, { status: 503 }),
        'Synthetic Google read',
      ),
    ).rejects.toThrow('failed with HTTP 503');
    expect(errorBodyCancelled).toBe(true);

    for (const invalidBody of [
      'provider-secret',
      JSON.stringify(['provider-secret']),
      JSON.stringify('provider-secret'),
    ]) {
      let message = '';
      try {
        await boundedGoogleJsonObject(
          new Response(invalidBody, { status: 200 }),
          'Synthetic Google read',
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('invalid or oversized');
      expect(message).not.toContain('provider-secret');
    }

    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    let observedInit: RequestInit | undefined;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const response = await guardedGoogleFetch(
        async (_input, init) => {
          observedInit = init;
          return new Response('{}', { status: 200 });
        },
        'https://www.googleapis.com/synthetic',
        { redirect: 'follow' },
        'Synthetic Google read',
      );
      await response.body?.cancel();
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
    }
    expect(observedInit?.redirect).toBe('error');

    const runtime = read('scripts/runtime.ts');
    const roleHelper = read('scripts/configure-workspace-role.ts');
    const verifier = read('scripts/verify-groups-readonly.ts');
    for (const source of [runtime, roleHelper, verifier]) {
      expect(source).not.toContain('response.json()');
    }
    expect(runtime).toMatch(
      /export async function guardedGoogleFetch[^]*assertNoAmbientTransportOverrides\(\);[^]*\.\.\.init,\s*redirect: 'error'/u,
    );
    expect(runtime).toMatch(
      /export async function assertApplicationDefaultIdentity[^]*guardedGoogleFetch\([^]*boundedGoogleJsonObject\(/u,
    );
    expect(roleHelper).toMatch(
      /async function authorizedFetch[^]*guardedGoogleFetch\([^]*boundedGoogleJsonObject\(/u,
    );
    expect(verifier).toMatch(
      /export async function redactedFetch[^]*guardedGoogleFetch\(/u,
    );
    expect(verifier.match(/boundedGoogleJsonObject\(/gu)).toHaveLength(2);
  });

  test('rejects ambient credential transport and debug overrides', () => {
    expect(() =>
      assertTrustedHome({
        HOME: '/Users/hagelk',
        LOGNAME: 'hagelk',
        USER: 'hagelk',
      }),
    ).not.toThrow();
    for (const source of [
      { HOME: '/tmp/untrusted' },
      { HOME: '/Users/hagelk', USER: 'attacker' },
      { HOME: '/Users/hagelk', LOGNAME: 'attacker' },
    ]) {
      expect(() => assertTrustedHome(source)).toThrow('fixed hagelk');
    }

    for (const name of [
      'ALL_PROXY',
      'all_proxy',
      'AWS_CA_BUNDLE',
      'AWS_CLI_AUTO_PROMPT',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
      'AWS_CSM_ENABLED',
      'AWS_DATA_PATH',
      'AWS_EC2_METADATA_SERVICE_ENDPOINT',
      'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
      'AWS_SECURITY_TOKEN',
      'BOTO_CONFIG',
      'BROWSER',
      'BUN_INSPECT',
      'BUN_INSPECT_CONNECT_TO',
      'BUN_INSPECT_NOTIFY',
      'BUN_INSPECT_PRELOAD',
      'BUN_OPTIONS',
      'BUN_CONFIG_VERBOSE_FETCH',
      'CLOUDSDK_AUTH_DISABLE_SSL_VALIDATION',
      'CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE',
      'CLOUDSDK_CORE_DISABLE_SSL_VALIDATION',
      'CLOUDSDK_PROXY_ADDRESS',
      'CLOUDSDK_PROXY_PASSWORD',
      'CLOUDSDK_PROXY_PORT',
      'CLOUDSDK_PROXY_TYPE',
      'CLOUDSDK_PROXY_USERNAME',
      'CURL_CA_BUNDLE',
      'ENABLE_ENTERPRISE_CERTIFICATE_LOGS',
      'EXPERIMENTAL_GOOGLE_API_USE_S2A',
      'GODEBUG',
      'GOTRACEBACK',
      'GOOGLE_SDK_GO_LOGGING_LEVEL',
      'GOOGLE_API_CERTIFICATE_CONFIG',
      'GOOGLE_API_GO_EXPERIMENTAL_ENABLE_NEW_AUTH_LIB',
      'GOOGLE_API_USE_CLIENT_CERTIFICATE',
      'GOOGLE_API_USE_MTLS',
      'GOOGLE_API_USE_MTLS_ENDPOINT',
      'GOOGLE_CLOUD_DISABLE_DIRECT_PATH',
      'GOOGLE_CLOUD_ENABLE_DIRECT_PATH_XDS',
      'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES',
      'GRPC_BINARY_LOG_FILTER',
      'GRPC_DEFAULT_SSL_ROOTS_FILE_PATH',
      'GRPC_GO_LOG_FORMATTER',
      'GRPC_GO_LOG_SEVERITY_LEVEL',
      'GRPC_GO_LOG_VERBOSITY_LEVEL',
      'GRPC_PROXY',
      'grpc_proxy',
      'GRPC_TRACE',
      'GRPC_VERBOSITY',
      'GRPC_GCP_OBSERVABILITY_CONFIG_FILE',
      'GRPC_XDS_BOOTSTRAP',
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'NODE_EXTRA_CA_CERTS',
      'NODE_DEBUG',
      'NODE_DEBUG_NATIVE',
      'NODE_OPTIONS',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'PYTHONBREAKPOINT',
      'PYTHONCASEOK',
      'PYTHONDEBUG',
      'PYTHONEXECUTABLE',
      'PYTHONFAULTHANDLER',
      'PYTHONHOME',
      'PYTHONINSPECT',
      'PYTHONPATH',
      'PYTHONPLATLIBDIR',
      'PYTHONPROFILEIMPORTTIME',
      'PYTHONSTARTUP',
      'PYTHONUSERBASE',
      'PYTHONVERBOSE',
      'PYTHONWARNINGS',
      'REQUESTS_CA_BUNDLE',
      'SSL_CERT_DIR',
      'SSL_CERT_FILE',
      'SSLKEYLOGFILE',
      'TF_LOG_CORE',
      'TF_LOG_PROVIDER',
      'TF_LOG_SDK_PROTO',
      'TF_LOG_UNREVIEWED',
      'TF_TEMP_LOG_PATH',
      'VIRTUAL_ENV',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'DYLD_INSERT_LIBRARIES',
      'LD_PRELOAD',
    ]) {
      const source = { PATH: '/usr/bin', [name]: 'configured' };
      expect(() => assertNoAmbientTransportOverrides(source)).toThrow(
        'reject ambient proxy',
      );
      expect(() => sanitizedTerraformEnvironment(source)).toThrow(
        'reject ambient proxy',
      );
      expect(() => sanitizedGcloudEnvironment(source)).toThrow(
        'reject ambient proxy',
      );
      expect(() => sanitizedAwsEnvironment(source)).toThrow(
        'reject ambient proxy',
      );
    }

    for (const argument of [
      '-i',
      '-r',
      '-r./instrumentation.ts',
      '--env-file',
      '--env-file=/tmp/ambient.env',
      '--fetch-preconnect',
      '--fetch-preconnect=https://attacker.invalid',
      '--import',
      '--import=./instrumentation.ts',
      '--inspect',
      '--inspect=0.0.0.0:9229',
      '--inspect-brk',
      '--inspect-wait=127.0.0.1:9229',
      '--install',
      '--install=force',
      '--preload',
      '--preload=./instrumentation.ts',
      '--redis-preconnect',
      '--require',
      '--require=./instrumentation.ts',
      '--sql-preconnect',
      '--tls-keylog',
      '--tls-keylog=/tmp/psd-eoc-synthetic.keys',
      '--use-env-proxy',
      '--use-openssl-ca',
      '--use-system-ca',
      '--verbose-fetch',
      '--verbose-fetch=curl',
    ]) {
      expect(() =>
        assertNoAmbientTransportOverrides({ PATH: '/usr/bin' }, [argument]),
      ).toThrow('debugger, and verbose-fetch');
    }
    expect(() =>
      assertNoAmbientTransportOverrides({ PATH: '/usr/bin' }, [
        'test',
        'infra/gcp/terraform.test.ts',
      ]),
    ).not.toThrow();

    for (const sanitizer of [
      sanitizedTerraformEnvironment,
      sanitizedGcloudEnvironment,
      sanitizedAwsEnvironment,
    ]) {
      const environment = sanitizer({
        NO_PROXY: 'localhost',
        PATH: '/usr/bin',
        no_proxy: '127.0.0.1',
      });
      expect(environment.NO_PROXY).toBe('*');
      expect(environment.no_proxy).toBe('*');
      expect(environment.PYTHONNOUSERSITE).toBe('1');
    }

    const runtime = read('scripts/runtime.ts');
    expect(runtime).toMatch(
      /export async function assertApplicationDefaultIdentity[^]*\{\s*assertNoAmbientTransportOverrides\(\);/u,
    );
    expect(runtime).toMatch(
      /function prepareCloudCommand[^]*if \(command === 'aws'\) \{\s*assertAwsLocalConfiguration\(\);[^]*return \{ args: \[\.\.\.args, '--no-cli-pager'\], executable \};/u,
    );
    expect(runtime).not.toContain("['configure', 'get'");
    expect(runtime).toContain("aws: '/opt/homebrew/bin/aws'");
    expect(runtime).toContain("gcloud: '/opt/homebrew/bin/gcloud'");
    expect(runtime).toContain("terraform: '/opt/homebrew/bin/terraform'");
    expect(read('scripts/configure-workspace-role.ts')).toContain(
      'guardedGoogleFetch(',
    );
    expect(read('scripts/verify-groups-readonly.ts')).toContain(
      'guardedGoogleFetch(',
    );
    expect(read('scripts/store-oauth-client.ts')).toMatch(
      /async function readSecureFileBytes[^]*\{\s*assertNoAmbientTransportOverrides\(\);/u,
    );
  });

  test('treats two dots as a parent only when they are a complete path component', () => {
    const repository = join(tmpdir(), 'psd-eoc-synthetic-repository');
    expect(isPathOutsideDirectory(repository, repository)).toBe(false);
    expect(
      isPathOutsideDirectory(
        repository,
        join(repository, '..credentials', 'client.json'),
      ),
    ).toBe(false);
    expect(
      isPathOutsideDirectory(
        repository,
        join(repository, 'credentials', 'client.json'),
      ),
    ).toBe(false);
    expect(
      isPathOutsideDirectory(
        repository,
        join(repository, '..', 'secure', 'client.json'),
      ),
    ).toBe(true);

    const secureReader = read('scripts/store-oauth-client.ts');
    expect(secureReader).toContain(
      'isPathOutsideDirectory(repositoryRoot, requested)',
    );
    expect(secureReader).toContain(
      'isPathOutsideDirectory(repositoryRoot, resolved)',
    );
    expect(secureReader).not.toContain("startsWith('..')");
    expect(read('scripts/operator-access.ts')).toContain(
      'readSecureFileBytes(path)',
    );
  });

  test('starts guarded helpers only through the pre-Bun launcher', () => {
    const configPath = join(gcpRoot, 'bunfig.toml');
    const safeArguments = [
      `--config=${configPath}`,
      '--no-env-file',
      '--no-install',
    ];
    const entrypoints = [
      'apply.ts',
      'configure-workspace-role.ts',
      'operator-access.ts',
      'provision-groups-credential.ts',
      'revoke-groups-credential.ts',
      'store-oauth-client.ts',
      'verify-groups-readonly.ts',
    ];
    for (const entrypoint of entrypoints) {
      expect(() =>
        validateGuardedBunInvocation(
          safeArguments,
          join(gcpRoot, 'scripts', entrypoint),
          gcpRoot,
          '1',
        ),
      ).not.toThrow();
    }
    for (const invalid of [
      { arguments: safeArguments, cwd: gcpRoot, marker: undefined },
      { arguments: safeArguments, cwd: join(gcpRoot, 'scripts'), marker: '1' },
      {
        arguments: ['--config=bunfig.toml', '--no-env-file', '--no-install'],
        cwd: gcpRoot,
        marker: '1',
      },
      {
        arguments: [`--config=${configPath}`, '--no-install'],
        cwd: gcpRoot,
        marker: '1',
      },
      {
        arguments: [...safeArguments, '--inspect'],
        cwd: gcpRoot,
        marker: '1',
      },
    ]) {
      expect(() =>
        validateGuardedBunInvocation(
          invalid.arguments,
          join(gcpRoot, 'scripts', 'apply.ts'),
          invalid.cwd,
          invalid.marker,
        ),
      ).toThrow('run-guarded.sh');
    }
    expect(() =>
      validateGuardedBunInvocation([], 'terraform.test.ts', gcpRoot, undefined),
    ).not.toThrow();
    expect(() =>
      validateGuardedBunInvocation(
        [],
        join(gcpRoot, 'scripts', '..credentials', 'bypass.ts'),
        gcpRoot,
        undefined,
      ),
    ).toThrow('run-guarded.sh');

    const linkedDirectory = mkdtempSync(
      join(tmpdir(), 'psd-eoc-guarded-entrypoint-'),
    );
    try {
      const linkedEntrypoint = join(linkedDirectory, 'apply.ts');
      const guardedEntrypoint = join(gcpRoot, 'scripts', 'apply.ts');
      symlinkSync(guardedEntrypoint, linkedEntrypoint);
      expect(() =>
        validateGuardedBunInvocation([], linkedEntrypoint, gcpRoot, undefined),
      ).toThrow('run-guarded.sh');

      const hardlinkedEntrypoint = join(linkedDirectory, 'hardlinked-apply.ts');
      linkSync(guardedEntrypoint, hardlinkedEntrypoint);
      expect(() =>
        validateGuardedBunInvocation(
          [],
          hardlinkedEntrypoint,
          gcpRoot,
          undefined,
        ),
      ).toThrow('run-guarded.sh');
    } finally {
      rmSync(linkedDirectory, { force: true, recursive: true });
    }

    const launcher = read('scripts/run-guarded.sh');
    const bunfig = read('bunfig.toml');
    const readme = read('README.md');
    expect(
      statSync(new URL('scripts/run-guarded.sh', root)).mode & 0o111,
    ).not.toBe(0);
    expect(launcher).toContain('/usr/bin/env');
    expect(launcher).toContain('/usr/bin/awk');
    expect(launcher).toContain('/usr/bin/dirname');
    expect(launcher).toContain('exec /opt/homebrew/bin/bun');
    expect(launcher).toContain('$1 == "NODE_OPTIONS" ||');
    expect(launcher).toContain('$1 ~ /^BUN_');
    expect(launcher).toContain('$1 ~ /^DYLD_');
    expect(launcher).toContain('PSD_EOC_GUARDED_LAUNCHER=1');
    expect(launcher).toContain('"--config=$gcp_root/bunfig.toml"');
    expect(launcher).toContain('--no-env-file');
    expect(launcher).toContain('--no-install');
    expect(launcher).not.toContain('eval ');
    expect(bunfig).toContain('preload = ["./scripts/preload-guard.ts"]');
    expect(bunfig).toContain('env = false');
    expect(bunfig).toContain('auto = "disable"');
    expect(read('scripts/preload-guard.ts')).toContain(
      'assertNoAmbientTransportOverrides();',
    );
    expect(read('scripts/preload-guard.ts')).toContain('assertTrustedHome();');
    expect(readme).not.toMatch(/\bbun scripts\//u);
    expect(readme).not.toMatch(/^[ \t]*(?:aws|gcloud)\s/gmu);
    expect(readme).not.toMatch(
      /^[ \t]*terraform (?:apply|console|destroy|force-unlock|graph|import|init|output|plan|providers|refresh|show|state|taint|test|untaint|validate|workspace)\b/gmu,
    );
    expect(readme).not.toContain('run `terraform destroy`');

    const operatorAccess = read('scripts/operator-access.ts');
    expect(operatorAccess).toMatch(
      /async function authenticate[^]*assertSafeGcloudConfiguration\(\);[^]*runInteractive\('gcloud', \[\s*'auth',\s*'login'[^]*assertAwsSsoLoginConfiguration[^]*runInteractive\('aws', \[\s*'sso',\s*'login'/u,
    );
    expect(operatorAccess).toMatch(
      /async function authenticate[^]*replaceWithOrdinaryAdc\(\);[^]*assertApplicationDefaultIdentity/u,
    );
    expect(operatorAccess).toMatch(
      /function replaceWithOrdinaryAdc[^]*revokeApplicationDefaultCredentials\(\);\s*ordinaryAdcLogin\(\)/u,
    );
    expect(operatorAccess).toMatch(
      /async function authorizeWorkspaceAdc[^]*withValidatedWorkspaceClientCopy[^]*revokeApplicationDefaultCredentials\(\);[^]*runInteractive\('gcloud'/u,
    );
    expect(operatorAccess).toMatch(
      /function revokeApplicationDefaultCredentials[^]*'application-default',[^]*'revoke',[^]*'--quiet'[^]*not revocable/u,
    );
    expect(operatorAccess.match(/--no-launch-browser/gu)).toHaveLength(2);
    expect(operatorAccess.match(/--no-browser/gu)).toHaveLength(2);
    expect(operatorAccess).toMatch(
      /async function authorizeWorkspaceAdc[^]*withValidatedWorkspaceClientCopy[^]*runInteractive\('gcloud', \[\s*'auth',\s*'application-default',\s*'login',\s*ADMIN_EMAIL,\s*`--client-id-file=\$\{secureClientPath\}`,\s*'--no-browser'[^]*WORKSPACE_ROLE_SCOPE/u,
    );
    expect(
      operatorAccess.slice(
        operatorAccess.indexOf('async function authorizeWorkspaceAdc'),
        operatorAccess.indexOf('async function restoreOrdinaryAdc'),
      ),
    ).not.toContain('--no-launch-browser');

    const terraformCliConfig = read('terraform.tfrc');
    expect(terraformCliConfig).toContain('provider_installation {');
    expect(terraformCliConfig).toContain('direct {}');
    expect(terraformCliConfig).not.toMatch(
      /dev_overrides|filesystem_mirror|plugin_cache_dir|credentials_helper|credentials\s/u,
    );
    expect(read('aws.config')).toBe(
      '[profile psd401-prr-prod]\n' +
        'sso_session = macbookpro\n' +
        'sso_account_id = <aws-account-id>\n' +
        'sso_role_name = AWSAdministratorAccess\n' +
        'region = us-west-2\n\n' +
        '[sso-session macbookpro]\n' +
        'sso_start_url = https://psd401.awsapps.com/start\n' +
        'sso_region = us-west-2\n' +
        'sso_registration_scopes = sso:account:access\n',
    );

    if (process.platform !== 'darwin') {
      return;
    }

    const launcherEnvironment: NodeJS.ProcessEnv = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
    };
    const launched = spawnSync(
      join(gcpRoot, 'scripts', 'run-guarded.sh'),
      ['store-oauth-client'],
      {
        cwd: gcpRoot,
        encoding: 'utf8',
        env: launcherEnvironment,
      },
    );
    expect(launched.status).toBe(1);
    expect(launched.stderr).toContain(
      'Usage: ./scripts/run-guarded.sh store-oauth-client',
    );

    const rejectedBeforeBun = spawnSync(
      join(gcpRoot, 'scripts', 'run-guarded.sh'),
      ['store-oauth-client'],
      {
        cwd: gcpRoot,
        encoding: 'utf8',
        env: {
          ...launcherEnvironment,
          BUN_OPTIONS: '--preload=/definitely-not-present/ambient.ts',
        },
      },
    );
    expect(rejectedBeforeBun.status).toBe(64);
    expect(rejectedBeforeBun.stderr).toContain(
      'reject startup hooks and executable overrides; unset: BUN_OPTIONS',
    );
    expect(rejectedBeforeBun.stderr).not.toContain('definitely-not-present');

    const rejectedHome = spawnSync(
      join(gcpRoot, 'scripts', 'run-guarded.sh'),
      ['store-oauth-client'],
      {
        cwd: gcpRoot,
        encoding: 'utf8',
        env: { ...launcherEnvironment, HOME: '/tmp/untrusted-home' },
      },
    );
    expect(rejectedHome.status).toBe(64);
    expect(rejectedHome.stderr).toContain(
      'require the fixed hagelk account and /Users/hagelk home directory',
    );

    const directBun = spawnSync(
      'bun',
      [
        `--config=${configPath}`,
        '--no-env-file',
        '--no-install',
        join(gcpRoot, 'scripts', 'store-oauth-client.ts'),
      ],
      {
        cwd: gcpRoot,
        encoding: 'utf8',
        env: launcherEnvironment,
      },
    );
    expect(directBun.status).toBe(1);
    expect(directBun.stderr).toContain(
      'must be started by infra/gcp/scripts/run-guarded.sh',
    );
  });

  test('pins Terraform provider installation away from ambient overrides', () => {
    for (const name of [
      'TERRAFORM_CONFIG',
      'TF_CLI_CONFIG_FILE',
      'TF_PLUGIN_CACHE_DIR',
      'TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE',
      'TF_REATTACH_PROVIDERS',
    ]) {
      expect(() =>
        sanitizedTerraformEnvironment({
          PATH: '/usr/bin',
          [name]: '/tmp/ambient-provider-override',
        }),
      ).toThrow('reject ambient CLI configuration and provider-plugin');
    }

    const environment = sanitizedTerraformEnvironment({
      HOME: '/tmp/synthetic-home-with-terraformrc',
      PATH: '/usr/bin',
    });
    expect(environment.HOME).toBe('/Users/hagelk');
    expect(environment.TERRAFORM_CONFIG).toBeUndefined();
    expect(environment.TF_PLUGIN_CACHE_DIR).toBeUndefined();
    expect(environment.TF_REATTACH_PROVIDERS).toBeUndefined();
    expect(environment.TF_CLI_CONFIG_FILE).toBe(
      join(gcpRoot, 'terraform.tfrc'),
    );
  });

  test('rejects GCS emulator routing before guarded Google commands', () => {
    for (const name of [
      'STORAGE_EMULATOR_HOST',
      'STORAGE_EMULATOR_HOST_GRPC',
    ]) {
      expect(() =>
        sanitizedTerraformEnvironment({
          PATH: '/usr/bin',
          [name]: 'http://127.0.0.1:4443',
        }),
      ).toThrow('require real Google Cloud Storage endpoints');
      expect(() =>
        sanitizedGcloudEnvironment({
          PATH: '/usr/bin',
          [name]: '',
        }),
      ).toThrow('require real Google Cloud Storage endpoints');
    }
  });

  test('rejects persistent gcloud impersonation and endpoint overrides', () => {
    expect(() =>
      validateGcloudLocalConfiguration(
        '[core]\naccount = kjh_admin@psd401.net\nproject = psd401-eoc\n',
      ),
    ).not.toThrow();
    for (const invalidConfiguration of [
      '[auth]\nimpersonate_service_account = attacker@invalid\n',
      '[core]\naccount = kjh_admin@psd401.net\nverbosity = debug\n',
      '[core]\naccount = kjh_admin@psd401.net\n\n[proxy]\naddress = attacker.invalid\n',
    ]) {
      expect(() =>
        validateGcloudLocalConfiguration(invalidConfiguration),
      ).toThrow('gcloud');
    }
    expect(() =>
      validateGcloudTransportConfiguration({ core: {} }),
    ).not.toThrow();
    expect(() =>
      validateGcloudTransportConfiguration({
        core: {},
        proxy: { address: 'attacker.invalid' },
      }),
    ).toThrow('without impersonation');
    expect(() =>
      validateGcloudConfiguration(
        { core: { account: 'kjh_admin@psd401.net' } },
        'kjh_admin@psd401.net',
      ),
    ).not.toThrow();
    expect(() =>
      validateGcloudConfiguration(
        {
          auth: {
            impersonate_service_account:
              'attacker@wrong.iam.gserviceaccount.com',
          },
          core: { account: 'kjh_admin@psd401.net' },
        },
        'kjh_admin@psd401.net',
      ),
    ).toThrow('without impersonation');
    expect(() =>
      validateGcloudConfiguration(
        {
          billing: { quota_project: 'aistudio-462612' },
          core: { account: 'kjh_admin@psd401.net' },
        },
        'kjh_admin@psd401.net',
      ),
    ).toThrow('billing/quota');
    expect(() =>
      validateGcloudConfiguration(
        {
          api_endpoint_overrides: { storage: 'https://attacker.invalid' },
          core: { account: 'kjh_admin@psd401.net' },
        },
        'kjh_admin@psd401.net',
      ),
    ).toThrow('without impersonation');
    expect(() =>
      validateGcloudConfiguration(
        {
          core: {
            account: 'kjh_admin@psd401.net',
            universe_domain: 'attacker.invalid',
          },
        },
        'kjh_admin@psd401.net',
      ),
    ).toThrow('without impersonation');
    expect(() =>
      validateGcloudConfiguration(
        {
          core: { account: 'kjh_admin@psd401.net' },
          storage: { gs_xml_endpoint_url: 'https://attacker.invalid' },
        },
        'kjh_admin@psd401.net',
      ),
    ).toThrow('without impersonation');
  });

  test('rejects an ADC identity other than the verified district admin', () => {
    expect(APPLICATION_DEFAULT_IDENTITY_SCOPES).toEqual([
      'https://www.googleapis.com/auth/cloud-platform',
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
    ]);
    expect(read('scripts/runtime.ts')).toContain(
      "`--scopes=${APPLICATION_DEFAULT_IDENTITY_SCOPES.join(',')}`",
    );
    expect(() =>
      validateGoogleUserIdentity(
        { email: 'kjh_admin@psd401.net', verified_email: true },
        'kjh_admin@psd401.net',
      ),
    ).not.toThrow();
    expect(() =>
      validateGoogleUserIdentity(
        { email: 'other@psd401.net', verified_email: true },
        'kjh_admin@psd401.net',
      ),
    ).toThrow('must identify');

    const validAdc = {
      account: 'kjh_admin@psd401.net',
      client_id: 'synthetic-gcloud.apps.googleusercontent.com',
      client_secret: 'synthetic-client-secret',
      refresh_token: 'synthetic-refresh-token',
      type: 'authorized_user',
      universe_domain: 'googleapis.com',
    } as const;
    expect(() =>
      validateApplicationDefaultCredentialMetadata(
        validAdc,
        'psd401-eoc',
        'kjh_admin@psd401.net',
      ),
    ).not.toThrow();
    expect(() =>
      validateApplicationDefaultCredentialMetadata(
        { ...validAdc, quota_project_id: 'psd401-eoc' },
        'psd401-eoc',
        'kjh_admin@psd401.net',
      ),
    ).not.toThrow();
    for (const invalid of [
      { ...validAdc, account: 'other@psd401.net' },
      { ...validAdc, credential_source: { file: '/tmp/credential' } },
      {
        ...validAdc,
        service_account_impersonation_url: 'https://evil.invalid',
      },
      { ...validAdc, token_uri: 'https://oauth2.googleapis.com/token' },
      { ...validAdc, token_url: 'https://evil.invalid/token' },
      { ...validAdc, type: 'external_account' },
      { ...validAdc, universe_domain: 'evil.invalid' },
      { ...validAdc, client_secret: '' },
      { ...validAdc, refresh_token: '' },
      { ...validAdc, quota_project_id: 'aistudio-462612' },
    ]) {
      expect(() =>
        validateApplicationDefaultCredentialMetadata(
          invalid,
          'psd401-eoc',
          'kjh_admin@psd401.net',
        ),
      ).toThrow('authorized-user contract');
    }
  });

  test('accepts only the fixed AWS SSO administrator identity', () => {
    expect(() =>
      validateAwsSsoProfile(
        '<aws-account-id>',
        'AWSAdministratorAccess',
        'us-west-2',
        'macbookpro',
        '<aws-account-id>',
        'us-west-2',
      ),
    ).not.toThrow();
    expect(() =>
      validateAwsSsoProfile(
        '<aws-account-id>',
        'ReadOnlyAccess',
        'us-west-2',
        'macbookpro',
        '<aws-account-id>',
        'us-west-2',
      ),
    ).toThrow('AWSAdministratorAccess');
    expect(() =>
      validateAwsSsoIdentity(
        {
          Account: '<aws-account-id>',
          Arn: 'arn:aws:sts::<aws-account-id>:assumed-role/AWSReservedSSO_AWSAdministratorAccess_2fafd9a1fbc2f07b/kjh_admin',
        },
        '<aws-account-id>',
      ),
    ).not.toThrow();
    expect(() =>
      validateAwsSsoIdentity(
        {
          Account: '<aws-account-id>',
          Arn: 'arn:aws:iam::<aws-account-id>:user/kjh_admin',
        },
        '<aws-account-id>',
      ),
    ).toThrow('SSO administrator role');

    const validConfiguration = read('aws.config');
    expect(() =>
      validateAwsSsoConfigurationFiles(validConfiguration, ''),
    ).not.toThrow();
    for (const invalidConfiguration of [
      `[DEFAULT]\ncredential_process = /tmp/untrusted\n\n${validConfiguration}`,
      `${validConfiguration}\n[plugins]\nuntrusted = module\n`,
      validConfiguration.replace(
        'region = us-west-2',
        'region = us-west-2\ncredential_process = /tmp/untrusted',
      ),
      validConfiguration.replace(
        'sso_start_url = https://psd401.awsapps.com/start',
        'sso_start_url = https://attacker.invalid/start',
      ),
    ]) {
      expect(() =>
        validateAwsSsoConfigurationFiles(invalidConfiguration, ''),
      ).toThrow('AWS');
    }
    expect(() =>
      validateAwsSsoConfigurationFiles(
        validConfiguration,
        '[psd401-prr-prod]\naws_access_key_id = synthetic\naws_secret_access_key = synthetic\n',
      ),
    ).toThrow('must not have a static');
  });

  test('accepts only a fixed-endpoint Desktop client for Workspace authorization', () => {
    const validClient = {
      installed: {
        auth_provider_x509_cert_url:
          'https://www.googleapis.com/oauth2/v1/certs',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        client_id: 'synthetic-admin.apps.googleusercontent.com',
        client_secret: 'synthetic-secret',
        project_id: 'synthetic-admin-tools',
        redirect_uris: ['http://localhost'],
        token_uri: 'https://oauth2.googleapis.com/token',
      },
    } as const;
    expect(() => validateWorkspaceAdminClient(validClient)).not.toThrow();
    for (const invalid of [
      { web: validClient.installed },
      {
        installed: {
          ...validClient.installed,
          auth_provider_x509_cert_url: 'https://attacker.invalid/certs',
        },
      },
      {
        installed: {
          auth_uri: validClient.installed.auth_uri,
          client_id: validClient.installed.client_id,
          client_secret: validClient.installed.client_secret,
          project_id: validClient.installed.project_id,
          redirect_uris: validClient.installed.redirect_uris,
          token_uri: validClient.installed.token_uri,
        },
      },
      {
        installed: {
          ...validClient.installed,
          token_uri: 'https://attacker.invalid/token',
        },
      },
      {
        installed: {
          ...validClient.installed,
          redirect_uris: ['https://attacker.invalid/callback'],
        },
      },
      {
        installed: {
          ...validClient.installed,
          extra_endpoint: 'https://attacker.invalid',
        },
      },
    ]) {
      expect(() => validateWorkspaceAdminClient(invalid)).toThrow(
        'OAuth client is invalid',
      );
    }
  });

  test('adopts only local retained AWS secrets with no resource policy', () => {
    const contract = {
      expectedAccountId: '<aws-account-id>',
      region: 'us-west-2',
      secretName: '/psd-eoc/google-groups',
    } as const;
    const arn =
      'arn:aws:secretsmanager:us-west-2:<aws-account-id>:secret:/psd-eoc/google-groups-a1B2c3';
    const metadata = {
      ARN: arn,
      Name: contract.secretName,
      RotationEnabled: false,
      Tags: [
        { Key: 'Application', Value: 'PSD EOC' },
        { Key: 'ManagedBy', Value: 'infra/gcp' },
      ],
    } as const;
    expect(() => validateAwsSecretMetadata(metadata, contract)).not.toThrow();
    expect(() =>
      validateAwsSecretMetadata(
        {
          ...metadata,
          Tags: [
            { Key: 'Application', Value: 'PSD EOC' },
            { Key: 'DataScope', Value: 'staff-minimized' },
            { Key: 'ManagedBy', Value: 'AWS CDK' },
          ],
        },
        contract,
      ),
    ).not.toThrow();
    for (const invalid of [
      { ...metadata, DeletedDate: '2026-08-09T00:00:00Z' },
      { ...metadata, KmsKeyId: 'attacker-controlled-key' },
      { ...metadata, ReplicationStatus: [{ Region: 'us-east-1' }] },
      { ...metadata, RotationEnabled: true },
      { ...metadata, ARN: arn.replace('<aws-account-id>', '000000000000') },
      { ...metadata, Tags: [] },
    ]) {
      expect(() => validateAwsSecretMetadata(invalid, contract)).toThrow();
    }

    expect(() =>
      validateAwsSecretResourcePolicy(
        { ARN: arn, Name: contract.secretName },
        contract,
      ),
    ).not.toThrow();
    expect(() =>
      validateAwsSecretResourcePolicy(
        {
          ARN: arn,
          Name: contract.secretName,
          ResourcePolicy: '{"Statement":[]}',
        },
        contract,
      ),
    ).toThrow('no resource-based policy');

    const runtime = read('scripts/runtime.ts');
    expect(runtime).toContain("'get-resource-policy'");
    for (const path of [
      'scripts/provision-groups-credential.ts',
      'scripts/store-oauth-client.ts',
    ]) {
      const helper = read(path);
      expect(helper.match(/awsSecretExists\(/gu)).toHaveLength(1);
      expect(helper).toContain('expectedAccountId: AWS_ACCOUNT_ID');
    }

    const verifier = read('scripts/verify-groups-readonly.ts');
    expect(verifier.match(/awsSecretExists\(/gu)).toHaveLength(1);
    expect(verifier).toContain('expectedAccountId: AWS_ACCOUNT_ID');
    expect(verifier.indexOf('awsSecretExists({')).toBeLessThan(
      verifier.indexOf('readSecretValue({'),
    );

    const revoker = read('scripts/revoke-groups-credential.ts');
    expect(revoker.match(/awsSecretExists\(/gu)).toHaveLength(1);
    expect(revoker).toContain('expectedAccountId: AWS_ACCOUNT_ID');
    expect(revoker.indexOf('awsSecretExists({')).toBeLessThan(
      revoker.indexOf('readSecretValue({'),
    );
  });

  test('revalidates remote boundaries after confirmations and around writes', () => {
    const provisioner = read('scripts/provision-groups-credential.ts');
    const provisionMain = provisioner.slice(
      provisioner.indexOf('async function main'),
    );
    const provisionConfirmation = provisionMain.indexOf(
      'await requireExactConfirmation',
    );
    const provisionPreflightGoogle = provisionMain.indexOf(
      'await readKeylessGoogleProvisioningContract()',
    );
    const provisionPreflightAws = provisionMain.indexOf(
      'inspectGroupsSecretDestination()',
    );
    const provisionPostConfirmationAws = provisionMain.indexOf(
      'if (!inspectGroupsSecretDestination())',
      provisionConfirmation,
    );
    const provisionPostConfirmationGoogle = provisionMain.indexOf(
      'await readKeylessGoogleProvisioningContract()',
      provisionPostConfirmationAws,
    );
    const keyCreation = provisionMain.indexOf(
      'const credentialOutput = runCommand',
      provisionPostConfirmationGoogle,
    );
    const provisionPreStoreGoogle = provisionMain.indexOf(
      'await assertGoogleProvisioningAuthorization(contract)',
      keyCreation,
    );
    const provisionPreStoreKey = provisionMain.indexOf(
      'readUserManagedKeyCreatedAt(contract, createdKeyId)',
      provisionPreStoreGoogle,
    );
    const provisionPreStoreAws = provisionMain.indexOf(
      'assertGroupsSecretDestination()',
      provisionPreStoreKey,
    );
    const credentialStore = provisionMain.indexOf(
      'const storedVersionId = await storeCredential(secretValue)',
      provisionPreStoreAws,
    );
    const provisionInitialStoredCredential = provisionMain.indexOf(
      'assertCurrentStoredCredential(secretValue, storedVersionId)',
      credentialStore,
    );
    const storedOutcome = provisionMain.indexOf(
      "storageOutcome = 'stored'",
      provisionInitialStoredCredential,
    );
    const provisionFinalGoogle = provisionMain.indexOf(
      'await assertGoogleProvisioningAuthorization(contract)',
      storedOutcome,
    );
    const provisionFinalKey = provisionMain.indexOf(
      'readUserManagedKeyCreatedAt(contract, createdKeyId)',
      provisionFinalGoogle,
    );
    const provisionFinalStoredCredential = provisionMain.indexOf(
      'assertCurrentStoredCredential(secretValue, storedVersionId)',
      provisionFinalKey,
    );
    expect(provisionPreflightGoogle).toBeGreaterThan(-1);
    expect(provisionPreflightGoogle).toBeLessThan(provisionConfirmation);
    expect(provisionPreflightAws).toBeLessThan(provisionConfirmation);
    expect(provisionPostConfirmationAws).toBeGreaterThan(provisionConfirmation);
    expect(provisionPostConfirmationGoogle).toBeGreaterThan(
      provisionPostConfirmationAws,
    );
    expect(keyCreation).toBeGreaterThan(provisionPostConfirmationGoogle);
    expect(provisionPreStoreGoogle).toBeGreaterThan(keyCreation);
    expect(provisionPreStoreKey).toBeGreaterThan(provisionPreStoreGoogle);
    expect(provisionPreStoreAws).toBeGreaterThan(provisionPreStoreKey);
    expect(credentialStore).toBeGreaterThan(provisionPreStoreAws);
    expect(provisionInitialStoredCredential).toBeGreaterThan(credentialStore);
    expect(provisionFinalGoogle).toBeGreaterThan(storedOutcome);
    expect(provisionFinalKey).toBeGreaterThan(provisionFinalGoogle);
    expect(provisionFinalStoredCredential).toBeGreaterThan(provisionFinalKey);
    expect(provisioner).toMatch(
      /attemptWrite: \(\) => \{\s*assertGroupsSecretDestination\(\);\s*return putSecretValue/u,
    );
    expect(provisioner).toMatch(
      /versionIsCurrent: \(\) => \{\s*assertGroupsSecretDestination\(\);\s*return secretVersionIsCurrent/u,
    );
    expect(provisioner).toMatch(
      /function inspectGroupsSecretDestination\(\): boolean \{\s*assertAwsAccount\(AWS_PROFILE, AWS_ACCOUNT_ID, AWS_REGION\);\s*return awsSecretExists/u,
    );
    expect(provisioner).toMatch(
      /function assertCurrentStoredCredential[^]*assertCurrentStoredCredentialEvidence\(expected, \{\s*assertDestination: assertGroupsSecretDestination,[^]*readSecretValue\([^]*versionIsCurrent: \(\) =>\s*secretVersionIsCurrent/u,
    );
    expect(provisioner).toContain(
      'return stored ? clientRequestToken : undefined;',
    );
    expect(provisioner).toMatch(
      /async function readKeylessGoogleProvisioningContract[^]*assertActiveGcloudAccount\(TERRAFORM_ADMIN\);\s*await assertApplicationDefaultIdentity\(TERRAFORM_ADMIN\);\s*const contract = readGroupsReaderContract\(\);\s*await assertExactLiveGroupsReaderRole\(contract\);\s*assertRosterReaderCredentialBoundary\(contract\);\s*const existingKeys = listUserManagedKeys\(contract\);\s*if \(existingKeys\.size > 0\)/u,
    );
    expect(provisioner).toMatch(
      /async function assertGoogleProvisioningAuthorization[^]*assertActiveGcloudAccount\(TERRAFORM_ADMIN\);\s*await assertApplicationDefaultIdentity\(TERRAFORM_ADMIN\);\s*await assertExactLiveGroupsReaderRole\(contract\);\s*assertRosterReaderCredentialBoundary\(contract\);/u,
    );

    const oauth = read('scripts/store-oauth-client.ts');
    const oauthMain = oauth.slice(oauth.indexOf('async function main'));
    const oauthConfirmation = oauthMain.indexOf(
      'await requireExactConfirmation',
    );
    const oauthPreflightProject = oauthMain.indexOf(
      'readLiveTerraformProjectNumber()',
    );
    const oauthPreflightAws = oauthMain.indexOf(
      'inspectOauthSecretDestination()',
    );
    const oauthPostConfirmationAws = oauthMain.indexOf(
      'if (!inspectOauthSecretDestination())',
      oauthConfirmation,
    );
    const oauthPostConfirmationProject = oauthMain.indexOf(
      'const confirmedProjectNumber = readLiveTerraformProjectNumber()',
      oauthPostConfirmationAws,
    );
    const oauthWrite = oauthMain.indexOf(
      'const versionStored = await reconcileIdempotentSecretWrite',
      oauthPostConfirmationProject,
    );
    const oauthPostWriteBoundary = oauthMain.indexOf(
      'assertOauthSecretDestination()',
      oauthMain.indexOf('if (!versionStored)'),
    );
    const oauthReadback = oauthMain.indexOf(
      'assertStoredValues(secretValue)',
      oauthPostWriteBoundary,
    );
    const oauthFinalBoundary = oauthMain.indexOf(
      'assertOauthSecretDestination()',
      oauthReadback,
    );
    expect(oauthPreflightProject).toBeGreaterThan(-1);
    expect(oauthPreflightProject).toBeLessThan(oauthConfirmation);
    expect(oauthPreflightAws).toBeLessThan(oauthConfirmation);
    expect(oauthPostConfirmationAws).toBeGreaterThan(oauthConfirmation);
    expect(oauthPostConfirmationProject).toBeGreaterThan(
      oauthPostConfirmationAws,
    );
    expect(oauthWrite).toBeGreaterThan(oauthPostConfirmationProject);
    expect(oauthPostWriteBoundary).toBeGreaterThan(oauthWrite);
    expect(oauthReadback).toBeGreaterThan(oauthPostWriteBoundary);
    expect(oauthFinalBoundary).toBeGreaterThan(oauthReadback);
    expect(oauth).toMatch(
      /attemptWrite: \(\) => \{\s*assertOauthSecretDestination\(\);\s*return putSecretValue/u,
    );
    expect(oauth).toMatch(
      /versionIsCurrent: \(\) => \{\s*assertOauthSecretDestination\(\);\s*return secretVersionIsCurrent/u,
    );
    expect(oauth).toMatch(
      /function inspectOauthSecretDestination\(\): boolean \{\s*assertAwsAccount\(AWS_PROFILE, AWS_ACCOUNT_ID, AWS_REGION\);\s*return awsSecretExists/u,
    );
    expect(oauth).toMatch(
      /function readLiveTerraformProjectNumber\(\): string \{[^]*assertDefaultTerraformWorkspace\(\);[^]*runCommand\('terraform', \['output', '-json', 'project'\]\)[^]*return terraformProjectNumber\(liveProject\);/u,
    );

    const revoker = read('scripts/revoke-groups-credential.ts');
    const revokeMain = revoker.slice(revoker.indexOf('async function main'));
    const revokeConfirmation = revokeMain.indexOf(
      'await requireExactConfirmation',
    );
    const revokePreflight = revokeMain.indexOf(
      'await readRevocationContract(approvedGroup)',
    );
    const revokePostConfirmation = revokeMain.indexOf(
      'await readRevocationContract(approvedGroup)',
      revokeConfirmation,
    );
    const keyDeletion = revokeMain.indexOf("'delete'", revokePostConfirmation);
    expect(revokePreflight).toBeGreaterThan(-1);
    expect(revokePreflight).toBeLessThan(revokeConfirmation);
    expect(revokePostConfirmation).toBeGreaterThan(revokeConfirmation);
    expect(keyDeletion).toBeGreaterThan(revokePostConfirmation);
    expect(revoker).toMatch(
      /function assertGroupsSecretDestination\(\): void \{\s*assertAwsAccount\(AWS_PROFILE, AWS_ACCOUNT_ID, AWS_REGION\);[^]*awsSecretExists/u,
    );
    expect(revoker).toMatch(
      /async function readRevocationContract[^]*assertActiveGcloudAccount\(TERRAFORM_ADMIN\);\s*await assertApplicationDefaultIdentity\(TERRAFORM_ADMIN\);\s*const contract = readGroupsReaderContract\(\);\s*assertRosterReaderCredentialBoundary\(contract\);\s*assertGroupsSecretDestination\(\);\s*const credential = readSecretValue[^]*assertGroupsSecretDestination\(\);\s*const privateKeyId = requiredString[^]*const liveKeys = listUserManagedKeys\(contract\)[^]*readRevocableUserManagedKeyCreatedAt[^]*validateStoredCredential[^]*assertRosterReaderCredentialBoundary\(contract\);\s*assertGroupsSecretDestination\(\);\s*return \{ contract, privateKeyId \};/u,
    );
  });

  test('proves the exact stored version and contents through final readback', () => {
    const expected = {
      client_email: 'psd-eoc-roster-reader@psd401-eoc.iam.gserviceaccount.com',
      private_key: 'synthetic-private-key',
      private_key_id: 'a'.repeat(40),
    } as const;
    const events: string[] = [];
    const versions = [true, true];
    expect(() =>
      assertCurrentStoredCredentialEvidence(expected, {
        assertDestination: () => events.push('destination'),
        readCurrentCredential: () => {
          events.push('credential');
          return { ...expected };
        },
        versionIsCurrent: () => {
          events.push('version');
          return versions.shift() ?? false;
        },
      }),
    ).not.toThrow();
    expect(events).toEqual([
      'destination',
      'version',
      'credential',
      'destination',
      'version',
    ]);

    const assertRejectedVersions = (
      versions: boolean[],
      message: string,
    ): void => {
      expect(() =>
        assertCurrentStoredCredentialEvidence(expected, {
          assertDestination: () => {},
          readCurrentCredential: () => ({ ...expected }),
          versionIsCurrent: () => versions.shift() ?? false,
        }),
      ).toThrow(message);
    };
    assertRejectedVersions([false], 'no longer AWSCURRENT');
    assertRejectedVersions([true, false], 'changed during readback');
    expect(() =>
      assertCurrentStoredCredentialEvidence(expected, {
        assertDestination: () => {},
        readCurrentCredential: () => ({
          ...expected,
          private_key: 'concurrently-rotated-private-key',
        }),
        versionIsCurrent: () => true,
      }),
    ).toThrow('exact roster-reader credential');
  });

  test('retries an ambiguous secret write and retains unresolved ambiguity', async () => {
    const token = 'synthetic-idempotency-token';
    let attempts = 0;
    const recovered = await reconcileIdempotentSecretWrite({
      attemptWrite: () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('synthetic lost response');
        }
        return token;
      },
      clientRequestToken: token,
      versionIsCurrent: () => attempts >= 3,
      wait: async () => {},
    });
    expect(recovered).toBe(true);
    expect(attempts).toBe(3);

    const retryDelays: number[] = [];
    let lostCurrentAttempts = 0;
    const lostCurrent = await reconcileIdempotentSecretWrite({
      attemptWrite: () => {
        lostCurrentAttempts += 1;
        return token;
      },
      clientRequestToken: token,
      versionIsCurrent: () => false,
      wait: async (delayMs) => {
        retryDelays.push(delayMs);
      },
    });
    expect(lostCurrent).toBe(false);
    expect(lostCurrentAttempts).toBe(7);
    expect(retryDelays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000]);

    const unresolved = await reconcileIdempotentSecretWrite({
      attemptWrite: () => {
        throw new Error('synthetic outage');
      },
      clientRequestToken: token,
      versionIsCurrent: () => false,
      wait: async () => {},
    });
    expect(unresolved).toBe(false);

    expect(
      parseCurrentSecretVersionMetadata(
        JSON.stringify({
          VersionId: token,
          VersionStages: ['AWSCURRENT'],
        }),
        token,
      ),
    ).toBe(true);
    expect(
      parseCurrentSecretVersionMetadata(
        JSON.stringify({
          VersionId: 'another-version',
          VersionStages: ['AWSCURRENT'],
        }),
        token,
      ),
    ).toBe(false);
    for (const invalid of [
      'not-json',
      '{}',
      JSON.stringify({ VersionId: token, VersionStages: [] }),
      JSON.stringify({
        SecretString: 'must-never-be-queried',
        VersionId: token,
        VersionStages: ['AWSCURRENT'],
      }),
    ]) {
      expect(() => parseCurrentSecretVersionMetadata(invalid, token)).toThrow(
        'current secret version metadata',
      );
    }

    const runtime = read('scripts/runtime.ts');
    expect(runtime).toContain("'get-secret-value'");
    expect(runtime).toContain("'--version-id'");
    expect(runtime).toContain("'--version-stage'");
    expect(runtime).toContain("'AWSCURRENT'");
    expect(runtime).toContain(
      "'{VersionId:VersionId,VersionStages:VersionStages}'",
    );
    expect(runtime).not.toContain("'list-secret-version-ids'");
  });
});

describe('Groups least-privilege contracts', () => {
  test('accepts only the fixed Terraform reader output', () => {
    expect(parseGroupsReaderContract(validGroupsOutput)).toEqual({
      email: ROSTER_READER_EMAIL,
      projectNumber: '123456789',
      serviceAccountUniqueId: '123456789012345678901',
    });
    expect(() =>
      parseGroupsReaderContract({
        ...validGroupsOutput,
        domain_wide_delegation: true,
      }),
    ).toThrow('fixed read-only contract');
    expect(() =>
      parseGroupsReaderContract({
        ...validGroupsOutput,
        project_iam_roles: ['roles/viewer'],
      }),
    ).toThrow('fixed read-only contract');
  });

  test('binds the Terraform numeric assignee to the fixed live service account', () => {
    const contract = parseGroupsReaderContract(validGroupsOutput);
    expect(
      validateLiveGroupsReaderServiceAccount(validLiveGroupsReader, contract),
    ).toEqual({
      email: ROSTER_READER_EMAIL,
      oauthClientId: '987654321098765432109',
      projectNumber: '123456789',
      serviceAccountUniqueId: '123456789012345678901',
    });
    for (const invalid of [
      { ...validLiveGroupsReader, disabled: true },
      { ...validLiveGroupsReader, projectId: 'wrong-project' },
      { ...validLiveGroupsReader, uniqueId: '999999999999999999999' },
      { ...validLiveGroupsReader, oauth2ClientId: 'not-numeric' },
    ]) {
      expect(() =>
        validateLiveGroupsReaderServiceAccount(invalid, contract),
      ).toThrow('fixed live roster-reader service account');
    }

    const source = read('scripts/groups-contract.ts');
    expect(source).toMatch(
      /'service-accounts',\s*'describe',\s*ROSTER_READER_EMAIL,\s*'--project',\s*PROJECT_ID/gu,
    );
  });

  test('matches only an externally supplied staff-group hash', () => {
    const normalized = normalizeApprovedStaffGroup('EOC-Test-Staff@PSD401.NET');
    expect(normalized).toBe('eoc-test-staff@psd401.net');
    expect(approvedStaffGroupHash(normalized)).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => normalizeApprovedStaffGroup('outside@example.net')).toThrow(
      'staff-only',
    );
    expect(() => normalizeApprovedStaffGroup('test@pſd401.net')).toThrow(
      'staff-only',
    );
  });

  test('binds the AWS credential to Terraform and the approved group', () => {
    const contract = validGroupsReaderContract();
    const group = 'eoc-test-staff@psd401.net';
    const credentialCreatedAt = new Date().toISOString();
    const credential = {
      approved_staff_group_sha256: approvedStaffGroupHash(group),
      client_email: contract.email,
      client_id: contract.oauthClientId,
      credential_created_at: credentialCreatedAt,
      domain_wide_delegation: false,
      oauth_scopes: [READONLY_GROUPS_SCOPE],
      private_key: 'synthetic-private-key',
      private_key_id: 'a'.repeat(40),
      project_id: 'psd401-eoc',
      token_uri: 'https://oauth2.googleapis.com/token',
      type: 'service_account',
      workspace_admin_role: GROUPS_READER_ROLE,
    } as const;

    expect(() =>
      validateStoredCredential(
        credential,
        contract,
        group,
        credentialCreatedAt,
      ),
    ).not.toThrow();
    expect(() =>
      validateStoredCredential(
        { ...credential, client_id: '999999999999999999999' },
        contract,
        group,
        credentialCreatedAt,
      ),
    ).toThrow('does not match');
    expect(() =>
      validateStoredCredential(
        credential,
        contract,
        'other-staff@psd401.net',
        credentialCreatedAt,
      ),
    ).toThrow('does not match');

    const verifiedCredential = {
      credential,
      credentialCreatedAt,
      privateKeyId: credential.private_key_id,
    } as const;
    const stableReads = [{ ...credential }, { ...credential }];
    const observedCredential = readVerifiedStoredCredentialEvidence({
      listLiveKeyIds: () => new Set([credential.private_key_id]),
      readCurrentCredential: () => stableReads.shift() ?? credential,
      readKeyCreatedAt: () => credentialCreatedAt,
      validateCredential: (observed, observedCreatedAt) =>
        validateStoredCredential(observed, contract, group, observedCreatedAt),
    });
    expect(observedCredential).toEqual(verifiedCredential);
    expect(
      sameVerifiedStoredCredential(verifiedCredential, {
        ...verifiedCredential,
        credential: { ...credential },
      }),
    ).toBe(true);
    for (const changed of [
      {
        ...verifiedCredential,
        credential: { ...credential, private_key: 'changed-private-key' },
      },
      {
        ...verifiedCredential,
        credential: { ...credential, unexpected: true },
      },
      { ...verifiedCredential, credentialCreatedAt: new Date(0).toISOString() },
      { ...verifiedCredential, privateKeyId: 'b'.repeat(40) },
    ]) {
      expect(sameVerifiedStoredCredential(verifiedCredential, changed)).toBe(
        false,
      );
      expect(() =>
        assertVerifiedStoredCredentialUnchanged(verifiedCredential, changed),
      ).toThrow('changed during live verification');
    }

    const rotatedCredential = {
      ...credential,
      credential_created_at: new Date(Date.now() + 1_000).toISOString(),
      private_key: 'concurrently-rotated-private-key',
      private_key_id: 'b'.repeat(40),
    } as const;
    const rotatedReads = [{ ...rotatedCredential }, { ...rotatedCredential }];
    const rotatedObservation = readVerifiedStoredCredentialEvidence({
      listLiveKeyIds: () => new Set([rotatedCredential.private_key_id]),
      readCurrentCredential: () => rotatedReads.shift() ?? rotatedCredential,
      readKeyCreatedAt: () => rotatedCredential.credential_created_at,
      validateCredential: (observed, observedCreatedAt) =>
        validateStoredCredential(observed, contract, group, observedCreatedAt),
    });
    expect(() =>
      assertVerifiedStoredCredentialUnchanged(
        observedCredential,
        rotatedObservation,
      ),
    ).toThrow('changed during live verification');

    for (const liveKeyIds of [
      new Set<string>(),
      new Set(['b'.repeat(40)]),
      new Set([credential.private_key_id, 'b'.repeat(40)]),
    ]) {
      expect(() =>
        readVerifiedStoredCredentialEvidence({
          listLiveKeyIds: () => liveKeyIds,
          readCurrentCredential: () => credential,
          readKeyCreatedAt: () => credentialCreatedAt,
          validateCredential: () => {},
        }),
      ).toThrow('exactly the one user-managed key');
    }

    const changingReads = [
      credential,
      { ...credential, private_key: 'concurrently-rotated-private-key' },
    ];
    expect(() =>
      readVerifiedStoredCredentialEvidence({
        listLiveKeyIds: () => new Set([credential.private_key_id]),
        readCurrentCredential: () => changingReads.shift() ?? credential,
        readKeyCreatedAt: () => credentialCreatedAt,
        validateCredential: () => {},
      }),
    ).toThrow('changed while its Google key was validated');
  });

  test('keeps a generated Google private key in memory only', () => {
    const contract = validGroupsReaderContract();
    const generated = {
      client_email: contract.email,
      client_id: contract.oauthClientId,
      private_key: '-----BEGIN PRIVATE KEY-----\nsynthetic-only\n',
      private_key_id: 'a'.repeat(40),
      project_id: 'psd401-eoc',
      token_uri: 'https://oauth2.googleapis.com/token',
      type: 'service_account',
    };
    expect(parseCreatedCredential(JSON.stringify(generated), contract)).toEqual(
      generated,
    );
    expect(parseCreatedKeyId(JSON.stringify(generated))).toBe('a'.repeat(40));
    expect(() =>
      parseCreatedCredential(
        JSON.stringify({ ...generated, project_id: 'wrong-project' }),
        contract,
      ),
    ).toThrow('fixed Terraform service-account contract');
    expect(
      parseCreatedKeyId(
        JSON.stringify({ ...generated, project_id: 'wrong-project' }),
      ),
    ).toBe('a'.repeat(40));
    expect(() =>
      parseCreatedKeyId(
        JSON.stringify({ ...generated, private_key_id: 'invalid-key-id' }),
      ),
    ).toThrow('valid private key ID');

    const provisioner = read('scripts/provision-groups-credential.ts');
    expect(provisioner).toContain("'create',\n        '-'");
    expect(provisioner).toContain(
      'await assertExactLiveGroupsReaderRole(contract)',
    );
    expect(provisioner).toMatch(
      /createdKeyId = candidateCreatedKeyId;\s*await waitForCreatedKey\(contract, existingKeys, createdKeyId\);/u,
    );
    for (const forbidden of ['tmpdir', 'mkdtemp', 'credential.json']) {
      expect(provisioner).not.toContain(forbidden);
    }
  });

  test('enforces the 30-day Google key rotation window', () => {
    const keyId = 'a'.repeat(40);
    const now = Date.parse('2026-08-08T20:00:00.000Z');
    const metadata = {
      keyAlgorithm: 'KEY_ALG_RSA_2048',
      keyOrigin: 'GOOGLE_PROVIDED',
      keyType: 'USER_MANAGED',
      name: `projects/psd401-eoc/serviceAccounts/${ROSTER_READER_EMAIL}/keys/${keyId}`,
      validAfterTime: '2026-08-08T19:00:00.000Z',
      validBeforeTime: '9999-12-31T23:59:59.999Z',
    } as const;
    expect(
      validateUserManagedKeyMetadata(
        { ...metadata, disabled: false, extendedStatus: [] },
        keyId,
        now,
      ),
    ).toBe(metadata.validAfterTime);
    expect(() =>
      validateUserManagedKeyMetadata(
        { ...metadata, validAfterTime: '2026-06-01T00:00:00.000Z' },
        keyId,
        now,
      ),
    ).toThrow('no more than 30 days old');
    expect(
      validateUserManagedKeyMetadata(
        { ...metadata, validAfterTime: '2026-06-01T00:00:00.000Z' },
        keyId,
        now,
        false,
      ),
    ).toBe('2026-06-01T00:00:00.000Z');
    for (const invalid of [
      { ...metadata, disabled: true },
      {
        ...metadata,
        disableReason: 'SERVICE_ACCOUNT_KEY_DISABLE_REASON_EXPOSED',
      },
      {
        ...metadata,
        extendedStatus: [
          { key: 'SERVICE_ACCOUNT_KEY_EXTENDED_STATUS_KEY_EXPOSED' },
        ],
      },
      { ...metadata, name: `${metadata.name}-wrong` },
      { ...metadata, validAfterTime: 'not-a-date' },
      { ...metadata, validAfterTime: '2026-08-08T20:06:00.000Z' },
      {
        ...metadata,
        validAfterTime: '2026-08-08T19:00:00.000Z',
        validBeforeTime: '2026-08-08T18:00:00.000Z',
      },
      { ...metadata, validBeforeTime: '2026-08-08T20:00:00.000Z' },
    ]) {
      expect(() => validateUserManagedKeyMetadata(invalid, keyId, now)).toThrow(
        'Google-generated, active',
      );
    }

    expect(
      validateRevocableUserManagedKeyMetadata(
        {
          ...metadata,
          disabled: true,
          disableReason: 'SERVICE_ACCOUNT_KEY_DISABLE_REASON_EXPOSED',
          extendedStatus: [
            { key: 'SERVICE_ACCOUNT_KEY_EXTENDED_STATUS_KEY_EXPOSED' },
          ],
          validBeforeTime: '2026-08-08T19:30:00.000Z',
        },
        keyId,
        now,
      ),
    ).toBe(metadata.validAfterTime);
    expect(() =>
      validateRevocableUserManagedKeyMetadata(
        { ...metadata, name: `${metadata.name}-wrong` },
        keyId,
        now,
      ),
    ).toThrow('exact Google-generated user-managed key');
  });

  test('requires exactly one full user-managed key metadata record', () => {
    const key = { name: 'synthetic-key' };
    expect(selectUserManagedKeyMetadata([key])).toBe(key);
    for (const invalid of [null, {}, [], [key, key], ['not-an-object']]) {
      expect(() => selectUserManagedKeyMetadata(invalid)).toThrow(
        'exactly one user-managed',
      );
    }

    const contractSource = read('scripts/groups-contract.ts');
    expect(contractSource).toContain("'--managed-by'");
    expect(contractSource).toContain("'--format=json'");
    expect(contractSource).not.toMatch(
      /'service-accounts',\s*'keys',\s*'describe'/gu,
    );
  });

  test('detects direct and broad project principals that can include the reader', () => {
    expect(
      policyCouldGrantServiceAccountAccess(
        {
          bindings: [
            { members: ['user:admin@psd401.net'], role: 'roles/viewer' },
          ],
        },
        ROSTER_READER_EMAIL,
      ),
    ).toBe(false);
    expect(
      policyCouldGrantServiceAccountAccess(
        {
          bindings: [
            {
              members: [
                'serviceAccount:unrelated@other.iam.gserviceaccount.com',
              ],
              role: 'roles/viewer',
            },
          ],
        },
        ROSTER_READER_EMAIL,
      ),
    ).toBe(false);
    for (const member of [
      `serviceAccount:${ROSTER_READER_EMAIL}`,
      'allUsers',
      'allAuthenticatedUsers',
      'principalSet://goog/public:all',
      'principalSet://goog/public:authenticated',
      'group:cloud-admins@psd401.net',
      'domain:psd401.net',
      'principalSet://goog/cloudIdentityCustomerId/C01234567',
      'principalSet://cloudresourcemanager.googleapis.com/projects/123456789/type/ServiceAccount',
      'principalSet://cloudresourcemanager.googleapis.com/organizations/482073499306/type/ServiceAccount',
      'projectOwner:psd401-eoc',
    ]) {
      expect(
        policyCouldGrantServiceAccountAccess(
          { bindings: [{ members: [member], role: 'roles/viewer' }] },
          ROSTER_READER_EMAIL,
        ),
      ).toBe(true);
    }
    expect(() =>
      policyCouldGrantServiceAccountAccess(
        { bindings: [{ members: [42], role: 'roles/viewer' }] },
        ROSTER_READER_EMAIL,
      ),
    ).toThrow('binding is invalid');

    for (const role of [
      'roles/iam.serviceAccountTokenCreator',
      'roles/iam.serviceAccountUser',
      'roles/iam.workloadIdentityUser',
    ]) {
      expect(
        policyCouldGrantServiceAccountAccess(
          {
            bindings: [{ members: ['user:outsider@psd401.net'], role }],
          },
          ROSTER_READER_EMAIL,
        ),
      ).toBe(true);
    }
  });

  test('requires an empty roster-reader resource policy and checks it around sensitive work', () => {
    expect(() => validateRosterReaderResourcePolicy({})).not.toThrow();
    expect(() =>
      validateRosterReaderResourcePolicy({ bindings: [] }),
    ).not.toThrow();
    expect(() =>
      validateRosterReaderResourcePolicy({
        bindings: [
          {
            members: ['user:outsider@psd401.net'],
            role: 'roles/iam.serviceAccountTokenCreator',
          },
        ],
      }),
    ).toThrow('could permit impersonation');
    expect(() =>
      validateRosterReaderResourcePolicy({ bindings: 'invalid' }),
    ).toThrow('bindings are invalid');

    const contract = read('scripts/groups-contract.ts');
    expect(contract).toMatch(
      /'service-accounts',\s*'get-iam-policy',\s*contract\.email,\s*'--project',\s*PROJECT_ID/u,
    );
    expect(contract).toContain('validateProjectIamPolicy(');
    expect(contract).toContain('validateRosterReaderResourcePolicy(');

    for (const [path, expectedChecks] of [
      ['scripts/configure-workspace-role.ts', 4],
      ['scripts/provision-groups-credential.ts', 2],
      ['scripts/verify-groups-readonly.ts', 2],
      ['scripts/revoke-groups-credential.ts', 3],
    ] as const) {
      const helper = read(path);
      expect(
        helper.match(/assertRosterReaderCredentialBoundary\(contract\)/gu),
      ).toHaveLength(expectedChecks);
    }
  });

  test('redacts a network exception that contains the group URL', async () => {
    const privateUrl =
      'https://cloudidentity.googleapis.com/v1/groups:lookup?groupKey.id=eoc-test-staff%40psd401.net';
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    let message = '';
    delete process.env.XDG_CONFIG_HOME;
    try {
      try {
        await redactedFetch(
          async () => {
            throw new Error(privateUrl);
          },
          privateUrl,
          { method: 'GET' },
          'Cloud Identity group lookup',
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
    }
    expect(message).toBe('Cloud Identity group lookup could not reach Google.');
    expect(message).not.toContain('eoc-test-staff');
  });

  test('binds key cleanup to the downloaded key and rejects concurrency', () => {
    const first = 'a'.repeat(40);
    const second = 'b'.repeat(40);
    const firstResource = `projects/psd401-eoc/serviceAccounts/${ROSTER_READER_EMAIL}/keys/${first}`;
    expect(parseUserManagedKeyIds(`${firstResource}\n`)).toEqual(
      new Set([first]),
    );
    expect(createdKeyIsVisible(new Set(), new Set([first]), first)).toBe(true);
    expect(createdKeyIsVisible(new Set(), new Set(), first)).toBe(false);
    expect(() =>
      createdKeyIsVisible(new Set(), new Set([second]), first),
    ).toThrow('concurrently');
    expect(() =>
      createdKeyIsVisible(new Set([first]), new Set([first]), first),
    ).toThrow('new Google key');
    expect(() => parseUserManagedKeyIds('not-a-key')).toThrow('invalid');
    expect(() =>
      parseUserManagedKeyIds(
        `projects/wrong/serviceAccounts/${ROSTER_READER_EMAIL}/keys/${first}`,
      ),
    ).toThrow('invalid service-account key resource name');
    expect(() =>
      parseUserManagedKeyIds(`${firstResource}\n${firstResource}`),
    ).toThrow('duplicate service-account key record');

    const provisioner = read('scripts/provision-groups-credential.ts');
    expect(provisioner.match(/readUserManagedKeyCreatedAt\(/gu)).toHaveLength(
      3,
    );
    expect(provisioner).toMatch(
      /await assertGoogleProvisioningAuthorization\(contract\);\s*if \(\s*readUserManagedKeyCreatedAt\(contract, createdKeyId\) !==\s*credentialCreatedAt\s*\)[^]*assertGroupsSecretDestination\(\);\s*storageOutcome = 'unknown';\s*const storedVersionId = await storeCredential/u,
    );
    expect(provisioner).toMatch(
      /storageOutcome = 'stored';\s*await assertGoogleProvisioningAuthorization\(contract\);\s*if \(\s*readUserManagedKeyCreatedAt\(contract, createdKeyId\) !==\s*credentialCreatedAt\s*\)[^]*assertCurrentStoredCredential\(secretValue, storedVersionId\)/u,
    );
  });

  test('retains unknown keys and reports failed bound-key cleanup', () => {
    const errors = cleanupCredentialArtifacts({
      createdKeyId: 'a'.repeat(40),
      deleteKey: () => {
        throw new Error('synthetic delete failure');
      },
      keyCreationAttempted: true,
      storageOutcome: 'not-stored',
    });

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('could not be deleted');
    expect(String(errors[0])).toContain('a'.repeat(40));

    let remoteDeleteAttempted = false;
    cleanupCredentialArtifacts({
      createdKeyId: 'a'.repeat(40),
      deleteKey: () => {
        remoteDeleteAttempted = true;
      },
      keyCreationAttempted: true,
      storageOutcome: 'unknown',
    });
    expect(remoteDeleteAttempted).toBe(false);
    cleanupCredentialArtifacts({
      createdKeyId: 'a'.repeat(40),
      deleteKey: () => {
        remoteDeleteAttempted = true;
      },
      keyCreationAttempted: true,
      storageOutcome: 'stored',
    });
    expect(remoteDeleteAttempted).toBe(false);

    let unboundKeyId: string | undefined;
    try {
      unboundKeyId = parseCreatedKeyId('synthetic unparseable key output');
    } catch {
      // A successful remote create with unparseable output leaves no safe ID.
    }
    const unboundErrors = cleanupCredentialArtifacts({
      createdKeyId: unboundKeyId,
      deleteKey: () => {
        remoteDeleteAttempted = true;
      },
      keyCreationAttempted: true,
      storageOutcome: 'not-stored',
    });
    expect(unboundKeyId).toBeUndefined();
    expect(remoteDeleteAttempted).toBe(false);
    expect(unboundErrors).toHaveLength(1);
    expect(String(unboundErrors[0])).toContain(
      'Could not bind remote cleanup to the generated Google key',
    );
    expect(String(unboundErrors[0])).not.toContain(
      'synthetic unparseable key output',
    );

    expect(
      cleanupCredentialArtifacts({
        createdKeyId: undefined,
        deleteKey: () => {
          remoteDeleteAttempted = true;
        },
        keyCreationAttempted: false,
        storageOutcome: 'not-stored',
      }),
    ).toEqual([]);
    expect(remoteDeleteAttempted).toBe(false);
  });

  test('rotates by revoking only the exact AWS-bound key', () => {
    const revoke = read('scripts/revoke-groups-credential.ts');

    expect(revoke).toContain('revoke-psd-eoc-readonly-groups-key');
    expect(revoke.match(/'delete'/gu)).toHaveLength(1);
    expect(revoke).toContain('remainingKeys.size !== 0');
    expect(revoke).toContain('readRevocableUserManagedKeyCreatedAt');
    expect(revoke).toContain('issue #68 is undeployed');
    expect(revoke).not.toContain('before re-enabling roster sync');
    expect(revoke).not.toContain('delete-secret');
    expect(revoke).not.toContain('delete-project');
  });

  test('selects the non-super-admin Groups Reader and no other assignment', () => {
    const role = selectGroupsReaderRole([
      {
        isSuperAdminRole: false,
        isSystemRole: true,
        roleId: 'reader-role-id',
        roleName: GROUPS_READER_ROLE,
      },
    ]);
    expect(role).toEqual({ roleId: 'reader-role-id' });
    for (const isSuperAdminRole of [true, 'false', undefined, null, 0, {}]) {
      expect(() =>
        selectGroupsReaderRole([
          {
            isSuperAdminRole,
            isSystemRole: true,
            roleId: 'reader-role-id',
            roleName: GROUPS_READER_ROLE,
          },
        ]),
      ).toThrow('non-super-admin system role');
    }
    expect(() =>
      assertNoUserManagedKeysBeforeRoleAssignment(new Set()),
    ).not.toThrow();
    expect(() =>
      assertNoUserManagedKeysBeforeRoleAssignment(new Set(['a'.repeat(40)])),
    ).toThrow('revoke every key first');
    expect(() =>
      assertNoUserManagedKeysBeforeRoleAssignment(
        new Set(['a'.repeat(40), 'b'.repeat(40)]),
      ),
    ).toThrow('revoke every key first');
    for (const assigneeType of ['user', 'USER']) {
      expect(
        findExactAssignment(
          [
            {
              assignedTo: validGroupsOutput.service_account_unique_id,
              assigneeType,
              condition: '',
              roleAssignmentId: 'assignment-id',
              roleId: role.roleId,
              scopeType: 'CUSTOMER',
            },
          ],
          validGroupsOutput.service_account_unique_id,
          role.roleId,
        ),
      ).toEqual({
        assignedTo: validGroupsOutput.service_account_unique_id,
        assigneeType: 'USER',
        roleAssignmentId: 'assignment-id',
        roleId: role.roleId,
        scopeType: 'CUSTOMER',
      });
    }
    expect(() =>
      findExactAssignment(
        [
          {
            assignedTo: validGroupsOutput.service_account_unique_id,
            assigneeType: 'USER',
            roleAssignmentId: 'wrong-assignment',
            roleId: 'writer-role-id',
            scopeType: 'CUSTOMER',
          },
        ],
        validGroupsOutput.service_account_unique_id,
        role.roleId,
      ),
    ).toThrow('unexpected Workspace admin role');
    expect(() =>
      findExactAssignment(
        [
          {
            assignedTo: validGroupsOutput.service_account_unique_id,
            assigneeType: 'USER',
            condition: 'SECURITY_GROUPS',
            roleAssignmentId: 'conditional-assignment',
            roleId: role.roleId,
            scopeType: 'CUSTOMER',
          },
        ],
        validGroupsOutput.service_account_unique_id,
        role.roleId,
      ),
    ).toThrow('must be unconditional');
    for (const assigneeType of [
      'group',
      'GROUP',
      'User',
      'unknown',
      undefined,
    ]) {
      expect(() =>
        findExactAssignment(
          [
            {
              assignedTo: 'indirect-group-id',
              ...(assigneeType === undefined ? {} : { assigneeType }),
              roleAssignmentId: 'indirect-assignment',
              roleId: role.roleId,
              scopeType: 'CUSTOMER',
            },
          ],
          validGroupsOutput.service_account_unique_id,
          role.roleId,
        ),
      ).toThrow('indirect or group-mediated');
    }

    const roleHelper = read('scripts/configure-workspace-role.ts');
    expect(roleHelper).toContain("'X-Goog-User-Project': PROJECT_ID");
    expect(roleHelper).toContain("url.searchParams.set('userKey', userKey)");
    expect(roleHelper).toContain(
      "url.searchParams.set('includeIndirectRoleAssignments', 'true')",
    );
    expect(roleHelper).toMatch(
      /if \(process\.env\.PSD_EOC_CONFIRM_WORKSPACE_ROLE_ASSIGNMENT !== CONFIRMATION\)[^]*assertRosterReaderCredentialBoundary\(contract\);\s*assertNoUserManagedKeysBeforeRoleAssignment\(listUserManagedKeys\(contract\)\);\s*const created = parseRoleAssignment/u,
    );
    const verifier = read('scripts/verify-groups-readonly.ts');
    expect(
      verifier.match(
        /await assertExactLiveGroupsReaderRole\(contract, fetcher\);/gu,
      ),
    ).toHaveLength(2);
    const firstRoleCheck = verifier.indexOf(
      'await assertExactLiveGroupsReaderRole(contract, fetcher);',
    );
    const membershipRead = verifier.lastIndexOf(
      'await membershipsResponse.body?.cancel();',
    );
    const finalCredentialBoundary = verifier.lastIndexOf(
      'assertRosterReaderCredentialBoundary(contract);',
    );
    const finalRoleCheck = verifier.lastIndexOf(
      'await assertExactLiveGroupsReaderRole(contract, fetcher);',
    );
    const initialCredentialRead = verifier.indexOf(
      'const initialCredential = readVerifiedStoredCredential',
    );
    const finalCredentialRead = verifier.indexOf(
      'const finalCredential = readVerifiedStoredCredential',
    );
    const finalCredentialComparison = verifier.indexOf(
      'assertVerifiedStoredCredentialUnchanged(initialCredential, finalCredential)',
    );
    const pass = verifier.indexOf("console.log(\n    'PASS:");
    expect(firstRoleCheck).toBeGreaterThan(-1);
    expect(firstRoleCheck).toBeLessThan(membershipRead);
    expect(initialCredentialRead).toBeLessThan(membershipRead);
    expect(finalCredentialBoundary).toBeGreaterThan(membershipRead);
    expect(finalRoleCheck).toBeGreaterThan(finalCredentialBoundary);
    expect(finalCredentialRead).toBeGreaterThan(finalRoleCheck);
    expect(finalCredentialComparison).toBeGreaterThan(finalCredentialRead);
    expect(finalCredentialComparison).toBeLessThan(pass);
    expect(finalRoleCheck).toBeLessThan(pass);
    expect(verifier).toMatch(
      /function readVerifiedStoredCredential[^]*return readVerifiedStoredCredentialEvidence\(\{[^]*listUserManagedKeys[^]*readSecretValue[^]*readUserManagedKeyCreatedAt[^]*validateStoredCredential/u,
    );
  });
});

describe('OAuth handoff validation', () => {
  test('parses only simple plist strings and rejects XML entities', () => {
    expect(
      parsePlistStrings(`<?xml version="1.0"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist><dict>
        <key>PROJECT_ID</key><string>psd401-eoc</string>
        <key>BUNDLE_ID</key><string>net.psd401.eoc</string>
      </dict></plist>`),
    ).toEqual({ BUNDLE_ID: 'net.psd401.eoc', PROJECT_ID: 'psd401-eoc' });
    expect(() =>
      parsePlistStrings(
        '<!DOCTYPE plist [<!ENTITY unsafe SYSTEM "file:///etc/passwd">]>',
      ),
    ).toThrow('must not declare');
  });

  test('enforces credential-file location, link, size, and permission boundaries', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    const directory = mkdtempSync(join(tmpdir(), 'psd-eoc-oauth-files-'));
    try {
      const workspaceClient = {
        installed: {
          auth_provider_x509_cert_url:
            'https://www.googleapis.com/oauth2/v1/certs',
          auth_uri: 'https://accounts.google.com/o/oauth2/auth',
          client_id: 'synthetic-admin.apps.googleusercontent.com',
          client_secret: 'synthetic-secret',
          project_id: 'synthetic-admin-tools',
          redirect_uris: ['http://localhost'],
          token_uri: 'https://oauth2.googleapis.com/token',
        },
      } as const;
      const workspacePath = join(directory, 'workspace-client.json');
      const workspaceContents = JSON.stringify(workspaceClient);
      writeFileSync(workspacePath, workspaceContents);
      chmodSync(workspacePath, 0o600);

      expect(await readSecureFile(workspacePath)).toBe(workspaceContents);
      expect(await readSecureFileBytes(workspacePath)).toEqual(
        Buffer.from(workspaceContents),
      );
      let secureCopyPath = '';
      expect(
        await withValidatedWorkspaceClientCopy(workspacePath, (clientPath) => {
          secureCopyPath = clientPath;
          expect(clientPath).not.toBe(workspacePath);
          expect(statSync(dirname(clientPath)).mode & 0o077).toBe(0);
          expect(statSync(clientPath).mode & 0o777).toBe(0o600);
          expect(readFileSync(clientPath, 'utf8')).toBe(workspaceContents);
          writeFileSync(
            workspacePath,
            JSON.stringify({
              installed: {
                ...workspaceClient.installed,
                client_id:
                  'synthetic-replacement-admin.apps.googleusercontent.com',
              },
            }),
          );
          chmodSync(workspacePath, 0o600);
          expect(readFileSync(clientPath, 'utf8')).toBe(workspaceContents);
          return 'synthetic-operation-complete';
        }),
      ).toBe('synthetic-operation-complete');
      expect(() => statSync(secureCopyPath)).toThrow();
      expect(() => statSync(dirname(secureCopyPath))).toThrow();

      let failedCopyPath = '';
      await expect(
        withValidatedWorkspaceClientCopy(workspacePath, (clientPath) => {
          failedCopyPath = clientPath;
          throw new Error('synthetic callback failure');
        }),
      ).rejects.toThrow('synthetic callback failure');
      expect(() => statSync(failedCopyPath)).toThrow();
      expect(() => statSync(dirname(failedCopyPath))).toThrow();

      const previousTempEnvironment = {
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        TMPDIR: process.env.TMPDIR,
      } as const;
      process.env.TEMP = gcpRoot;
      process.env.TMP = gcpRoot;
      process.env.TMPDIR = gcpRoot;
      let ambientProofCopyPath = '';
      try {
        await withValidatedWorkspaceClientCopy(workspacePath, (clientPath) => {
          ambientProofCopyPath = clientPath;
          expect(clientPath.startsWith('/tmp/psd-eoc-workspace-client-')).toBe(
            true,
          );
          expect(isPathOutsideDirectory(gcpRoot, clientPath)).toBe(true);
        });
      } finally {
        for (const name of ['TEMP', 'TMP', 'TMPDIR'] as const) {
          const previous = previousTempEnvironment[name];
          if (previous === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = previous;
          }
        }
      }
      expect(() => statSync(ambientProofCopyPath)).toThrow();
      expect(() => statSync(dirname(ambientProofCopyPath))).toThrow();

      const mutablePath = join(directory, 'mutable-download.json');
      writeFileSync(mutablePath, 'a'.repeat(1_024));
      chmodSync(mutablePath, 0o600);
      await expect(
        readSecureFileBytes(mutablePath, {
          afterInitialValidation: () => {
            writeFileSync(mutablePath, 'b'.repeat(1_024));
          },
        }),
      ).rejects.toThrow('changed while it was being read');

      const webClient = {
        web: {
          client_id: 'synthetic-web.apps.googleusercontent.com',
          client_secret: 'synthetic-secret',
          project_id: 'psd401-eoc',
        },
      } as const;
      const webPath = join(directory, 'web-client.json');
      writeFileSync(webPath, JSON.stringify(webClient));
      chmodSync(webPath, 0o600);
      expect(await readWebClientDownload(webPath)).toEqual(webClient);

      const wrongModePath = join(directory, 'wrong-mode.json');
      writeFileSync(wrongModePath, JSON.stringify(webClient));
      chmodSync(wrongModePath, 0o640);
      await expect(readSecureFile(wrongModePath)).rejects.toThrow(
        'permissions must deny all group and other access',
      );
      await expect(readWebClientDownload(wrongModePath)).rejects.toThrow(
        'permissions must deny all group and other access',
      );
      await expect(
        withValidatedWorkspaceClientCopy(wrongModePath, () => undefined),
      ).rejects.toThrow('mode-0600 file outside the repository');

      const malformedPath = join(directory, 'malformed.json');
      writeFileSync(malformedPath, '{not-json');
      chmodSync(malformedPath, 0o600);
      await expect(readWebClientDownload(malformedPath)).rejects.toThrow(
        'did not contain valid JSON',
      );
      await expect(
        withValidatedWorkspaceClientCopy(malformedPath, () => undefined),
      ).rejects.toThrow('OAuth client is invalid');

      const emptyPath = join(directory, 'empty.json');
      writeFileSync(emptyPath, '');
      chmodSync(emptyPath, 0o600);
      await expect(readSecureFile(emptyPath)).rejects.toThrow(
        'one regular file under 64 KiB',
      );
      await expect(
        withValidatedWorkspaceClientCopy(emptyPath, () => undefined),
      ).rejects.toThrow('mode-0600 file outside the repository');

      const oversizedPath = join(directory, 'oversized.json');
      writeFileSync(oversizedPath, 'x'.repeat(64 * 1024 + 1));
      chmodSync(oversizedPath, 0o600);
      await expect(readSecureFile(oversizedPath)).rejects.toThrow(
        'one regular file under 64 KiB',
      );
      await expect(
        withValidatedWorkspaceClientCopy(oversizedPath, () => undefined),
      ).rejects.toThrow('mode-0600 file outside the repository');

      const repositoryFile = join(gcpRoot, 'README.md');
      await expect(readSecureFile(repositoryFile)).rejects.toThrow(
        'outside the repository',
      );
      await expect(
        withValidatedWorkspaceClientCopy(repositoryFile, () => undefined),
      ).rejects.toThrow('mode-0600 file outside the repository');

      const repositorySymlink = join(directory, 'repository-link.json');
      symlinkSync(repositoryFile, repositorySymlink);
      await expect(readSecureFile(repositorySymlink)).rejects.toThrow(
        'outside the repository',
      );
      await expect(
        withValidatedWorkspaceClientCopy(repositorySymlink, () => undefined),
      ).rejects.toThrow('mode-0600 file outside the repository');

      const hardlinkPath = join(directory, 'workspace-hardlink.json');
      linkSync(workspacePath, hardlinkPath);
      await expect(readSecureFile(hardlinkPath)).rejects.toThrow(
        'one regular file under 64 KiB',
      );
      await expect(
        withValidatedWorkspaceClientCopy(hardlinkPath, () => undefined),
      ).rejects.toThrow('mode-0600 file outside the repository');
    } finally {
      rmSync(directory, { force: true, recursive: true });
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
    }
  });

  test('pins web and iOS identifiers and stores no source file in the repo', () => {
    const helper = read('scripts/store-oauth-client.ts');

    expect(helper).toContain('https://eoc.psd401.net');
    expect(helper).toContain('https://eoc.psd401.net/auth/callback');
    expect(helper).toContain('net.psd401.eoc');
    expect(helper).toContain(
      'OAuth downloads must remain outside the repository',
    );
    expect(helper).toContain('secretVersionIsCurrent');
  });

  test('binds OAuth client IDs to the live Terraform project number', () => {
    expect(
      terraformProjectNumber({
        id: 'psd401-eoc',
        name: 'PSD EOC',
        number: '123456789',
        parent: 'organizations/482073499306',
      }),
    ).toBe('123456789');
    expect(() =>
      terraformProjectNumber({
        id: 'other-project',
        name: 'PSD EOC',
        number: '123456789',
        parent: 'organizations/482073499306',
      }),
    ).toThrow('invalid');
  });
});
