import { FacilityIdSchema } from '@psd-eoc/contracts';
import Link from 'next/link';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { eventTypesForMode, loadOperationalViewData } from './_lib/data';
import {
  startConfirmationReturnPath,
  startSelectionReturnPath,
} from './_lib/return-path';
import { requirePageSession } from './_lib/session';
import { Call911Affordance } from './components/call-911-affordance';
import { ClassificationBanner } from './components/classification-banner';
import { ClassificationIcon } from './components/classification-icon';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SearchValue = string | readonly string[] | undefined;

interface SelectEventTypePageProps {
  readonly searchParams: Promise<
    Readonly<{ facilityId?: SearchValue; mode?: SearchValue }>
  >;
}

function one(value: SearchValue): string | null {
  return typeof value === 'string' ? value : null;
}

async function StartFacilityPage() {
  const authenticated = await requirePageSession('/start');
  const data = await loadOperationalViewData(authenticated);

  return (
    <main className="page-shell start-flow" id="main-content" tabIndex={-1}>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Staff emergency operations</p>
          <h1>Start an event</h1>
          <p className="lede">
            Choose a site and whether this is a real incident or a drill.
            Choosing here does not start an event or notify anyone.
          </p>
        </div>
        <Link className="button button--secondary" href="/">
          Return to active events
        </Link>
      </header>

      <Call911Affordance />

      <section aria-labelledby="start-site-heading">
        <div className="section-heading">
          <h2 id="start-site-heading">Choose site and mode</h2>
          <span className="step-hint">Step 1 of 3</span>
        </div>
        <div className="dashboard-grid">
          {data.facilities.map((facility) => (
            <article className="facility-card" key={facility.id}>
              <p className="facility-code">{facility.code}</p>
              <h3>{facility.name}</h3>
              <div className="action-grid">
                <a
                  aria-label={`Start REAL incident at ${facility.name}`}
                  className="action-link action-link--real"
                  href={startSelectionReturnPath({
                    facilityId: facility.id,
                    mode: 'real',
                  })}
                >
                  <ClassificationIcon mode="real" />
                  <span>
                    Start <strong>REAL incident</strong>
                  </span>
                </a>
                <a
                  aria-label={`Run DRILL at ${facility.name}`}
                  className="action-link action-link--drill"
                  href={startSelectionReturnPath({
                    facilityId: facility.id,
                    mode: 'drill',
                  })}
                >
                  <ClassificationIcon mode="drill" />
                  <span>
                    Run <strong>DRILL</strong>
                  </span>
                </a>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export async function generateMetadata({
  searchParams,
}: SelectEventTypePageProps): Promise<Metadata> {
  const parameters = await searchParams;
  const facilityId = one(parameters.facilityId);
  const mode = one(parameters.mode);
  return {
    title:
      facilityId === null && mode === null
        ? 'Start an event'
        : mode === 'real'
          ? 'Choose REAL incident type'
          : mode === 'drill'
            ? 'Choose DRILL type'
            : 'Choose event type',
  };
}

export default async function SelectEventTypePage({
  searchParams,
}: SelectEventTypePageProps) {
  const parameters = await searchParams;
  const facilityValue = one(parameters.facilityId);
  const mode = one(parameters.mode);
  if (facilityValue === null && mode === null) {
    return <StartFacilityPage />;
  }
  const facilityResult = FacilityIdSchema.safeParse(facilityValue);
  if (!facilityResult.success || (mode !== 'real' && mode !== 'drill')) {
    redirect('/start');
  }

  const returnPath = startSelectionReturnPath({
    facilityId: facilityResult.data,
    mode,
  });
  const authenticated = await requirePageSession(returnPath);
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
          href={startSelectionReturnPath({
            facilityId: facility.id,
            mode: 'real',
          })}
        >
          <ClassificationIcon mode="real" /> REAL incident
        </Link>
        <Link
          aria-current={mode === 'drill' ? 'page' : undefined}
          className="mode-switch__drill"
          href={startSelectionReturnPath({
            facilityId: facility.id,
            mode: 'drill',
          })}
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
                href={startConfirmationReturnPath({
                  eventTypeVersionId: item.latestVersion.id,
                  facilityId: facility.id,
                  mode,
                })}
                key={item.eventType.id}
              >
                <span className="choice-card__icon" aria-hidden="true">
                  <ClassificationIcon mode={mode} />
                </span>
                <span className="choice-card__copy">
                  <strong className="choice-card__label">
                    {item.latestVersion.name}
                  </strong>
                  {item.latestVersion.description === null ? null : (
                    <>
                      {' '}
                      <small className="choice-card__detail">
                        {item.latestVersion.description}
                      </small>
                    </>
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
