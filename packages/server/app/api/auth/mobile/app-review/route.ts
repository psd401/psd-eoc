import { randomUUID } from 'node:crypto';

import {
  ApiErrorSchema,
  MobileAppReviewSignInRequestSchema,
  MobileSessionResponseSchema,
} from '@psd-eoc/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';

import {
  DatabaseConfigurationError,
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseConnection,
} from '../../../../../db/client';
import {
  AppReviewSignInError,
  completeAppReviewSignIn,
  readAppReviewSignInDigest,
} from '../../../../../lib/auth/app-review-sign-in';
import {
  GoogleOidcConfigurationError,
  readGoogleOidcConfiguration,
} from '../../../../../lib/auth/oidc';
import { WebSessionIssuanceError } from '../../../../../lib/auth/session-cookie';
import { readSessionPolicy } from '../../../../../lib/auth/sessions';
import { parseInitialMobileTransitionEmailDigest } from '../../../../../lib/auth/sign-in-audit';

export const dynamic = 'force-dynamic';

/** A wrong code costs the caller this long, so the endpoint is not a fast oracle. */
const REJECTION_DELAY_MS = 750;

const PRIVATE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
});

function failure(
  status: number,
  code:
    | 'VALIDATION_ERROR'
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'INTERNAL_ERROR',
  message: string,
  requestId: string,
): NextResponse {
  return NextResponse.json(
    ApiErrorSchema.parse({
      code,
      message,
      requestId,
      retryable: false,
      fieldErrors: [],
    }),
    { status, headers: PRIVATE_HEADERS },
  );
}

/**
 * Signs in the deployment's app-store review account with a code. Absent the
 * deployment's digest this route does not exist.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const expectedDigest = readAppReviewSignInDigest(
    process.env.PSD_EOC_APP_REVIEW_SIGN_IN_SHA256,
  );
  if (expectedDigest === null) {
    return failure(404, 'NOT_FOUND', 'Not found.', requestId);
  }

  let connection: DatabaseConnection | undefined;
  try {
    const body = MobileAppReviewSignInRequestSchema.parse(await request.json());
    const configuration = readGoogleOidcConfiguration();
    connection = createDatabaseClient(readDatabaseConfig());
    const result = await completeAppReviewSignIn(connection.db, {
      request: body,
      expectedDigest,
      clientId: configuration.clientId,
      requestId,
      now: new Date(),
      policy: readSessionPolicy(),
      initialMobileTransitionEmailDigest:
        parseInitialMobileTransitionEmailDigest(
          process.env.PSD_EOC_INITIAL_MOBILE_TRANSITION_EMAIL_SHA256,
        ),
    });
    return NextResponse.json(
      MobileSessionResponseSchema.parse({
        session: result.session,
        tokenType: 'Bearer',
        refreshToken: result.bearer,
      }),
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return failure(
        400,
        'VALIDATION_ERROR',
        'Enter the review email address and code exactly as provided.',
        requestId,
      );
    }
    if (error instanceof AppReviewSignInError) {
      if (error.code === 'REJECTED') {
        await new Promise((resolve) => setTimeout(resolve, REJECTION_DELAY_MS));
        return failure(401, 'UNAUTHENTICATED', error.message, requestId);
      }
      if (error.code === 'DISABLED') {
        return failure(404, 'NOT_FOUND', 'Not found.', requestId);
      }
      return failure(403, 'FORBIDDEN', error.message, requestId);
    }
    if (
      error instanceof WebSessionIssuanceError &&
      error.code === 'MEMBERSHIP_NOT_CURRENT'
    ) {
      return failure(403, 'FORBIDDEN', error.message, requestId);
    }
    if (
      error instanceof GoogleOidcConfigurationError ||
      error instanceof DatabaseConfigurationError
    ) {
      return failure(
        500,
        'INTERNAL_ERROR',
        'Mobile sign-in is not configured.',
        requestId,
      );
    }
    return failure(
      500,
      'INTERNAL_ERROR',
      'Review sign-in could not be completed.',
      requestId,
    );
  } finally {
    await connection?.close();
  }
}
