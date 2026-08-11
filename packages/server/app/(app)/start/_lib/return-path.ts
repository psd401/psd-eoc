import {
  EventTypeVersionIdSchema,
  FacilityIdSchema,
  TemplateModeSchema,
} from '@psd-eoc/contracts';

declare const START_FLOW_RETURN_PATH: unique symbol;

/** A same-origin start-flow target produced only from validated domain IDs. */
export type StartFlowReturnPath = string & {
  readonly [START_FLOW_RETURN_PATH]: true;
};

function exactReturnPath(
  pathname: '/start' | '/start/confirm',
  entries: readonly (readonly [string, string])[],
): StartFlowReturnPath {
  const query = new URLSearchParams();
  for (const [name, value] of entries) {
    query.append(name, value);
  }
  return `${pathname}?${query.toString()}` as StartFlowReturnPath;
}

/** Canonical return target for the event-type selection page. */
export function startSelectionReturnPath(
  input: Readonly<{
    facilityId: unknown;
    mode: unknown;
  }>,
): StartFlowReturnPath {
  const facilityId = FacilityIdSchema.parse(input.facilityId);
  const mode = TemplateModeSchema.parse(input.mode);
  return exactReturnPath('/start', [
    ['facilityId', facilityId],
    ['mode', mode],
  ]);
}

/** Canonical return target for the exact activation confirmation page. */
export function startConfirmationReturnPath(
  input: Readonly<{
    eventTypeVersionId: unknown;
    facilityId: unknown;
    mode: unknown;
  }>,
): StartFlowReturnPath {
  const facilityId = FacilityIdSchema.parse(input.facilityId);
  const mode = TemplateModeSchema.parse(input.mode);
  const eventTypeVersionId = EventTypeVersionIdSchema.parse(
    input.eventTypeVersionId,
  );
  return exactReturnPath('/start/confirm', [
    ['facilityId', facilityId],
    ['mode', mode],
    ['eventTypeVersionId', eventTypeVersionId],
  ]);
}
