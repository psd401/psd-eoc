import { randomUUID } from 'node:crypto';

import {
  IdempotencyKeySchema,
  ListFacilitiesInputSchema,
  type CapabilityInput,
} from '@psd-eoc/contracts';
import { NextResponse } from 'next/server';

import {
  START_FLOW_CONFIRMATION_HEADER,
  START_FLOW_IDEMPOTENCY_HEADER,
  handleActivateEvent,
  handleCreateActivationPreview,
  startFlowApiErrorResponse,
  type StartFlowRouteRuntime,
} from '../../../../(app)/start/_lib/http';
import { getDefaultStartFlowCapabilityRuntime } from '../../../../(app)/start/_lib/capabilities';
import {
  getDefaultStartConfirmationRuntime,
  type IssueStartConfirmationInput,
} from '../../../../(app)/start/_lib/confirmation';
import { authenticateSessionRequest } from '../../../../../lib/auth/middleware';
import {
  getDefaultSessionService,
  SessionAccessError,
  type AuthenticatedSession,
  type SessionService,
} from '../../../../../lib/auth/sessions';
import {
  resolveHumanCapabilityInvocation,
  type TrustedCapabilityInvocation,
} from '../../../../../lib/capabilities/engine';
import { getDefaultEventCapabilityRuntime } from '../../../../../lib/capabilities/events';

const RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  Vary: 'Authorization, Cookie',
});
const DEFAULT_FACILITY_PAGE_LIMIT = 200;

export interface MobileStartRouteRuntime extends StartFlowRouteRuntime {
  authenticateQuery(request: Request, now: Date): Promise<AuthenticatedSession>;
  executeFacilities(
    input: CapabilityInput<'list-facilities'>,
    invocation: TrustedCapabilityInvocation,
  ): Promise<unknown>;
}

/** Accepts only a current native bearer and never treats a cookie as mobile. */
export async function authenticateMobileStartRequest(
  request: Request,
  sessions: SessionService,
  options: Readonly<{ mutation: boolean }>,
  now: Date,
): Promise<AuthenticatedSession> {
  const authenticated = await authenticateSessionRequest(
    request,
    sessions,
    options,
    now,
  );
  if (authenticated.source !== 'mobile') {
    throw new SessionAccessError(
      'FORBIDDEN',
      'This endpoint requires an authenticated mobile session.',
    );
  }
  return authenticated;
}

/** Mobile adapters over the same canonical capability and confirmation runtimes. */
export function getDefaultMobileStartRouteRuntime(): MobileStartRouteRuntime {
  const sessions = getDefaultSessionService();
  const startCapabilities = getDefaultStartFlowCapabilityRuntime();
  const eventCapabilities = getDefaultEventCapabilityRuntime();
  const confirmations = getDefaultStartConfirmationRuntime();
  return Object.freeze({
    createRequestId: randomUUID,
    now: () => new Date(),
    authenticate: (request: Request, now: Date) =>
      authenticateMobileStartRequest(
        request,
        sessions,
        { mutation: true },
        now,
      ),
    authenticateQuery: (request: Request, now: Date) =>
      authenticateMobileStartRequest(
        request,
        sessions,
        { mutation: false },
        now,
      ),
    issueConfirmation: (input: IssueStartConfirmationInput) =>
      confirmations.issue(input),
    executeFacilities: (
      input: CapabilityInput<'list-facilities'>,
      invocation: TrustedCapabilityInvocation,
    ) => startCapabilities.execute('list-facilities', input, invocation),
    executePreview: (
      input: CapabilityInput<'create-activation-preview'>,
      invocation: TrustedCapabilityInvocation,
    ) =>
      startCapabilities.execute('create-activation-preview', input, invocation),
    executeEvent: (
      capabilityId: Parameters<StartFlowRouteRuntime['executeEvent']>[0],
      input: unknown,
      invocation: TrustedCapabilityInvocation,
    ) => eventCapabilities.execute(capabilityId, input, invocation),
  });
}

function assertFacilitiesQueryHeaders(request: Request): void {
  if (
    request.headers.has(START_FLOW_IDEMPOTENCY_HEADER) ||
    request.headers.has(START_FLOW_CONFIRMATION_HEADER)
  ) {
    throw new SyntaxError('Facility queries cannot carry mutation metadata.');
  }
}

function parseFacilitiesInput(
  request: Request,
): CapabilityInput<'list-facilities'> {
  if (request.method !== 'GET') {
    throw new SyntaxError('The mobile facility route requires GET.');
  }
  const parameters = new URL(request.url).searchParams;
  const allowed = new Set(['cursor', 'limit']);
  for (const key of parameters.keys()) {
    if (!allowed.has(key) || parameters.getAll(key).length !== 1) {
      throw new SyntaxError('The facility query parameters are invalid.');
    }
  }
  const limit = parameters.get('limit');
  return ListFacilitiesInputSchema.parse({
    includeInactive: true,
    cursor: parameters.get('cursor'),
    limit: limit === null ? DEFAULT_FACILITY_PAGE_LIMIT : Number(limit),
  });
}

function queryInvocation(
  authenticated: AuthenticatedSession,
  requestId: string,
  serverTime: Date,
): TrustedCapabilityInvocation {
  return resolveHumanCapabilityInvocation(authenticated, {
    requestId,
    serverTime,
    mutation: null,
  });
}

/** Lists authorized facilities so active events retain names after deactivation. */
export async function handleListMobileStartFacilities(
  request: Request,
  runtimeValue?: MobileStartRouteRuntime,
): Promise<NextResponse> {
  let requestId: string = randomUUID();
  try {
    const runtime = runtimeValue ?? getDefaultMobileStartRouteRuntime();
    requestId = runtime.createRequestId();
    const serverTime = runtime.now();
    const authenticated = await runtime.authenticateQuery(request, serverTime);
    assertFacilitiesQueryHeaders(request);
    const input = parseFacilitiesInput(request);
    const result = await runtime.executeFacilities(
      input,
      queryInvocation(authenticated, requestId, serverTime),
    );
    return NextResponse.json(result, { headers: RESPONSE_HEADERS });
  } catch (error) {
    return startFlowApiErrorResponse(error, requestId);
  }
}

/** Creates a consequence preview; no confirmation or mutation is performed. */
export function handleMobileActivationPreview(
  request: Request,
  runtimeValue?: MobileStartRouteRuntime,
): Promise<NextResponse> {
  const runtime = runtimeValue ?? getDefaultMobileStartRouteRuntime();
  const transportIdempotencyKey = request.headers.get(
    START_FLOW_IDEMPOTENCY_HEADER,
  );
  const headers = new Headers(request.headers);
  headers.delete(START_FLOW_IDEMPOTENCY_HEADER);
  const previewRequest = new Request(request, { headers });

  return handleCreateActivationPreview(previewRequest, {
    ...runtime,
    async authenticate(authRequest, now) {
      const authenticated = await runtime.authenticate(authRequest, now);
      // The centralized mobile transport requires a key for every POST. It is
      // validated after authentication, consumed only by this adapter, and is
      // deliberately excluded from the non-mutating capability invocation.
      IdempotencyKeySchema.parse(transportIdempotencyKey ?? '');
      return authenticated;
    },
  });
}

/** Issues server-owned confirmation and immediately executes one explicit start. */
export function handleMobileActivateEvent(
  request: Request,
  runtime?: MobileStartRouteRuntime,
): Promise<NextResponse> {
  return handleActivateEvent(
    request,
    runtime ?? getDefaultMobileStartRouteRuntime(),
  );
}
