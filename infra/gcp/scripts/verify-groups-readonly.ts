import { createSign, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { assertExactLiveGroupsReaderRole } from './configure-workspace-role';
import {
  approvedStaffGroupHash,
  assertRosterReaderCredentialBoundary,
  GROUPS_READER_ROLE,
  listUserManagedKeys,
  normalizeApprovedStaffGroup,
  PROJECT_ID,
  READONLY_GROUPS_SCOPE,
  readGroupsReaderContract,
  readUserManagedKeyCreatedAt,
  type GroupsReaderContract,
} from './groups-contract';
import {
  AWS_ACCOUNT_ID,
  assertActiveGcloudAccount,
  assertApplicationDefaultIdentity,
  assertAwsAccount,
  awsSecretExists,
  boundedGoogleJsonObject,
  guardedGoogleFetch,
  readSecretValue,
  requiredString,
  type GoogleFetcher,
} from './runtime';

const AWS_PROFILE = 'psd401-prr-prod';
const AWS_REGION = 'us-west-2';
const SECRET_NAME = '/psd-eoc/google-groups';
const TERRAFORM_ADMIN = 'kjh_admin@psd401.net';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CLOUD_IDENTITY_ENDPOINT = 'https://cloudidentity.googleapis.com/v1';

type Fetcher = GoogleFetcher;

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function validateStoredCredential(
  credential: Readonly<Record<string, unknown>>,
  contract: GroupsReaderContract,
  approvedGroup: string,
  liveCredentialCreatedAt: string,
): void {
  const configuredScopes = credential.oauth_scopes;
  const expectedHash = approvedStaffGroupHash(approvedGroup);
  const storedHash = credential.approved_staff_group_sha256;
  const hashMatches =
    typeof storedHash === 'string' &&
    /^[a-f0-9]{64}$/u.test(storedHash) &&
    timingSafeEqual(Buffer.from(storedHash), Buffer.from(expectedHash));
  if (
    credential.type !== 'service_account' ||
    credential.project_id !== PROJECT_ID ||
    credential.client_email !== contract.email ||
    credential.client_id !== contract.oauthClientId ||
    credential.credential_created_at !== liveCredentialCreatedAt ||
    credential.token_uri !== TOKEN_ENDPOINT ||
    credential.domain_wide_delegation !== false ||
    credential.workspace_admin_role !== GROUPS_READER_ROLE ||
    !Array.isArray(configuredScopes) ||
    configuredScopes.length !== 1 ||
    configuredScopes[0] !== READONLY_GROUPS_SCOPE ||
    !hashMatches
  ) {
    throw new Error(
      'Stored credential does not match the Terraform identity and approved staff-group contract.',
    );
  }
  requiredString(credential, 'private_key_id');
  requiredString(credential, 'private_key');
}

function serviceAccountAssertion(
  credential: Readonly<Record<string, unknown>>,
): string {
  const clientEmail = requiredString(credential, 'client_email');
  const privateKey = requiredString(credential, 'private_key');
  const privateKeyId = requiredString(credential, 'private_key_id');
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(
    JSON.stringify({ alg: 'RS256', kid: privateKeyId, typ: 'JWT' }),
  );
  const payload = base64Url(
    JSON.stringify({
      aud: TOKEN_ENDPOINT,
      exp: now + 3_600,
      iat: now,
      iss: clientEmail,
      scope: READONLY_GROUPS_SCOPE,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${base64Url(signer.sign(privateKey))}`;
}

export interface VerifiedStoredCredential {
  readonly credential: Readonly<Record<string, unknown>>;
  readonly credentialCreatedAt: string;
  readonly privateKeyId: string;
}

export function sameVerifiedStoredCredential(
  left: VerifiedStoredCredential,
  right: VerifiedStoredCredential,
): boolean {
  return (
    left.privateKeyId === right.privateKeyId &&
    left.credentialCreatedAt === right.credentialCreatedAt &&
    isDeepStrictEqual(left.credential, right.credential)
  );
}

export function assertVerifiedStoredCredentialUnchanged(
  initial: VerifiedStoredCredential,
  final: VerifiedStoredCredential,
): void {
  if (!sameVerifiedStoredCredential(initial, final)) {
    throw new Error(
      'The current AWS-backed roster-reader credential changed during live verification.',
    );
  }
}

export interface StoredCredentialEvidenceProbe {
  readonly listLiveKeyIds: () => ReadonlySet<string>;
  readonly readCurrentCredential: () => Readonly<Record<string, unknown>>;
  readonly readKeyCreatedAt: (privateKeyId: string) => string;
  readonly validateCredential: (
    credential: Readonly<Record<string, unknown>>,
    credentialCreatedAt: string,
  ) => void;
}

export function readVerifiedStoredCredentialEvidence(
  probe: StoredCredentialEvidenceProbe,
): VerifiedStoredCredential {
  const credential = probe.readCurrentCredential();
  const privateKeyId = requiredString(credential, 'private_key_id');
  const liveKeys = probe.listLiveKeyIds();
  if (liveKeys.size !== 1 || !liveKeys.has(privateKeyId)) {
    throw new Error(
      'The roster-reader must have exactly the one user-managed key stored in AWS.',
    );
  }
  const credentialCreatedAt = probe.readKeyCreatedAt(privateKeyId);
  probe.validateCredential(credential, credentialCreatedAt);
  const confirmedCredential = probe.readCurrentCredential();
  if (!isDeepStrictEqual(confirmedCredential, credential)) {
    throw new Error(
      'The current AWS-backed roster-reader credential changed while its Google key was validated.',
    );
  }
  return { credential: confirmedCredential, credentialCreatedAt, privateKeyId };
}

function readVerifiedStoredCredential(
  contract: GroupsReaderContract,
  approvedGroup: string,
): VerifiedStoredCredential {
  assertAwsAccount(AWS_PROFILE, AWS_ACCOUNT_ID, AWS_REGION);
  if (
    !awsSecretExists({
      expectedAccountId: AWS_ACCOUNT_ID,
      profile: AWS_PROFILE,
      region: AWS_REGION,
      secretName: SECRET_NAME,
    })
  ) {
    throw new Error(
      'The retained AWS Groups credential secret does not exist.',
    );
  }
  return readVerifiedStoredCredentialEvidence({
    listLiveKeyIds: () => listUserManagedKeys(contract),
    readCurrentCredential: () =>
      readSecretValue({
        profile: AWS_PROFILE,
        region: AWS_REGION,
        secretName: SECRET_NAME,
      }),
    readKeyCreatedAt: (privateKeyId) =>
      readUserManagedKeyCreatedAt(contract, privateKeyId),
    validateCredential: (credential, credentialCreatedAt) =>
      validateStoredCredential(
        credential,
        contract,
        approvedGroup,
        credentialCreatedAt,
      ),
  });
}

export async function redactedFetch(
  fetcher: Fetcher,
  input: string | URL,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  return guardedGoogleFetch(fetcher, input, init, operation);
}

async function main(fetcher: Fetcher = fetch): Promise<void> {
  if (process.argv.slice(2).length > 0) {
    throw new Error(
      'This helper accepts no arguments; use PSD_EOC_APPROVED_TEST_GROUP to keep the address out of the process list.',
    );
  }
  const approvedGroup = normalizeApprovedStaffGroup(
    process.env.PSD_EOC_APPROVED_TEST_GROUP,
  );
  assertActiveGcloudAccount(TERRAFORM_ADMIN);
  await assertApplicationDefaultIdentity(TERRAFORM_ADMIN);
  const contract = readGroupsReaderContract();
  await assertExactLiveGroupsReaderRole(contract, fetcher);
  assertRosterReaderCredentialBoundary(contract);
  const initialCredential = readVerifiedStoredCredential(
    contract,
    approvedGroup,
  );

  const assertion = serviceAccountAssertion(initialCredential.credential);
  const tokenResponse = await redactedFetch(
    fetcher,
    TOKEN_ENDPOINT,
    {
      body: new URLSearchParams({
        assertion,
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    },
    'Service-account token exchange',
  );
  const token = await boundedGoogleJsonObject(
    tokenResponse,
    'Service-account token exchange',
  );
  const accessToken = requiredString(token, 'access_token');
  if (
    token.token_type !== 'Bearer' ||
    typeof token.expires_in !== 'number' ||
    token.expires_in <= 0 ||
    token.expires_in > 3_600 ||
    (token.scope !== undefined && token.scope !== READONLY_GROUPS_SCOPE)
  ) {
    throw new Error('Google issued a token with an unexpected contract.');
  }

  const authorization = { Authorization: `Bearer ${accessToken}` };
  const lookupUrl = new URL(`${CLOUD_IDENTITY_ENDPOINT}/groups:lookup`);
  lookupUrl.searchParams.set('groupKey.id', approvedGroup);
  lookupUrl.searchParams.set('fields', 'name');
  const group = await boundedGoogleJsonObject(
    await redactedFetch(
      fetcher,
      lookupUrl,
      { headers: authorization, method: 'GET' },
      'Cloud Identity group lookup',
    ),
    'Cloud Identity group lookup',
  );
  const groupName = requiredString(group, 'name');
  if (!/^groups\/[A-Za-z0-9_-]+$/u.test(groupName)) {
    throw new Error('Cloud Identity returned an invalid group resource name.');
  }

  const membershipsUrl = new URL(
    `${CLOUD_IDENTITY_ENDPOINT}/${groupName}/memberships`,
  );
  membershipsUrl.searchParams.set('pageSize', '1');
  membershipsUrl.searchParams.set('view', 'BASIC');
  membershipsUrl.searchParams.set('fields', 'nextPageToken');
  const membershipsResponse = await redactedFetch(
    fetcher,
    membershipsUrl,
    { headers: authorization, method: 'GET' },
    'Cloud Identity membership read',
  );
  if (!membershipsResponse.ok) {
    try {
      await membershipsResponse.body?.cancel();
    } catch {
      // Preserve the original HTTP failure without exposing a response body.
    }
    throw new Error(
      `Cloud Identity membership read failed with HTTP ${membershipsResponse.status}.`,
    );
  }
  try {
    await membershipsResponse.body?.cancel();
  } catch {
    throw new Error(
      'Cloud Identity membership response could not be discarded safely.',
    );
  }

  assertRosterReaderCredentialBoundary(contract);
  await assertExactLiveGroupsReaderRole(contract, fetcher);
  const finalCredential = readVerifiedStoredCredential(contract, approvedGroup);
  assertVerifiedStoredCredentialUnchanged(initialCredential, finalCredential);

  console.log(
    'PASS: the live Workspace assignment is exactly direct Groups Reader with no indirect role, and the service account performed approved staff-group lookup and membership-list authorization with one read-only OAuth scope; Google returned no member identity fields and no value was printed.',
  );
}

if (import.meta.main) {
  await main();
}
