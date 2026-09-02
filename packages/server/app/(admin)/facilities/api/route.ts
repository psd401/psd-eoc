import {
  executeCreateFacilityCapability,
  executeCreateGroupSourceCapability,
  executeSetManualRosterMembersCapability,
  executeCreateNeighborhoodVersionCapability,
  executeUpdateFacilityCapability,
  executeUpdateGroupSourceCapability,
} from '../capabilities';
import {
  AdminFormError,
  adminFormErrorResponse,
  adminSuccessRedirect,
  authenticateAdminMutation,
  parseIdempotencyKey,
  readAdminForm,
} from '../admin-request';
import {
  currentStaffRosterConfiguration,
  publishAfterManualMembersSave,
  publishRosterSnapshotOrExplain,
} from '../roster-publish';
import { resolveGoogleGroupIdForForm } from '../google-group-id';
import { parseFacilitiesAdminMutation } from './request';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await readAdminForm(request);
    const authenticated = await authenticateAdminMutation(request, form);
    const idempotencyKey = parseIdempotencyKey(form);
    const mutation = await parseFacilitiesAdminMutation(form, (email) =>
      resolveGoogleGroupIdForForm(authenticated, email),
    );
    const metadata = { idempotencyKey } as const;

    switch (mutation.intent) {
      case 'create-facility':
        await executeCreateFacilityCapability({
          authenticated,
          command: mutation.command,
          metadata,
        });
        break;
      case 'update-facility':
        await executeUpdateFacilityCapability({
          authenticated,
          command: mutation.command,
          metadata,
        });
        break;
      case 'create-google-building-group':
      case 'create-google-others-group':
      case 'create-manual-building-group':
      case 'create-manual-others-group':
      case 'create-synthetic-building-group':
      case 'create-synthetic-others-group':
        await executeCreateGroupSourceCapability({
          authenticated,
          command: mutation.command,
          metadata,
        });
        break;
      case 'replace-google-building-group':
      case 'replace-google-others-group':
      case 'replace-synthetic-building-group':
      case 'replace-synthetic-others-group':
        await executeUpdateGroupSourceCapability({
          authenticated,
          command: mutation.command,
          metadata,
        });
        break;
      case 'publish-roster-snapshot': {
        const sourceConfiguration = await currentStaffRosterConfiguration();
        if (sourceConfiguration === null) {
          throw new AdminFormError(
            'Add a building source before publishing a roster snapshot.',
          );
        }
        await publishRosterSnapshotOrExplain({
          authenticated,
          sourceConfiguration,
          idempotencyKey,
        });
        break;
      }
      case 'set-manual-roster-members':
        await executeSetManualRosterMembersCapability({
          authenticated,
          command: mutation.command,
          metadata,
        });
        // Saving is the publish. The save has committed by now; a refused
        // publication reports that the people were saved and why the roster
        // did not publish, rather than redirecting as a success.
        await publishAfterManualMembersSave({ authenticated, idempotencyKey });
        return adminSuccessRedirect(
          request,
          '/facilities',
          'manual-members-published',
        );
      case 'create-neighborhood-version':
        await executeCreateNeighborhoodVersionCapability({
          authenticated,
          command: mutation.command,
          metadata,
        });
        break;
    }
    return adminSuccessRedirect(request, '/facilities', mutation.status);
  } catch (error) {
    return adminFormErrorResponse(error, '/facilities');
  }
}
