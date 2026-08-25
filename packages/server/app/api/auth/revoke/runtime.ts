import { randomUUID } from 'node:crypto';

import {
  ApiErrorSchema,
  RevokeSessionInputSchema,
  type SessionRevocation,
} from '@psd-eoc/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';

import {
  authenticateSessionRequest,
  clearBrowserSessionCookies,
  readPresentedSessionCredential,
} from '../../../../lib/auth/middleware';
import {
  SessionAccessError,
  executeAuditedCompletedRevokeSessionReplay,
  executeRevokeSessionCapability,
  getDefaultSessionCapabilityStore,
  getDefaultSessionService,
  type SessionCapabilityStore,
  type SessionService,
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
          ? 'The revocation request is invalid.'
          : 'Session revocation failed.'),
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

function revocationResponse(
  revocation: SessionRevocation,
  clearWebCredentials: boolean,
): NextResponse {
  const response = NextResponse.json(revocation, {
    headers: { 'Cache-Control': 'no-store' },
  });
  if (clearWebCredentials) {
    clearBrowserSessionCookies(response.cookies);
  }
  return response;
}

export function createRevokeSessionRouteHandler(
  getSessionService: () => SessionService = getDefaultSessionService,
  getSessionCapabilityStore: () => SessionCapabilityStore = getDefaultSessionCapabilityStore,
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest): Promise<NextResponse> => {
    const requestId = randomUUID();
    try {
      const service = getSessionService();
      const capabilityStore = getSessionCapabilityStore();
      let authenticated;
      try {
        authenticated = await authenticateSessionRequest(request, service, {
          mutation: true,
        });
      } catch (authenticationError) {
        if (
          !(authenticationError instanceof SessionAccessError) ||
          authenticationError.code !== 'SESSION_REVOKED'
        ) {
          throw authenticationError;
        }
        const presented = readPresentedSessionCredential(request, {
          mutation: true,
        });
        const body = RevokeSessionInputSchema.parse(await request.json());
        const recovered = await service.recoverCompletedSelfRevocation(
          presented.token,
          presented.source,
          body,
          request.headers.get('idempotency-key') ?? '',
        );
        if (recovered === null) throw authenticationError;
        await executeAuditedCompletedRevokeSessionReplay({
          capabilityStore,
          revocation: recovered,
          source: presented.source,
          requestId,
        });
        return revocationResponse(recovered, presented.source === 'web');
      }
      const body = RevokeSessionInputSchema.parse(await request.json());
      const revocation = await executeRevokeSessionCapability({
        service,
        capabilityStore,
        authenticated,
        sessionId: body.sessionId,
        reasonCode: body.reasonCode,
        idempotencyKey: request.headers.get('idempotency-key') ?? '',
        csrfVerified: authenticated.source === 'web',
        requestId,
      });
      return revocationResponse(
        revocation,
        authenticated.source === 'web' &&
          body.sessionId === authenticated.actor.sessionId,
      );
    } catch (error) {
      return apiErrorResponse(error, requestId);
    }
  };
}

export const handleRevokeSessionPost = createRevokeSessionRouteHandler();
