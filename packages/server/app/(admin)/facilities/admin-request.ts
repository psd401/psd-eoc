import { IdempotencyKeySchema } from '@psd-eoc/contracts';
import { ZodError } from 'zod';

import { authenticateSessionRequest } from '../../../lib/auth/middleware';
import {
  SessionAccessError,
  getDefaultSessionService,
  type AuthenticatedSession,
} from '../../../lib/auth/sessions';
import { CapabilityEngineError } from '../../../lib/capabilities/engine';
import { AdminCapabilityError } from './admin-core';

const MAX_ADMIN_FORM_BYTES = 64 * 1024;

export class AdminFormError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AdminFormError';
  }
}

/** Strict URL-encoded form wrapper that rejects unexpected or repeated fields. */
export class AdminForm {
  public constructor(private readonly parameters: URLSearchParams) {}

  public assertFields(
    allowed: readonly string[],
    repeated: readonly string[] = [],
  ): void {
    const allowedSet = new Set(allowed);
    const repeatedSet = new Set(repeated);
    const counts = new Map<string, number>();
    for (const [name] of this.parameters) {
      if (!allowedSet.has(name)) {
        throw new AdminFormError('The administration form is invalid.');
      }
      const count = (counts.get(name) ?? 0) + 1;
      counts.set(name, count);
      if (count > 1 && !repeatedSet.has(name)) {
        throw new AdminFormError('The administration form is invalid.');
      }
    }
  }

  public required(name: string): string {
    const values = this.parameters.getAll(name);
    const value = values[0];
    if (
      values.length !== 1 ||
      value === undefined ||
      value.trim().length === 0
    ) {
      throw new AdminFormError('Complete every required field and try again.');
    }
    return value;
  }

  public optional(name: string): string | null {
    const values = this.parameters.getAll(name);
    if (values.length > 1) {
      throw new AdminFormError('The administration form is invalid.');
    }
    const value = values[0]?.trim() ?? '';
    return value.length === 0 ? null : value;
  }

  public all(name: string): readonly string[] {
    return Object.freeze(
      this.parameters
        .getAll(name)
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
  }
}

/** Reads the actual request stream with a hard cap; Content-Length is advisory. */
export async function readAdminForm(request: Request): Promise<AdminForm> {
  const contentType = request.headers.get('content-type') ?? '';
  if (
    contentType.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/x-www-form-urlencoded'
  ) {
    throw new AdminFormError(
      'The administration form must use URL-encoded data.',
    );
  }
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_ADMIN_FORM_BYTES
    ) {
      throw new AdminFormError('The administration form is too large.');
    }
  }
  if (request.body === null) {
    throw new AdminFormError('The administration form is empty.');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_ADMIN_FORM_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AdminFormError('The administration form is too large.');
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AdminFormError('The administration form is not valid UTF-8.');
  }
  return new AdminForm(new URLSearchParams(text));
}

/** Verifies the double-submit token before resolving the server-owned session. */
export async function authenticateAdminMutation(
  request: Request,
  form: AdminForm,
): Promise<AuthenticatedSession> {
  const headers = new Headers(request.headers);
  headers.set('x-psd-eoc-csrf', form.required('csrfToken'));
  const authenticationRequest = new Request(request.url, {
    method: 'POST',
    headers,
  });
  return authenticateSessionRequest(
    authenticationRequest,
    getDefaultSessionService(),
    { mutation: true },
  );
}

export function parseIdempotencyKey(form: AdminForm): string {
  return IdempotencyKeySchema.parse(form.required('idempotencyKey'));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}

function errorDetails(error: unknown): Readonly<{
  status: number;
  heading: string;
  message: string;
}> {
  if (error instanceof AdminFormError || error instanceof ZodError) {
    return {
      status: 400,
      heading: 'Review the administration form',
      message:
        error instanceof AdminFormError
          ? error.message
          : 'One or more submitted values are invalid.',
    };
  }
  if (error instanceof SessionAccessError) {
    return {
      status: error.status,
      heading:
        error.status === 403
          ? 'Administrator request denied'
          : 'Sign-in required',
      message:
        error.status === 403
          ? 'The authenticated session is not permitted to make this change.'
          : 'A current PSD EOC session is required.',
    };
  }
  if (error instanceof AdminCapabilityError) {
    return {
      status: error.status,
      heading:
        error.status === 403
          ? 'Administrator request denied'
          : 'Configuration was not changed',
      message: error.message,
    };
  }
  if (error instanceof CapabilityEngineError) {
    return {
      status: error.status,
      heading:
        error.status === 403
          ? 'Administrator request denied'
          : error.status === 409
            ? 'Configuration was not changed'
            : 'Review the administration request',
      message: error.message,
    };
  }
  return {
    status: 500,
    heading: 'Configuration was not changed',
    message: 'PSD EOC could not safely complete the administration request.',
  };
}

/** Accessible, cache-disabled error document for native form submissions. */
export function adminFormErrorResponse(
  error: unknown,
  returnPath: '/access' | '/facilities' | '/integrations',
): Response {
  const details = errorDetails(error);
  const heading = escapeHtml(details.heading);
  const message = escapeHtml(details.message);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${heading} | PSD EOC</title></head><body><main><h1>${heading}</h1><p role="alert">${message}</p><p>No incident or notification action was performed.</p><p><a href="${returnPath}">Return to administration</a></p></main></body></html>`,
    {
      status: details.status,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
      },
    },
  );
}

export function adminSuccessRedirect(
  request: Request,
  path: '/access' | '/facilities' | '/integrations',
  status: string,
): Response {
  const url = new URL(path, request.url);
  url.searchParams.set('status', status);
  return Response.redirect(url, 303);
}
