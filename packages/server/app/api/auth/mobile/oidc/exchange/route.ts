import { randomUUID } from 'node:crypto';

import {
  ApiErrorSchema,
  MobileOidcExchangeRequestSchema,
  MobileSessionResponseSchema,
  executeCapability,
  parseCapabilityEnvelopeFor,
  type AccessGroupSourceRef,
} from '@psd-eoc/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';

import {
  DatabaseConfigurationError,
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseConnection,
} from '../../../../../../db/client';
import {
  AccessGateConfigurationError,
  POST_GATE_SIGN_IN_FAILED_REASON,
  checkAccessGate,
  createDrizzleAccessGateAuditSink,
  createDrizzleAccessGateStore,
  type AccessGateAuditSink,
} from '../../../../../../lib/auth/access-gate';
import {
  GoogleOidcCallbackError,
  GoogleOidcConfigurationError,
  completeGoogleMobileOidcExchange,
  createCompleteMobileOidcSignInEnvelope,
  readGoogleOidcConfiguration,
} from '../../../../../../lib/auth/oidc';
import {
  WebSessionIssuanceError,
  createCompleteOidcSignInAuthorizer,
  createCompleteOidcSignInHandler,
  createDrizzleInitialWebSessionStore,
  type CompleteOidcSignInContext,
} from '../../../../../../lib/auth/session-cookie';
import { readSessionPolicy } from '../../../../../../lib/auth/sessions';

export const dynamic = 'force-dynamic';

class MobileAccessDeniedError extends Error {
  public constructor() {
    super('Access requires current membership in a designated Google Group.');
    this.name = 'MobileAccessDeniedError';
  }
}

interface PostGateAuditContext {
  readonly requestId: string;
  readonly subjectDigest: string;
  readonly userId: string;
}

function responseStatus(error: unknown): number {
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return 400;
  }
  if (error instanceof MobileAccessDeniedError) {
    return 403;
  }
  if (error instanceof GoogleOidcCallbackError) {
    return error.code === 'OIDC_PROVIDER_UNAVAILABLE' ? 503 : 401;
  }
  if (
    error instanceof WebSessionIssuanceError &&
    error.code === 'SESSION_REPLAY_REJECTED'
  ) {
    return 409;
  }
  if (
    error instanceof WebSessionIssuanceError &&
    error.code === 'MEMBERSHIP_NOT_CURRENT'
  ) {
    return 403;
  }
  return 500;
}

function safeMessage(error: unknown, status: number): string {
  if (error instanceof MobileAccessDeniedError) {
    return error.message;
  }
  if (
    error instanceof GoogleOidcCallbackError ||
    error instanceof WebSessionIssuanceError
  ) {
    return error.message;
  }
  if (status === 400) {
    return 'The mobile sign-in exchange is invalid.';
  }
  if (
    error instanceof GoogleOidcConfigurationError ||
    error instanceof DatabaseConfigurationError ||
    error instanceof AccessGateConfigurationError
  ) {
    return 'Mobile sign-in is not configured.';
  }
  return 'Mobile sign-in could not be completed.';
}

function errorResponse(error: unknown, requestId: string): NextResponse {
  const status = responseStatus(error);
  const code =
    status === 400
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
      message: safeMessage(error, status),
      requestId,
      retryable: status === 503,
      fieldErrors: [],
    }),
    {
      status,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
        'Referrer-Policy': 'no-referrer',
      },
    },
  );
}

function membershipMember(
  userId: string,
  googleSubject: string,
  accessGroupSourceRefs: readonly AccessGroupSourceRef[],
  facilityScope: CompleteOidcSignInContext['authorization']['user']['facilityScope'],
): CompleteOidcSignInContext['authorization']['membershipMember'] {
  return Object.freeze({
    userId,
    googleSubject,
    accessGroupSourceRefs,
    facilityScope,
  });
}

