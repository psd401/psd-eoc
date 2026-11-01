import { randomBytes, randomUUID } from 'node:crypto';

import {
  PartnerPasskeyRegisterStartResponseSchema,
  PartnerPasskeyRequestSchema,
  PartnerPasskeySignInStartResponseSchema,
} from '@psd-eoc/contracts';
import { NextResponse } from 'next/server';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseConnection,
} from '../../../../../db/client';
import { applicationOriginForRequest } from '../../../../../lib/auth/application-origin';
import {
  createCsrfToken,
  writeBrowserCsrfCookie,
} from '../../../../../lib/auth/middleware';
import {
  clearPartnerFlowCookieHeader,
  openPartnerSignInFlow,
  partnerFlowCookieHeader,
  readPartnerFlowCookie,
} from '../../../../../lib/auth/partner-flow-cookie';
import { PartnerOtpError } from '../../../../../lib/auth/partner-otp';
import { getPartnerOtpLimiter } from '../../../../../lib/auth/partner-otp-limit';
import {
  clearPartnerPasskeyCookieHeader,
  openPartnerPasskeyEnrollment,
  readPartnerPasskeyCookie,
} from '../../../../../lib/auth/partner-passkey-enrollment';
import {
  partnerRelyingPartyIdForRequest,
  readPasskeyClientData,
  resolvePartnerPasskeyProvider,
} from '../../../../../lib/auth/partner-passkey';
import {
  completePartnerSignIn,
  PartnerSignInError,
} from '../../../../../lib/auth/partner-sign-in';
import {
  createDrizzleAccessGateAuditSink,
  POST_GATE_SIGN_IN_FAILED_REASON,
} from '../../../../../lib/auth/sign-in-audit';
import { forwardedClientAddress } from '../../../../../lib/http/client-address';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 24 * 1_024;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]{1,63}(?:\.[^\s@.]{1,63}){1,8}$/u;

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

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

/** The one refusal, with the flow and any enrollment hand-off cleared. */
function refused(status = 401): NextResponse {
  const response = NextResponse.json({ status: 'refused' }, { status });
  response.headers.append('Set-Cookie', clearPartnerFlowCookieHeader());
  response.headers.append('Set-Cookie', clearPartnerPasskeyCookieHeader());
  return noStore(response);
}

/**
 * A failure that is the provider's, not the partner's.
 *
 * Unlike a refusal this leaves the enrollment hand-off in place: the pool
 * being briefly unreachable is not a reason to make the partner sign in again
 * before they can try enrolling, and the hand-off expires on its own.
 */
function unavailable(): NextResponse {
  const response = NextResponse.json(
    { status: 'unavailable' },
    { status: 503 },
  );
  response.headers.append('Set-Cookie', clearPartnerFlowCookieHeader());
  return noStore(response);
}

