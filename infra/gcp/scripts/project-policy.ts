export const TERRAFORM_ADMIN = 'kjh_admin@psd401.net';

export const TERRAFORM_ADMIN_ROLES = [
  'roles/billing.projectManager',
  'roles/iam.serviceAccountAdmin',
  'roles/iam.serviceAccountKeyAdmin',
  'roles/oauthconfig.editor',
  'roles/resourcemanager.projectIamAdmin',
  'roles/resourcemanager.projectMover',
  'roles/serviceusage.serviceUsageAdmin',
  'roles/storage.admin',
  'roles/viewer',
] as const;

export type ProjectIamPhase = 'recovery' | 'steady-state';

function exactSingleMember(
  members: readonly string[],
  expected: string,
): boolean {
  return members.length === 1 && members[0] === expected;
}

export function validateProjectIamPolicy(
  value: unknown,
  projectNumber: string,
  phase: ProjectIamPhase,
): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !/^\d+$/u.test(projectNumber)
  ) {
    throw new Error('Google Cloud project IAM policy is invalid.');
  }
  const rawBindings = (value as Readonly<Record<string, unknown>>).bindings;
  const bindings = rawBindings === undefined ? [] : rawBindings;
  if (!Array.isArray(bindings)) {
    throw new Error('Google Cloud project IAM policy bindings are invalid.');
  }

  const adminMember = `user:${TERRAFORM_ADMIN}`;
  const googleApisServiceAgent = `serviceAccount:${projectNumber}@cloudservices.gserviceaccount.com`;
  const requiredAdminRoles = new Set<string>(TERRAFORM_ADMIN_ROLES);
  const seenRoles = new Set<string>();

  for (const binding of bindings) {
    if (
      typeof binding !== 'object' ||
      binding === null ||
      Array.isArray(binding)
    ) {
      throw new Error('Google Cloud project IAM binding is invalid.');
    }
    const record = binding as Readonly<Record<string, unknown>>;
    if (
      typeof record.role !== 'string' ||
      record.role.length === 0 ||
      !Array.isArray(record.members) ||
      record.members.length === 0 ||
      record.members.some((member) => typeof member !== 'string') ||
      record.condition !== undefined ||
      seenRoles.has(record.role)
    ) {
      throw new Error(
        'Google Cloud project IAM policy contains a conditional, duplicate, or malformed binding.',
      );
    }
    const members = record.members as string[];
    if (new Set(members).size !== members.length) {
      throw new Error(
        'Google Cloud project IAM policy contains a duplicate member.',
      );
    }
    seenRoles.add(record.role);

    if (requiredAdminRoles.has(record.role)) {
      if (!exactSingleMember(members, adminMember)) {
        throw new Error(
          'A Terraform administrator role is granted to an unexpected project principal.',
        );
      }
      requiredAdminRoles.delete(record.role);
      continue;
    }

    if (
      phase === 'recovery' &&
      record.role === 'roles/owner' &&
      exactSingleMember(members, adminMember)
    ) {
      continue;
    }
    if (
      phase === 'recovery' &&
      record.role === 'roles/editor' &&
      exactSingleMember(members, googleApisServiceAgent)
    ) {
      continue;
    }

    throw new Error(
      'Google Cloud project IAM contains an unexpected role or principal that could bypass the reviewed project and state-bucket boundary.',
    );
  }

  if (phase === 'steady-state' && requiredAdminRoles.size > 0) {
    throw new Error(
      'Google Cloud project IAM is missing one or more required Terraform administrator roles.',
    );
  }
}

export function validateRosterReaderResourcePolicy(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Roster-reader service-account IAM policy is invalid.');
  }
  const rawBindings = (value as Readonly<Record<string, unknown>>).bindings;
  if (rawBindings === undefined) {
    return;
  }
  if (!Array.isArray(rawBindings)) {
    throw new Error(
      'Roster-reader service-account IAM policy bindings are invalid.',
    );
  }
  if (rawBindings.length > 0) {
    throw new Error(
      'Roster-reader service account has a direct resource IAM binding that could permit impersonation.',
    );
  }
}
