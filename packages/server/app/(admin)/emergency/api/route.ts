import {
  AdminFormError,
  authenticateAdminMutation,
  parseIdempotencyKey,
  readAdminForm,
} from '../../facilities/admin-request';
import { SessionAccessError } from '../../../../lib/auth/sessions';
import { CapabilityEngineError } from '../../../../lib/capabilities/engine';
import { executeSetFanoutControlCapability } from '../capabilities';
import { parseEmergencyControlMutation } from '../request';

export const dynamic = 'force-dynamic';

function emergencyFormErrorResponse(error: unknown): Response {
  const status =
    error instanceof AdminFormError
      ? 400
      : error instanceof SessionAccessError ||
          error instanceof CapabilityEngineError
        ? error.status
        : 500;
  const heading =
    status === 403
      ? 'Administrator request denied'
      : status === 401
        ? 'Sign-in required'
        : status < 500
          ? 'Emergency control was not changed'
          : 'Emergency control is unavailable';
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${heading} | PSD EOC</title></head><body><main><h1>${heading}</h1><p role="alert">PSD EOC could not safely complete the emergency-control request.</p><p>No incident, all-clear, event closure, or notification action was performed.</p><p><a href="/emergency">Return to emergency notification control</a></p></main></body></html>`,
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
      },
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await readAdminForm(request);
    const authenticated = await authenticateAdminMutation(request, form);
    const command = parseEmergencyControlMutation(form);
    await executeSetFanoutControlCapability({
      authenticated,
      command,
      metadata: { idempotencyKey: parseIdempotencyKey(form) },
    });
    const redirect = new URL('/emergency', request.url);
    redirect.searchParams.set(
      'status',
      command.desiredMode === 'enabled'
        ? 'fanout-enabled'
        : 'fanout-emergency-disabled',
    );
    return Response.redirect(redirect, 303);
  } catch (error) {
    return emergencyFormErrorResponse(error);
  }
}
