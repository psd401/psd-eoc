import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';

import {
  parseBucketDescribeResult,
  parseProjectDescribeResult,
  parseStateListResult,
  validateBootstrapProject,
  validateStateBucket,
  validateTerraformWorkspace,
} from './scripts/apply';
import {
  findExactAssignment,
  selectGroupsReaderRole,
} from './scripts/configure-workspace-role';
import {
  approvedStaffGroupHash,
  GROUPS_READER_ROLE,
  normalizeApprovedStaffGroup,
  parseGroupsReaderContract,
  parseUserManagedKeyIds,
  policyHasServiceAccountBinding,
  READONLY_GROUPS_SCOPE,
  ROSTER_READER_EMAIL,
  selectUserManagedKeyMetadata,
  validateRevocableUserManagedKeyMetadata,
  validateUserManagedKeyMetadata,
} from './scripts/groups-contract';
import {
  cleanupCredentialArtifacts,
  createdKeyIsVisible,
  parseCreatedCredential,
  parseCreatedKeyId,
} from './scripts/provision-groups-credential';
import {
  reconcileIdempotentSecretWrite,
  sanitizedAwsEnvironment,
  sanitizedGcloudEnvironment,
  sanitizedTerraformEnvironment,
  validateAwsSecretMetadata,
  validateAwsSecretResourcePolicy,
  validateAwsCliHistoryResult,
  validateAwsSsoIdentity,
  validateApplicationDefaultCredentialMetadata,
  validateGcloudConfiguration,
  validateGoogleUserIdentity,
} from './scripts/runtime';
import {
  parsePlistStrings,
  terraformProjectNumber,
} from './scripts/store-oauth-client';
import {
  redactedFetch,
  validateStoredCredential,
} from './scripts/verify-groups-readonly';

const root = new URL('.', import.meta.url);
const read = (path: string): string =>
  readFileSync(new URL(path, root), 'utf8');

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
  oauth_client_id: '123456789012345678901',
  oauth_scopes: [READONLY_GROUPS_SCOPE],
  project_id: 'psd401-eoc',
  project_iam_roles: [],
  workspace_admin_role: GROUPS_READER_ROLE,
  workspace_grant_api_managed: true,
} as const;

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
  storage_url: 'gs://psd401-eoc-terraform-state/',
  uniform_bucket_level_access: true,
  versioning_enabled: true,
} as const;

const validBucketPolicy = {
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

describe('PSD EOC GCP Terraform safety boundary', () => {
  test('binds the project to the district organization and prevents deletion', () => {
    const variables = read('variables.tf');
    const main = read('main.tf');

    expect(variables).toContain('default     = "psd401-eoc"');
    expect(variables).toContain('default     = "482073499306"');
    expect(variables).toContain('default     = "<billing-account>"');
    expect(main).toContain('auto_create_network = false');
    expect(main).toContain('deletion_policy     = "PREVENT"');
    expect(main.match(/prevent_destroy = true/gu)).toHaveLength(4);
    expect(main).toContain('deletion_policy             = "PREVENT"');
  });

  test('pins quota billing to the dedicated project after bootstrap', () => {
    const provider = read('providers.tf');
    const bootstrap = read('bootstrap/main.tf');
    const readme = read('README.md');

    expect(provider).toContain('billing_project       = var.project_id');
    expect(provider).toContain('user_project_override = true');
    expect(bootstrap).not.toContain('billing_project');
    expect(bootstrap).not.toContain('user_project_override');
    expect(readme.match(/--disable-quota-project/gu)).toHaveLength(2);
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
      9,
    );
  });

  test('gives the roster reader no project role and never puts a key in state', () => {
    const allTerraform = terraformFiles()
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    expect(allTerraform).toContain(
      'resource "google_service_account" "roster_reader"',
    );
    expect(allTerraform).not.toContain('serviceAccount:${');
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
    expect(readme).toContain('gcloud auth application-default revoke --quiet');
    expect(readme).toContain(
      '--scopes=openid,https://www.googleapis.com/auth/userinfo.email',
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
      "['plan', '-input=false', `-out=${options.planPath}`]",
    );
    expect(apply).toContain('requireExactConfirmation');
    expect(apply).not.toContain('auto-approve');
    expect(read('scripts/provision-groups-credential.ts')).toContain(
      'store-psd-eoc-readonly-groups-key',
    );
    expect(read('scripts/store-oauth-client.ts')).toContain(
      'store-psd-eoc-google-oauth',
    );
  });

  test('breaks the new-bucket backend cycle with a non-secret bootstrap root', () => {
    const bootstrap = read('bootstrap/main.tf');
    const apply = read('scripts/apply.ts');

    expect(bootstrap).not.toContain('backend "gcs"');
    expect(bootstrap).not.toContain('google_service_account');
    expect(bootstrap).not.toContain('private_key');
    expect(apply).toContain("'terraform', ['init', '-input=false']");
    expect(apply).toContain("'import'");
    expect(apply).toContain("['state', 'rm', ...duplicateResources]");
  });
});

