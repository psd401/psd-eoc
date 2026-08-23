import type { AdminReadiness, AdminReadinessStatus } from '@psd-eoc/contracts';

import { AdminNavigation } from '../facilities/admin-nav';

function statusLabel(status: AdminReadinessStatus): string {
  switch (status) {
    case 'ready':
      return 'Ready';
    case 'action-required':
      return 'Action required';
    case 'unavailable':
      return 'Unable to verify';
  }
}

const timestampFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

function Timestamp({ value }: Readonly<{ value: string | null }>) {
  return value === null ? (
    <>Never</>
  ) : (
    <time dateTime={value} title={value}>
      {timestampFormatter.format(new Date(value))}
    </time>
  );
}

function accessStateLabel(state: 'fresh' | 'never-read' | 'stale'): string {
  switch (state) {
    case 'fresh':
      return 'Fresh';
    case 'never-read':
      return 'Never read';
    case 'stale':
      return 'Stale';
  }
}

function rosterOutcomeLabel(
  outcome: AdminReadiness['roster']['latestAttemptOutcome'],
): string {
  switch (outcome) {
    case null:
      return 'No attempt recorded';
    case 'complete':
      return 'Complete';
    case 'failed':
      return 'Failed';
    case 'partial-rejected':
      return 'Partially rejected';
  }
}

function ReadinessHeader({
  readiness,
}: Readonly<{ readiness: AdminReadiness }>) {
  const summary =
    readiness.overallStatus === 'ready'
      ? 'Ready for a first drill'
      : readiness.overallStatus === 'action-required'
        ? 'Action required before a first drill'
        : 'Some readiness checks are unavailable';
  return (
    <header>
      <p className="eyebrow">Administration</p>
      <h1 id="admin-readiness-heading">Deployment readiness</h1>
      <p className="lede">
        See whether first-run configuration exists and whether recurring syncs
        are still fresh. Observed <Timestamp value={readiness.observedAt} />.
      </p>
      <p
        className={`readiness-summary readiness-status--${readiness.overallStatus}`}
        role="status"
      >
        <strong>{summary}</strong>
      </p>
      <p className="muted">
        This page does not start or change an event and does not send a
        notification.
      </p>
    </header>
  );
}

