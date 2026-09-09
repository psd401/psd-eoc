import { randomUUID } from 'node:crypto';

import { legacyMobileWording } from './legacy-mobile-wording';

import {
  ApiErrorSchema,
  CreateEventTypeDraftInputSchema,
  GetEventTypeDraftInputSchema,
  GetEventTypeVersionInputSchema,
  IdempotencyKeySchema,
  ListEventTypesInputSchema,
  PreviewEventTypeRenderingInputSchema,
  PublishEventTypeVersionInputSchema,
  UpdateEventTypeDraftInputSchema,
  type ApiErrorCode,
} from '@psd-eoc/contracts';

import { authenticateSessionRequest } from '../../../../lib/auth/middleware';
import {
  SessionAccessError,
  getDefaultSessionService,
} from '../../../../lib/auth/sessions';
import {
  EventTypeCapabilityError,
  executeCreateEventTypeDraftCapability,
  executeGetEventTypeDraftCapability,
  executeGetEventTypeVersionCapability,
  executeListEventTypesCapability,
  executePreviewEventTypeRenderingCapability,
  executePublishEventTypeVersionCapability,
  executeUpdateEventTypeDraftCapability,
  getDefaultEventTypeCapabilityStore,
  getDefaultEventTypeStore,
} from '../../../../lib/capabilities/event-types';
import { TemplateRenderError } from '../../../../lib/notify/render';
import {
  RequestValidationError,
  parseRequestInput,
  readBoundedJson,
  type RequestFieldError,
} from './request';

export const dynamic = 'force-dynamic';

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function errorResponse(
  requestId: string,
  code: ApiErrorCode,
  message: string,
  status: number,
  fieldErrors: readonly RequestFieldError[] = [],
): Response {
  return json(
    ApiErrorSchema.parse({
      code,
      message,
      requestId,
      retryable: status >= 500,
      fieldErrors,
    }),
    status,
  );
}

function handleError(error: unknown, requestId: string): Response {
  if (error instanceof RequestValidationError) {
    return errorResponse(
      requestId,
      'VALIDATION_ERROR',
      error.message,
      400,
      error.fieldErrors,
    );
  }
  if (error instanceof SessionAccessError) {
    return errorResponse(
      requestId,
      error.status === 403 ? 'FORBIDDEN' : 'UNAUTHENTICATED',
      error.status === 403
        ? 'Access is denied.'
        : 'A current PSD EOC session is required.',
      error.status,
    );
  }
  if (error instanceof EventTypeCapabilityError) {
    const code =
      error.code === 'IDEMPOTENCY_CONFLICT'
        ? 'IDEMPOTENCY_CONFLICT'
        : error.code;
    return errorResponse(requestId, code, error.message, error.status);
  }
  if (error instanceof TemplateRenderError) {
    return errorResponse(requestId, 'VALIDATION_ERROR', error.message, 400);
  }
  return errorResponse(
    requestId,
    'INTERNAL_ERROR',
    'PSD EOC could not complete the event-type request.',
    500,
  );
}

/**
 * The installed mobile app (1.0.14) refuses the two lifecycle wording tokens;
 * a mobile session gets them rewritten until every device runs 1.0.15.
 */
function forClient<Value>(
  authenticated: Readonly<{ source: 'web' | 'mobile' }>,
  value: Value,
): Value {
  return authenticated.source === 'mobile' ? legacyMobileWording(value) : value;
}

