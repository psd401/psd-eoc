import { randomUUID } from 'node:crypto';

import {
  ApiErrorSchema,
  IdempotencyKeySchema,
  defineCapability,
  isAgentGrantableCapabilityId,
  isHumanOnlyActionId,
  type ApiErrorCode,
} from '@psd-eoc/contracts';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { CapabilityEngineError } from '../../../../../lib/capabilities/engine';
import { EventTypeCapabilityError } from '../../../../../lib/capabilities/event-types';
import {
  SecurityAuditCursorError,
  SecurityAuditScopeError,
  isSecurityAuditForbiddenError,
} from '../../../../../lib/audit';
import { AgentCapabilityUnavailableError } from '../../../../../lib/agents/dispatcher';
import { AgentApiKeyAdministrationError } from '../../../../../lib/agents/admin-capabilities';
import {
  AgentGatewayCapabilityNotFoundError,
  AgentGatewayError,
  AgentGatewayOutputError,
  type AuthorizedAgentGatewayCall,
  type AgentGatewayRequest,
  type PreparedAgentGatewayRequest,
} from '../../../../../lib/agents/gateway';
import { AgentApiKeyError } from '../../../../../lib/agents/keys';
import { getDefaultAgentRestGateway } from '../../../../../lib/agents/runtime';

export const AGENT_IDEMPOTENCY_KEY_HEADER = 'idempotency-key' as const;
const JSON_MEDIA_TYPE = 'application/json';
const MAX_AGENT_REQUEST_BODY_BYTES = 128 * 1_024;
const RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  Vary: 'Authorization',
  'X-Content-Type-Options': 'nosniff',
});

export interface AgentRestRouteGateway {
  authorize(
    request: Pick<
      AgentGatewayRequest,
      'credential' | 'capabilityId' | 'requestId' | 'serverTime'
    >,
  ): Promise<AuthorizedAgentGatewayCall>;
  executeAuthorized(
    call: AuthorizedAgentGatewayCall,
    prepare: () => Promise<PreparedAgentGatewayRequest>,
  ): Promise<unknown>;
}

export interface AgentRestRouteRuntime {
  readonly gateway: AgentRestRouteGateway;
  createRequestId(): string;
  now(): Date;
}

export function getDefaultAgentRestRouteRuntime(): AgentRestRouteRuntime {
  return Object.freeze({
    gateway: getDefaultAgentRestGateway(),
    createRequestId: randomUUID,
    now: () => new Date(),
  });
}

function readBearerCredential(request: Request): string {
  const authorization = request.headers.get('authorization');
  const match = /^Bearer ([A-Za-z0-9_.-]{1,512})$/u.exec(authorization ?? '');
  return match?.[1] ?? '';
}

function assertNoQueryParameters(request: Request): void {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    throw new SyntaxError(
      'Agent capability routes do not accept query parameters.',
    );
  }
}

function assertJsonContentType(request: Request): void {
  const mediaType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new SyntaxError('Agent capability requests require JSON content.');
  }
}

async function readJsonValue(request: Request): Promise<unknown> {
  assertJsonContentType(request);
  const contentLength = request.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) ||
      Number(contentLength) > MAX_AGENT_REQUEST_BODY_BYTES)
  ) {
    throw new SyntaxError('The agent request body is too large.');
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  if (reader !== undefined) {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_AGENT_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SyntaxError('The agent request body is too large.');
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError('The agent request body is not valid UTF-8.');
  }
  if (text.trim().length === 0) {
    throw new SyntaxError('The agent request body is required.');
  }
  return JSON.parse(text) as unknown;
}

function idempotencyKey(request: Request, capabilityId: string): string | null {
  if (isHumanOnlyActionId(capabilityId)) {
    return null;
  }
  if (!isAgentGrantableCapabilityId(capabilityId)) {
    return null;
  }
  const definition = defineCapability(capabilityId);
  const header = request.headers.get(AGENT_IDEMPOTENCY_KEY_HEADER);
  if (definition.operation === 'mutation') {
    return IdempotencyKeySchema.parse(header ?? '');
  }
  if (header !== null) {
    throw new SyntaxError('Agent queries cannot carry an idempotency key.');
  }
  return null;
}

function apiCodeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL_ERROR';
  }
}

