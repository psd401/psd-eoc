import { randomUUID } from 'node:crypto';

import {
  MobilePartnerPasskeyRegisterFinishResponseSchema,
  MobilePartnerPasskeyRegisterStartResponseSchema,
  MobilePartnerPasskeySignInStartResponseSchema,
  MobileSessionResponseSchema,
  type NativeDevicePlatform,
} from '@psd-eoc/contracts';
import { NextResponse } from 'next/server';

import { type DatabaseConnection } from '../../../../../../db/client';
import {
  PARTNER_FLOW_LIFETIME_SECONDS,
  openPartnerSignInFlow,
  sealPartnerSignInFlow,
} from '../../../../../../lib/auth/partner-flow-cookie';
import { PartnerOtpError } from '../../../../../../lib/auth/partner-otp';
import { getPartnerOtpLimiter } from '../../../../../../lib/auth/partner-otp-limit';
import { openPartnerPasskeyEnrollment } from '../../../../../../lib/auth/partner-passkey-enrollment';
import {
  beginPartnerPasskeyProbe,
  endPartnerPasskeyProbe,
  nativePasskeyCeremonyOrigins,
  poolMailsOnProbe,
  readPasskeyClientData,
  recordPoolMailedOnProbe,
  type PartnerPasskeyStart,
  type resolvePartnerPasskeyProvider,
} from '../../../../../../lib/auth/partner-passkey';
import {
  completeNativePartnerSignIn,
  PartnerSignInError,
} from '../../../../../../lib/auth/partner-sign-in';
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
} from '../_lib/http';

/**
 * The four steps of the native partner passkey endpoint.
 *
 * They mirror the browser's four exactly (`app/(auth)/auth/partner/passkey`),
 * including every budget, every probe bound, and the rule that the sign-in
 * first step answers `passkey` or `code` and nothing else. What differs is
 * only the transport: a browser carries each ceremony's state in a sealed
 * `__Host-` cookie, and the app is handed the same sealed value as an opaque
 * token and returns it untouched.
 *
 * Nothing here is a second way in. The pool proves a first factor and
 * `completeNativePartnerSignIn` then applies the same admission check, the
 * same one-day session ceiling and the same audit as the emailed code, so a
 * partner whose admission has ended or expired, or whose account is disabled,
 * is refused on the passkey path exactly as on the code path.
 *
 * They live beside `route.ts` rather than inside it because a Next route
 * module may export only its handlers, and each step is worth testing
 * directly: none resolves anything for itself, so giving it a provider is the
 * only way to exercise what it does with every answer a pool can give.
 *
 * Issue #647.
 */

type Provider = NonNullable<ReturnType<typeof resolvePartnerPasskeyProvider>>;

/** The one thing a refused passkey request ever says. */
function refused(requestId: string): NextResponse {
  return partnerFailure('UNAUTHENTICATED', PARTNER_REFUSAL_MESSAGE, requestId);
}

/** A failure that is the provider's, not the partner's. */
function unavailable(requestId: string): NextResponse {
  return partnerFailure(
    'INTERNAL_ERROR',
    'Partner sign-in is unavailable right now. Try again shortly.',
    requestId,
  );
}

function rateLimited(
  retryAfterSeconds: number,
  requestId: string,
): NextResponse {
  return partnerFailure(
    'RATE_LIMITED',
    'Too many sign-in attempts. Wait a few minutes and try again.',
    requestId,
    { 'Retry-After': String(retryAfterSeconds) },
  );
}

/** The answer that sends the app to the emailed code, and says nothing else. */
function useACode(): NextResponse {
  return NextResponse.json(
    MobilePartnerPasskeySignInStartResponseSchema.parse({ method: 'code' }),
    { headers: PARTNER_PRIVATE_HEADERS },
  );
}

/**
 * Asks whether this address signs in with a passkey on this device.
 *
 * The answer is `passkey` with the ceremony options, or `code` for every
 * other case: no account, no passkey, a pool that offered some other
 * challenge, and a provider that did not answer. `code` is also what the app
 * does when the device cannot run a ceremony at all, so the one answer the
 * app acts on reveals nothing about who holds partner access. The send budget
 * is charged here, so this cannot be used as an unmetered oracle against a
 * list of addresses.
 */
