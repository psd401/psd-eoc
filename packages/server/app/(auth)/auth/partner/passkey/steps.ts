import { randomBytes, randomUUID } from 'node:crypto';

import {
  PartnerPasskeyRegisterStartResponseSchema,
  PartnerPasskeySignInStartResponseSchema,
} from '@psd-eoc/contracts';
import { NextResponse } from 'next/server';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseConnection,
} from '../../../../../db/client';
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
  beginPartnerPasskeyProbe,
  endPartnerPasskeyProbe,
  poolMailsOnProbe,
  readPasskeyClientData,
  recordPoolMailedOnProbe,
  type resolvePartnerPasskeyProvider,
  type PartnerPasskeyStart,
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

/**
 * The four steps of the partner passkey endpoint.
 *
 * They live beside `route.ts` rather than inside it because a Next route
 * module may export only its handlers, and these are worth testing directly:
 * each one resolves nothing for itself, so giving it a provider is the only
 * way to exercise what it does with every answer a pool can give.
 *
 * Issue #599.
 */

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]{1,63}(?:\.[^\s@.]{1,63}){1,8}$/u;

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

/** The one refusal, with the flow and any enrollment hand-off cleared. */
export function refused(status = 401): NextResponse {
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
export function unavailable(): NextResponse {
  const response = NextResponse.json(
    { status: 'unavailable' },
    { status: 503 },
  );
  response.headers.append('Set-Cookie', clearPartnerFlowCookieHeader());
  return noStore(response);
}

export function rateLimited(retryAfterSeconds: number): NextResponse {
  const response = NextResponse.json(
    { status: 'rate-limited' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
  response.headers.append('Set-Cookie', clearPartnerFlowCookieHeader());
  return noStore(response);
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
export async function signInStart(
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

  // A pool that has been seen mailing a code merely for being asked what a
  // partner could use will do it again. Once that is known, a probe is
  // treated as the send it turns out to be: if that address cannot afford
  // one, the pool is not asked at all, and the page is told to use a code —
  // which is where it was heading anyway. A pool that behaves as documented
  // never reaches this, so a passkey is never gated on the mail budget.
  if (
    poolMailsOnProbe() &&
    !getPartnerOtpLimiter().allows(
      {
        kind: 'send',
        email: input.email,
        client: forwardedClientAddress(request),
      },
      input.now,
    )
  ) {
    return noStore(
      NextResponse.json(
        PartnerPasskeySignInStartResponseSchema.parse({ method: 'code' }),
      ),
    );
  }

  // One question per address at a time, per instance. A burst would
  // otherwise all read the observation above before the first of them
  // answered, so all of them would reach a pool that mails and all of them
  // would mail. A partner who double-submits with a passkey enrolled is sent
  // a code they did not need; that is the cost, and it is the right way
  // round. Their passkey works on the next attempt.
  if (!beginPartnerPasskeyProbe(input.email)) {
    return noStore(
      NextResponse.json(
        PartnerPasskeySignInStartResponseSchema.parse({ method: 'code' }),
      ),
    );
  }
  let started: PartnerPasskeyStart;
  try {
    started = await input.provider.startSignIn(
      input.email,
      input.relyingPartyId,
    );
  } catch {
    // A provider that did not answer must not stop the code path: tell the
    // page to ask for a code, which is the same answer an unenrolled address
    // receives.
    started = { kind: 'code' };
  } finally {
    endPartnerPasskeyProbe(input.email);
  }
  if (started.kind !== 'passkey') {
    if (started.kind === 'code-sent') {
      // The pool put a code in that inbox, so the budget that bounds how
      // much mail an inbox can be made to receive carries it — even though
      // the attempt was admitted on the passkey budget, and even though the
      // answer to the page is unchanged. `charge` rather than `admit`: the
      // mail has gone, so it is recorded whether or not there was room,
      // because a budget that stopped counting once full would stop
      // describing what actually reached the inbox.
      getPartnerOtpLimiter().charge(
        {
          kind: 'send',
          email: input.email,
          client: forwardedClientAddress(request),
        },
        input.now,
      );
      // And this pool is now known to mail on a question, so the next probe
      // for an address with no send left does not ask it again.
      recordPoolMailedOnProbe();
    }
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
        options: started.challenge.options,
      }),
    ),
  );
  response.headers.append(
    'Set-Cookie',
    partnerFlowCookieHeader({
      email: input.email,
      flowSession: started.challenge.flowSession,
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
function createConnection(): DatabaseConnection {
  const config = readDatabaseConfig();
  if (config.driver !== 'postgres') {
    throw new Error('Partner sign-in requires native PostgreSQL.');
  }
  return createDatabaseClient(config);
}

export async function signInFinish(
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
export async function registerStart(
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
export async function registerFinish(
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
