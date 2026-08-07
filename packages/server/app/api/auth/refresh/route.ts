import { randomUUID } from 'node:crypto';

import { ApiErrorSchema, RefreshSessionInputSchema } from '@psd-eoc/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';

import {
  createCsrfToken,
  readPresentedSessionCredential,
  writeBrowserSessionCookies,
} from '../../../../lib/auth/middleware';
import {
  SessionAccessError,
  executeRefreshSessionCapability,
  getDefaultSessionService,
} from '../../../../lib/auth/sessions';

function apiErrorResponse(error: unknown, requestId: string): NextResponse {
  const known = error instanceof SessionAccessError ? error : null;
  const validation = error instanceof ZodError || error instanceof SyntaxError;
  const status = validation ? 400 : (known?.status ?? 500);
  const code = validation
    ? 'VALIDATION_ERROR'
    : status === 401
      ? 'UNAUTHENTICATED'
      : status === 403
        ? 'FORBIDDEN'
        : status === 409
          ? 'CONFLICT'
          : 'INTERNAL_ERROR';
  return NextResponse.json(
    ApiErrorSchema.parse({
      code,
      message:
        known?.message ??
        (validation
          ? 'The refresh request is invalid.'
          : 'Session refresh failed.'),
      requestId,
      retryable: status >= 500,
      fieldErrors: [],
    }),
    {
      status,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

async function parseEmptyInput(request: NextRequest): Promise<void> {
  const body = await request.text();
  RefreshSessionInputSchema.parse(
    body.trim().length === 0 ? {} : JSON.parse(body),
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  try {
    await parseEmptyInput(request);
    const presented = readPresentedSessionCredential(request, {
      mutation: true,
    });
    const idempotencyKey = request.headers.get('idempotency-key') ?? '';
    const now = new Date();
    const issued = await executeRefreshSessionCapability({
      service: getDefaultSessionService(),
      token: presented.token,
      source: presented.source,
      idempotencyKey,
      csrfVerified: presented.csrfVerified,
      requestId,
      now,
    });
    const response = NextResponse.json(
      presented.source === 'web'
        ? { session: issued.result }
        : {
            session: issued.result,
            tokenType: 'Bearer',
            refreshToken: issued.refreshToken,
          },
      { headers: { 'Cache-Control': 'no-store' } },
    );
    if (presented.source === 'web') {
      const maxAgeSeconds = Math.max(
        0,
        Math.floor(
          (Date.parse(issued.result.session.expiresAt) - now.getTime()) / 1_000,
        ),
      );
      writeBrowserSessionCookies(
        response.cookies,
        issued.refreshToken,
        createCsrfToken(),
        maxAgeSeconds,
      );
    }
    return response;
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}
