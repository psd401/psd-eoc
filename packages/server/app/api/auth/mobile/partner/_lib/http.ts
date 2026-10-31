import { ApiErrorSchema } from '@psd-eoc/contracts';
import { NextResponse } from 'next/server';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type DatabaseConnection,
} from '../../../../../../db/client';

/**
 * Shared shape for the two native partner sign-in steps.
 *
 * The browser's partner route answers by redirecting to a page with one
 * status; the native app has no page, so these two routes answer with the
 * ordinary API error envelope. What does not change is the rule the browser
 * route keeps: every refusal says the same thing. An address with no
 * admission, an ended admission, an expired admission, a district address,
 * a disabled account and a wrong code are one message, or the endpoint
 * answers questions about who has partner access.
 */

/** The one thing a refused partner sign-in ever says. */
export const PARTNER_REFUSAL_MESSAGE = 'The sign-in details were not accepted.';

/** A wrong code costs the caller this long, so neither step is a fast oracle. */
export const PARTNER_REJECTION_DELAY_MS = 750;

export const PARTNER_PRIVATE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
});

export type PartnerApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

const STATUS: Readonly<Record<PartnerApiErrorCode, number>> = Object.freeze({
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
});

export function partnerFailure(
  code: PartnerApiErrorCode,
  message: string,
  requestId: string,
  headers: Readonly<Record<string, string>> = {},
): NextResponse {
  return NextResponse.json(
    ApiErrorSchema.parse({
      code,
      message,
      requestId,
      // A rate limit and a server fault are worth another attempt later; a
      // refusal never is.
      retryable: code === 'RATE_LIMITED' || code === 'INTERNAL_ERROR',
      fieldErrors: [],
    }),
    {
      status: STATUS[code],
      headers: { ...PARTNER_PRIVATE_HEADERS, ...headers },
    },
  );
}

/**
 * A deployment with no partner pool has no native partner sign-in, and says
 * so the way it would about any path it does not serve.
 */
export function partnerSignInAbsent(requestId: string): NextResponse {
  return partnerFailure('NOT_FOUND', 'Not found.', requestId);
}

export function createPartnerConnection(): DatabaseConnection {
  const config = readDatabaseConfig();
  if (config.driver !== 'postgres') {
    throw new Error('Partner sign-in requires native PostgreSQL.');
  }
  return createDatabaseClient(config);
}
