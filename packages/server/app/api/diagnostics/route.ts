import { randomUUID } from 'node:crypto';

import {
  ClientDiagnosticBatchSchema,
  MAX_CLIENT_DIAGNOSTIC_REPORTS,
} from '@psd-eoc/contracts';
import { NextResponse } from 'next/server';

import { authenticateSessionRequest } from '../../../lib/auth/middleware';
import { getDefaultSessionService } from '../../../lib/auth/sessions';

const RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  Vary: 'Authorization, Cookie',
});

/**
 * A body larger than any valid batch is refused before it is parsed, so a
 * client cannot spend server memory reporting its own failures.
 */
const MAX_BODY_BYTES = 16 * 1_024;

/**
 * Records what a client saw when a request failed.
 *
 * Nothing the server logs can explain a request it never received. PSD EOC
 * spent an emergency drill showing an unavailable timeline while the server
 * recorded nothing at all, because the failing requests never arrived; the only
 * witness to those is the client. This route is that witness's voice.
 *
 * It is authenticated, so reports are attributable to a signed-in staff
 * session, and it writes nothing: reports go to the log, not the journal. They
 * are operational telemetry about the software, never part of the append-only
 * record of an event.
 *
 * Every field is drawn from a closed enum, a bounded numeric range, or a route
 * shape whose identifiers were already substituted out by the client. There is
 * no message and no free text anywhere in the contract, which is what makes the
 * whole report safe to log verbatim -- and a report that cannot be logged
 * verbatim is one nobody reads during an incident.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const requestId = randomUUID();
  try {
    const declaredLength = request.headers.get('content-length');
    if (
      declaredLength !== null &&
      (!/^\d+$/u.test(declaredLength) ||
        Number(declaredLength) > MAX_BODY_BYTES)
    ) {
      throw new SyntaxError('The diagnostic report is too large.');
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      throw new SyntaxError('The diagnostic report is too large.');
    }
    const authenticated = await authenticateSessionRequest(
      request,
      getDefaultSessionService(),
      { mutation: false },
      new Date(),
    );
    const batch = ClientDiagnosticBatchSchema.parse(JSON.parse(raw));
    for (const report of batch.reports.slice(
      0,
      MAX_CLIENT_DIAGNOSTIC_REPORTS,
    )) {
      console.info(
        JSON.stringify({
          event: 'client-diagnostic',
          kind: report.kind,
          method: report.method,
          routeShape: report.routeShape,
          status: report.status,
          clientRequestId: report.requestId,
          surface: authenticated.source,
          declaredSurface: report.surface,
          platform: report.platform,
          applicationVersion: report.applicationVersion,
          nativeBuildVersion: report.nativeBuildVersion,
          occurredAt: report.occurredAt,
          userId: authenticated.actor.userId,
          requestId,
        }),
      );
    }
    return new NextResponse(null, { status: 204, headers: RESPONSE_HEADERS });
  } catch (error) {
    console.info(
      JSON.stringify({
        event: 'client-diagnostic-rejected',
        requestId,
        errorName: error instanceof Error ? error.name : typeof error,
      }),
    );
    // A client must never retry or escalate because its own telemetry failed,
    // so this reports the refusal and says nothing else.
    return new NextResponse(null, { status: 204, headers: RESPONSE_HEADERS });
  }
}
