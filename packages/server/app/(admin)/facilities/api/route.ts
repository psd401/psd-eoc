import {
  executeCreateFacilityCapability,
  executeCreateGroupSourceCapability,
  executeSetManualRosterMembersCapability,
  executeCreateNeighborhoodVersionCapability,
  executeUpdateFacilityCapability,
  executeUpdateGroupSourceCapability,
  listFacilitiesWithoutGoogleBuildingSource,
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
import {
  resolveGoogleGroupIdForForm,
  resolveGoogleGroupIdOrWaitingForForm,
} from '../google-group-id';
import { parseFacilitiesAdminMutation } from './request';
import { checkWaitingGroups } from '../waiting-groups-check';
import {
  CONVENTION_ACTION_LABEL,
  registerConventionBuildingGroups,
} from '../convention-registration';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await readAdminForm(request);
    const authenticated = await authenticateAdminMutation(request, form);
    const idempotencyKey = parseIdempotencyKey(form);
    const mutation = await parseFacilitiesAdminMutation(form, {
      resolve: (email) => resolveGoogleGroupIdForForm(authenticated, email),
      resolveOrWaiting: (email) =>
        resolveGoogleGroupIdOrWaitingForForm(authenticated, email),
    });
    const metadata = { idempotencyKey } as const;

    switch (mutation.intent) {
      case 'create-facility': {
        const facility = await executeCreateFacilityCapability({
          authenticated,
          command: mutation.command,
          metadata,
        });
        // A new school gets its convention building group at once, waiting
        // if Google does not hold it yet, so nobody has to remember to add it.
        // The school is committed before this step: when the step fails, the
        // page says the school exists and how to register its group.
        try {
          await registerConventionBuildingGroups({
            authenticated,
            facilities: [facility],
            idempotencyKey,
          });
        } catch (error) {
          if (error instanceof AdminFormError) {
            throw new AdminFormError(
              `The school ${facility.code} was created, but its building group was not registered: ${error.message} Press "${CONVENTION_ACTION_LABEL}" to register it.`,
            );
          }
          throw error;
        }
        break;
      }
      case 'register-building-groups-by-convention': {
        await registerConventionBuildingGroups({
          authenticated,
          facilities: await listFacilitiesWithoutGoogleBuildingSource(),
          idempotencyKey,
        });
        const sourceConfiguration = await currentStaffRosterConfiguration();
        if (sourceConfiguration === null) {
          throw new AdminFormError(
            'No school has a building source, so there is no roster to publish.',
          );
        }
        await publishRosterSnapshotOrExplain({
          authenticated,
          sourceConfiguration,
          idempotencyKey,
        });
        break;
      }
      case 'check-waiting-groups': {
        const check = await checkWaitingGroups({ authenticated });
        if (check.held.length === 0 && check.stillWaiting.length === 0) {
          return adminSuccessRedirect(
            request,
            '/facilities',
            'waiting-groups-none',
          );
        }
        return adminSuccessRedirect(
          request,
          '/facilities',
          check.held.length === 0
            ? 'waiting-groups-still-waiting'
            : 'waiting-groups-held',
        );
      }
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
