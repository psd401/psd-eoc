import { randomUUID } from 'node:crypto';

import {
  EventIdSchema,
  ExportEventSummaryInputSchema,
} from '@psd-eoc/contracts';
import { notFound } from 'next/navigation';

import { resolveHumanCapabilityInvocation } from '../../../../../../lib/capabilities/engine';
import { getDefaultRecordsCapabilityRuntime } from '../../../../../../lib/capabilities/records';
import {
  authenticateRecordsExportRequest,
  eventSummaryRedirect,
  exactExportQuery,
  recordsExportFailure,
} from '../../_lib/http';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface EventSummaryRouteContext {
  readonly params: Promise<Readonly<{ id: string }>>;
}

export async function GET(
  request: Request,
  context: EventSummaryRouteContext,
): Promise<Response> {
  const serverTime = new Date();
  const authentication = await authenticateRecordsExportRequest(
    request,
    serverTime,
  );
  if (authentication.response !== null) {
    return authentication.response;
  }

  const { id } = await context.params;
  const parsedEventId = EventIdSchema.safeParse(id);
  if (!parsedEventId.success) {
    notFound();
  }

  try {
    exactExportQuery(request, []);
    const input = ExportEventSummaryInputSchema.parse({
      eventId: parsedEventId.data,
      format: 'pdf',
    });
    const result = await getDefaultRecordsCapabilityRuntime().execute(
      'export-event-summary',
      input,
      resolveHumanCapabilityInvocation(authentication.authenticated, {
        requestId: randomUUID(),
        serverTime,
        mutation: null,
      }),
    );
    return eventSummaryRedirect(result, parsedEventId.data, new Date());
  } catch (error) {
    return recordsExportFailure(error);
  }
}