function rateLimited(retryAfterSeconds: number): NextResponse {
  const response = NextResponse.json(
    { status: 'rate-limited' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
  response.headers.append('Set-Cookie', clearPartnerFlowCookieHeader());
  return noStore(response);
}

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
  if (body.length === 0 || body.length > MAX_BODY_BYTES) {
    return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function createConnection(): DatabaseConnection {
  const config = readDatabaseConfig();
  if (config.driver !== 'postgres') {
    throw new Error('Partner sign-in requires native PostgreSQL.');
  }
  return createDatabaseClient(config);
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

type Provider = NonNullable<ReturnType<typeof resolvePartnerPasskeyProvider>>;

/**
 * Asks whether this address signs in with a passkey.
 *
 * The answer is `passkey` with the ceremony options, or `code` for every
 * other case: no account, no passkey, a pool that offered something else, and
 * a provider that did not answer. `code` is also what the page does when it
 * cannot run a ceremony at all, so the one answer the page acts on reveals
 * nothing. The send budget is charged here, so this cannot be used as an
 * unmetered oracle against a list of addresses.
 */
async function signInStart(
  request: Request,
  input: Readonly<{
    provider: Provider;
    relyingPartyId: string;
    email: string;
    now: Date;
  }>,
): Promise<NextResponse> {
  if (
    input.email.length === 0 ||
    input.email.length > 320 ||
    !EMAIL_PATTERN.test(input.email)
  ) {
    return refused(400);
  }
  const decision = getPartnerOtpLimiter().admit(
    {
      kind: 'passkey-start',
      email: input.email,
      client: forwardedClientAddress(request),
    },
    input.now,
  );
  if (!decision.admitted) {
    return rateLimited(decision.retryAfterSeconds);
  }

  let challenge;
  try {
    challenge = await input.provider.startSignIn(
      input.email,
      input.relyingPartyId,
    );
  } catch {
    // A provider that did not answer must not stop the code path: tell the
    // page to ask for a code, which is the same answer an unenrolled address
    // receives.
    challenge = null;
  }
  if (challenge === null) {
    return noStore(
      NextResponse.json(
        PartnerPasskeySignInStartResponseSchema.parse({ method: 'code' }),
      ),
    );
  }
  const response = noStore(
    NextResponse.json(
      PartnerPasskeySignInStartResponseSchema.parse({
        method: 'passkey',
        options: challenge.options,
      }),
    ),
  );
  response.headers.append(
    'Set-Cookie',
    partnerFlowCookieHeader({
      email: input.email,
      flowSession: challenge.flowSession,
      // One browser, one enrollment per sign-in, exactly as the code path
      // mints one for each completed sign-in.
      installationId: `web.${randomBytes(32).toString('base64url')}`,
      factor: 'passkey',
      expiresAt: input.now.getTime() + 5 * 60 * 1_000,
    }),
  );
  return response;
}

/** Answers the pool's challenge, and on success issues the session. */
async function signInFinish(
  request: Request,
  input: Readonly<{
    provider: Provider;
    credential: Parameters<Provider['verifySignIn']>[0]['credential'];
    origin: string;
    now: Date;
  }>,
): Promise<NextResponse> {
  const flow = openPartnerSignInFlow(
    readPartnerFlowCookie(request.headers.get('cookie')),
    input.now,
  );
  // A flow opened for an emailed code is not answered with an assertion. The
  // pool would refuse it anyway, since its continuation belongs to one
  // challenge; refusing here spends no verify budget and no provider call.
  if (flow === null || flow.factor !== 'passkey') {
    return refused();
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
    return rateLimited(decision.retryAfterSeconds);
  }
  // The one part of the authenticator's answer this deployment reads: the
  // ceremony it performed, and the origin that asked for it.
  if (
    readPasskeyClientData(input.credential.response.clientDataJSON, {
      type: 'webauthn.get',
      origin: input.origin,
    }) === null
  ) {
    return refused();
  }

  let connection: DatabaseConnection | undefined;
  const requestId = randomUUID();
  try {
    const { claims } = await input.provider.verifySignIn({
      email: flow.email,
      flowSession: flow.flowSession,
      credential: input.credential,
    });
    connection = createConnection();
    const completed = await completePartnerSignIn(connection.db, {
      claims,
      installationId: flow.installationId,
      factor: 'passkey',
      requestId,
      now: input.now,
    });
    const response = NextResponse.json({ status: 'signed-in', location: '/' });
    response.cookies.set(completed.cookie);
    writeBrowserCsrfCookie(
      response.cookies,
      createCsrfToken(),
      completed.cookie.maxAge,
    );
    // NextResponse.cookies rewrites Set-Cookie, so the clearing headers are
    // appended only after every cookie-writer call has completed.
    response.headers.append('Set-Cookie', clearPartnerFlowCookieHeader());
    return noStore(response);
  } catch (error) {
    if (error instanceof PartnerSignInError) {
      // The exact refusal is recorded, never shown. A failure to record it
      // must not turn into a session, so the refusal stands either way.
      try {
        connection ??= createConnection();
        await createDrizzleAccessGateAuditSink(connection.db).append({
          outcome: 'denied',
          requestId,
          occurredAt: input.now.toISOString(),
          subjectDigest: null,
          reasonCode: error.refusal ?? POST_GATE_SIGN_IN_FAILED_REASON,
          userId: null,
          source: 'web',
        });
      } catch {
        // Recording failed; the refusal below is still the outcome.
      }
      return refused();
    }
    if (
      error instanceof PartnerOtpError &&
      error.code === 'PARTNER_SIGN_IN_REFUSED'
    ) {
      return refused();
    }
    return unavailable();
  } finally {
    await connection?.close();
  }
}

/**
 * Hands the page the options to create a passkey with.
 *
 * Authorized by the enrollment hand-off alone: the sealed cookie the code
 * sign-in set a moment ago, which carries the pool's own access token for the
 * partner who just proved their address. Without it there is nothing to
 * enroll against, so a request with no hand-off is refused rather than
 * answered from the session — a session is this application's credential and
 * cannot authorize a change inside the pool.
 */
async function registerStart(
  request: Request,
  input: Readonly<{
    provider: Provider;
    relyingPartyId: string;
    now: Date;
  }>,
): Promise<NextResponse> {
  const enrollment = openPartnerPasskeyEnrollment(
    readPartnerPasskeyCookie(request.headers.get('cookie')),
    input.now,
  );
  if (enrollment === null) {
    return refused();
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
    return rateLimited(decision.retryAfterSeconds);
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
      ? refused()
      : unavailable();
  }
  return noStore(
    NextResponse.json(
      PartnerPasskeyRegisterStartResponseSchema.parse({ options }),
    ),
  );
}

/** Hands the pool the created passkey and ends the enrollment hand-off. */
async function registerFinish(
  request: Request,
  input: Readonly<{
    provider: Provider;
    credential: Parameters<Provider['completeRegistration']>[0]['credential'];
    origin: string;
    now: Date;
  }>,
): Promise<NextResponse> {
  const enrollment = openPartnerPasskeyEnrollment(
    readPartnerPasskeyCookie(request.headers.get('cookie')),
    input.now,
  );
  if (enrollment === null) {
    return refused();
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
    return rateLimited(decision.retryAfterSeconds);
  }
  if (
    readPasskeyClientData(input.credential.response.clientDataJSON, {
      type: 'webauthn.create',
      origin: input.origin,
    }) === null
  ) {
    return refused();
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
      ? refused()
      : unavailable();
  }
  // The hand-off is spent: one enrollment per code sign-in. A partner who
  // wants a second passkey, on a second device, signs in with a code there
  // and is offered enrollment again.
  const response = NextResponse.json({ status: 'registered' });
  response.headers.append('Set-Cookie', clearPartnerPasskeyCookieHeader());
  return noStore(response);
}
