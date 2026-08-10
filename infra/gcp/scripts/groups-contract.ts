import { createHash } from 'node:crypto';

import {
  validateProjectIamPolicy,
  validateRosterReaderResourcePolicy,
} from './project-policy';
import { assertDefaultTerraformWorkspace, runCommand } from './runtime';

export const PROJECT_ID = 'psd401-eoc';
export const ROSTER_READER_EMAIL =
  'roster-sync-reader@psd401-eoc.iam.gserviceaccount.com';
export const GROUPS_READER_ROLE = '_GROUPS_READER_ROLE';
export const READONLY_GROUPS_SCOPE =
  'https://www.googleapis.com/auth/cloud-identity.groups.readonly';
export const MAX_GROUPS_KEY_AGE_DAYS = 30;

export interface TerraformGroupsReaderContract {
  readonly email: string;
  readonly projectNumber: string;
  readonly serviceAccountUniqueId: string;
}

export interface GroupsReaderContract extends TerraformGroupsReaderContract {
  readonly oauthClientId: string;
}

export function normalizeApprovedStaffGroup(value: string | undefined): string {
  const normalized = value?.toLowerCase();
  if (
    normalized === undefined ||
    !/^[a-z0-9._%+-]+@psd401\.net$/u.test(normalized)
  ) {
    throw new Error(
      'An approved staff-only psd401.net test group is required.',
    );
  }
  return normalized;
}

export function approvedStaffGroupHash(groupEmail: string): string {
  return createHash('sha256').update(groupEmail, 'utf8').digest('hex');
}

export function parseUserManagedKeyIds(output: string): Set<string> {
  const keyIds = output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((name) => name.split('/').at(-1) ?? '');
  if (keyIds.some((keyId) => !/^[a-f0-9]{40}$/u.test(keyId))) {
    throw new Error('Google returned an invalid service-account key ID.');
  }
  return new Set(keyIds);
}

export function parseGroupsReaderContract(
  value: unknown,
): TerraformGroupsReaderContract {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Terraform google_groups_reader output is invalid.');
  }

  const output = value as Readonly<Record<string, unknown>>;
  const projectIamRoles = output.project_iam_roles;
  const oauthScopes = output.oauth_scopes;
  if (
    output.application_writes_google_groups !== false ||
    output.domain_wide_delegation !== false ||
    output.email !== ROSTER_READER_EMAIL ||
    typeof output.service_account_unique_id !== 'string' ||
    !/^\d+$/u.test(output.service_account_unique_id) ||
    !Array.isArray(oauthScopes) ||
    oauthScopes.length !== 1 ||
    oauthScopes[0] !== READONLY_GROUPS_SCOPE ||
    output.project_id !== PROJECT_ID ||
    typeof output.project_number !== 'string' ||
    !/^\d+$/u.test(output.project_number) ||
    !Array.isArray(projectIamRoles) ||
    projectIamRoles.length !== 0 ||
    output.workspace_admin_role !== GROUPS_READER_ROLE ||
    output.workspace_grant_api_managed !== true
  ) {
    throw new Error(
      'Terraform google_groups_reader output does not match the fixed read-only contract.',
    );
  }

  return {
    email: output.email,
    projectNumber: output.project_number,
    serviceAccountUniqueId: output.service_account_unique_id,
  };
}

export function validateLiveGroupsReaderServiceAccount(
  value: unknown,
  contract: TerraformGroupsReaderContract,
): GroupsReaderContract {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Live roster-reader service-account metadata is invalid.');
  }
  const serviceAccount = value as Readonly<Record<string, unknown>>;
  if (
    serviceAccount.name !==
      `projects/${PROJECT_ID}/serviceAccounts/${ROSTER_READER_EMAIL}` ||
    serviceAccount.projectId !== PROJECT_ID ||
    serviceAccount.email !== ROSTER_READER_EMAIL ||
    serviceAccount.uniqueId !== contract.serviceAccountUniqueId ||
    typeof serviceAccount.oauth2ClientId !== 'string' ||
    !/^\d+$/u.test(serviceAccount.oauth2ClientId) ||
    (serviceAccount.disabled !== undefined && serviceAccount.disabled !== false)
  ) {
    throw new Error(
      'Terraform google_groups_reader output does not identify the fixed live roster-reader service account.',
    );
  }
  return {
    ...contract,
    oauthClientId: serviceAccount.oauth2ClientId,
  };
}

