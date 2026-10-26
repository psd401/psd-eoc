import { randomBytes, randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseConnection,
} from '../../../../db/client';
import { applicationOriginForRequest } from '../../../../lib/auth/application-origin';
import {
  createCsrfToken,
  writeBrowserCsrfCookie,
} from '../../../../lib/auth/middleware';
import {
  clearPartnerFlowCookieHeader,
  openPartnerSignInFlow,
  partnerFlowCookieHeader,
  readPartnerFlowCookie,
} from '../../../../lib/auth/partner-flow-cookie';
import {
  OTP_CODE_PATTERN,
  PartnerOtpError,
  resolvePartnerOtpProvider,
} from '../../../../lib/auth/partner-otp';
import { getPartnerOtpLimiter } from '../../../../lib/auth/partner-otp-limit';
import {
  completePartnerSignIn,
  PartnerSignInError,
} from '../../../../lib/auth/partner-sign-in';
import {
  createDrizzleAccessGateAuditSink,
  POST_GATE_SIGN_IN_FAILED_REASON,
} from '../../../../lib/auth/sign-in-audit';
import { forwardedClientAddress } from '../../../../lib/http/client-address';
import {
  PARTNER_SIGN_IN_PATH,
  type PartnerSignInStatus,
} from '../../partner-sign-in/status';

export const dynamic = 'force-dynamic';

const MAX_FORM_BYTES = 4 * 1_024;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]{1,63}(?:\.[^\s@.]{1,63}){1,8}$/u;

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

/**
 * Sends the browser back to the partner sign-in page with one status. Every
 * refusal uses `refused`, so the page cannot be read as an answer about
 * whether an address has partner access.
 */
function back(
  request: Request,
  status: PartnerSignInStatus,
  options: Readonly<{ step?: 'code'; clearFlow?: boolean }> = {},
): NextResponse {
  const url = new URL(
    PARTNER_SIGN_IN_PATH,
    `${applicationOriginForRequest(request.url)}/`,
  );
  url.searchParams.set('status', status);
  if (options.step !== undefined) {
    url.searchParams.set('step', options.step);
  }
  const response = NextResponse.redirect(url, 303);
  if (options.clearFlow === true) {
    response.headers.append('Set-Cookie', clearPartnerFlowCookieHeader());
  }
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

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const contentType = request.headers.get('content-type') ?? '';
  if (
    contentType.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/x-www-form-urlencoded'
  ) {
    return null;
  }
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_FORM_BYTES
    ) {
      return null;
    }
  }
  const body = await request.text();
  return body.length > MAX_FORM_BYTES ? null : new URLSearchParams(body);
}

function singleValue(form: URLSearchParams, name: string): string | null {
  const values = form.getAll(name);
  return values.length === 1 ? (values[0]?.trim() ?? null) : null;
}

function createConnection(): DatabaseConnection {
  const config = readDatabaseConfig();
  if (config.driver !== 'postgres') {
    throw new Error('Partner sign-in requires native PostgreSQL.');
  }
  return createDatabaseClient(config);
}

/**
 * Partner sign-in: ask for a code, then answer with it.
 *
 * Both steps are POSTs from this deployment's own page, checked by Origin.
 * The first step never consults the admission: whether an address has partner
 * access is decided at the second step, after the pool has proven the person
 * holds the address, so the form cannot be used to ask who has access. The
 * pool holds only invited accounts, so an address with no account is emailed
 * nothing either way.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!sameOrigin(request)) {
    return back(request, 'refused', { clearFlow: true });
  }
  const form = await readForm(request);
  const step = form === null ? null : singleValue(form, 'step');
  if (form === null || (step !== 'send-code' && step !== 'verify-code')) {
    return back(request, 'refused', { clearFlow: true });
  }

  let provider;
  try {
    provider = resolvePartnerOtpProvider();
  } catch {
    return back(request, 'unavailable', { clearFlow: true });
  }
  if (provider === null) {
    // This deployment has no partner sign-in path at all.
    return back(request, 'unavailable', { clearFlow: true });
  }

  const now = new Date();
  const limiter = getPartnerOtpLimiter();
  const client = forwardedClientAddress(request);

  if (step === 'send-code') {
    const email = singleValue(form, 'email')?.toLowerCase() ?? '';
    if (
      email.length === 0 ||
      email.length > 320 ||
      !EMAIL_PATTERN.test(email)
    ) {
      return back(request, 'refused', { clearFlow: true });
    }
    if (!limiter.admit({ kind: 'send', email, client }, now).admitted) {
      return back(request, 'rate-limited', { clearFlow: true });
    }
    try {
      const challenge = await provider.start(email);
      const response = back(request, 'code-sent', { step: 'code' });
      response.headers.append(
        'Set-Cookie',
        partnerFlowCookieHeader({
          email,
          flowSession: challenge.flowSession,
          // One browser, one enrollment per sign-in, exactly as the staff
          // callback mints one for each completed Google sign-in.
          installationId: `web.${randomBytes(32).toString('base64url')}`,
          expiresAt: now.getTime() + 5 * 60 * 1_000,
        }),
      );
      return response;
    } catch (error) {
      return back(
        request,
        error instanceof PartnerOtpError &&
          error.code === 'PARTNER_SIGN_IN_REFUSED'
          ? 'refused'
          : 'unavailable',
        { clearFlow: true },
      );
    }
  }

  const flow = openPartnerSignInFlow(
    readPartnerFlowCookie(request.headers.get('cookie')),
    now,
  );
  if (flow === null) {
    return back(request, 'expired', { clearFlow: true });
  }
  const code = singleValue(form, 'code') ?? '';
  if (!OTP_CODE_PATTERN.test(code)) {
    return back(request, 'refused', { step: 'code' });
  }
  if (
    !limiter.admit({ kind: 'verify', email: flow.email, client }, now).admitted
  ) {
    return back(request, 'rate-limited', { clearFlow: true });
  }

  let connection: DatabaseConnection | undefined;
  const requestId = randomUUID();
  try {
    const claims = await provider.verify({
      email: flow.email,
      flowSession: flow.flowSession,
      code,
    });
    connection = createConnection();
    const completed = await completePartnerSignIn(connection.db, {
      claims,
      installationId: flow.installationId,
      requestId,
      now,
    });
    const response = NextResponse.redirect(
      new URL('/', `${applicationOriginForRequest(request.url)}/`),
      303,
    );
    response.cookies.set(completed.cookie);
    writeBrowserCsrfCookie(
      response.cookies,
      createCsrfToken(),
      completed.cookie.maxAge,
    );
    // NextResponse.cookies rewrites Set-Cookie, so the flow-cookie clearing
    // is appended only after every cookie-writer call has completed.
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
          occurredAt: now.toISOString(),
          subjectDigest: null,
          reasonCode: error.refusal ?? POST_GATE_SIGN_IN_FAILED_REASON,
          userId: null,
          source: 'web',
        });
      } catch {
        // Recording failed; the refusal below is still the outcome.
      }
      return back(request, 'refused', { clearFlow: true });
    }
    return back(
      request,
      error instanceof PartnerOtpError &&
        error.code === 'PARTNER_SIGN_IN_REFUSED'
        ? 'refused'
        : 'unavailable',
      { clearFlow: true },
    );
  } finally {
    await connection?.close();
  }
}
