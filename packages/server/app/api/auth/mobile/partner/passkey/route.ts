import { randomUUID } from 'node:crypto';

import { MobilePartnerPasskeyRequestSchema } from '@psd-eoc/contracts';
import type { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';

import {
  partnerRelyingPartyIdForRequest,
  resolvePartnerPasskeyProvider,
} from '../../../../../../lib/auth/partner-passkey';
import { partnerFailure, partnerSignInAbsent } from '../_lib/http';
import {
  registerFinish,
  registerStart,
  signInFinish,
  signInStart,
} from './steps';

export const dynamic = 'force-dynamic';

/**
 * Native partner passkey sign-in and enrollment.
 *
 * A passkey is a faster way in, never a wider one. This endpoint is the app's
 * counterpart of the browser's `/auth/partner/passkey`: the pool proves a
 * first factor exactly as it does for an emailed code, and the admission then
 * decides access, so a partner who enrolls a passkey has gained a faster way
 * in and no additional access.
 *
 * It is one path with four steps rather than four paths, because the browser
 * endpoint is one path with four steps and the two must not drift apart. The
 * app presents a sealed token for whichever ceremony it is in the middle of;
 * nothing here reads a session, and nothing here accepts an address that did
 * not come out of a seal this deployment wrote.
 *
 * Every refusal is the same refusal, for the same reason the emailed-code
 * steps have only one: an address with no account, an address with no
 * passkey, a rejected assertion, an ended admission and a disabled account
 * must be indistinguishable, or this endpoint becomes a way to ask who has
 * partner access. The sign-in first step goes further and answers `code` for
 * all of them, so even a refusal is not an answer about enrollment.
 *
 * The emailed code remains the fallback, so a partner whose device has no
 * passkey, or who has not enrolled one, signs in exactly as before.
 *
 * Issue #647.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  let body;
  try {
    body = MobilePartnerPasskeyRequestSchema.parse(await request.json());
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return partnerFailure(
        'VALIDATION_ERROR',
        'This sign-in request could not be read. Start again.',
        requestId,
      );
    }
    throw error;
  }

  let provider;
  let relyingPartyId: string;
  try {
    provider = resolvePartnerPasskeyProvider();
    if (provider === null) {
      return partnerSignInAbsent(requestId);
    }
    relyingPartyId = partnerRelyingPartyIdForRequest(request.url);
  } catch {
    // A deployment with no partner pool, or one whose origin cannot be a
    // relying-party id. Either way there is no passkey path here, and the app
    // falls back to the emailed code.
    return partnerSignInAbsent(requestId);
  }

  const now = new Date();

  if (body.step === 'sign-in-start') {
    return signInStart(request, {
      provider,
      relyingPartyId,
      email: body.email,
      platform: body.platform,
      installationId: body.installationId,
      now,
    });
  }
  if (body.step === 'sign-in-finish') {
    return signInFinish(request, {
      provider,
      relyingPartyId,
      flowToken: body.flowToken,
      credential: body.credential,
      now,
    });
  }
  if (body.step === 'register-start') {
    return registerStart(request, {
      provider,
      relyingPartyId,
      enrollmentToken: body.enrollmentToken,
      now,
    });
  }
  return registerFinish(request, {
    provider,
    relyingPartyId,
    enrollmentToken: body.enrollmentToken,
    credential: body.credential,
    now,
  });
}
