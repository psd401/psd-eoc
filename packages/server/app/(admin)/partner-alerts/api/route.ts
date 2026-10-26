import {
  AdminFormError,
  adminFormErrorResponse,
  adminSuccessRedirect,
  authenticateAdminMutation,
  parseIdempotencyKey,
  readAdminForm,
} from '../../facilities/admin-request';
import { executeSetPartnerAlertSettingsCapability } from '../capabilities';
import { parsePartnerAlertSettingsForm } from './request';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await readAdminForm(request);
    const authenticated = await authenticateAdminMutation(request, form);
    if (form.required('intent') !== 'set-partner-alert-settings') {
      throw new AdminFormError(
        'The partner alert administration action is invalid.',
      );
    }
    const command = parsePartnerAlertSettingsForm(form);
    await executeSetPartnerAlertSettingsCapability({
      authenticated,
      command,
      metadata: { idempotencyKey: parseIdempotencyKey(form) },
    });
    return adminSuccessRedirect(request, '/partner-alerts', 'settings-saved');
  } catch (error) {
    return adminFormErrorResponse(error, '/partner-alerts');
  }
}
