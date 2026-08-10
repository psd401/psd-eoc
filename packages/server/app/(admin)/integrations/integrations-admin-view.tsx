import type {
  ChannelConfiguration,
  IntegrationHealth,
  IntegrationTruthLabel,
  RosterSyncResult,
  StaleRosterReport,
} from '@psd-eoc/contracts';

import { AdminMutationFields } from '../facilities/admin-form-fields';
import { AdminNavigation } from '../facilities/admin-nav';
import { SMS_INTEGRATION_ID } from './capabilities';
import { TEST_MODE_TARGETING } from './test-mode';

export const TEST_MODE_BANNER =
  'TEST — SYNTHETIC RECIPIENTS ONLY — NO REAL NOTIFICATIONS' as const;

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

function truthLabelDescription(label: IntegrationTruthLabel): string {
  switch (label) {
    case 'mocked':
      return 'Mock boundary only; this does not prove live connectivity.';
    case 'configured-unverified':
      return 'Configured, but live behavior has not been verified.';
    case 'live-verified':
      return 'Live verification has recorded human-approved provenance.';
    case 'blocked':
      return 'Unavailable until the displayed prerequisite is resolved.';
  }
}

function IntegrationHealthSection({
  health,
}: Readonly<{ health: IntegrationHealth }>) {
  return (
    <section aria-labelledby="integration-health-heading">
      <h2 id="integration-health-heading">Integration health</h2>
      <p>
        Observed <Timestamp value={health.observedAt} />. Truth labels describe
        only the evidence currently available.
      </p>
      {health.statuses.length === 0 ? (
        <p>No integration observations are available.</p>
      ) : (
        <div
          aria-label="Integration truth observations"
          className="table-region"
          role="region"
          tabIndex={0}
        >
          <table>
            <caption>Current external integration truth</caption>
            <thead>
              <tr>
                <th scope="col">Integration</th>
                <th scope="col">Truth label</th>
                <th scope="col">Meaning</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {health.statuses.map((status) => (
                <tr key={status.integrationId}>
                  <th scope="row">{status.integrationId}</th>
                  <td>{status.label}</td>
                  <td>{truthLabelDescription(status.label)}</td>
                  <td>{status.reasonCode ?? 'None recorded'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
            <caption>Administrative channel enablement and truth</caption>
            <thead>
              <tr>
                <th scope="col">Channel integration</th>
                <th scope="col">State</th>
                <th scope="col">Truth label</th>
                <th scope="col">Changed</th>
                <th scope="col">Administrative change</th>
              </tr>
            </thead>
            <tbody>
              {configurations.map((configuration) => (
                <tr key={configuration.integrationId}>
                  <th scope="row">{configuration.integrationId}</th>
                  <td>{configuration.enabled ? 'Enabled' : 'Disabled'}</td>
                  <td>{configuration.status.label}</td>
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
                          <option
                            disabled={
                              configuration.integrationId ===
                                SMS_INTEGRATION_ID ||
                              configuration.status.label === 'blocked' ||
                              configuration.status.label ===
                                'configured-unverified'
                            }
                            value="true"
                          >
                            Enabled
                          </option>
                        </select>
                      </label>
                      <label>
                        Product-owner approval reference
                        <input
                          aria-describedby={`approval-${configuration.integrationId}`}
                          autoComplete="off"
                          maxLength={255}
                          name="productOwnerApprovalReference"
                          required
                        />
                      </label>
                      <span
                        className="field-help"
                        id={`approval-${configuration.integrationId}`}
                      >
                        Non-secret approval evidence only. Never enter a token,
                        credential, recipient, or provider payload.
                      </span>
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
      <dl>
        <dt>Status</dt>
        <dd>{report.status}</dd>
        <dt>Recipients without a usable endpoint</dt>
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
      <AdminNavigation />
      <h1 id="integrations-admin-heading">Integrations administration</h1>
      {statusMessage === null ? null : (
        <p className="notice status-message" role="status">
          {statusMessage}
        </p>
      )}
      <aside aria-labelledby="test-mode-heading" className="test-boundary">
        <h2 id="test-mode-heading">{TEST_MODE_BANNER}</h2>
        <p>
          Test mode is server-fixed to test classification, drill rendering,
          mocked integrations, and reserved synthetic endpoints.
        </p>
        <dl>
          <dt>Event kind</dt>
          <dd>{TEST_MODE_TARGETING.kind.toUpperCase()}</dd>
          <dt>Template mode</dt>
          <dd>{TEST_MODE_TARGETING.templateMode.toUpperCase()}</dd>
          <dt>Roster population</dt>
          <dd>{TEST_MODE_TARGETING.rosterPopulation.toUpperCase()}</dd>
        </dl>
      </aside>
      <IntegrationHealthSection health={integrationHealth} />
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
