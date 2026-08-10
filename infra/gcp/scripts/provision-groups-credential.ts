import { randomUUID } from 'node:crypto';

import { assertExactLiveGroupsReaderRole } from './configure-workspace-role';
import {
  assertRosterReaderCredentialBoundary,
  approvedStaffGroupHash,
  GROUPS_READER_ROLE,
  listUserManagedKeys,
  normalizeApprovedStaffGroup,
  PROJECT_ID,
  readUserManagedKeyCreatedAt,
  READONLY_GROUPS_SCOPE,
  readGroupsReaderContract,
  type GroupsReaderContract,
} from './groups-contract';
import {
  assertActiveGcloudAccount,
  assertApplicationDefaultIdentity,
  assertAwsAccount,
  awsServiceEndpoint,
  awsSecretExists,
  putSecretValue,
  readSecretValue,
  reconcileIdempotentSecretWrite,
  requiredString,
  requireExactConfirmation,
  runCommand,
  secretVersionIsCurrent,
} from './runtime';

const AWS_ACCOUNT_ID = '338414773271';
const AWS_PROFILE = 'psd401-prr-prod';
const AWS_REGION = 'us-west-2';
const SECRET_NAME = '/psd-eoc/google-groups';
const TERRAFORM_ADMIN = 'kjh_admin@psd401.net';

export function createdKeyIsVisible(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  expectedKeyId: string,
): boolean {
  if (!/^[a-f0-9]{40}$/u.test(expectedKeyId) || before.has(expectedKeyId)) {
    throw new Error(
      'Downloaded credential does not identify a new Google key.',
    );
  }
  const unexpected = [...after].filter(
    (keyId) => !before.has(keyId) && keyId !== expectedKeyId,
  );
  if (unexpected.length > 0) {
    throw new Error(
      'Another service-account key appeared concurrently; only the downloaded key can be deleted safely.',
    );
  }
  return after.has(expectedKeyId);
}

function createGroupsSecretPlaceholder(): void {
  runCommand('aws', [
    'secretsmanager',
    'create-secret',
    '--name',
    SECRET_NAME,
    '--description',
    'PSD EOC read-only Google Groups roster-sync credential.',
    '--region',
    AWS_REGION,
    '--profile',
    AWS_PROFILE,
    '--endpoint-url',
    awsServiceEndpoint('secretsmanager', AWS_REGION),
    '--tags',
    'Key=Application,Value=PSD EOC',
    'Key=ManagedBy,Value=infra/gcp',
    '--query',
    'ARN',
    '--output',
    'text',
  ]);
}

function inspectGroupsSecretDestination(): boolean {
  assertAwsAccount(AWS_PROFILE, AWS_ACCOUNT_ID, AWS_REGION);
  return awsSecretExists({
    expectedAccountId: AWS_ACCOUNT_ID,
    profile: AWS_PROFILE,
    region: AWS_REGION,
    secretName: SECRET_NAME,
  });
}

function assertGroupsSecretDestination(): void {
  if (!inspectGroupsSecretDestination()) {
    throw new Error('The expected Groups secret is unavailable.');
  }
}

function validateCredential(
  value: unknown,
  contract: GroupsReaderContract,
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Created Google credential is not one JSON object.');
  }
  const credential = value as Readonly<Record<string, unknown>>;
  const projectId = requiredString(credential, 'project_id');
  const clientEmail = requiredString(credential, 'client_email');
  const clientId = requiredString(credential, 'client_id');
  const privateKeyId = requiredString(credential, 'private_key_id');
  const privateKey = requiredString(credential, 'private_key');
  if (
    credential.type !== 'service_account' ||
    credential.token_uri !== 'https://oauth2.googleapis.com/token' ||
    projectId !== PROJECT_ID ||
    clientEmail !== contract.email ||
    clientId !== contract.oauthClientId ||
    !/^[a-f0-9]{40}$/u.test(privateKeyId) ||
    !privateKey.startsWith('-----BEGIN PRIVATE KEY-----\n')
  ) {
    throw new Error(
      'Created credential does not match the fixed Terraform service-account contract.',
    );
  }
  return credential;
}

export function parseCreatedCredential(
  output: string,
  contract: GroupsReaderContract,
): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error('Created Google credential did not contain valid JSON.');
  }
  return validateCredential(value, contract);
}

export function parseCreatedKeyId(output: string): string {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error('Created Google credential did not contain valid JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Created Google credential is not one JSON object.');
  }
  const privateKeyId = (value as Readonly<Record<string, unknown>>)
    .private_key_id;
  if (
    typeof privateKeyId !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(privateKeyId)
  ) {
    throw new Error(
      'Created Google credential does not contain a valid private key ID.',
    );
  }
  return privateKeyId;
}

