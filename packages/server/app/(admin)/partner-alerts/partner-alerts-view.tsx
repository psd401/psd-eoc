import type { PartnerAlertSettingsState } from '@psd-eoc/contracts';

import { AdminMutationFields } from '../facilities/admin-form-fields';

export type PartnerAlertsView =
  | Readonly<{ kind: 'authorized'; state: PartnerAlertSettingsState }>
  | Readonly<{ kind: 'forbidden' }>;

export const NON_ADMIN_PARTNER_ALERTS_VIEW: PartnerAlertsView = Object.freeze({
  kind: 'forbidden',
});

function SettingsProvenance({
  current,
}: Readonly<{ current: PartnerAlertSettingsState['current'] }>) {
  if (current === null) {
    return (
      <p className="notice">
        <strong>Default settings in effect.</strong> No administrator has saved
        partner alert settings yet; the defaults are checked below.
      </p>
    );
  }
  return (
    <p className="notice">
      <strong>Version {current.version} in effect,</strong> saved{' '}
      <time dateTime={current.createdAt}>{current.createdAt}</time>. Every save
      is kept as a new version with the administrator who made it.
    </p>
  );
}

function SettingsForm({
  csrfToken,
  state,
}: Readonly<{ csrfToken: string; state: PartnerAlertSettingsState }>) {
  const responses = new Set(state.effective.responseFamilyKeys);
  const excluded = new Set(state.effective.excludedThreatKeys);
  const offeredResponses = new Set(
    state.responseOptions.map(({ familyKey }) => familyKey),
  );
  // A saved response with no published real version stays listed, checked
  // and named by its key, so saving never silently drops it and unchecking
  // it removes it.
  const responseChoices = [
    ...state.responseOptions,
    ...state.effective.responseFamilyKeys
      .filter((key) => !offeredResponses.has(key))
      .map((key) => ({
        familyKey: key,
        name: `${key} (no published response)`,
      })),
  ];
  // A threat that was retired after it was excluded stays listed, so saving
  // the page never silently drops the exclusion.
  const threats = state.threatOptions.filter(
    ({ key, active }) => active || excluded.has(key),
  );
  return (
    <form action="/partner-alerts/api" method="post">
      <AdminMutationFields csrfToken={csrfToken} />
      <input name="intent" type="hidden" value="set-partner-alert-settings" />
      <input
        name="baseVersionId"
        type="hidden"
        value={state.current?.id ?? ''}
      />
      <fieldset aria-describedby="partner-alert-responses-help">
        <legend>Responses that alert partners</legend>
        <p className="field-help" id="partner-alert-responses-help">
          A real event with one of these responses alerts partners. Drills never
          alert partners. Choose none to stop partner alerts entirely.
        </p>
        {responseChoices.length === 0 ? (
          <p>No responses are published.</p>
        ) : (
          responseChoices.map((option) => (
            <label key={option.familyKey}>
              <input
                defaultChecked={responses.has(option.familyKey)}
                name="responseFamilyKeys"
                type="checkbox"
                value={option.familyKey}
              />{' '}
              {option.name}
            </label>
          ))
        )}
      </fieldset>
      <fieldset aria-describedby="partner-alert-threats-help">
        <legend>Threats that never alert partners</legend>
        <p className="field-help" id="partner-alert-threats-help">
          An event with an excluded threat does not alert partners, whatever its
          response. A retired threat is listed only while it is excluded;
          unchecking it removes the exclusion for good.
        </p>
        {threats.length === 0 ? (
          <p>No threats are configured.</p>
        ) : (
          threats.map((option) => (
            <label key={option.key}>
              <input
                defaultChecked={excluded.has(option.key)}
                name="excludedThreatKeys"
                type="checkbox"
                value={option.key}
              />{' '}
              {option.name}
              {option.active ? '' : ' (retired)'}
            </label>
          ))
        )}
      </fieldset>
      <button type="submit">Save partner alert settings</button>
    </form>
  );
}

/** The partner alert settings page; pure presentation of the capability. */
export function PartnerAlertsAdminView({
  view,
  csrfToken = '',
  statusMessage = null,
}: Readonly<{
  view: PartnerAlertsView;
  csrfToken?: string;
  statusMessage?: string | null;
}>) {
  if (view.kind === 'forbidden') {
    return (
      <main id="main-content" tabIndex={-1}>
        <section aria-labelledby="partner-alerts-forbidden-heading">
          <h1 id="partner-alerts-forbidden-heading">
            Administrator access required
          </h1>
          <p role="alert">
            Your PSD EOC session is active, but only district administrators can
            review or change partner alert settings.
          </p>
          <p>No partner alert settings were displayed.</p>
        </section>
      </main>
    );
  }
  return (
    <main
      aria-labelledby="partner-alerts-heading"
      id="main-content"
      tabIndex={-1}
    >
      <h1 id="partner-alerts-heading">Partner alerts</h1>
      {statusMessage === null ? null : (
        <p className="notice status-message" role="status">
          {statusMessage}
        </p>
      )}
      <p>
        Partners are responders from outside the district. These settings decide
        which real events will alert them.
      </p>
      <p className="notice">
        <strong>Partner alert delivery is not turned on yet.</strong> Saving
        here records your choice; no partner is alerted until delivery is
        enabled in a later release.
      </p>
      <SettingsProvenance current={view.state.current} />
      <section aria-labelledby="partner-alert-settings-heading">
        <h2 id="partner-alert-settings-heading">Settings</h2>
        <SettingsForm csrfToken={csrfToken} state={view.state} />
      </section>
    </main>
  );
}
