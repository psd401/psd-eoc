import { PartnerPasskeyRequestSchema } from '@psd-eoc/contracts';
import type { NextResponse } from 'next/server';

import { applicationOriginForRequest } from '../../../../../lib/auth/application-origin';
import {
  partnerRelyingPartyIdForRequest,
  resolvePartnerPasskeyProvider,
} from '../../../../../lib/auth/partner-passkey';
import {
  refused,
  registerFinish,
  registerStart,
  signInFinish,
  signInStart,
  unavailable,
} from './steps';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 24 * 1_024;

/**
 * Partner passkey sign-in and enrollment, over JSON.
 *
 * This is the one partner endpoint a browser script calls, because the
 * WebAuthn ceremony can only run in the page. It is not a second sign-in
 * path: the pool proves a first factor exactly as it does for an emailed
 * code, and `completePartnerSignIn` then applies the same admission check,
 * the same one-day ceiling, and the same audit. A partner who enrolls a
 * passkey has gained a faster way in and no additional access.
 *
 * Every refusal is the same refusal, for the same reason the form has only
 * one: an address with no account, an address with no passkey, a rejected
 * assertion, an ended admission, and a disabled account must be
 * indistinguishable, or this endpoint becomes a way to ask who has access.
 * The sign-in first step goes further and answers `code` for all of them, so
 * even "refused" is not an answer about enrollment.
 *
 * The emailed code remains the fallback and the only path that needs no
 * script, so a partner whose device has no passkey, or whose browser blocks
 * the ceremony, signs in exactly as before.
 *
 * Issue #599.
 */

/** Refuses a submission that did not come from this application's own page. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) {
    return false;
  }
  try {
    return new URL(origin).origin === applicationOriginForRequest(request.url);
  } catch {
    return false;
  }
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (
    contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    return null;
  }
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_BODY_BYTES
    ) {
      return null;
    }
  }
  const body = await request.text();
  // Bytes, because the cap is in bytes: a body of multi-byte characters is
  // longer than its length in UTF-16 code units suggests.
  const size = Buffer.byteLength(body, 'utf8');
  if (size === 0 || size > MAX_BODY_BYTES) {
    return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!sameOrigin(request)) {
    return refused();
  }
  const parsed = PartnerPasskeyRequestSchema.safeParse(
    await readJsonBody(request),
  );
  if (!parsed.success) {
    return refused(400);
  }
  const body = parsed.data;

  let provider;
  let relyingPartyId: string;
  try {
    provider = resolvePartnerPasskeyProvider();
    if (provider === null) {
      return unavailable();
    }
    relyingPartyId = partnerRelyingPartyIdForRequest(request.url);
  } catch {
    // A deployment with no partner pool, or one whose origin cannot be a
    // relying-party id. Either way there is no passkey path here, and the
    // page falls back to the emailed code.
    return unavailable();
  }

  const now = new Date();
  const origin = applicationOriginForRequest(request.url);

  if (body.step === 'sign-in-start') {
    return signInStart(request, {
      provider,
      relyingPartyId,
      email: body.email.trim().toLowerCase(),
      now,
    });
  }
  if (body.step === 'sign-in-finish') {
    return signInFinish(request, {
      provider,
      credential: body.credential,
      origin,
      now,
    });
  }
  if (body.step === 'register-start') {
    return registerStart(request, { provider, relyingPartyId, now });
  }
  return registerFinish(request, {
    provider,
    credential: body.credential,
    origin,
    now,
  });
}