async function waitForCreatedKey(
  contract: GroupsReaderContract,
  existingKeys: ReadonlySet<string>,
  createdKeyId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (
      createdKeyIsVisible(
        existingKeys,
        listUserManagedKeys(contract),
        createdKeyId,
      )
    ) {
      return;
    }
    if (attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(
    'The downloaded Google key did not become visible in the service-account key list.',
  );
}

function storedCredentialValue(
  credential: Readonly<Record<string, unknown>>,
  approvedGroupHash: string,
  credentialCreatedAt: string,
): Readonly<Record<string, unknown>> {
  return {
    ...credential,
    approved_staff_group_sha256: approvedGroupHash,
    credential_created_at: credentialCreatedAt,
    domain_wide_delegation: false,
    oauth_scopes: [READONLY_GROUPS_SCOPE],
    workspace_admin_role: GROUPS_READER_ROLE,
  };
}

async function storeCredential(
  secretValue: Readonly<Record<string, unknown>>,
): Promise<string | undefined> {
  const clientRequestToken = randomUUID();
  const stored = await reconcileIdempotentSecretWrite({
    attemptWrite: () => {
      assertGroupsSecretDestination();
      return putSecretValue({
        clientRequestToken,
        profile: AWS_PROFILE,
        region: AWS_REGION,
        secretName: SECRET_NAME,
        secretValue,
      });
    },
    clientRequestToken,
    versionIsCurrent: () => {
      assertGroupsSecretDestination();
      return secretVersionIsCurrent({
        clientRequestToken,
        profile: AWS_PROFILE,
        region: AWS_REGION,
        secretName: SECRET_NAME,
      });
    },
  });
  return stored ? clientRequestToken : undefined;
}

function assertStoredCredential(
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
): void {
  const expectedNames = Object.keys(expected).sort();
  const actualNames = Object.keys(actual).sort();
  if (
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames) ||
    expectedNames.some(
      (name) => JSON.stringify(actual[name]) !== JSON.stringify(expected[name]),
    )
  ) {
    throw new Error(
      'AWS did not read back the exact roster-reader credential contract.',
    );
  }
}

export interface CurrentStoredCredentialProbe {
  readonly assertDestination: () => void;
  readonly readCurrentCredential: () => Readonly<Record<string, unknown>>;
  readonly versionIsCurrent: () => boolean;
}

export function assertCurrentStoredCredentialEvidence(
  expected: Readonly<Record<string, unknown>>,
  probe: CurrentStoredCredentialProbe,
): void {
  probe.assertDestination();
  if (!probe.versionIsCurrent()) {
    throw new Error(
      'The stored roster-reader credential version is no longer AWSCURRENT.',
    );
  }
  assertStoredCredential(expected, probe.readCurrentCredential());
  probe.assertDestination();
  if (!probe.versionIsCurrent()) {
    throw new Error(
      'The stored roster-reader credential version changed during readback.',
    );
  }
}

function assertCurrentStoredCredential(
  expected: Readonly<Record<string, unknown>>,
  storedVersionId: string,
): void {
  assertCurrentStoredCredentialEvidence(expected, {
    assertDestination: assertGroupsSecretDestination,
    readCurrentCredential: () =>
      readSecretValue({
        profile: AWS_PROFILE,
        region: AWS_REGION,
        secretName: SECRET_NAME,
      }),
    versionIsCurrent: () =>
      secretVersionIsCurrent({
        clientRequestToken: storedVersionId,
        profile: AWS_PROFILE,
        region: AWS_REGION,
        secretName: SECRET_NAME,
      }),
  });
}

export function cleanupCredentialArtifacts(options: {
  readonly createdKeyId: string | undefined;
  readonly deleteKey: (keyId: string) => void;
  readonly keyCreationAttempted: boolean;
  readonly storageOutcome: 'stored' | 'not-stored' | 'unknown';
}): unknown[] {
  const errors: unknown[] = [];
  if (options.keyCreationAttempted && options.createdKeyId === undefined) {
    errors.push(
      new Error(
        'Could not bind remote cleanup to the generated Google key; manual reconciliation is required.',
      ),
    );
  }
  if (
    options.storageOutcome === 'not-stored' &&
    options.createdKeyId !== undefined
  ) {
    try {
      options.deleteKey(options.createdKeyId);
    } catch {
      errors.push(
        new Error(
          `The newly created Google key ${options.createdKeyId} could not be deleted; manual reconciliation is required.`,
        ),
      );
    }
  }
  return errors;
}

async function assertGoogleProvisioningAuthorization(
  contract: GroupsReaderContract,
): Promise<void> {
  assertActiveGcloudAccount(TERRAFORM_ADMIN);
  await assertApplicationDefaultIdentity(TERRAFORM_ADMIN);
  await assertExactLiveGroupsReaderRole(contract);
  assertRosterReaderCredentialBoundary(contract);
}