export function readGroupsReaderContract(): GroupsReaderContract {
  assertDefaultTerraformWorkspace();
  const value: unknown = JSON.parse(
    runCommand('terraform', ['output', '-json', 'google_groups_reader']),
  );
  const contract = parseGroupsReaderContract(value);
  let serviceAccount: unknown;
  try {
    serviceAccount = JSON.parse(
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
    );
  } catch {
    throw new Error(
      'Live roster-reader service-account metadata is unavailable.',
    );
  }
  return validateLiveGroupsReaderServiceAccount(serviceAccount, contract);
}

export function listUserManagedKeys(
  contract: GroupsReaderContract,
): Set<string> {
  return parseUserManagedKeyIds(
    runCommand('gcloud', [
      'iam',
      'service-accounts',
      'keys',
      'list',
      '--iam-account',
      contract.email,
      '--project',
      PROJECT_ID,
      '--managed-by',
      'user',
      '--format=value(name)',
    ]),
  );
}

function validateKeyMetadata(
  value: unknown,
  expectedKeyId: string,
  now: number,
  enforceMaximumAge: boolean,
  requireActive: boolean,
): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !/^[a-f0-9]{40}$/u.test(expectedKeyId)
  ) {
    throw new Error('Google service-account key metadata is invalid.');
  }
  const key = value as Readonly<Record<string, unknown>>;
  const validAfter =
    typeof key.validAfterTime === 'string'
      ? Date.parse(key.validAfterTime)
      : Number.NaN;
  const validBefore =
    typeof key.validBeforeTime === 'string'
      ? Date.parse(key.validBeforeTime)
      : Number.NaN;
  const extendedStatus = key.extendedStatus;
  const maximumAge = MAX_GROUPS_KEY_AGE_DAYS * 24 * 60 * 60 * 1_000;
  if (
    key.name !==
      `projects/${PROJECT_ID}/serviceAccounts/${ROSTER_READER_EMAIL}/keys/${expectedKeyId}` ||
    key.keyAlgorithm !== 'KEY_ALG_RSA_2048' ||
    key.keyOrigin !== 'GOOGLE_PROVIDED' ||
    key.keyType !== 'USER_MANAGED' ||
    (requireActive &&
      ((key.disabled !== undefined && key.disabled !== false) ||
        key.disableReason !== undefined ||
        (extendedStatus !== undefined &&
          (!Array.isArray(extendedStatus) || extendedStatus.length > 0)))) ||
    !Number.isFinite(validAfter) ||
    !Number.isFinite(validBefore) ||
    validAfter > now + 5 * 60 * 1_000 ||
    (enforceMaximumAge && now - validAfter > maximumAge) ||
    validBefore <= validAfter ||
    (requireActive && validBefore <= now)
  ) {
    throw new Error(
      requireActive
        ? `The roster-reader key must be Google-generated, active, and no more than ${MAX_GROUPS_KEY_AGE_DAYS} days old.`
        : 'The revocable roster-reader key must be the exact Google-generated user-managed key with valid identity metadata.',
    );
  }
  return new Date(validAfter).toISOString();
}

export function validateUserManagedKeyMetadata(
  value: unknown,
  expectedKeyId: string,
  now = Date.now(),
  enforceMaximumAge = true,
): string {
  return validateKeyMetadata(
    value,
    expectedKeyId,
    now,
    enforceMaximumAge,
    true,
  );
}

export function validateRevocableUserManagedKeyMetadata(
  value: unknown,
  expectedKeyId: string,
  now = Date.now(),
): string {
  return validateKeyMetadata(value, expectedKeyId, now, false, false);
}

export function selectUserManagedKeyMetadata(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    typeof value[0] !== 'object' ||
    value[0] === null ||
    Array.isArray(value[0])
  ) {
    throw new Error(
      'Google must return exactly one user-managed service-account key.',
    );
  }
  return value[0] as Readonly<Record<string, unknown>>;
}