export function agentApiErrorResponse(
  error: unknown,
  requestId: string,
): NextResponse {
  const engineError = error instanceof CapabilityEngineError ? error : null;
  const keyError = error instanceof AgentApiKeyError ? error : null;
  const gatewayError = error instanceof AgentGatewayError ? error : null;
  const gatewayOutputError =
    error instanceof AgentGatewayOutputError ? error : null;
  const unavailableError =
    error instanceof AgentCapabilityUnavailableError ? error : null;
  const routeNotFoundError =
    error instanceof AgentGatewayCapabilityNotFoundError ? error : null;
  const auditForbiddenError = isSecurityAuditForbiddenError(error)
    ? error
    : null;
  const auditCursorError =
    error instanceof SecurityAuditCursorError ? error : null;
  const auditScopeError =
    error instanceof SecurityAuditScopeError ? error : null;
  const eventTypeError =
    error instanceof EventTypeCapabilityError ? error : null;
  const administrationError =
    error instanceof AgentApiKeyAdministrationError ? error : null;
  const validationError =
    error instanceof ZodError ||
    error instanceof SyntaxError ||
    error instanceof TypeError;
  const status = validationError
    ? 400
    : (engineError?.status ??
      keyError?.status ??
      gatewayError?.status ??
      gatewayOutputError?.status ??
      unavailableError?.status ??
      routeNotFoundError?.status ??
      administrationError?.status ??
      auditForbiddenError?.status ??
      (auditCursorError === null ? undefined : 400) ??
      (auditScopeError === null ? undefined : 403) ??
      (eventTypeError === null
        ? 500
        : eventTypeError.code === 'FORBIDDEN'
          ? 403
          : eventTypeError.code === 'NOT_FOUND'
            ? 404
            : eventTypeError.code === 'CONFLICT'
              ? 409
              : 400));
  const code =
    engineError?.code ??
    routeNotFoundError?.code ??
    gatewayOutputError?.code ??
    administrationError?.code ??
    auditForbiddenError?.code ??
    apiCodeForStatus(status);
  const message =
    engineError?.message ??
    keyError?.message ??
    gatewayError?.message ??
    gatewayOutputError?.message ??
    unavailableError?.message ??
    routeNotFoundError?.message ??
    administrationError?.message ??
    auditForbiddenError?.message ??
    (auditCursorError === null
      ? undefined
      : 'The security-audit cursor is invalid.') ??
    (auditScopeError === null
      ? undefined
      : 'The requested security-audit scope is not permitted.') ??
    eventTypeError?.message ??
    (validationError
      ? 'The agent capability request is invalid.'
      : 'The agent capability request failed.');
  const headers: Record<string, string> = { ...RESPONSE_HEADERS };
  if (status === 401) headers['WWW-Authenticate'] = 'Bearer';
  return NextResponse.json(
    ApiErrorSchema.parse({
      code,
      message,
      requestId,
      retryable:
        engineError?.retryable ??
        keyError?.retryable ??
        gatewayError?.retryable ??
        gatewayOutputError?.retryable ??
        unavailableError?.retryable ??
        routeNotFoundError?.retryable ??
        administrationError?.retryable ??
        (auditForbiddenError === null ? undefined : false) ??
        (auditCursorError === null ? undefined : false) ??
        (auditScopeError === null ? undefined : false) ??
        status >= 500,
      fieldErrors: [],
    }),
    { status, headers },
  );
}

/** Executes one canonical agent capability; no action alias reaches dispatch. */
export async function handleAgentCapability(
  request: Request,
  capabilityId: string,
  runtime?: AgentRestRouteRuntime,
): Promise<NextResponse> {
  let requestId: string = randomUUID();
  try {
    const resolvedRuntime = runtime ?? getDefaultAgentRestRouteRuntime();
    requestId = resolvedRuntime.createRequestId();
    if (
      !isHumanOnlyActionId(capabilityId) &&
      !isAgentGrantableCapabilityId(capabilityId)
    ) {
      throw new AgentGatewayCapabilityNotFoundError();
    }
    const authorized = await resolvedRuntime.gateway.authorize({
      credential: readBearerCredential(request),
      capabilityId,
      requestId,
      serverTime: resolvedRuntime.now(),
    });
    const result = await resolvedRuntime.gateway.executeAuthorized(
      authorized,
      async () => {
        assertNoQueryParameters(request);
        if (request.headers.has('human-confirmation-id')) {
          throw new AgentGatewayError(
            'HUMAN_ONLY_REQUIRED',
            'Agent credentials cannot present human confirmation.',
          );
        }
        return {
          input: await readJsonValue(request),
          idempotencyKey: idempotencyKey(request, capabilityId),
        };
      },
    );
    return NextResponse.json(result, { headers: RESPONSE_HEADERS });
  } catch (error) {
    return agentApiErrorResponse(error, requestId);
  }
}
