import { randomUUID } from 'node:crypto';

import { EventTypeVersionIdSchema, FacilityIdSchema } from '@psd-eoc/contracts';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { WEB_CSRF_COOKIE_NAME } from '../../../../lib/auth/sessions';
import { eventTypesForMode, loadOperationalViewData } from '../_lib/data';
import {
  startConfirmationReturnPath,
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

function one(value: SearchValue): string | null {
  return typeof value === 'string' ? value : null;
}

export default async function ConfirmStartPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<
    Readonly<{
      eventTypeVersionId?: SearchValue;
      facilityId?: SearchValue;
      mode?: SearchValue;
    }>
  >;
}>) {
  const parameters = await searchParams;
  const facilityResult = FacilityIdSchema.safeParse(one(parameters.facilityId));
  const eventTypeVersionResult = EventTypeVersionIdSchema.safeParse(
    one(parameters.eventTypeVersionId),
  );
  const mode = one(parameters.mode);
  if (
    !facilityResult.success ||
    !eventTypeVersionResult.success ||
    (mode !== 'real' && mode !== 'drill')
  ) {
    redirect('/');
  }

  const returnPath = startConfirmationReturnPath({
    eventTypeVersionId: eventTypeVersionResult.data,
    facilityId: facilityResult.data,
    mode,
  });
  const authenticated = await requirePageSession(returnPath);
  const data = await loadOperationalViewData(authenticated);
  const facility = data.facilities.find(
    (candidate) => candidate.id === facilityResult.data,
  );
  const eventType = eventTypesForMode(data.eventTypes, mode).find(
    (item) => item.latestVersion.id === eventTypeVersionResult.data,
  );
  if (facility === undefined || eventType === undefined) {
    redirect('/');
  }

  const activeEvents: readonly ActiveEventChoice[] = data.activeEvents
    .filter(({ event }) => event.facilityId === facility.id)
    .map(({ event, eventTypeName }) => ({
      event,
      label: eventTypeName,
    }));
  const selectionHref = startSelectionReturnPath({
    facilityId: facility.id,
    mode,
  });

  return (
    <main className="page-shell start-flow" id="main-content" tabIndex={-1}>
      <nav aria-label="Start-event progress">
        <ol className="step-list">
          <li className="step-list__complete">1. Site and mode chosen</li>
          <li className="step-list__complete">2. Event type chosen</li>
          <li aria-current="step">3. Review and confirm</li>
        </ol>
      </nav>

      <header className="page-heading">
        <div className="page-heading__copy">
          <p className="eyebrow">{facility.code}</p>
          <h1>Review and confirm</h1>
          <p className="lede">
            Review the current roster snapshot and every notification channel
            before making the final human decision.
          </p>
        </div>
        <Link className="button button--secondary" href={selectionHref}>
          Change event type
        </Link>
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
          templateMode: mode,
        }}
      />
    </main>
  );
}
