import {
  CreateGroupSourceInputSchema,
  UpdateGroupSourceInputSchema,
} from '@psd-eoc/contracts';

import {
  executeCreateGroupSourceCapability,
  executeUpdateGroupSourceCapability,
} from '../../facilities/capabilities';
import {
  adminFormErrorResponse,
  adminSuccessRedirect,
  AdminFormError,
  authenticateAdminMutation,
  parseIdempotencyKey,
  readAdminForm,
} from '../../facilities/admin-request';
import { resolveGoogleGroupIdForForm } from '../../facilities/google-group-id';

export const dynamic = 'force-dynamic';

const COMMON_FIELDS = ['csrfToken', 'idempotencyKey', 'intent'] as const;

function parseActive(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new AdminFormError('The group status is invalid.');
}

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await readAdminForm(request);
    const authenticated = await authenticateAdminMutation(request, form);
    const idempotencyKey = parseIdempotencyKey(form);
    const intent = form.required('intent');

    switch (intent) {
      case 'create-access-group': {
        form.assertFields([
          ...COMMON_FIELDS,
          'displayName',
          'email',
          'grantedRole',
        ]);
        // The role is the whole point of an access group: every member of it
        // receives exactly this. The contract requires it, and without this
        // field the form could never create a second group. The Google Group
        // ID is not the form's to supply: Google resolves it from the address.
        const email = form.required('email');
        const command = CreateGroupSourceInputSchema.parse({
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
          displayName: form.required('displayName'),
          active: true,
          grantedRole: form.required('grantedRole'),
          googleGroupId: await resolveGoogleGroupIdForForm(email),
          email,
        });
        await executeCreateGroupSourceCapability({
          authenticated,
          command,
          metadata: { idempotencyKey },
        });
        return adminSuccessRedirect(request, '/access', 'access-group-created');
      }
      case 'update-access-group': {
        form.assertFields([
          ...COMMON_FIELDS,
          'id',
          'displayName',
          'email',
          'active',
          'grantedRole',
        ]);
        const email = form.required('email');
        const command = UpdateGroupSourceInputSchema.parse({
          id: form.required('id'),
          kind: 'google-group',
          purpose: 'access',
          facilityId: null,
          displayName: form.required('displayName'),
          active: parseActive(form.required('active')),
          grantedRole: form.required('grantedRole'),
          googleGroupId: await resolveGoogleGroupIdForForm(email),
          email,
        });
        await executeUpdateGroupSourceCapability({
          authenticated,
          command,
          metadata: { idempotencyKey },
        });
        return adminSuccessRedirect(request, '/access', 'access-group-updated');
      }
      default:
        throw new AdminFormError(
          'The access administration action is invalid.',
        );
    }
  } catch (error) {
    return adminFormErrorResponse(error, '/access');
  }
}
