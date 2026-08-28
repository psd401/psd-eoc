import {
  executeCreateFacilityCapability,
  executeCreateGroupSourceCapability,
  executeSetManualRosterMembersCapability,
  executeCreateNeighborhoodVersionCapability,
  executeUpdateFacilityCapability,
  executeUpdateGroupSourceCapability,
} from '../capabilities';
import {
  adminFormErrorResponse,
  adminSuccessRedirect,
  authenticateAdminMutation,
  parseIdempotencyKey,
  readAdminForm,
} from '../admin-request';
import { parseFacilitiesAdminMutation } from './request';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await readAdminForm(request);
    const authenticated = await authenticateAdminMutation(request, form);
    const idempotencyKey = parseIdempotencyKey(form);
    const mutation = parseFacilitiesAdminMutation(form);
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
      case 'set-manual-roster-members':
        await executeSetManualRosterMembersCapability({
          authenticated,
          command: mutation.command,
          metadata,
        });
        break;
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
