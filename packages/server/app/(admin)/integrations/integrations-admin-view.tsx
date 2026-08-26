import { INTEGRATION_VERIFICATION_REFERENCE_PATTERN_SOURCE } from '@psd-eoc/contracts';
import type {
  ChannelConfiguration,
  IntegrationHealth,
  IntegrationTruthLabel,
  RosterSyncResult,
  StaleRosterReport,
} from '@psd-eoc/contracts';

import { AdminMutationFields } from '../facilities/admin-form-fields';
import { MOBILE_PUSH_INTEGRATION_ID, SMS_INTEGRATION_ID } from './capabilities';

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
  const liveVerifiedCount = health.statuses.filter(
    (status) => status.label === 'live-verified',
  ).length;
  const enabledCount = configurations.filter(
    (configuration) => configuration.enabled,
  ).length;
  return (
    <p className="notice integration-state-summary">
      <strong>Current integration state:</strong> {liveVerifiedCount} of{' '}
      {health.statuses.length} observed integrations are live-verified;{' '}
      {enabledCount} of {configurations.length} notification channels are
      enabled. Channel enablement is configuration state, not proof that a
      notification was sent or received.
    </p>
  );
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
                    {configuration.integrationId === 'ses-email' &&
                    (configuration.status.label === 'configured-unverified' ||
                      (configuration.enabled &&
                        configuration.status.label === 'live-verified')) ? (
                      <form action="/integrations/api" method="post">
                        <AdminMutationFields csrfToken={csrfToken} />
                        <input
                          name="intent"
                          type="hidden"
                          value="verify-email-integration"
                        />
                        <input
                          name="integrationId"
                          type="hidden"
                          value="ses-email"
                        />
                        <p className="field-help">
                          Uses the retained, address-free SES verification
                          reference configured on this deployment. This does not
                          send an email.
                        </p>
                        <button type="submit">
                          {configuration.status.label === 'live-verified'
                            ? 'Re-verify email deployment'
                            : 'Verify and enable email'}
                        </button>
                      </form>
                    ) : null}
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
                              (configuration.integrationId ===
                                SMS_INTEGRATION_ID &&
                                configuration.status.label !==
                                  'live-verified') ||
                              configuration.status.label === 'blocked' ||
                              (configuration.status.label ===
                                'configured-unverified' &&
                                configuration.integrationId !==
                                  MOBILE_PUSH_INTEGRATION_ID)
                            }
                            value="true"
                          >
                            Enabled
                          </option>
                        </select>
                      </label>
                      {configuration.status.label === 'live-verified' ? (
                        <>
                          <label>
                            Pre-issued live authorization artifact
                            <textarea
                              aria-describedby={`approval-${configuration.integrationId}`}
                              autoComplete="off"
                              maxLength={8_192}
                              name="authorization"
                              required
                              rows={8}
                            />
                          </label>
                          <span
                            className="field-help"
                            id={`approval-${configuration.integrationId}`}
                          >
                            Paste only the non-secret, change-specific JSON
                            artifact issued for this integration and requested
                            state. Never enter a token, credential, recipient,
                            or provider payload.
                          </span>
                        </>
                      ) : null}
                      {configuration.integrationId ===
                        MOBILE_PUSH_INTEGRATION_ID &&
                      configuration.status.label === 'configured-unverified' ? (
                        <>
                          <label>
                            Retained direct-push verification reference
                            <input
                              autoComplete="off"
                              maxLength={255}
                              minLength={16}
                              name="verificationReference"
                              pattern={
                                INTEGRATION_VERIFICATION_REFERENCE_PATTERN_SOURCE
                              }
                              required
                            />
                          </label>
                          <span className="field-help">
                            Enter only the non-secret evidence reference for
                            this mobile-push configuration. Saving Enabled
                            appends live verification and enables the channel
                            atomically.
                          </span>
                        </>
                      ) : null}
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
