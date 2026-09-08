import type {
  ChannelConfiguration,
  IntegrationHealth,
  RosterSyncResult,
  StaleRosterReport,
} from '@psd-eoc/contracts';

import { AdminMutationFields } from '../facilities/admin-form-fields';

export interface IntegrationsAdminViewProps {
  readonly integrationHealth: IntegrationHealth;
  readonly channelConfigurations: readonly ChannelConfiguration[];
  readonly lastRosterSync: Pick<
    RosterSyncResult,
    'completedAt' | 'outcome' | 'population'
  > | null;
  readonly staleEndpointReport: StaleRosterReport;
}

function Timestamp({ value }: Readonly<{ value: string }>) {
  return <time dateTime={value}>{value}</time>;
}

function IntegrationStateSummary({
  configurations,
  health,
}: Readonly<{
  configurations: readonly ChannelConfiguration[];
  health: IntegrationHealth;
}>) {
  const enabledCount = configurations.filter(
    (configuration) => configuration.enabled,
  ).length;
  return (
    <p className="notice integration-state-summary">
      <strong>Current channel state:</strong> {enabledCount} of{' '}
      {configurations.length} notification channels are enabled, observed{' '}
      <Timestamp value={health.observedAt} />. Enablement is the switch; whether
      a provider delivers is discovered by sending, and every send is recorded.
    </p>
  );
}

function ChannelStateSection({
  configurations,
  csrfToken,
}: Readonly<{
  configurations: readonly ChannelConfiguration[];
  csrfToken: string;
}>) {
  return (
    <section aria-labelledby="channel-state-heading">
      <h2 id="channel-state-heading">Notification channel state</h2>
      {configurations.length === 0 ? (
        <p>No notification channels are configured.</p>
      ) : (
        <div
          aria-label="Notification channel configurations"
          className="table-region"
          role="region"
          tabIndex={0}
        >
          <table>
            <caption>Administrative channel enablement</caption>
            <thead>
              <tr>
                <th scope="col">Channel integration</th>
                <th scope="col">State</th>
                <th scope="col">Changed</th>
                <th scope="col">Administrative change</th>
              </tr>
            </thead>
            <tbody>
              {configurations.map((configuration) => (
                <tr key={configuration.integrationId}>
                  <th scope="row">{configuration.integrationId}</th>
                  <td>{configuration.enabled ? 'Enabled' : 'Disabled'}</td>
                  <td>
                    <Timestamp value={configuration.changedAt} />
                  </td>
                  <td>
                    <form action="/integrations/api" method="post">
                      <AdminMutationFields csrfToken={csrfToken} />
                      <input
                        name="intent"
                        type="hidden"
                        value="set-channel-enabled"
                      />
                      <input
                        name="integrationId"
                        type="hidden"
                        value={configuration.integrationId}
                      />
                      <label>
                        Requested state
                        <select
                          defaultValue={String(configuration.enabled)}
                          name="enabled"
                        >
                          <option value="false">Disabled</option>
                          <option value="true">Enabled</option>
                        </select>
                      </label>
                      <button type="submit">
                        Save {configuration.integrationId} state
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RosterHealthSection({
  lastRosterSync,
  report,
}: Readonly<{
  lastRosterSync: IntegrationsAdminViewProps['lastRosterSync'];
  report: StaleRosterReport;
}>) {
  return (
    <section aria-labelledby="roster-health-heading">
      <h2 id="roster-health-heading">Roster and endpoint health</h2>
      {lastRosterSync === null ? (
        <p>No roster synchronization result is available.</p>
      ) : (
        <dl>
          <dt>Last synchronization outcome</dt>
          <dd>{lastRosterSync.outcome}</dd>
          <dt>Roster population</dt>
          <dd>{lastRosterSync.population}</dd>
          <dt>Completed</dt>
          <dd>
            <Timestamp value={lastRosterSync.completedAt} />
          </dd>
        </dl>
      )}
      <h3>Stale endpoint report</h3>
      <p>
        Generated <Timestamp value={report.generatedAt} />.
      </p>
      <p>
        This is a bounded page of endpoint evidence, not a district-wide total.
      </p>
      <dl>
        <dt>Status</dt>
        <dd>{report.status}</dd>
        <dt>Recipients shown without a usable endpoint</dt>
        <dd>{report.staleRecipients.length}</dd>
        <dt>Failed group sources</dt>
        <dd>{report.failedGroups.length}</dd>
        <dt>Latest complete roster capture</dt>
        <dd>
          {report.latestCompleteCapturedAt === null ? (
            'None recorded'
          ) : (
            <Timestamp value={report.latestCompleteCapturedAt} />
          )}
        </dd>
      </dl>
    </section>
  );
}

/** Pure, read-only presentation for the integrations administration surface. */
export function IntegrationsAdminView({
  integrationHealth,
  channelConfigurations,
  lastRosterSync,
  staleEndpointReport,
  csrfToken = '',
  statusMessage = null,
}: Readonly<
  IntegrationsAdminViewProps & {
    readonly csrfToken?: string;
    readonly statusMessage?: string | null;
  }
>) {
  return (
    <main
      aria-labelledby="integrations-admin-heading"
      id="main-content"
      tabIndex={-1}
    >
      <h1 id="integrations-admin-heading">Integrations administration</h1>
      {statusMessage === null ? null : (
        <p className="notice status-message" role="status">
          {statusMessage}
        </p>
      )}
      <IntegrationStateSummary
        configurations={channelConfigurations}
        health={integrationHealth}
      />
      <ChannelStateSection
        configurations={channelConfigurations}
        csrfToken={csrfToken}
      />
      <RosterHealthSection
        lastRosterSync={lastRosterSync}
        report={staleEndpointReport}
      />
    </main>
  );
}
