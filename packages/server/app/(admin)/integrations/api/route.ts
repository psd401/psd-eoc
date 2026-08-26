import {
  SetChannelEnabledInputSchema,
  VerifyEmailIntegrationInputSchema,
} from '@psd-eoc/contracts';

import {
  AdminFormError,
  adminFormErrorResponse,
  adminSuccessRedirect,
  authenticateAdminMutation,
  parseIdempotencyKey,
  readAdminForm,
} from '../../facilities/admin-request';
import {
  executeSetChannelEnabledCapability,
  executeVerifyEmailIntegrationCapability,
} from '../capabilities';

export const dynamic = 'force-dynamic';

function parseEnabled(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new AdminFormError('The requested channel state is invalid.');
}

function parseAuthorization(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new AdminFormError(
      'The live channel authorization artifact is not valid JSON.',
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await readAdminForm(request);
    const authenticated = await authenticateAdminMutation(request, form);
    form.assertFields([
      'csrfToken',
      'idempotencyKey',
      'intent',
      'integrationId',
      'enabled',
      'authorization',
      'verificationReference',
    ]);
    const intent = form.required('intent');
    if (intent === 'verify-email-integration') {
      await executeVerifyEmailIntegrationCapability({
        authenticated,
        command: VerifyEmailIntegrationInputSchema.parse({
          integrationId: form.required('integrationId'),
        }),
        metadata: { idempotencyKey: parseIdempotencyKey(form) },
      });
      return adminSuccessRedirect(request, '/integrations', 'email-verified');
    }
    if (intent !== 'set-channel-enabled') {
      throw new AdminFormError(
        'The integration administration action is invalid.',
      );
    }
    const command = SetChannelEnabledInputSchema.parse({
      integrationId: form.required('integrationId'),
      enabled: parseEnabled(form.required('enabled')),
      authorization: parseAuthorization(form.optional('authorization')),
      verificationReference:
        form.optional('verificationReference') ?? undefined,
    });
    await executeSetChannelEnabledCapability({
      authenticated,
      command,
      metadata: { idempotencyKey: parseIdempotencyKey(form) },
    });
    return adminSuccessRedirect(request, '/integrations', 'channel-updated');
  } catch (error) {
    return adminFormErrorResponse(error, '/integrations');
  }
}