export async function signInStart(
  request: Request,
  input: Readonly<{
    provider: Provider;
    relyingPartyId: string;
    email: string;
    platform: NativeDevicePlatform;
    installationId: string;
    now: Date;
  }>,
): Promise<NextResponse> {
  const requestId = randomUUID();
  const client = forwardedClientAddress(request);
  const decision = getPartnerOtpLimiter().admit(
    { kind: 'passkey-start', email: input.email, client },
    input.now,
  );
  if (!decision.admitted) {
    return rateLimited(decision.retryAfterSeconds, requestId);
  }

  // A pool that has been seen mailing a code merely for being asked what a
  // partner could use will do it again. Once that is known, a probe is
  // treated as the send it turns out to be: if that address cannot afford
  // one, the pool is not asked, and the app is told to use a code — which is
  // where it was heading anyway. A pool that behaves as documented never
  // reaches this, so a passkey is never gated on the mail budget.
  if (
    poolMailsOnProbe() &&
    !getPartnerOtpLimiter().allows(
      { kind: 'send', email: input.email, client },
      input.now,
    )
  ) {
    return useACode();
  }

  // One question per address at a time, per instance. A burst would otherwise
  // all read the observation above before the first of them answered, so all
  // of them would reach a pool that mails and all of them would mail.
  if (!beginPartnerPasskeyProbe(input.email)) {
    return useACode();
  }
  let started: PartnerPasskeyStart;
  try {
    started = await input.provider.startSignIn(
      input.email,
      input.relyingPartyId,
    );
  } catch {
    // A provider that did not answer must not stop the code path: tell the
    // app to ask for a code, which is the same answer an unenrolled address
    // receives.
    started = { kind: 'code' };
  } finally {
    endPartnerPasskeyProbe(input.email);
  }
  if (started.kind !== 'passkey') {
    if (started.kind === 'code-sent') {
      // The pool put a code in that inbox, so the budget that bounds how much
      // mail an inbox can be made to receive carries it — even though the
      // attempt was admitted on the passkey budget. `charge` rather than
      // `admit`: the mail has gone, so it is recorded whether or not there
      // was room.
      getPartnerOtpLimiter().charge(
        { kind: 'send', email: input.email, client },
        input.now,
      );
      recordPoolMailedOnProbe();
    }
    return useACode();
  }
  const expiresAt = new Date(
    input.now.getTime() + PARTNER_FLOW_LIFETIME_SECONDS * 1_000,
  );
  return NextResponse.json(
    MobilePartnerPasskeySignInStartResponseSchema.parse({
      method: 'passkey',
      flowToken: sealPartnerSignInFlow(
        {
          email: input.email,
          flowSession: started.challenge.flowSession,
          installationId: input.installationId,
          platform: input.platform,
          factor: 'passkey',
          expiresAt: expiresAt.getTime(),
        },
        process.env,
        'native',
      ),
      options: started.challenge.options,
      expiresAt: expiresAt.toISOString(),
    }),
    { headers: PARTNER_PRIVATE_HEADERS },
  );
}

/** Answers the pool's challenge, and on success issues the session. */
export async function signInFinish(
  request: Request,
  input: Readonly<{
    provider: Provider;
    relyingPartyId: string;
    flowToken: string;
    credential: Parameters<Provider['verifySignIn']>[0]['credential'];
    now: Date;
  }>,
): Promise<NextResponse> {
  const requestId = randomUUID();
  const flow = openPartnerSignInFlow(
    input.flowToken,
    input.now,
    process.env,
    'native',
  );
  // A flow opened for an emailed code is not answered with an assertion. The
  // pool would refuse it anyway, since its continuation belongs to one
  // challenge; refusing here spends no verify budget and no provider call.
  if (flow === null || flow.platform === undefined) {
    return partnerFailure(
      'UNAUTHENTICATED',
      'This sign-in request expired. Start again.',
      requestId,
    );
  }
  if (flow.factor !== 'passkey') {
    return refused(requestId);
  }
  // The passkey budget, never the code's: anyone who knows an address can
  // spend a budget keyed to it, and a partner locked out of their passkey
  // must still be able to ask for an emailed code.
  const decision = getPartnerOtpLimiter().admit(
    {
      kind: 'passkey-verify',
      email: flow.email,
      client: forwardedClientAddress(request),
    },
    input.now,
  );
  if (!decision.admitted) {
    return rateLimited(decision.retryAfterSeconds, requestId);
  }
  // The one part of the authenticator's answer this deployment reads: the
  // ceremony it performed, and which of this app's own ceremony origins asked
  // for it. The platform comes from the seal, so an Android assertion cannot
  // be presented as an iOS one.
  if (
    readPasskeyClientData(input.credential.response.clientDataJSON, {
      type: 'webauthn.get',
      origins: nativePasskeyCeremonyOrigins(
        flow.platform,
        input.relyingPartyId,
      ),
    }) === null
  ) {
    return refused(requestId);
  }

  let connection: DatabaseConnection | undefined;
  try {
    const { claims } = await input.provider.verifySignIn({
      email: flow.email,
      flowSession: flow.flowSession,
      credential: input.credential,
    });
    connection = createPartnerConnection();
    const completed = await completeNativePartnerSignIn(connection.db, {
      claims,
      installationId: flow.installationId,
      platform: flow.platform,
      factor: 'passkey',
      requestId,
      now: input.now,
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
          occurredAt: input.now.toISOString(),
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
      return refused(requestId);
    }
    if (
      error instanceof PartnerOtpError &&
      error.code === 'PARTNER_SIGN_IN_REFUSED'
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, PARTNER_REJECTION_DELAY_MS),
      );
      return refused(requestId);
    }
    return unavailable(requestId);
  } finally {
    await connection?.close();
  }
}