describe('fail-closed bootstrap and process behavior', () => {
  test('refuses every persisted non-default Terraform workspace', () => {
    expect(() => validateTerraformWorkspace('default')).not.toThrow();
    expect(() => validateTerraformWorkspace('production-shadow')).toThrow(
      'Terraform workspace must be default',
    );

    const apply = read('scripts/apply.ts');
    expect(apply).toContain("runCommand('terraform', ['workspace', 'show']");
    expect(apply).toContain('assertDefaultTerraformWorkspace(bootstrapRoot)');
    expect(apply).toContain('assertDefaultTerraformWorkspace();');
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
  });

  test('adopts only a fully private project-owned state backend', () => {
    expect(() =>
      validateStateBucket(validBucket, validBucketPolicy),
    ).not.toThrow();
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
    ).toThrow('project-only');
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
      TF_CLI_ARGS: '-auto-approve',
      TF_CLI_ARGS_apply: '-auto-approve',
      TF_CLI_CONFIG_FILE: '/tmp/wrong.tfrc',
      TF_DATA_DIR: '/tmp/wrong-plugins',
      TF_VAR_project_id: 'wrong-project',
      TF_WORKSPACE: 'wrong',
    });

    expect(environment.PATH).toBe('/usr/bin');
    expect(
      environment.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT,
    ).toBeUndefined();
    expect(environment.CLOUDSDK_CONFIG).toBeUndefined();
    expect(environment.TF_CLI_ARGS).toBeUndefined();
    expect(environment.TF_CLI_ARGS_apply).toBeUndefined();
    expect(environment.TF_CLI_CONFIG_FILE).toBeUndefined();
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
    expect(gcloudEnvironment.PATH).toBe('/usr/bin');
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

    const awsEnvironment = sanitizedAwsEnvironment({
      AWS_ACCESS_KEY_ID: 'wrong-key',
      AWS_CONFIG_FILE: '/tmp/wrong-config',
      AWS_ENDPOINT_URL_SECRETS_MANAGER: 'https://attacker.invalid',
      PATH: '/usr/bin',
      PSD_EOC_APPROVED_TEST_GROUP: 'staff-group@psd401.net',
    });
    expect(awsEnvironment.PATH).toBe('/usr/bin');
    expect(awsEnvironment.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(awsEnvironment.AWS_CONFIG_FILE).toBeUndefined();
    expect(awsEnvironment.AWS_ENDPOINT_URL_SECRETS_MANAGER).toBeUndefined();
    expect(awsEnvironment.PSD_EOC_APPROVED_TEST_GROUP).toBeUndefined();
  });

  test('rejects persistent gcloud impersonation and endpoint overrides', () => {
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

    expect(() =>
      validateApplicationDefaultCredentialMetadata(
        { type: 'authorized_user' },
        'psd401-eoc',
      ),
    ).not.toThrow();
    expect(() =>
      validateApplicationDefaultCredentialMetadata(
        { quota_project_id: 'psd401-eoc', type: 'authorized_user' },
        'psd401-eoc',
      ),
    ).not.toThrow();
    expect(() =>
      validateApplicationDefaultCredentialMetadata(
        { quota_project_id: 'aistudio-462612', type: 'authorized_user' },
        'psd401-eoc',
      ),
    ).toThrow('must omit the quota project');
  });

  test('accepts only the fixed AWS SSO administrator identity', () => {
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
    expect(() => validateAwsCliHistoryResult(1, '', '')).not.toThrow();
    expect(() =>
      validateAwsCliHistoryResult(0, 'disabled\n', ''),
    ).not.toThrow();
    expect(() => validateAwsCliHistoryResult(0, 'enabled\n', '')).toThrow(
      'history must be disabled',
    );
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
      expect(helper.match(/awsSecretExists\(/gu)).toHaveLength(2);
      expect(helper).toContain('expectedAccountId: AWS_ACCOUNT_ID');
    }
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

    const lostCurrent = await reconcileIdempotentSecretWrite({
      attemptWrite: () => token,
      clientRequestToken: token,
      versionIsCurrent: () => false,
      wait: async () => {},
    });
    expect(lostCurrent).toBe(false);

    const unresolved = await reconcileIdempotentSecretWrite({
      attemptWrite: () => {
        throw new Error('synthetic outage');
      },
      clientRequestToken: token,
      versionIsCurrent: () => false,
      wait: async () => {},
    });
    expect(unresolved).toBe(false);
  });
});

