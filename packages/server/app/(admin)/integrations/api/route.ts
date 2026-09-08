import { SetChannelEnabledInputSchema } from '@psd-eoc/contracts';

import {
  AdminFormError,
  adminFormErrorResponse,
  adminSuccessRedirect,
  authenticateAdminMutation,
  parseIdempotencyKey,
  readAdminForm,
} from '../../facilities/admin-request';
import { executeSetChannelEnabledCapability } from '../capabilities';

export const dynamic = 'force-dynamic';

function parseEnabled(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new AdminFormError('The requested channel state is invalid.');
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
    ]);
    if (form.required('intent') !== 'set-channel-enabled') {
      throw new AdminFormError(
        'The integration administration action is invalid.',
      );
    }
    const command = SetChannelEnabledInputSchema.parse({
      integrationId: form.required('integrationId'),
      enabled: parseEnabled(form.required('enabled')),
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