async function readKeylessGoogleProvisioningContract(): Promise<{
  readonly contract: GroupsReaderContract;
  readonly existingKeys: ReadonlySet<string>;
}> {
  assertActiveGcloudAccount(TERRAFORM_ADMIN);
  await assertApplicationDefaultIdentity(TERRAFORM_ADMIN);
  const contract = readGroupsReaderContract();
  await assertExactLiveGroupsReaderRole(contract);
  assertRosterReaderCredentialBoundary(contract);
  const existingKeys = listUserManagedKeys(contract);
  if (existingKeys.size > 0) {
    throw new Error(
      'A user-managed roster-reader key already exists; rotate it explicitly instead of creating another.',
    );
  }
  return { contract, existingKeys };
}

async function main(): Promise<void> {
  if (process.argv.slice(2).length > 0) {
    throw new Error('This helper accepts no command-line options.');
  }
  const approvedGroup = normalizeApprovedStaffGroup(
    process.env.PSD_EOC_APPROVED_TEST_GROUP,
  );
  const approvedGroupHash = approvedStaffGroupHash(approvedGroup);
  await readKeylessGoogleProvisioningContract();
  inspectGroupsSecretDestination();
  await requireExactConfirmation(
    'Groups credential consequence preview: create one user-managed key for the roster-reader service account, which has no direct project IAM binding, and store it only in the retained AWS secret bound to the externally approved staff-only group hash. Inherited or group-mediated GCP IAM must be checked separately as documented. This does not read a group, send a notification, or authorize any human-only action.',
    'store-psd-eoc-readonly-groups-key',
  );
  if (!inspectGroupsSecretDestination()) {
    createGroupsSecretPlaceholder();
    assertGroupsSecretDestination();
  }
  const { contract, existingKeys } =
    await readKeylessGoogleProvisioningContract();

  let keyCreationAttempted = false;
  let createdKeyId: string | undefined;
  let storageOutcome: 'stored' | 'not-stored' | 'unknown' = 'not-stored';
  let operationError: unknown;
  const cleanupErrors: unknown[] = [];

  try {
    keyCreationAttempted = true;
    const credentialOutput = runCommand(
      'gcloud',
      [
        'iam',
        'service-accounts',
        'keys',
        'create',
        '-',
        '--iam-account',
        contract.email,
        '--project',
        PROJECT_ID,
        '--key-file-type=json',
      ],
      { redactFailureOutput: true },
    );

    const candidateCreatedKeyId = parseCreatedKeyId(credentialOutput);
    createdKeyId = candidateCreatedKeyId;
    await waitForCreatedKey(contract, existingKeys, createdKeyId);
    const credential = parseCreatedCredential(credentialOutput, contract);
    const credentialCreatedAt = readUserManagedKeyCreatedAt(
      contract,
      createdKeyId,
    );
    const secretValue = storedCredentialValue(
      credential,
      approvedGroupHash,
      credentialCreatedAt,
    );
    await assertGoogleProvisioningAuthorization(contract);
    if (
      readUserManagedKeyCreatedAt(contract, createdKeyId) !==
      credentialCreatedAt
    ) {
      throw new Error(
        'Google did not preserve the exact sole roster-reader key before AWS storage.',
      );
    }
    assertGroupsSecretDestination();
    storageOutcome = 'unknown';
    const storedVersionId = await storeCredential(secretValue);
    if (storedVersionId === undefined) {
      throw new Error(
        'AWS credential storage could not be verified; the remote key is retained for manual reconciliation.',
      );
    }
    try {
      assertCurrentStoredCredential(secretValue, storedVersionId);
    } catch {
      throw new Error(
        'AWS credential readback could not be verified; the remote key is retained for manual reconciliation.',
      );
    }
    storageOutcome = 'stored';
    await assertGoogleProvisioningAuthorization(contract);
    if (
      readUserManagedKeyCreatedAt(contract, createdKeyId) !==
      credentialCreatedAt
    ) {
      throw new Error(
        'Google did not preserve the exact sole AWS-stored roster-reader key; manual reconciliation is required.',
      );
    }
    try {
      assertCurrentStoredCredential(secretValue, storedVersionId);
    } catch {
      throw new Error(
        'The exact AWS credential version or contents changed after final Google verification; the remote key is retained for manual reconciliation.',
      );
    }
  } catch (error) {
    operationError = error;
  }

  cleanupErrors.push(
    ...cleanupCredentialArtifacts({
      createdKeyId,
      deleteKey: (keyId) => {
        runCommand(
          'gcloud',
          [
            'iam',
            'service-accounts',
            'keys',
            'delete',
            keyId,
            '--iam-account',
            contract.email,
            '--project',
            PROJECT_ID,
            '--quiet',
          ],
          { redactFailureOutput: true },
        );
      },
      keyCreationAttempted,
      storageOutcome,
    }),
  );

  if (operationError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      [
        ...(operationError === undefined ? [] : [operationError]),
        ...cleanupErrors,
      ],
      'Roster-reader credential provisioning failed.',
    );
  }

  console.log(
    `Stored the roster-reader credential as a new ${SECRET_NAME} version; no credential or group value was printed or written to Terraform state.`,
  );
}

if (import.meta.main) {
  await main();
}