describe('Groups least-privilege contracts', () => {
  test('accepts only the fixed Terraform reader output', () => {
    expect(parseGroupsReaderContract(validGroupsOutput)).toEqual({
      email: ROSTER_READER_EMAIL,
      oauthClientId: '123456789012345678901',
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
    const contract = parseGroupsReaderContract(validGroupsOutput);
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
  });

  test('keeps a generated Google private key in memory only', () => {
    const contract = parseGroupsReaderContract(validGroupsOutput);
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
    expect(contractSource).not.toContain("'describe'");
  });

  test('detects any live direct project binding', () => {
    expect(
      policyHasServiceAccountBinding(
        { bindings: [{ members: ['user:admin@psd401.net'] }] },
        ROSTER_READER_EMAIL,
      ),
    ).toBe(false);
    expect(
      policyHasServiceAccountBinding(
        {
          bindings: [{ members: [`serviceAccount:${ROSTER_READER_EMAIL}`] }],
        },
        ROSTER_READER_EMAIL,
      ),
    ).toBe(true);
  });

  test('redacts a network exception that contains the group URL', async () => {
    const privateUrl =
      'https://cloudidentity.googleapis.com/v1/groups:lookup?groupKey.id=eoc-test-staff%40psd401.net';
    let message = '';
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
    expect(message).toBe('Cloud Identity group lookup could not reach Google.');
    expect(message).not.toContain('eoc-test-staff');
  });

  test('binds key cleanup to the downloaded key and rejects concurrency', () => {
    const first = 'a'.repeat(40);
    const second = 'b'.repeat(40);
    expect(parseUserManagedKeyIds(`${first}\n`)).toEqual(new Set([first]));
    expect(createdKeyIsVisible(new Set(), new Set([first]), first)).toBe(true);
    expect(createdKeyIsVisible(new Set(), new Set(), first)).toBe(false);
    expect(() =>
      createdKeyIsVisible(new Set(), new Set([second]), first),
    ).toThrow('concurrently');
    expect(() =>
      createdKeyIsVisible(new Set([first]), new Set([first]), first),
    ).toThrow('new Google key');
    expect(() => parseUserManagedKeyIds('not-a-key')).toThrow('invalid');
  });

  test('retains unknown keys and reports failed bound-key cleanup', () => {
    const errors = cleanupCredentialArtifacts({
      createdKeyId: 'a'.repeat(40),
      deleteKey: () => {
        throw new Error('synthetic delete failure');
      },
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
      storageOutcome: 'unknown',
    });
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
    expect(
      findExactAssignment(
        [
          {
            assignedTo: validGroupsOutput.oauth_client_id,
            assigneeType: 'USER',
            condition: '',
            roleAssignmentId: 'assignment-id',
            roleId: role.roleId,
            scopeType: 'CUSTOMER',
          },
        ],
        validGroupsOutput.oauth_client_id,
        role.roleId,
      ),
    ).toEqual({
      assignedTo: validGroupsOutput.oauth_client_id,
      assigneeType: 'USER',
      roleAssignmentId: 'assignment-id',
      roleId: role.roleId,
      scopeType: 'CUSTOMER',
    });
    expect(() =>
      findExactAssignment(
        [
          {
            assignedTo: validGroupsOutput.oauth_client_id,
            assigneeType: 'USER',
            roleAssignmentId: 'wrong-assignment',
            roleId: 'writer-role-id',
            scopeType: 'CUSTOMER',
          },
        ],
        validGroupsOutput.oauth_client_id,
        role.roleId,
      ),
    ).toThrow('unexpected Workspace admin role');
    expect(() =>
      findExactAssignment(
        [
          {
            assignedTo: validGroupsOutput.oauth_client_id,
            assigneeType: 'USER',
            condition: 'SECURITY_GROUPS',
            roleAssignmentId: 'conditional-assignment',
            roleId: role.roleId,
            scopeType: 'CUSTOMER',
          },
        ],
        validGroupsOutput.oauth_client_id,
        role.roleId,
      ),
    ).toThrow('must be unconditional');
    expect(() =>
      findExactAssignment(
        [
          {
            assignedTo: 'indirect-group-id',
            assigneeType: 'GROUP',
            roleAssignmentId: 'indirect-assignment',
            roleId: role.roleId,
            scopeType: 'CUSTOMER',
          },
        ],
        validGroupsOutput.oauth_client_id,
        role.roleId,
      ),
    ).toThrow('indirect or group-mediated');

    const roleHelper = read('scripts/configure-workspace-role.ts');
    expect(roleHelper).toContain("'X-Goog-User-Project': PROJECT_ID");
    expect(roleHelper).toContain("url.searchParams.set('userKey', userKey)");
    expect(roleHelper).toContain(
      "url.searchParams.set('includeIndirectRoleAssignments', 'true')",
    );
    expect(read('scripts/verify-groups-readonly.ts')).toContain(
      'assertExactLiveGroupsReaderRole(contract, fetcher)',
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