export async function GET(request: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    const authenticated = await authenticateSessionRequest(
      request,
      getDefaultSessionService(),
      { mutation: false },
    );
    const store = getDefaultEventTypeStore();
    const parameters = new URL(request.url).searchParams;
    const operation = parameters.get('operation') ?? 'list';
    switch (operation) {
      case 'list': {
        const enabledParameter = parameters.get('enabled');
        return json(
          forClient(
            authenticated,
            await executeListEventTypesCapability({
              store,
              authenticated,
              requestId,
              query: parseRequestInput(ListEventTypesInputSchema, {
                templateMode: parameters.get('templateMode'),
                enabled:
                  enabledParameter === null
                    ? null
                    : enabledParameter === 'true'
                      ? true
                      : enabledParameter === 'false'
                        ? false
                        : enabledParameter,
                cursor: parameters.get('cursor'),
                limit: Number(parameters.get('limit') ?? '200'),
              }),
            }),
          ),
        );
      }
      case 'version':
        return json(
          forClient(
            authenticated,
            await executeGetEventTypeVersionCapability({
              store,
              authenticated,
              requestId,
              query: parseRequestInput(GetEventTypeVersionInputSchema, {
                eventTypeVersionId: parameters.get('eventTypeVersionId'),
              }),
            }),
          ),
        );
      case 'draft':
        return json(
          await executeGetEventTypeDraftCapability({
            store,
            authenticated,
            requestId,
            query: parseRequestInput(GetEventTypeDraftInputSchema, {
              draftId: parameters.get('draftId'),
            }),
          }),
        );
      case 'preview':
        return json(
          await executePreviewEventTypeRenderingCapability({
            store,
            authenticated,
            requestId,
            query: parseRequestInput(PreviewEventTypeRenderingInputSchema, {
              draftId: parameters.get('draftId'),
              expectedDraftRevision: parameters.get('expectedDraftRevision'),
              eventKind: parameters.get('eventKind'),
              purpose: parameters.get('purpose'),
            }),
          }),
        );
      default:
        return errorResponse(
          requestId,
          'VALIDATION_ERROR',
          'The event-type query operation is not supported.',
          400,
        );
    }
  } catch (error) {
    return handleError(error, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    const authenticated = await authenticateSessionRequest(
      request,
      getDefaultSessionService(),
      { mutation: true },
    );
    const idempotencyKey = parseRequestInput(
      IdempotencyKeySchema,
      request.headers.get('idempotency-key') ?? '',
    );
    const transport =
      authenticated.source === 'web'
        ? ({
            kind: 'web-interactive',
            method: 'POST',
            interaction: 'explicit-user-submit',
            csrfVerified: true,
          } as const)
        : ({
            kind: 'mobile-interactive',
            interaction: 'explicit-user-submit',
          } as const);
    const store = getDefaultEventTypeStore();
    const capabilityStore = getDefaultEventTypeCapabilityStore();
    const body = await readBoundedJson(request);
    if (typeof body !== 'object' || body === null || !('action' in body)) {
      return errorResponse(
        requestId,
        'VALIDATION_ERROR',
        'The event-type command is invalid.',
        400,
      );
    }
    const action = body.action;
    const rawInput = 'input' in body ? body.input : undefined;
    switch (action) {
      case 'create-draft':
        return json(
          await executeCreateEventTypeDraftCapability({
            store,
            capabilityStore,
            authenticated,
            requestId,
            idempotencyKey,
            transport,
            command: parseRequestInput(
              CreateEventTypeDraftInputSchema,
              rawInput,
            ),
          }),
          201,
        );
      case 'update-draft':
        return json(
          await executeUpdateEventTypeDraftCapability({
            store,
            capabilityStore,
            authenticated,
            requestId,
            idempotencyKey,
            transport,
            command: parseRequestInput(
              UpdateEventTypeDraftInputSchema,
              rawInput,
            ),
          }),
        );
      case 'publish-version':
        return json(
          await executePublishEventTypeVersionCapability({
            store,
            capabilityStore,
            authenticated,
            requestId,
            idempotencyKey,
            transport,
            command: parseRequestInput(
              PublishEventTypeVersionInputSchema,
              rawInput,
            ),
          }),
          201,
        );
      default:
        return errorResponse(
          requestId,
          'VALIDATION_ERROR',
          'The event-type command is not supported.',
          400,
        );
    }
  } catch (error) {
    return handleError(error, requestId);
  }
}
