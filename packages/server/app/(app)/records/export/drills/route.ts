import { randomUUID } from 'node:crypto';

import { resolveHumanCapabilityInvocation } from '../../../../../lib/capabilities/engine';
import { getDefaultRecordsCapabilityRuntime } from '../../../../../lib/capabilities/records';
import {
  authenticateRecordsExportRequest,
  drillExportRedirect,
  parseDrillExportInput,
  recordsExportFailure,
} from '../_lib/http';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request): Promise<Response> {
  const serverTime = new Date();
  const authentication = await authenticateRecordsExportRequest(
    request,
    serverTime,
  );
  if (authentication.response !== null) {
    return authentication.response;
  }

  try {
    const input = parseDrillExportInput(request);
    const result = await getDefaultRecordsCapabilityRuntime().execute(
      'export-drill-records',
      input,
      resolveHumanCapabilityInvocation(authentication.authenticated, {
        requestId: randomUUID(),
        serverTime,
        mutation: null,
      }),
    );
    return drillExportRedirect(result, new Date());
  } catch (error) {
    return recordsExportFailure(error);
  }
}
