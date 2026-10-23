import { AdminCapabilityError } from '../../../lib/capabilities/admin';
import { CapabilityEngineError } from '../../../lib/capabilities/engine';

const STATUS_MESSAGES = Object.freeze({
  'access-group-created': 'The Google access group was added.',
  'access-group-updated': 'The Google access group was updated.',
  'roles-updated': 'The staff role assignment was updated.',
  'account-admitted':
    'The address was admitted. It may sign in as staff from now on.',
  'admission-revoked':
    'The admission was revoked. The next sign-in with that address is refused.',
  'user-scope-updated':
    "The person's facility scope was updated. It applies to their next request.",
  'partner-invited':
    'The partner was invited. Their sign-in account is ready and the invitation email was sent.',
  'partner-invite-pending':
    'The partner was admitted, but their sign-in account or invitation email is not confirmed yet. Retry the pending change from the partner list.',
  'partner-disabled':
    'The partner was disabled. Their sessions were signed out, their alerts stopped, and their sign-in account was disabled.',
  'partner-disable-pending':
    'The partner was disabled and can no longer use PSD EOC, but disabling their sign-in account is not confirmed yet. Retry the pending change from the partner list.',
  'partner-reconciled': 'The pending partner change was completed.',
  'partner-invitation-sent': 'The invitation email was sent again.',
} as const);

export interface AccessAdminCursorState {
  readonly accessGroupCursor: string | null;
  readonly userCursor: string | null;
}

export interface AccessAdminSearchParameters {
  readonly accessGroupCursor?: string | readonly string[];
  readonly userCursor?: string | readonly string[];
  readonly status?: string | readonly string[];
}

function singleCursor(
  value: string | readonly string[] | undefined,
): string | null {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  throw new AdminCapabilityError(
    'VALIDATION_ERROR',
    'The access administration pagination query is invalid.',
    400,
  );
}

/** Normalizes exactly one value for each independent paginated collection. */
export function normalizeAccessAdminCursorState(
  parameters: AccessAdminSearchParameters,
): AccessAdminCursorState {
  return Object.freeze({
    accessGroupCursor: singleCursor(parameters.accessGroupCursor),
    userCursor: singleCursor(parameters.userCursor),
  });
}

/** Maps only own, allowlisted status keys; prototype names and repeats are inert. */
export function accessAdminStatusMessage(
  value: string | readonly string[] | undefined,
): string | null {
  return typeof value === 'string' && Object.hasOwn(STATUS_MESSAGES, value)
    ? STATUS_MESSAGES[value as keyof typeof STATUS_MESSAGES]
    : null;
}

/** Identifies a bounded query-input failure that should return to clean state. */
export function isInvalidAccessAdminQueryError(
  error: unknown,
): error is CapabilityEngineError {
  return (
    error instanceof CapabilityEngineError &&
    error.code === 'VALIDATION_ERROR' &&
    error.status === 400
  );
}
