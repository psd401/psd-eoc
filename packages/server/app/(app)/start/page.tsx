import { FacilityIdSchema } from '@psd-eoc/contracts';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { eventTypesForMode, loadOperationalViewData } from './_lib/data';
import { requirePageSession } from './_lib/session';
import { Call911Affordance } from './components/call-911-affordance';
import { ClassificationBanner } from './components/classification-banner';
import { ClassificationIcon } from './components/classification-icon';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SearchValue = string | readonly string[] | undefined;

function one(value: SearchValue): string | null {
  return typeof value === 'string' ? value : null;
}

export default async function SelectEventTypePage({
  searchParams,
}: Readonly<{
  searchParams: Promise<
    Readonly<{ facilityId?: SearchValue; mode?: SearchValue }>
  >;
}>) {
  const parameters = await searchParams;
  const facilityResult = FacilityIdSchema.safeParse(one(parameters.facilityId));
  const mode = one(parameters.mode);
  if (!facilityResult.success || (mode !== 'real' && mode !== 'drill')) {
    redirect('/');
  }

  const authenticated = await requirePageSession('/start');
  const data = await loadOperationalViewData(authenticated);
  const facility = data.facilities.find(
    (candidate) => candidate.id === facilityResult.data,
  );
  if (facility === undefined) {
    redirect('/');
  }
  const eventTypes = eventTypesForMode(data.eventTypes, mode);
  const otherMode = mode === 'real' ? 'drill' : 'real';

  return (
    <main className="page-shell start-flow" id="main-content" tabIndex={-1}>
      <nav aria-label="Start-event progress">
        <ol className="step-list">
          <li className="step-list__complete">1. Site and mode chosen</li>
          <li aria-current="step">2. Choose event type</li>
          <li>3. Review and confirm</li>
        </ol>
      </nav>

      <header className="page-heading">
        <div>
          <p className="eyebrow">{facility.code}</p>
          <h1>Choose event type</h1>
          <p className="lede">{facility.name}</p>
        </div>
        <Link className="button button--secondary" href="/">
          Change site
        </Link>
      </header>

      <ClassificationBanner
        mode={mode}
        detail={
          mode === 'real'
            ? 'This path is for an actual emergency. The confirmation step can notify staff.'
            : 'This path is training only. Every screen and message remains marked DRILL.'
        }
      />

      <Call911Affordance />

      <nav className="mode-switch" aria-label="Event mode">
        <Link
          aria-current={mode === 'real' ? 'page' : undefined}
          className="mode-switch__real"
          href={`/start?facilityId=${facility.id}&mode=real`}
        >
          <ClassificationIcon mode="real" /> REAL incident
        </Link>
        <Link
          aria-current={mode === 'drill' ? 'page' : undefined}
          className="mode-switch__drill"
          href={`/start?facilityId=${facility.id}&mode=drill`}
        >
          <ClassificationIcon mode="drill" /> DRILL — training only
        </Link>
      </nav>
      <p className="supporting-text">
        Switching to {otherMode === 'real' ? 'REAL incident' : 'DRILL'} mode
        restarts the type choice and does not start an event.
      </p>

      <section aria-labelledby="event-type-heading">
        <h2 id="event-type-heading">
          {mode === 'real' ? 'Real incident types' : 'Drill types'}
        </h2>
        {eventTypes.length === 0 ? (
          <div className="error-summary" role="alert">
            <h3>No enabled event types</h3>
            <p>
              No event was started. Contact a PSD EOC administrator before
              continuing.
            </p>
          </div>
        ) : (
          <div className="choice-grid">
            {eventTypes.map((item) => (
              <Link
                className={`choice-card ${
                  mode === 'real' ? 'choice-card--real' : 'choice-card--drill'
                }`}
                href={`/start/confirm?facilityId=${facility.id}&mode=${mode}&eventTypeVersionId=${item.latestVersion.id}`}
                key={item.eventType.id}
              >
                <span className="choice-card__icon" aria-hidden="true">
                  <ClassificationIcon mode={mode} />
                </span>
                <span>
                  <strong>{item.latestVersion.name}</strong>
                  {item.latestVersion.description === null ? null : (
                    <small>{item.latestVersion.description}</small>
                  )}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
