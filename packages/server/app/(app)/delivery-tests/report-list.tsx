import type {
  AttemptDeliveryTruthState,
  MonthlyDeliveryTestReport,
} from '@psd-eoc/contracts';

interface DeliveryTestReportListProps {
  readonly reports: readonly MonthlyDeliveryTestReport[];
}

const DATE_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  dateStyle: 'medium',
  timeStyle: 'long',
});

function statusLabel(status: MonthlyDeliveryTestReport['status']): string {
  switch (status) {
    case 'succeeded':
      return 'Succeeded — all endpoints reached provider acceptance or better';
    case 'failed':
      return 'Failed';
    case 'incomplete':
      return 'Incomplete — includes unknown outcomes';
  }
}

function truthLabel(state: AttemptDeliveryTruthState): string {
  switch (state) {
    case 'attempted':
      return 'Attempted';
    case 'provider-accepted':
      return 'Provider accepted';
    case 'delivered':
      return 'Delivered (only when provable)';
    case 'failed':
      return 'Failed';
    case 'expired':
      return 'Expired';
    case 'unknown':
      return 'Unknown';
  }
}

function channelLabel(channel: string): string {
  return channel === 'push'
    ? 'Push'
    : channel === 'email'
      ? 'Email'
      : channel === 'sms'
        ? 'SMS'
        : channel;
}

/** Destination-free append-only monthly delivery-test evidence. */
export function DeliveryTestReportList({
  reports,
}: DeliveryTestReportListProps) {
  return (
    <section className="panel" aria-labelledby="delivery-test-reports-heading">
      <div className="section-heading">
        <h2 id="delivery-test-reports-heading">Append-only reports</h2>
        <span className="count-badge">{reports.length}</span>
      </div>
      <p>
        Reports contain opaque run IDs, counts, latency, and delivery truth —
        never endpoint destinations. Provider acceptance means a provider
        accepted the handoff; it does not prove delivery or human receipt.
        Unknown is retained as an explicit outcome.
      </p>
      {reports.length === 0 ? (
        <p className="status-message" role="status">
          No delivery-test reports are available in your authorized facility
          scope.
        </p>
      ) : (
        <ol className="delivery-test-report-list">
          {reports.map((report) => (
            <li className="delivery-test-report" key={report.id}>
              <header>
                <div>
                  <p className="eyebrow">
                    Report sequence {report.sequence} · {report.source}
                  </p>
                  <h3>{statusLabel(report.status)}</h3>
                </div>
                <time dateTime={report.generatedAt}>
                  {DATE_TIME.format(new Date(report.generatedAt))}
                </time>
              </header>
              <dl className="facts">
                <dt>Run ID</dt>
                <dd className="code-value">
                  <code>{report.runId}</code>
                </dd>
                <dt>Report ID</dt>
                <dd className="code-value">
                  <code>{report.id}</code>
                </dd>
                <dt>Supersedes</dt>
                <dd className="code-value">
                  {report.supersedesReportId === null ? (
                    'Initial report'
                  ) : (
                    <code>{report.supersedesReportId}</code>
                  )}
                </dd>
                <dt>Reason code</dt>
                <dd>{report.reasonCode ?? 'None — succeeded'}</dd>
              </dl>
              <div className="delivery-test-report-channels">
                {report.channels.map((channel) => (
                  <section key={channel.channel}>
                    <h4>{channelLabel(channel.channel)}</h4>
                    <dl>
                      <dt>Planned endpoints</dt>
                      <dd>{channel.endpointCount}</dd>
                      <dt>Activation to provider acceptance</dt>
                      <dd>
                        {channel.activationToProviderAcceptMs === null
                          ? 'Unknown / not established'
                          : `${channel.activationToProviderAcceptMs} ms`}
                      </dd>
                      <dt>Latest truth</dt>
                      <dd>
                        {channel.latestStateCounts.length === 0 ? (
                          'Unknown / no endpoint evidence'
                        ) : (
                          <ul>
                            {channel.latestStateCounts.map((truth) => (
                              <li key={truth.state}>
                                {truthLabel(truth.state)}: {truth.count}
                              </li>
                            ))}
                          </ul>
                        )}
                      </dd>
                    </dl>
                  </section>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
