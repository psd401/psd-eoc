import {
  assertRosterReaderCredentialBoundary,
  GROUPS_READER_ROLE,
  listUserManagedKeys,
  PROJECT_ID,
  readGroupsReaderContract,
  type GroupsReaderContract,
} from './groups-contract';
import {
  assertActiveGcloudAccount,
  assertApplicationDefaultIdentity,
  requiredString,
  runCommand,
} from './runtime';

export const ROLE_MANAGEMENT_SCOPE =
  'https://www.googleapis.com/auth/admin.directory.rolemanagement';
const ADMIN_SDK_ROOT =
  'https://admin.googleapis.com/admin/directory/v1/customer/my_customer';
const CONFIRMATION = 'assign-groups-reader-to-roster-sync-reader';
const TERRAFORM_ADMIN = 'kjh_admin@psd401.net';

interface GroupsReaderRole {
  readonly roleId: string;
}

interface RoleAssignment {
  readonly assignedTo: string;
  readonly assigneeType?: 'USER';
  readonly roleAssignmentId: string;
  readonly roleId: string;
  readonly scopeType: string;
}

export type Fetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

async function responseJson(
  response: Response,
  operation: string,
): Promise<Readonly<Record<string, unknown>>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`${operation} returned an invalid response.`);
  }
  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${response.status}.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${operation} returned an invalid response.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

async function authorizedFetch(
  fetcher: Fetcher,
  accessToken: string,
  url: URL,
  operation: string,
  init: RequestInit = {},
): Promise<Readonly<Record<string, unknown>>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: {
        ...init.headers,
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-Goog-User-Project': PROJECT_ID,
      },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`${operation} could not reach Google.`);
  }
  return responseJson(response, operation);
}