/**
 * Exchanges verified Google transport evidence for one opaque app bearer. Raw
 * provider credentials are removed before executeCapability is invoked.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  let connection: DatabaseConnection | undefined;
  let auditSink: AccessGateAuditSink | undefined;
  let postGateAuditContext: PostGateAuditContext | undefined;
  try {
    const requestBody = MobileOidcExchangeRequestSchema.parse(
      await request.json(),
    );
    const configuration = readGoogleOidcConfiguration();
    const exchange = await completeGoogleMobileOidcExchange(
      configuration,
      requestBody,
    );
    const serverTime = new Date().toISOString();
    const envelope = parseCapabilityEnvelopeFor(
      'complete-oidc-sign-in',
      createCompleteMobileOidcSignInEnvelope(exchange, {
        requestId,
        serverTime,
      }),
    );

    connection = createDatabaseClient(readDatabaseConfig());
    auditSink = createDrizzleAccessGateAuditSink(connection.db);
    const access = await checkAccessGate(
      {
        googleSubject: exchange.principal.subject,
        email: exchange.principal.email,
        displayName: exchange.principal.displayName,
        subjectDigest: exchange.principal.subjectDigest,
        requestId,
        checkedAt: serverTime,
        source: 'mobile',
      },
      {
        store: createDrizzleAccessGateStore(connection.db),
        audit: auditSink,
      },
    );
    if (!access.granted) {
      throw new MobileAccessDeniedError();
    }
    postGateAuditContext = Object.freeze({
      requestId,
      subjectDigest: exchange.principal.subjectDigest,
      userId: access.user.id,
    });

    let bearer: string | undefined;
    const context: CompleteOidcSignInContext = Object.freeze({
      authorization: Object.freeze({
        user: access.user,
        membershipSnapshot: Object.freeze({
          id: access.membership.snapshotId,
          version: access.membership.snapshotVersion,
          complete: true as const,
          syncStartedAt: access.membership.syncStartedAt,
          capturedAt: access.membership.capturedAt,
        }),
        membershipMember: membershipMember(
          access.user.id,
          access.user.googleSubject,
          access.membership.accessGroupSourceRefs,
          access.user.facilityScope,
        ),
        firstLoginBinding: access.firstLoginBinding,
        grantBootstrapAdmin: access.bootstrapAdminEligible,
      }),
      bearerSink: Object.freeze({
        set(value: string): void {
          if (bearer !== undefined) {
            throw new Error('A mobile sign-in may issue only one bearer.');
          }
          bearer = value;
        },
      }),
      envelope,
      responseDigest: exchange.responseDigest,
    });
    const policy = readSessionPolicy();
    const result = await executeCapability(
      createCompleteOidcSignInHandler({
        store: createDrizzleInitialWebSessionStore(connection.db),
        policy,
      }),
      envelope.input,
      {
        context,
        humanActionResolutionContext: null,
        safetyResolver: null,
        authorizer: createCompleteOidcSignInAuthorizer({ policy }),
      },
    );
    if (bearer === undefined) {
      throw new Error('The canonical sign-in capability issued no bearer.');
    }
    return NextResponse.json(
      MobileSessionResponseSchema.parse({
        session: result,
        tokenType: 'Bearer',
        refreshToken: bearer,
      }),
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
          Pragma: 'no-cache',
          'Referrer-Policy': 'no-referrer',
        },
      },
    );
  } catch (error) {
    if (postGateAuditContext !== undefined && auditSink !== undefined) {
      try {
        await auditSink.append({
          outcome: 'denied',
          requestId: postGateAuditContext.requestId,
          occurredAt: new Date().toISOString(),
          subjectDigest: postGateAuditContext.subjectDigest,
          reasonCode:
            error instanceof WebSessionIssuanceError
              ? error.code
              : POST_GATE_SIGN_IN_FAILED_REASON,
          userId: postGateAuditContext.userId,
          source: 'mobile',
        });
      } catch {
        return errorResponse(
          new Error('The mobile sign-in audit could not be recorded.'),
          requestId,
        );
      }
    }
    return errorResponse(error, requestId);
  } finally {
    await connection?.close();
  }
}
