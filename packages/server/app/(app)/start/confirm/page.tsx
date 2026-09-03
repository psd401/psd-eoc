import { randomUUID } from 'node:crypto';

import {
  EventTypeVersionIdSchema,
  FacilityIdSchema,
  OperatorDetailSchema,
  ThreatIdSchema,
} from '@psd-eoc/contracts';
import Link from 'next/link';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { WEB_CSRF_COOKIE_NAME } from '../../../../lib/auth/sessions';
import { eventTypesForMode, loadOperationalViewData } from '../_lib/data';
import {
  startConfirmationReturnPath,
  startResponseReturnPath,
  startSelectionReturnPath,
} from '../_lib/return-path';
import { requirePageSession } from '../_lib/session';
import {
  ActivationConfirm,
  type ActiveEventChoice,
} from '../components/activation-confirm';
import { Call911Affordance } from '../components/call-911-affordance';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SearchValue = string | readonly string[] | undefined;

interface ConfirmStartPageProps {
  readonly searchParams: Promise<
    Readonly<{
      eventTypeVersionId?: SearchValue;
      facilityId?: SearchValue;
      mode?: SearchValue;
      responseDetail?: SearchValue;
      threatDetail?: SearchValue;
      threatId?: SearchValue;
    }>
  >;
}

function one(value: SearchValue): string | null {
  return typeof value === 'string' ? value : null;
}

export async function generateMetadata({
  searchParams,
}: ConfirmStartPageProps): Promise<Metadata> {
  const mode = one((await searchParams).mode);
  return {
    title:
      mode === 'real'
        ? 'Review REAL incident confirmation'
        : mode === 'drill'
          ? 'Review DRILL confirmation'
          : 'Review event confirmation',
  };
}

export default async function ConfirmStartPage({
  searchParams,
}: ConfirmStartPageProps) {
  const parameters = await searchParams;
  const facilityResult = FacilityIdSchema.safeParse(one(parameters.facilityId));
  const eventTypeVersionResult = EventTypeVersionIdSchema.safeParse(
    one(parameters.eventTypeVersionId),
  );
  const threatResult = ThreatIdSchema.safeParse(one(parameters.threatId));
  const mode = one(parameters.mode);
  if (
    !facilityResult.success ||
    !eventTypeVersionResult.success ||
    !threatResult.success ||
    (mode !== 'real' && mode !== 'drill')
  ) {
    redirect('/');
  }

  // Descriptions are validated by the same contract the server applies; a
  // value that fails it is treated as absent so the operator is sent back to
  // type it rather than shown a confirmation for something the server will
  // refuse.
  const threatDetailResult = OperatorDetailSchema.safeParse(
    one(parameters.threatDetail),
  );
  const responseDetailResult = OperatorDetailSchema.safeParse(
    one(parameters.responseDetail),
  );
  const threatDetailValue = threatDetailResult.success
    ? threatDetailResult.data
    : null;
  const responseDetailValue = responseDetailResult.success
    ? responseDetailResult.data
    : null;

  const returnPath = startConfirmationReturnPath({
    eventTypeVersionId: eventTypeVersionResult.data,
    facilityId: facilityResult.data,
    mode,
    threatId: threatResult.data,
    threatDetail: threatDetailValue,
    responseDetail: responseDetailValue,
  });
  const authenticated = await requirePageSession(returnPath);
  const data = await loadOperationalViewData(authenticated);
  const facility = data.facilities.find(
    (candidate) => candidate.id === facilityResult.data,
  );
  const eventType = eventTypesForMode(data.eventTypes, mode).find(
    (item) => item.latestVersion.id === eventTypeVersionResult.data,
  );
  const threat = data.threats.find(
    (candidate) => candidate.id === threatResult.data,
  );
  if (facility === undefined || eventType === undefined) {
    redirect('/');
  }
  if (threat === undefined) {
    redirect(startSelectionReturnPath({ facilityId: facility.id, mode }));
  }
  if (threat.requiresDetail && threatDetailValue === null) {
    redirect(startSelectionReturnPath({ facilityId: facility.id, mode }));
  }
  const threatDetail = threat.requiresDetail ? threatDetailValue : null;
  const responseHref = startResponseReturnPath({
    facilityId: facility.id,
    mode,
    threatId: threat.id,
    threatDetail,
  });
  if (eventType.eventType.requiresDetail && responseDetailValue === null) {
    redirect(responseHref);
  }
  const responseDetail = eventType.eventType.requiresDetail
    ? responseDetailValue
    : null;

  const activeEvents: readonly ActiveEventChoice[] = data.activeEvents
    .filter(({ event }) => event.facilityId === facility.id)
    .map(({ event, eventTypeName }) => ({
      event,
      label: eventTypeName,
    }));

  return (
    <main className="page-shell start-flow" id="main-content" tabIndex={-1}>
      <nav aria-label="Start-event progress">
        <ol className="step-list">
          <li className="step-list__complete">1. Site and mode chosen</li>
          <li className="step-list__complete">2. Threat chosen</li>
          <li className="step-list__complete">3. Response chosen</li>
          <li aria-current="step">4. Review and confirm</li>
        </ol>
      </nav>

      <header className="page-heading">
        <div className="page-heading__copy">
          <p className="eyebrow">{facility.code}</p>
          <h1>Review and confirm</h1>
          <p className="lede">Check who gets notified, then start the event.</p>
        </div>
        <div className="page-heading__actions">
          <Link
            className="button button--secondary"
            href={startSelectionReturnPath({ facilityId: facility.id, mode })}
          >
            Change threat
          </Link>
          <Link className="button button--secondary" href={responseHref}>
            Change response
          </Link>
        </div>
      </header>

      <Call911Affordance />

      <ActivationConfirm
        activationIdempotencyKey={`activate:${randomUUID()}`}
        activeEvents={activeEvents}
        csrfCookieName={WEB_CSRF_COOKIE_NAME}
        selection={{
          eventKind: mode === 'real' ? 'incident' : 'drill',
          eventTypeName: eventType.latestVersion.name,
          eventTypeVersionId: eventType.latestVersion.id,
          facilityId: facility.id,
          facilityName: facility.name,
          responseDetail,
          templateMode: mode,
          threatDetail,
          threatId: threat.id,
          threatName: threat.name,
        }}
      />
    </main>
  );
}
