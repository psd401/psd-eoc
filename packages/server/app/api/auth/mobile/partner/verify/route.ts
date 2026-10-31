import { randomUUID } from 'node:crypto';

import {
  MobilePartnerSignInVerifyRequestSchema,
  MobileSessionResponseSchema,
} from '@psd-eoc/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';

import {
  DatabaseConfigurationError,
  type DatabaseConnection,
} from '../../../../../../db/client';
import { openPartnerSignInFlow } from '../../../../../../lib/auth/partner-flow-cookie';
import {
  PartnerOtpError,
  resolvePartnerOtpProvider,
} from '../../../../../../lib/auth/partner-otp';
import { getPartnerOtpLimiter } from '../../../../../../lib/auth/partner-otp-limit';
import {
  completeNativePartnerSignIn,
  PartnerSignInError,
} from '../../../../../../lib/auth/partner-sign-in';
import { describeSessionPersistenceFailure } from '../../../../../../lib/auth/session-cookie';
import {
  createDrizzleAccessGateAuditSink,
  POST_GATE_SIGN_IN_FAILED_REASON,
} from '../../../../../../lib/auth/sign-in-audit';
import { forwardedClientAddress } from '../../../../../../lib/http/client-address';
import {
  PARTNER_PRIVATE_HEADERS,
  PARTNER_REFUSAL_MESSAGE,
  PARTNER_REJECTION_DELAY_MS,
  createPartnerConnection,
  partnerFailure,
  partnerSignInAbsent,
} from '../_lib/http';

export const dynamic = 'force-dynamic';

/**
 * Native partner sign-in, second step: answer with the emailed code.
 *
 * The address comes from the sealed flow, never from the request, so a code
 * cannot be answered on behalf of someone else. The pool proves the code and
 * signs an identity token; only then does the admission decide whether this
 * person may be let in, and a refusal there is the same message a wrong code
 * gets. The exact reason is recorded in the access-gate audit and never
 * shown.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  let provider;
  try {
    provider = resolvePartnerOtpProvider();
  } catch {
    return partnerSignInAbsent(requestId);
  }
  if (provider === null) {
    return partnerSignInAbsent(requestId);
  }

  let body;
  try {
    body = MobilePartnerSignInVerifyRequestSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return partnerFailure(
        'VALIDATION_ERROR',
        'Enter the code from your email exactly as it was sent.',
        requestId,
      );
    }
    throw error;
  }

  const now = new Date();
  const flow = openPartnerSignInFlow(
    body.flowToken,
    now,
    process.env,
    'native',
  );
  if (flow === null || flow.platform === undefined) {
    // Saying that the request itself expired reveals nothing about the
    // address, and without it the app could only tell the partner to retype
    // a code that can no longer work.
    return partnerFailure(
      'UNAUTHENTICATED',
      'This sign-in request expired. Request a new code.',
      requestId,
    );
  }

  const limiter = getPartnerOtpLimiter();
  const decision = limiter.admit(
    {
      kind: 'verify',
      email: flow.email,
      client: forwardedClientAddress(request),
    },
    now,
  );
  if (!decision.admitted) {
    return partnerFailure(
      'RATE_LIMITED',
      'Too many sign-in attempts. Wait a few minutes and try again.',
      requestId,
      { 'Retry-After': String(decision.retryAfterSeconds) },
    );
  }

  let connection: DatabaseConnection | undefined;
  try {
    const claims = await provider.verify({
      email: flow.email,
      flowSession: flow.flowSession,
      code: body.code,
    });
    connection = createPartnerConnection();
    const completed = await completeNativePartnerSignIn(connection.db, {
      claims,
      installationId: flow.installationId,
      platform: flow.platform,
      requestId,
      now,
    });
    return NextResponse.json(
      MobileSessionResponseSchema.parse({
        session: completed.session,
        tokenType: 'Bearer',
        refreshToken: completed.bearer,
      }),
      { headers: PARTNER_PRIVATE_HEADERS },
    );
  } catch (error) {
    if (error instanceof PartnerSignInError) {
      // The exact refusal is recorded, never shown. A failure to record it
      // must not turn into a session, so the refusal stands either way.
      try {
        connection ??= createPartnerConnection();
        await createDrizzleAccessGateAuditSink(connection.db).append({
          outcome: 'denied',
          requestId,
          occurredAt: now.toISOString(),
          subjectDigest: null,
          reasonCode: error.refusal ?? POST_GATE_SIGN_IN_FAILED_REASON,
          userId: null,
          source: 'mobile',
        });
      } catch {
        // Recording failed; the refusal below is still the outcome.
      }
      await new Promise((resolve) =>
        setTimeout(resolve, PARTNER_REJECTION_DELAY_MS),
      );
      return partnerFailure(
        'UNAUTHENTICATED',
        PARTNER_REFUSAL_MESSAGE,
        requestId,
      );
    }
    if (
      error instanceof PartnerOtpError &&
      error.code === 'PARTNER_SIGN_IN_REFUSED'
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, PARTNER_REJECTION_DELAY_MS),
      );
      return partnerFailure(
        'UNAUTHENTICATED',
        PARTNER_REFUSAL_MESSAGE,
        requestId,
      );
    }
    if (error instanceof DatabaseConfigurationError) {
      return partnerFailure(
        'INTERNAL_ERROR',
        'Partner sign-in is not configured.',
        requestId,
      );
    }
    // Credential-free by construction: the helper keeps only structural
    // fields and the message, never PostgreSQL's row-carrying detail.
    console.error(
      JSON.stringify({
        event: 'native-partner-sign-in-failed',
        requestId,
        failure: describeSessionPersistenceFailure(error),
      }),
    );
    return partnerFailure(
      'INTERNAL_ERROR',
      'Partner sign-in could not be completed.',
      requestId,
    );
  } finally {
    await connection?.close();
  }
}