function AccessReadiness({
  readiness,
}: Readonly<{ readiness: AdminReadiness }>) {
  const access = readiness.accessMembership;
  return (
    <section aria-labelledby="access-readiness-heading">
      <div className="readiness-section-heading">
        <h2 id="access-readiness-heading">Access membership</h2>
        <strong
          className={`readiness-badge readiness-status--${access.status}`}
        >
          {statusLabel(access.status)}
        </strong>
      </div>
      <p>
        Sign-in requires membership read within{' '}
        {access.freshnessWindowSeconds / 3_600} hours for every active access
        group.
      </p>
      {access.groups.length === 0 ? (
        <p>
          No active access group is configured.{' '}
          <a href="/access">Configure access groups</a>.
        </p>
      ) : (
        <div
          aria-label="Access membership read evidence"
          className="table-region"
          role="region"
          tabIndex={0}
        >
          <table>
            <caption>
              Active access groups and their last membership read
            </caption>
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Role</th>
                <th scope="col">Last read</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {access.groups.map((group) => (
                <tr key={group.id}>
                  <th scope="row">{group.displayName}</th>
                  <td>
                    {group.grantedRole === 'admin' ? 'Administrator' : 'Staff'}
                  </td>
                  <td>
                    <Timestamp value={group.membersCapturedAt} />
                  </td>
                  <td>{accessStateLabel(group.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {access.status === 'action-required' && access.groups.length > 0 ? (
        <p>
          Run or repair the access-membership sync, then{' '}
          <a href="/access">review access groups</a>.
        </p>
      ) : null}
    </section>
  );
}

function FacilityReadiness({
  readiness,
}: Readonly<{ readiness: AdminReadiness }>) {
  const configuration = readiness.facilityConfiguration;
  return (
    <section aria-labelledby="facility-readiness-heading">
      <div className="readiness-section-heading">
        <h2 id="facility-readiness-heading">Facility configuration</h2>
        <strong
          className={`readiness-badge readiness-status--${configuration.status}`}
        >
          {statusLabel(configuration.status)}
        </strong>
      </div>
      <dl>
        <dt>Active facilities</dt>
        <dd>{configuration.activeFacilityCount}</dd>
        <dt>Without a current neighborhood</dt>
        <dd>{configuration.facilitiesWithoutNeighborhoodCount}</dd>
        <dt>Without an audience configuration</dt>
        <dd>{configuration.facilitiesWithoutAudienceCount}</dd>
      </dl>
      {configuration.status === 'action-required' ? (
        <p>
          <a href="/facilities">Complete facility configuration</a> before
          relying on a consequence preview.
        </p>
      ) : null}
    </section>
  );
}

function RosterReadiness({
  readiness,
}: Readonly<{ readiness: AdminReadiness }>) {
  const roster = readiness.roster;
  return (
    <section aria-labelledby="roster-readiness-heading">
      <div className="readiness-section-heading">
        <h2 id="roster-readiness-heading">Staff roster</h2>
        <strong
          className={`readiness-badge readiness-status--${roster.status}`}
        >
          {statusLabel(roster.status)}
        </strong>
      </div>
      <p>
        A successful staff roster sync and its complete snapshot must remain
        within {roster.freshnessWindowSeconds / 3_600} hours.
      </p>
      <dl>
        <dt>Latest attempt outcome</dt>
        <dd>{rosterOutcomeLabel(roster.latestAttemptOutcome)}</dd>
        <dt>Latest attempt completed</dt>
        <dd>
          <Timestamp value={roster.latestAttemptCompletedAt} />
        </dd>
        <dt>Latest complete snapshot</dt>
        <dd>
          <Timestamp value={roster.latestCompleteSnapshotCapturedAt} />
        </dd>
      </dl>
      {roster.status === 'action-required' ? (
        <p>
          <a href="/integrations">Review roster and integration health</a>. A
          newer failed attempt remains visible even when an older complete
          snapshot exists.
        </p>
      ) : null}
    </section>
  );
}

function AlarmReadiness({
  readiness,
}: Readonly<{ readiness: AdminReadiness }>) {
  const actionRequired = readiness.alarmTopics.some(
    ({ status }) => status === 'action-required',
  );
  const unavailable = readiness.alarmTopics.some(
    ({ status }) => status === 'unavailable',
  );
  return (
    <section aria-labelledby="alarm-readiness-heading">
      <h2 id="alarm-readiness-heading">Operational alarm delivery</h2>
      <p>
        Each CloudWatch alarm topic needs at least one confirmed subscriber.
        Only counts are shown; subscriber endpoints are never returned.
      </p>
      <ul className="readiness-topic-list">
        {readiness.alarmTopics.map((topic) => (
          <li key={topic.kind}>
            <div>
              <strong>
                {topic.kind === 'operations' ? 'Operations' : 'Critical'} alarms
              </strong>
              <span>
                {topic.confirmedSubscriberCount === null
                  ? 'Provider status could not be read.'
                  : `${topic.confirmedSubscriberCount} confirmed subscriber${
                      topic.confirmedSubscriberCount === 1 ? '' : 's'
                    }.`}
              </span>
            </div>
            <strong
              className={`readiness-badge readiness-status--${topic.status}`}
            >
              {statusLabel(topic.status)}
            </strong>
          </li>
        ))}
      </ul>
      {actionRequired ? (
        <p>
          Confirm at least one subscriber on each zero-subscriber alarm topic in
          AWS SNS.
        </p>
      ) : null}
      {unavailable ? (
        <p>
          To restore an unavailable check, verify the alarm-topic ARN settings,
          the App Runner role’s subscription-list permission, and AWS
          connectivity, then reload this page. An unavailable check is not the
          same as a confirmed zero-subscriber result.
        </p>
      ) : null}
    </section>
  );
}

export function AdminReadinessView({
  readiness,
}: Readonly<{ readiness: AdminReadiness }>) {
  return (
    <main
      aria-labelledby="admin-readiness-heading"
      id="main-content"
      tabIndex={-1}
    >
      <AdminNavigation />
      <ReadinessHeader readiness={readiness} />
      <div className="admin-grid readiness-grid">
        <AccessReadiness readiness={readiness} />
        <FacilityReadiness readiness={readiness} />
        <RosterReadiness readiness={readiness} />
        <AlarmReadiness readiness={readiness} />
      </div>
    </main>
  );
}

export function ForbiddenAdminReadiness() {
  return (
    <main id="main-content" tabIndex={-1}>
      <section aria-labelledby="admin-readiness-forbidden-heading">
        <h1 id="admin-readiness-forbidden-heading">
          Administrator access required
        </h1>
        <p role="alert">
          Your session is active, but only district administrators can review
          deployment readiness.
        </p>
        <p>
          No configuration, membership, roster, or alarm data was displayed.
        </p>
      </section>
    </main>
  );
}