function readUserManagedKeyMetadata(
  contract: GroupsReaderContract,
): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = selectUserManagedKeyMetadata(
      JSON.parse(
        runCommand(
          'gcloud',
          [
            'iam',
            'service-accounts',
            'keys',
            'list',
            '--iam-account',
            contract.email,
            '--project',
            PROJECT_ID,
            '--managed-by',
            'user',
            '--format=json',
          ],
          { redactFailureOutput: true },
        ),
      ),
    );
  } catch {
    throw new Error('Google service-account key metadata is unavailable.');
  }
  return value as Readonly<Record<string, unknown>>;
}

export function readUserManagedKeyCreatedAt(
  contract: GroupsReaderContract,
  keyId: string,
  enforceMaximumAge = true,
): string {
  return validateUserManagedKeyMetadata(
    readUserManagedKeyMetadata(contract),
    keyId,
    Date.now(),
    enforceMaximumAge,
  );
}

export function readRevocableUserManagedKeyCreatedAt(
  contract: GroupsReaderContract,
  keyId: string,
): string {
  return validateRevocableUserManagedKeyMetadata(
    readUserManagedKeyMetadata(contract),
    keyId,
  );
}

export function policyCouldGrantServiceAccountAccess(
  value: unknown,
  serviceAccountEmail: string,
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Google Cloud project IAM policy is invalid.');
  }
  const bindings = (value as Readonly<Record<string, unknown>>).bindings;
  if (!Array.isArray(bindings)) {
    throw new Error('Google Cloud project IAM policy has no bindings array.');
  }

  const member = `serviceAccount:${serviceAccountEmail}`;
  return bindings.some((binding) => {
    if (
      typeof binding !== 'object' ||
      binding === null ||
      Array.isArray(binding)
    ) {
      throw new Error('Google Cloud project IAM binding is invalid.');
    }
    const record = binding as Readonly<Record<string, unknown>>;
    const members = record.members;
    if (
      typeof record.role !== 'string' ||
      record.role.length === 0 ||
      !Array.isArray(members) ||
      members.length === 0 ||
      members.some((candidate) => typeof candidate !== 'string')
    ) {
      throw new Error('Google Cloud project IAM binding is invalid.');
    }
    if (
      new Set([
        'roles/iam.serviceAccountTokenCreator',
        'roles/iam.serviceAccountUser',
        'roles/iam.workloadIdentityUser',
      ]).has(record.role)
    ) {
      return true;
    }
    return members.some(
      (candidate) =>
        candidate === member ||
        candidate === 'allUsers' ||
        candidate === 'allAuthenticatedUsers' ||
        candidate === 'principalSet://goog/public:all' ||
        candidate === 'principalSet://goog/public:authenticated' ||
        candidate.startsWith('group:') ||
        candidate.startsWith('domain:') ||
        candidate.startsWith('principalSet://goog/') ||
        /^principalSet:\/\/cloudresourcemanager\.googleapis\.com\/(?:projects|folders|organizations)\/\d+\/type\/ServiceAccount$/u.test(
          candidate,
        ) ||
        /^project(?:Editor|Owner|Viewer):/u.test(candidate),
    );
  });
}

export function assertRosterReaderCredentialBoundary(
  contract: GroupsReaderContract,
): void {
  const projectPolicy: unknown = JSON.parse(
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
  );
  if (policyCouldGrantServiceAccountAccess(projectPolicy, contract.email)) {
    throw new Error(
      'The roster-reader service account unexpectedly has a project role or an unreviewed principal can impersonate it.',
    );
  }
  validateProjectIamPolicy(
    projectPolicy,
    contract.projectNumber,
    'steady-state',
  );

  const serviceAccountPolicy: unknown = JSON.parse(
    runCommand(
      'gcloud',
      [
        'iam',
        'service-accounts',
        'get-iam-policy',
        contract.email,
        '--project',
        PROJECT_ID,
        '--format=json',
        '--quiet',
      ],
      { redactFailureOutput: true },
    ),
  );
  validateRosterReaderResourcePolicy(serviceAccountPolicy);
}
