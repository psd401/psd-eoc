import { CapabilityEngineError } from '../../../lib/capabilities/engine';
import { redirect } from 'next/navigation';

import { AdminCapabilityError } from '../../../lib/capabilities/admin';

const STATUS_MESSAGES = Object.freeze({
  'audience-version-created': 'The facility audience version was saved.',
  'building-group-created': 'The immutable building source was added.',
  'building-group-replaced':
    'The building source was replaced with a new immutable source and roster configuration version.',
  'facility-created': 'The facility was added.',
  'facility-updated': 'The facility settings were updated.',
  'manual-members-saved':
    'The people notified by that manual source were saved. Rebuild the roster to put the change into effect.',
  'neighborhood-version-created': 'The neighborhood version was saved.',
  'others-group-created': 'The immutable others source was added.',
  'roster-snapshot-published':
    'A new roster snapshot was published. Activations now reach the saved people.',
  'others-group-replaced':
    'The others source was replaced with a new immutable source and roster configuration version.',
} as const);

export interface FacilitiesAdminCursorState {
  readonly buildingGroupCursor: string | null;
  readonly facilityCursor: string | null;
  readonly neighborhoodCursor: string | null;
  readonly othersGroupCursor: string | null;
}

export interface FacilitiesAdminSearchParameters {
  readonly buildingGroupCursor?: string | readonly string[];
  readonly facilityCursor?: string | readonly string[];
  readonly neighborhoodCursor?: string | readonly string[];
  readonly othersGroupCursor?: string | readonly string[];
  readonly status?: string | readonly string[];
}

function singleCursor(
  value: string | readonly string[] | undefined,
): string | null {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  throw new AdminCapabilityError(
    'VALIDATION_ERROR',
    'The facilities administration pagination query is invalid.',
    400,
  );
}

/** Normalizes exactly one cursor value for each independently paged catalog. */
export function normalizeFacilitiesAdminCursorState(
  parameters: FacilitiesAdminSearchParameters,
): FacilitiesAdminCursorState {
  return Object.freeze({
    buildingGroupCursor: singleCursor(parameters.buildingGroupCursor),
    facilityCursor: singleCursor(parameters.facilityCursor),
    neighborhoodCursor: singleCursor(parameters.neighborhoodCursor),
    othersGroupCursor: singleCursor(parameters.othersGroupCursor),
  });
}

/** Maps only own allowlisted status keys; repeated and prototype values are inert. */
export function facilitiesAdminStatusMessage(
  value: string | readonly string[] | undefined,
): string | null {
  return typeof value === 'string' && Object.hasOwn(STATUS_MESSAGES, value)
    ? STATUS_MESSAGES[value as keyof typeof STATUS_MESSAGES]
    : null;
}

/** Identifies a bounded query-input failure that should return to clean state. */
export function isInvalidFacilitiesAdminQueryError(
  error: unknown,
): error is CapabilityEngineError {
  return (
    error instanceof CapabilityEngineError &&
    error.code === 'VALIDATION_ERROR' &&
    error.status === 400
  );
}

/** Returns the bounded recovery location for a rejected query, if applicable. */
export function facilitiesAdminQueryRecoveryPath(
  error: unknown,
): '/facilities' | null {
  return isInvalidFacilitiesAdminQueryError(error) ? '/facilities' : null;
}

/** Performs the bounded server-page redirect for invalid pagination input. */
export function redirectInvalidFacilitiesAdminQuery(error: unknown): void {
  const recoveryPath = facilitiesAdminQueryRecoveryPath(error);
  if (recoveryPath !== null) {
    redirect(recoveryPath);
  }
}
