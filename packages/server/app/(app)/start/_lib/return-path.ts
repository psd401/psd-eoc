import {
  EventTypeVersionIdSchema,
  FacilityIdSchema,
  OperatorDetailSchema,
  TemplateModeSchema,
  ThreatIdSchema,
} from '@psd-eoc/contracts';
import { z } from 'zod';

/**
 * A description the operator typed and the contract refused. It is carried
 * back to its own step so they can correct it, so it is bounded and stripped
 * of line breaks here and shown as plain text there; it is never rendered
 * into a notification, which only ever receives a value the contract accepts.
 */
const RejectedDetailDraftSchema = z
  .string()
  .max(400)
  .transform((draft) => draft.replaceAll(/[\r\n]/gu, ' '));

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

/** Canonical return target for the threat selection page (step two). */
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

/**
 * Canonical return target for the response selection page (step three). The
 * operator's threat description travels as a validated query value so a
 * refresh or a back step never loses what they typed.
 */
export function startResponseReturnPath(
  input: Readonly<{
    facilityId: unknown;
    mode: unknown;
    threatId: unknown;
    threatDetail: unknown;
    /**
     * Carries a rejected response description back to its own step so the
     * operator sees an inline error and their own words, exactly as the
     * threat step does. The draft is unvalidated by definition, so it is
     * length-bounded here and rendered as plain text.
     */
    rejectedResponse?: Readonly<{
      eventTypeVersionId: unknown;
      draft: unknown;
    }>;
  }>,
): StartFlowReturnPath {
  const facilityId = FacilityIdSchema.parse(input.facilityId);
  const mode = TemplateModeSchema.parse(input.mode);
  const threatId = ThreatIdSchema.parse(input.threatId);
  const threatDetail = OperatorDetailSchema.nullable().parse(
    input.threatDetail,
  );
  const rejected =
    input.rejectedResponse === undefined
      ? null
      : {
          eventTypeVersionId: EventTypeVersionIdSchema.parse(
            input.rejectedResponse.eventTypeVersionId,
          ),
          draft: RejectedDetailDraftSchema.parse(
            input.rejectedResponse.draft ?? '',
          ),
        };
  return exactReturnPath('/start', [
    ['facilityId', facilityId],
    ['mode', mode],
    ['threatId', threatId],
    ...(threatDetail === null
      ? []
      : ([['threatDetail', threatDetail]] as const)),
    ...(rejected === null
      ? []
      : ([
          ['eventTypeVersionId', rejected.eventTypeVersionId],
          ['responseDetail', rejected.draft],
        ] as const)),
  ]);
}

/** Canonical return target for the exact activation confirmation page. */
export function startConfirmationReturnPath(
  input: Readonly<{
    eventTypeVersionId: unknown;
    facilityId: unknown;
    mode: unknown;
    threatId: unknown;
    threatDetail: unknown;
    responseDetail: unknown;
  }>,
): StartFlowReturnPath {
  const facilityId = FacilityIdSchema.parse(input.facilityId);
  const mode = TemplateModeSchema.parse(input.mode);
  const threatId = ThreatIdSchema.parse(input.threatId);
  const threatDetail = OperatorDetailSchema.nullable().parse(
    input.threatDetail,
  );
  const eventTypeVersionId = EventTypeVersionIdSchema.parse(
    input.eventTypeVersionId,
  );
  const responseDetail = OperatorDetailSchema.nullable().parse(
    input.responseDetail,
  );
  return exactReturnPath('/start/confirm', [
    ['facilityId', facilityId],
    ['mode', mode],
    ['threatId', threatId],
    ...(threatDetail === null
      ? []
      : ([['threatDetail', threatDetail]] as const)),
    ['eventTypeVersionId', eventTypeVersionId],
    ...(responseDetail === null
      ? []
      : ([['responseDetail', responseDetail]] as const)),
  ]);
}
