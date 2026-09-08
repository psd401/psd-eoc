import { randomUUID } from 'node:crypto';

import {
  ReadMySmsConsentInputSchema,
  RecordSmsConsentInputSchema,
  WithdrawSmsConsentInputSchema,
} from '@psd-eoc/contracts';
import type { NextResponse } from 'next/server';

import { authenticateSessionRequest } from '../../../../lib/auth/middleware';
import { getDefaultSessionService } from '../../../../lib/auth/sessions';
import {
  resolveHumanCapabilityInvocation,
  type TrustedCapabilityInvocation,
} from '../../../../lib/capabilities/engine';
import {
  getDefaultSmsConsentCapabilityRuntime,
  type SmsConsentCapabilityId,
} from '../../../../lib/capabilities/sms-consent';
import {
  executeHumanRoute,
  readBoundedJson,
  type HumanRouteInvocationRequest,
  type HumanRouteRuntime,
  type HumanRouteSubject,
} from '../../../../lib/http/human-route';

/**
 * A consent body is a number, a date-shaped version, and a literal true. The
 * generous device limit would only widen what a caller can make the server
 * decode before it is rejected.
 */
const SUBJECT: HumanRouteSubject = Object.freeze({
  maxBodyBytes: 2 * 1_024,
  noun: 'SMS consent',
});

export type SmsConsentRouteRuntime = HumanRouteRuntime<SmsConsentCapabilityId>;

export function getDefaultSmsConsentRouteRuntime(): SmsConsentRouteRuntime {
  const sessions = getDefaultSessionService();
  const capabilities = getDefaultSmsConsentCapabilityRuntime();
  return Object.freeze({
    capabilities: {
      execute: (
        capabilityId: SmsConsentCapabilityId,
        input: unknown,
        invocation: TrustedCapabilityInvocation,
      ) => capabilities.execute(capabilityId, input, invocation),
    },
    createRequestId: randomUUID,
    now: () => new Date(),
    async resolveInvocation(
      request: Request,
      input: HumanRouteInvocationRequest,
    ) {
      const authenticated = await authenticateSessionRequest(
        request,
        sessions,
        { mutation: input.mutation !== null },
        input.serverTime,
      );
      return resolveHumanCapabilityInvocation(authenticated, {
        ...input,
        mutation:
          input.mutation === null
            ? null
            : {
                idempotencyKey: input.mutation.idempotencyKey,
                humanConfirmationId: null,
              },
      });
    },
  });
}

function assertNoQueryParameters(request: Request): void {
  if (new URL(request.url).searchParams.size > 0) {
    throw new SyntaxError('The SMS consent request takes no query parameters.');
  }
}

/** Reads the caller's own consent state; never another staff member's. */
export function handleReadMySmsConsent(
  request: Request,
  runtime: SmsConsentRouteRuntime = getDefaultSmsConsentRouteRuntime(),
): Promise<NextResponse> {
  return executeHumanRoute(
    request,
    runtime,
    'read-my-sms-consent',
    false,
    SUBJECT,
    () => {
      assertNoQueryParameters(request);
      return ReadMySmsConsentInputSchema.parse({});
    },
  );
}

/** Records an affirmative consent for the authenticated caller. */
export function handleRecordSmsConsent(
  request: Request,
  runtime: SmsConsentRouteRuntime = getDefaultSmsConsentRouteRuntime(),
): Promise<NextResponse> {
  return executeHumanRoute(
    request,
    runtime,
    'record-sms-consent',
    true,
    SUBJECT,
    async () =>
      RecordSmsConsentInputSchema.parse(
        await readBoundedJson(request, SUBJECT),
      ),
  );
}

/**
 * Withdraws the caller's live consent.
 *
 * The body is required and must be an empty object rather than absent, so a
 * withdrawal is always a deliberate JSON mutation carrying an idempotency key
 * and can never be triggered by a bare navigation.
 */
export function handleWithdrawSmsConsent(
  request: Request,
  runtime: SmsConsentRouteRuntime = getDefaultSmsConsentRouteRuntime(),
): Promise<NextResponse> {
  return executeHumanRoute(
    request,
    runtime,
    'withdraw-sms-consent',
    true,
    SUBJECT,
    async () =>
      WithdrawSmsConsentInputSchema.parse(
        await readBoundedJson(request, SUBJECT),
      ),
  );
}
