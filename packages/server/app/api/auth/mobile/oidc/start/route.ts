import { randomUUID } from 'node:crypto';

import {
  ApiErrorSchema,
  MobileOidcStartRequestSchema,
  MobileOidcStartResponseSchema,
} from '@psd-eoc/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';

import {
  beginGoogleMobileOidcSignIn,
  GoogleOidcConfigurationError,
  readGoogleOidcConfiguration,
} from '../../../../../../lib/auth/oidc';

export const dynamic = 'force-dynamic';

function errorResponse(error: unknown, requestId: string): NextResponse {
  const validation = error instanceof ZodError || error instanceof SyntaxError;
  const configuration = error instanceof GoogleOidcConfigurationError;
  const status = validation ? 400 : 500;
  return NextResponse.json(
    ApiErrorSchema.parse({
      code: validation ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
      message: validation
        ? 'The mobile sign-in request is invalid.'
        : configuration
          ? 'Mobile sign-in is not configured.'
          : 'Mobile sign-in could not be started.',
      requestId,
      retryable: false,
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

/** Creates only short-lived OIDC transport state; it establishes no session. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  try {
    const input = MobileOidcStartRequestSchema.parse(await request.json());
    const result = await beginGoogleMobileOidcSignIn(
      readGoogleOidcConfiguration(),
      input,
    );
    return NextResponse.json(MobileOidcStartResponseSchema.parse(result), {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
