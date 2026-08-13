import { randomUUID } from 'node:crypto';

import { FanoutStatusSchema, type CapabilityInput } from '@psd-eoc/contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  START_FLOW_CONFIRMATION_HEADER,
  START_FLOW_IDEMPOTENCY_HEADER,
  startFlowApiErrorResponse,
} from '../../../../(app)/start/_lib/http';
import {
  createDrizzleAdminCapabilityStore,
  executeAdminQueryCapability,
  getDefaultAdminDatabase,
  type AdminCapabilityStore,
  type AdminCapabilityTransaction,
} from '../../../../(admin)/facilities/admin-core';
import { getDefaultSessionService } from '../../../../../lib/auth/sessions';
import type { AuthenticatedSession } from '../../../../../lib/auth/sessions';
import type { ServerCapabilityRegistration } from '../../../../../lib/capabilities/engine';
import { readFanoutStatus } from '../../../../../lib/notify/fanout-control';
import { authenticateMobileStartRequest } from '../_lib/http';

const RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  Vary: 'Authorization, Cookie',
});

const UNAVAILABLE_STATE = FanoutStatusSchema.parse({ status: 'unavailable' });

export interface MobileFanoutControlRouteRuntime {
  createRequestId(): string;
  now(): Date;
  authenticate(request: Request, now: Date): Promise<AuthenticatedSession>;
  execute(
    authenticated: AuthenticatedSession,
    input: CapabilityInput<'get-fanout-status'>,
    metadata: Readonly<{ requestId: string; now: Date }>,
  ): Promise<unknown>;
}

const getMobileFanoutControlRegistration: ServerCapabilityRegistration<
  'get-fanout-status',
  AdminCapabilityTransaction
> = {
  id: 'get-fanout-status',
  resolveFacilityId(_input, context) {
    const actor = context.invocation.actor;
    if (
      actor.kind !== 'human' ||
      context.invocation.source !== 'mobile' ||
      context.invocation.mutation !== null
    ) {
      throw new TypeError(
        'Mobile fanout status requires an authenticated human mobile query.',
      );
    }
    return null;
  },
  handler(_input, context) {
    return readFanoutStatus(context.transaction.database);
  },
};

function executeMobileFanoutControl(
  authenticated: AuthenticatedSession,
  input: CapabilityInput<'get-fanout-status'>,
  metadata: Readonly<{ requestId: string; now: Date }>,
  injectedStore?: AdminCapabilityStore,
) {
  const store =
    injectedStore ??
    createDrizzleAdminCapabilityStore(getDefaultAdminDatabase(), authenticated);
  return executeAdminQueryCapability(
    getMobileFanoutControlRegistration,
    input,
    authenticated,
    store,
    metadata,
  );
}

function getDefaultRuntime(): MobileFanoutControlRouteRuntime {
  const sessions = getDefaultSessionService();
  return Object.freeze({
    createRequestId: randomUUID,
    now: () => new Date(),
    authenticate: (request: Request, now: Date) =>
      authenticateMobileStartRequest(
        request,
        sessions,
        { mutation: false },
        now,
      ),
    execute: executeMobileFanoutControl,
  });
}

function assertReadOnlyRequest(request: Request): void {
  if (request.method !== 'GET') {
    throw new SyntaxError('The mobile fanout-control route requires GET.');
  }
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    throw new SyntaxError(
      'The mobile fanout-control route does not accept query parameters.',
    );
  }
  if (
    request.headers.has(START_FLOW_IDEMPOTENCY_HEADER) ||
    request.headers.has(START_FLOW_CONFIRMATION_HEADER)
  ) {
    throw new SyntaxError(
      'Fanout-control status cannot carry mutation or confirmation metadata.',
    );
  }
}

/**
 * Returns authenticated, non-mutating mobile status only. Any persistence or
 * contract read failure is represented as the canonical fail-closed state;
 * this endpoint exposes no control mutation or protected lifecycle action.
 */
export async function handleGetMobileFanoutControl(
  request: Request,
  runtimeValue?: MobileFanoutControlRouteRuntime,
): Promise<NextResponse> {
  let requestId: string = randomUUID();
  try {
    const runtime = runtimeValue ?? getDefaultRuntime();
    requestId = runtime.createRequestId();
    const now = runtime.now();
    const authenticated = await runtime.authenticate(request, now);
    assertReadOnlyRequest(request);

    let state;
    try {
      state = FanoutStatusSchema.parse(
        await runtime.execute(authenticated, {}, { requestId, now }),
      );
    } catch {
      state = UNAVAILABLE_STATE;
    }
    return NextResponse.json(state, { headers: RESPONSE_HEADERS });
  } catch (error) {
    return startFlowApiErrorResponse(error, requestId);
  }
}

export function GET(request: NextRequest) {
  return handleGetMobileFanoutControl(request);
}