/**
 * Hands the app the options to create a passkey with.
 *
 * Authorized by the enrollment hand-off alone: the sealed token the code
 * sign-in handed back a moment ago, which carries the pool's own access token
 * for the partner who just proved their address. Without it there is nothing
 * to enroll against, so a request with no hand-off is refused rather than
 * answered from the session — a session is this application's credential and
 * cannot authorize a change inside the pool.
 */
export async function registerStart(
  request: Request,
  input: Readonly<{
    provider: Provider;
    relyingPartyId: string;
    enrollmentToken: string;
    now: Date;
  }>,
): Promise<NextResponse> {
  const requestId = randomUUID();
  const enrollment = openPartnerPasskeyEnrollment(
    input.enrollmentToken,
    input.now,
    process.env,
    'native',
  );
  if (enrollment === null) {
    return refused(requestId);
  }
  const decision = getPartnerOtpLimiter().admit(
    {
      kind: 'passkey-register',
      email: enrollment.email,
      client: forwardedClientAddress(request),
    },
    input.now,
  );
  if (!decision.admitted) {
    return rateLimited(decision.retryAfterSeconds, requestId);
  }
  let options;
  try {
    options = await input.provider.startRegistration({
      email: enrollment.email,
      accessToken: enrollment.accessToken,
      relyingPartyId: input.relyingPartyId,
    });
  } catch (error) {
    return error instanceof PartnerOtpError &&
      error.code === 'PARTNER_SIGN_IN_REFUSED'
      ? refused(requestId)
      : unavailable(requestId);
  }
  return NextResponse.json(
    MobilePartnerPasskeyRegisterStartResponseSchema.parse({ options }),
    { headers: PARTNER_PRIVATE_HEADERS },
  );
}

/** Hands the pool the created passkey and ends the enrollment hand-off. */
export async function registerFinish(
  request: Request,
  input: Readonly<{
    provider: Provider;
    relyingPartyId: string;
    enrollmentToken: string;
    credential: Parameters<Provider['completeRegistration']>[0]['credential'];
    now: Date;
  }>,
): Promise<NextResponse> {
  const requestId = randomUUID();
  const enrollment = openPartnerPasskeyEnrollment(
    input.enrollmentToken,
    input.now,
    process.env,
    'native',
  );
  // The platform is read from the seal, never from the request, so a caller
  // cannot choose which ceremony origin its credential is checked against.
  if (enrollment === null || enrollment.platform === undefined) {
    return refused(requestId);
  }
  const decision = getPartnerOtpLimiter().admit(
    {
      kind: 'passkey-register',
      email: enrollment.email,
      client: forwardedClientAddress(request),
    },
    input.now,
  );
  if (!decision.admitted) {
    return rateLimited(decision.retryAfterSeconds, requestId);
  }
  if (
    readPasskeyClientData(input.credential.response.clientDataJSON, {
      type: 'webauthn.create',
      origins: nativePasskeyCeremonyOrigins(
        enrollment.platform,
        input.relyingPartyId,
      ),
    }) === null
  ) {
    return refused(requestId);
  }
  try {
    await input.provider.completeRegistration({
      email: enrollment.email,
      accessToken: enrollment.accessToken,
      credential: input.credential,
    });
  } catch (error) {
    return error instanceof PartnerOtpError &&
      error.code === 'PARTNER_SIGN_IN_REFUSED'
      ? refused(requestId)
      : unavailable(requestId);
  }
  // The app discards the hand-off here, as the browser clears its cookie.
  // Neither is a cryptographic spend — the token is stateless, so what bounds
  // it is its ten-minute life and the registration budget above, exactly as
  // on the web. A partner who wants a second passkey, on a second device,
  // signs in with a code there and is offered enrollment again.
  return NextResponse.json(
    MobilePartnerPasskeyRegisterFinishResponseSchema.parse({
      status: 'registered',
    }),
    { headers: PARTNER_PRIVATE_HEADERS },
  );
}
