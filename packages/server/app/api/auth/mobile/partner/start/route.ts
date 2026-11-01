import { randomUUID } from 'node:crypto';

import {
  MobilePartnerSignInStartRequestSchema,
  MobilePartnerSignInStartResponseSchema,
} from '@psd-eoc/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';

import {
  PARTNER_FLOW_LIFETIME_SECONDS,
  sealPartnerSignInFlow,
} from '../../../../../../lib/auth/partner-flow-cookie';
import {
  PartnerOtpError,
  resolvePartnerOtpProvider,
} from '../../../../../../lib/auth/partner-otp';
import { getPartnerOtpLimiter } from '../../../../../../lib/auth/partner-otp-limit';
import { forwardedClientAddress } from '../../../../../../lib/http/client-address';
import {
  PARTNER_PRIVATE_HEADERS,
  PARTNER_REFUSAL_MESSAGE,
  PARTNER_REJECTION_DELAY_MS,
  partnerFailure,
  partnerSignInAbsent,
} from '../_lib/http';

export const dynamic = 'force-dynamic';

/**
 * Native partner sign-in, first step: ask the partner pool to email a code.
 *
 * This step deliberately never consults the admission. Whether an address
 * holds partner access is decided only at the second step, after the pool
 * has proven the person holds the address, so this endpoint cannot be used
 * to ask who has access. It hands back only a sealed flow: the pool's
 * continuation, the address, and the device this sign-in would enroll, none
 * of which the caller can choose or read.
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
    body = MobilePartnerSignInStartRequestSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return partnerFailure(
        'VALIDATION_ERROR',
        'Enter the email address your agency was invited with.',
        requestId,
      );
    }
    throw error;
  }

  const now = new Date();
  const limiter = getPartnerOtpLimiter();
  const decision = limiter.admit(
    {
      kind: 'send',
      email: body.email,
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

  try {
    const challenge = await provider.start(body.email);
    const expiresAt = new Date(
      now.getTime() + PARTNER_FLOW_LIFETIME_SECONDS * 1_000,
    );
    return NextResponse.json(
      MobilePartnerSignInStartResponseSchema.parse({
        flowToken: sealPartnerSignInFlow(
          {
            email: body.email,
            flowSession: challenge.flowSession,
            installationId: body.installationId,
            platform: body.platform,
            expiresAt: expiresAt.getTime(),
          },
          process.env,
          'native',
        ),
        expiresAt: expiresAt.toISOString(),
      }),
      { headers: PARTNER_PRIVATE_HEADERS },
    );
  } catch (error) {
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
    return partnerFailure(
      'INTERNAL_ERROR',
      'Partner sign-in is unavailable right now. Try again shortly.',
      requestId,
    );
  }
}
