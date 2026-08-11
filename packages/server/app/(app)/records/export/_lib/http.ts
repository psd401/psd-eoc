import {
  ExportDrillRecordsInputSchema,
  EventSummaryExportSchema,
  RecordsExportSchema,
  type ExportDrillRecordsInput,
  type RecordsExport,
} from '@psd-eoc/contracts';
import { notFound } from 'next/navigation';
import { NextResponse } from 'next/server';

import { authenticateSessionRequest } from '../../../../../lib/auth/middleware';
import {
  SessionAccessError,
  getDefaultSessionService,
  type AuthenticatedSession,
} from '../../../../../lib/auth/sessions';
import { CapabilityEngineError } from '../../../../../lib/capabilities/engine';
import { parsePacificDateRange } from '../../_lib/date-range';
import { recordsSignInUrl } from '../../_lib/session';

const RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, private',
  Vary: 'Authorization, Cookie',
});
const CLOCK_TOLERANCE_MILLISECONDS = 60_000;

export class RecordsExportRequestError extends Error {
  public constructor() {
    super('The records export request is invalid.');
    this.name = 'RecordsExportRequestError';
  }
}

export type RecordsExportAuthentication =
  | Readonly<{ authenticated: AuthenticatedSession; response: null }>
  | Readonly<{ authenticated: null; response: Response }>;

function requestReturnTo(request: Request): string {
  try {
    const url = new URL(request.url);
    return `${url.pathname}${url.search}`;
  } catch {
    return '/records';
  }
}

/** Freshly authenticates every export GET without treating it as a mutation. */
export async function authenticateRecordsExportRequest(
  request: Request,
  serverTime: Date,
): Promise<RecordsExportAuthentication> {
  try {
    return Object.freeze({
      authenticated: await authenticateSessionRequest(
        request,
        getDefaultSessionService(),
        { mutation: false },
        serverTime,
      ),
      response: null,
    });
  } catch (error) {
    if (error instanceof SessionAccessError) {
      const location = new URL(
        recordsSignInUrl(requestReturnTo(request), 'session-required'),
        request.url,
      );
      return Object.freeze({
        authenticated: null,
        response: new Response(null, {
          status: 303,
          headers: { ...RESPONSE_HEADERS, Location: location.toString() },
        }),
      });
    }
    throw error;
  }
}

/** Rejects unknown, absent, or repeated export query fields. */
export function exactExportQuery(
  request: Request,
  requiredNames: readonly string[],
): ReadonlyMap<string, string> {
  let parameters: URLSearchParams;
  try {
    parameters = new URL(request.url).searchParams;
  } catch {
    throw new RecordsExportRequestError();
  }
  const required = new Set(requiredNames);
  for (const name of parameters.keys()) {
    if (!required.has(name) || parameters.getAll(name).length !== 1) {
      throw new RecordsExportRequestError();
    }
  }
  const values = new Map<string, string>();
  for (const name of requiredNames) {
    const candidates = parameters.getAll(name);
    if (candidates.length !== 1 || candidates[0] === undefined) {
      throw new RecordsExportRequestError();
    }
    values.set(name, candidates[0]);
  }
  return values;
}

/** Parses every CSV filter as one bounded client request error. */
export function parseDrillExportInput(
  request: Request,
): ExportDrillRecordsInput {
  try {
    const query = exactExportQuery(request, [
      'facilityId',
      'startedFrom',
      'startedThrough',
      'eventTypeId',
    ]);
    const range = parsePacificDateRange(
      query.get('startedFrom') ?? '',
      query.get('startedThrough') ?? '',
    );
    const rawEventTypeId = query.get('eventTypeId') ?? '';
    return ExportDrillRecordsInputSchema.parse({
      facilityId: query.get('facilityId'),
      eventTypeId: rawEventTypeId.length === 0 ? null : rawEventTypeId,
      startedFrom: range.startedFrom,
      startedThrough: range.startedThrough,
      format: 'csv',
    });
  } catch (error) {
    if (error instanceof RecordsExportRequestError) throw error;
    throw new RecordsExportRequestError();
  }
}

function validatedArtifact(
  value: unknown,
  expectedFormat: RecordsExport['format'],
  serverTime: Date,
): RecordsExport {
  const artifact = RecordsExportSchema.parse(value);
  if (
    artifact.format !== expectedFormat ||
    Date.parse(artifact.generatedAt) >
      serverTime.getTime() + CLOCK_TOLERANCE_MILLISECONDS ||
    Date.parse(artifact.expiresAt) <= serverTime.getTime()
  ) {
    throw new Error('The records export grant is unusable.');
  }
  return artifact;
}

export function drillExportRedirect(
  value: unknown,
  serverTime: Date,
): NextResponse {
  const artifact = validatedArtifact(value, 'csv', serverTime);
  return artifactRedirect(artifact);
}

function artifactRedirect(artifact: RecordsExport): NextResponse {
  const response = NextResponse.redirect(artifact.downloadUrl, 303);
  for (const [name, headerValue] of Object.entries(RESPONSE_HEADERS)) {
    response.headers.set(name, headerValue);
  }
  return response;
}

export function eventSummaryRedirect(
  value: unknown,
  eventId: string,
  serverTime: Date,
): NextResponse {
  const summary = EventSummaryExportSchema.parse(value);
  if (summary.eventId !== eventId) {
    throw new Error('The event-summary grant does not match its event.');
  }
  return artifactRedirect(
    validatedArtifact(summary.artifact, 'pdf', serverTime),
  );
}

/** Maps authorization existence safely and never leaks provider details. */
export function recordsExportFailure(error: unknown): NextResponse {
  if (
    error instanceof CapabilityEngineError &&
    (error.status === 403 || error.status === 404)
  ) {
    notFound();
  }
  const invalidRequest =
    error instanceof RecordsExportRequestError ||
    (error instanceof CapabilityEngineError && error.status === 400);
  return NextResponse.json(
    {
      code: invalidRequest ? 'INVALID_EXPORT_REQUEST' : 'EXPORT_UNAVAILABLE',
      message: invalidRequest
        ? 'Check the export filters and try again.'
        : 'The export could not be prepared. Try again later.',
    },
    {
      status: invalidRequest ? 400 : 503,
      headers: RESPONSE_HEADERS,
    },
  );
}