function records(
  value: unknown,
  field: string,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Admin SDK ${field} response is invalid.`);
  }
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`Admin SDK ${field} response is invalid.`);
    }
    return item as Readonly<Record<string, unknown>>;
  });
}

async function listAll(
  fetcher: Fetcher,
  accessToken: string,
  collection: 'roles' | 'roleassignments',
  userKey?: string,
): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> {
  const items: Array<Readonly<Record<string, unknown>>> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(`${ADMIN_SDK_ROOT}/${collection}`);
    url.searchParams.set('maxResults', '200');
    if (collection === 'roleassignments') {
      if (userKey === undefined) {
        throw new Error(
          'Admin SDK role-assignment checks require one exact assignee.',
        );
      }
      url.searchParams.set('userKey', userKey);
      url.searchParams.set('includeIndirectRoleAssignments', 'true');
    }
    if (pageToken !== undefined) {
      url.searchParams.set('pageToken', pageToken);
    }
    const response = await authorizedFetch(
      fetcher,
      accessToken,
      url,
      `Admin SDK ${collection} list`,
    );
    items.push(...records(response.items, collection));
    const nextPageToken = response.nextPageToken;
    if (nextPageToken === undefined) {
      return items;
    }
    if (typeof nextPageToken !== 'string' || nextPageToken.length === 0) {
      throw new Error(`Admin SDK ${collection} pagination is invalid.`);
    }
    pageToken = nextPageToken;
  }
  throw new Error(`Admin SDK ${collection} pagination exceeded 100 pages.`);
}

export function selectGroupsReaderRole(
  roles: ReadonlyArray<Readonly<Record<string, unknown>>>,
): GroupsReaderRole {
  const matches = roles.filter((role) => role.roleName === GROUPS_READER_ROLE);
  const role = matches[0];
  if (matches.length !== 1 || role === undefined) {
    throw new Error('Workspace must expose exactly one Groups Reader role.');
  }
  if (role.isSystemRole !== true || role.isSuperAdminRole !== false) {
    throw new Error(
      'Workspace Groups Reader is not the expected non-super-admin system role.',
    );
  }
  return { roleId: requiredString(role, 'roleId') };
}

export function assertNoUserManagedKeysBeforeRoleAssignment(
  userManagedKeys: ReadonlySet<string>,
): void {
  if (userManagedKeys.size !== 0) {
    throw new Error(
      'Workspace Groups Reader cannot be assigned while the roster-reader service account has a user-managed key; revoke every key first.',
    );
  }
}

function parseRoleAssignment(
  value: Readonly<Record<string, unknown>>,
  requireAssigneeType = true,
): RoleAssignment {
  if (
    value.condition !== undefined &&
    value.condition !== null &&
    value.condition !== ''
  ) {
    throw new Error(
      'Workspace Groups Reader assignment must be unconditional.',
    );
  }
  const scopeType = requiredString(value, 'scopeType');
  const assigneeType = value.assigneeType;
  if (scopeType !== 'CUSTOMER') {
    throw new Error('Workspace role assignment has an unexpected scope.');
  }
  let validatedAssigneeType: 'USER' | undefined;
  if (assigneeType === 'USER') {
    validatedAssigneeType = assigneeType;
  } else if (requireAssigneeType || assigneeType !== undefined) {
    throw new Error(
      'The roster-reader service account has an indirect or group-mediated Workspace admin role.',
    );
  }
  return {
    assignedTo: requiredString(value, 'assignedTo'),
    ...(validatedAssigneeType === undefined
      ? {}
      : { assigneeType: validatedAssigneeType }),
    roleAssignmentId: requiredString(value, 'roleAssignmentId'),
    roleId: requiredString(value, 'roleId'),
    scopeType,
  };
}

export function findExactAssignment(
  assignments: ReadonlyArray<Readonly<Record<string, unknown>>>,
  assignedTo: string,
  roleId: string,
): RoleAssignment | undefined {
  const serviceAccountAssignments = assignments.map((assignment) =>
    parseRoleAssignment(assignment),
  );
  if (
    serviceAccountAssignments.some(
      (assignment) =>
        assignment.assignedTo !== assignedTo || assignment.roleId !== roleId,
    )
  ) {
    throw new Error(
      'The roster-reader service account has an unexpected Workspace admin role.',
    );
  }
  const matches = serviceAccountAssignments.filter(
    (assignment) => assignment.roleId === roleId,
  );
  if (matches.length > 1) {
    throw new Error('The Groups Reader role is assigned more than once.');
  }
  return matches[0];
}

export async function assertExactLiveGroupsReaderRole(
  contract: GroupsReaderContract,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const token = accessToken();
  const role = selectGroupsReaderRole(await listAll(fetcher, token, 'roles'));
  const assignment = findExactAssignment(
    await listAll(
      fetcher,
      token,
      'roleassignments',
      contract.serviceAccountUniqueId,
    ),
    contract.serviceAccountUniqueId,
    role.roleId,
  );
  if (assignment === undefined) {
    throw new Error(
      'The roster-reader service account does not have exactly the live Workspace Groups Reader role.',
    );
  }
}

function accessToken(): string {
  try {
    return runCommand(
      'gcloud',
      [
        'auth',
        'application-default',
        'print-access-token',
        `--scopes=${ROLE_MANAGEMENT_SCOPE}`,
      ],
      { redactFailureOutput: true },
    );
  } catch {
    throw new Error(
      'Google ADC is not authorized for the required Workspace role-management scope; follow the README authentication step.',
    );
  }
}

async function main(fetcher: Fetcher = fetch): Promise<void> {
  if (process.argv.slice(2).length > 0) {
    throw new Error('This helper accepts no command-line options.');
  }
  assertActiveGcloudAccount(TERRAFORM_ADMIN);
  await assertApplicationDefaultIdentity(TERRAFORM_ADMIN);
  const contract = readGroupsReaderContract();
  assertRosterReaderCredentialBoundary(contract);
  const token = accessToken();
  const role = selectGroupsReaderRole(await listAll(fetcher, token, 'roles'));
  const assignments = await listAll(
    fetcher,
    token,
    'roleassignments',
    contract.serviceAccountUniqueId,
  );
  const existing = findExactAssignment(
    assignments,
    contract.serviceAccountUniqueId,
    role.roleId,
  );
  if (existing !== undefined) {
    assertRosterReaderCredentialBoundary(contract);
    console.log(
      'PASS: the roster-reader service account already has only the direct Workspace Groups Reader role and no indirect role assignment.',
    );
    return;
  }

  console.log(
    'Workspace consequence preview: assign the built-in read-only Groups Reader role across the district Workspace to the roster-reader service account. The root gives the account no direct project IAM binding, runtime requests one read-only OAuth scope, and inherited/group-mediated GCP IAM plus the application staff-group allowlist remain separate required checks.',
  );
  if (process.env.PSD_EOC_CONFIRM_WORKSPACE_ROLE_ASSIGNMENT !== CONFIRMATION) {
    throw new Error(
      `Set PSD_EOC_CONFIRM_WORKSPACE_ROLE_ASSIGNMENT=${CONFIRMATION} only after reviewing the consequence preview.`,
    );
  }
  assertRosterReaderCredentialBoundary(contract);
  assertNoUserManagedKeysBeforeRoleAssignment(listUserManagedKeys(contract));

  const created = parseRoleAssignment(
    await authorizedFetch(
      fetcher,
      token,
      new URL(`${ADMIN_SDK_ROOT}/roleassignments`),
      'Admin SDK Groups Reader assignment',
      {
        body: JSON.stringify({
          assignedTo: contract.serviceAccountUniqueId,
          kind: 'admin#directory#roleAssignment',
          roleId: role.roleId,
          scopeType: 'CUSTOMER',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    ),
    false,
  );
  if (
    created.assignedTo !== contract.serviceAccountUniqueId ||
    created.roleId !== role.roleId ||
    created.scopeType !== 'CUSTOMER'
  ) {
    throw new Error('Admin SDK created an unexpected role assignment.');
  }

  const verified = findExactAssignment(
    await listAll(
      fetcher,
      token,
      'roleassignments',
      contract.serviceAccountUniqueId,
    ),
    contract.serviceAccountUniqueId,
    role.roleId,
  );
  if (verified?.roleAssignmentId !== created.roleAssignmentId) {
    throw new Error(
      'Admin SDK could not verify the new Groups Reader assignment.',
    );
  }
  assertRosterReaderCredentialBoundary(contract);
  console.log(
    'PASS: assigned and read back the Workspace Groups Reader role for the roster-reader service account.',
  );
}

if (import.meta.main) {
  await main();
}
