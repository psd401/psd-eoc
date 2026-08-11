import { AdminCapabilityError } from '../facilities/admin-core';

const STATUS_MESSAGES = Object.freeze({
  'access-group-created': 'The Google access group was added.',
  'access-group-updated': 'The Google access group was updated.',
  'roles-updated': 'The staff role assignment was updated.',
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
