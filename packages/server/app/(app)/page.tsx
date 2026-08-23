import { WEB_CSRF_COOKIE_NAME } from '../../lib/auth/sessions';
import type { Metadata } from 'next';
import Link from 'next/link';
import { loadOperationalViewData } from './start/_lib/data';
import { startSelectionReturnPath } from './start/_lib/return-path';
import { requirePageSession } from './start/_lib/session';
import { Call911Affordance } from './start/components/call-911-affordance';
import { ClassificationIcon } from './start/components/classification-icon';
import { JoinEventButton } from './start/components/join-event-button';
import './start/styles.css';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = {
  title: { absolute: 'Active events | PSD EOC' },
};

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  dateStyle: 'medium',
  timeStyle: 'short',
});

export default async function DashboardPage() {
  const authenticated = await requirePageSession('/');
  const data = await loadOperationalViewData(authenticated);

  return (
    <main className="page-shell" id="main-content" tabIndex={-1}>
      <header className="page-heading">
        <div>
          <p className="eyebrow">Staff emergency operations</p>
          <h1>Active events</h1>
          <p className="lede">
            Join an event already underway, or choose a facility below to start
            a separate incident or drill.
          </p>
        </div>
        <Link className="button button--secondary" href="/records">
          View drill records
        </Link>
      </header>

      <Call911Affordance />

      <section aria-labelledby="active-events-heading">
        <div className="section-heading">
          <h2 id="active-events-heading">Current active events</h2>
          <span className="count-badge">{data.activeEvents.length}</span>
        </div>
        {data.activeEvents.length === 0 ? (
          <p className="status-message" role="status">
            No events are active in your authorized facilities.
          </p>
        ) : (
          <ul className="event-list">
            {data.activeEvents.map(({ event, eventTypeName, facilityName }) => {
              const real = event.templateMode === 'real';
              const joinLabel = `${
                real ? 'REAL INCIDENT' : 'DRILL — TRAINING ONLY'
              } — ${eventTypeName} at ${facilityName} — started ${DATE_FORMATTER.format(
                new Date(event.activatedAt ?? event.createdAt),
              )} — event ${event.id.slice(-8)}`;
              return (
                <li
                  className={`event-card ${
                    real ? 'event-card--real' : 'event-card--drill'
                  }`}
                  key={event.id}
                >
                  <p
                    className={`classification-label ${
                      real
                        ? 'classification-label--real'
                        : 'classification-label--drill'
                    }`}
                  >
                    <ClassificationIcon mode={event.templateMode} />{' '}
                    {real ? 'REAL INCIDENT' : 'DRILL — TRAINING ONLY'}
                  </p>
                  <h3>{eventTypeName}</h3>
                  <p>
                    <strong>{facilityName}</strong>
                    <br />
                    Started{' '}
                    <time dateTime={event.activatedAt ?? event.createdAt}>
                      {DATE_FORMATTER.format(
                        new Date(event.activatedAt ?? event.createdAt),
                      )}
                    </time>
                  </p>
                  <JoinEventButton
                    csrfCookieName={WEB_CSRF_COOKIE_NAME}
                    event={event}
                    label={joinLabel}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="start-event-heading">
        <div className="section-heading">
          <h2 id="start-event-heading">Start an event</h2>
          <span className="step-hint">First choose site and mode</span>
        </div>
        <p>
          Every action below is an explicit choice. Selecting a site does not
          start an event or notify anyone.
        </p>
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
