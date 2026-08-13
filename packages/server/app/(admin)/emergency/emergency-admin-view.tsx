import type { FanoutControlEffectiveState } from '@psd-eoc/contracts';

import { AdminMutationFields } from '../facilities/admin-form-fields';
import { AdminNavigation } from '../facilities/admin-nav';

export const NON_ADMIN_EMERGENCY_VIEW = Object.freeze({
  kind: 'forbidden' as const,
});

export type EmergencyAdminViewModel =
  | typeof NON_ADMIN_EMERGENCY_VIEW
  | Readonly<{
      kind: 'authorized';
      state: FanoutControlEffectiveState;
    }>;

function ForbiddenEmergencyView() {
  return (
    <main id="main-content" tabIndex={-1}>
      <section aria-labelledby="emergency-forbidden-heading">
        <h1 id="emergency-forbidden-heading">Administrator access required</h1>
        <p role="alert">
          Your session cannot read or change the district notification fan-out
          control.
        </p>
        <p>No emergency-control history or approval reference was displayed.</p>
      </section>
    </main>
  );
}

function StateSummary({
  state,
}: Readonly<{ state: FanoutControlEffectiveState }>) {
  const enabled = state.effectiveMode === 'enabled';
  return (
    <section
      aria-labelledby="fanout-state-heading"
      className={enabled ? 'notice' : 'test-boundary'}
    >
      <h2 id="fanout-state-heading">
        {enabled
          ? 'Notification fan-out is enabled'
          : 'EMERGENCY DISABLE ACTIVE — notification fan-out is blocked'}
      </h2>
      <p role="status">
        {enabled
          ? 'The current epoch may admit newly human-confirmed notification intents.'
          : 'New previews, intent admission, queue dispatch, and provider handoff must fail closed.'}
      </p>
      {state.kind === 'current' ? (
        <dl>
          <dt>Revision</dt>
          <dd>{state.currentRecord.revision}</dd>
          <dt>Changed</dt>
          <dd>
            <time dateTime={state.currentRecord.changedAt}>
              {state.currentRecord.changedAt}
            </time>
          </dd>
          <dt>Reason</dt>
          <dd>{state.currentRecord.reason}</dd>
          <dt>Current enable epoch</dt>
          <dd>
            <code>
              {state.currentRecord.enableEpochId ?? 'None — emergency-disabled'}
            </code>
          </dd>
          <dt>Product-owner approval</dt>
          <dd>
            {state.currentRecord.productOwnerApprovalReference ??
              'Not applicable to emergency disablement'}
          </dd>
        </dl>
      ) : (
        <p>
          Control persistence is {state.kind}; fail-closed reason:{' '}
          <code>{state.reasonCode}</code>.
        </p>
      )}
    </section>
  );
}

export function EmergencyAdminView({
  view,
  csrfToken = '',
  statusMessage = null,
}: Readonly<{
  view: EmergencyAdminViewModel;
  csrfToken?: string;
  statusMessage?: string | null;
}>) {
  if (view.kind === 'forbidden') return <ForbiddenEmergencyView />;
  const expectedCurrentRecordId =
    view.state.kind === 'current' ? view.state.currentRecord.id : '';
  return (
    <main
      aria-labelledby="emergency-control-heading"
      id="main-content"
      tabIndex={-1}
    >
      <AdminNavigation />
      <h1 id="emergency-control-heading">Emergency notification control</h1>
      <p>
        This district-wide switch controls notification fan-out. It does not
        close events, issue all-clear, or send a notification by itself.
      </p>
      {statusMessage === null ? null : (
        <p className="notice" role="status">
          {statusMessage}
        </p>
      )}
      <StateSummary state={view.state} />

      <section aria-labelledby="disable-heading">
        <h2 id="disable-heading">Emergency-disable fan-out</h2>
        <div className="test-boundary">
          <h3>Consequence preview</h3>
          <p>
            Submitting this form immediately blocks new notification previews,
            new fan-out intent admission, unpublished queue handoffs, and
            provider-bound attempts after their next authoritative check.
            Existing events and append-only records remain available.
          </p>
        </div>
        <form action="/emergency/api" method="post">
          <AdminMutationFields csrfToken={csrfToken} />
          <input name="intent" type="hidden" value="set-fanout-control" />
          <input
            name="expectedCurrentRecordId"
            type="hidden"
            value={expectedCurrentRecordId}
          />
          <input name="desiredMode" type="hidden" value="emergency-disabled" />
          <label>
            Operational reason
            <textarea maxLength={500} name="reason" required rows={4} />
          </label>
          <button type="submit">Emergency-disable notification fan-out</button>
        </form>
      </section>

      <section aria-labelledby="enable-heading">
        <h2 id="enable-heading">Re-enable fan-out</h2>
        <div className="notice">
          <h3>Consequence preview</h3>
          <p>
            Re-enabling creates a fresh epoch. It does not release work pinned
            to an older epoch, does not start an event, and does not send a
            notification. A fresh, non-secret product-owner authorization
            reference is mandatory; do not self-approve.
          </p>
        </div>
        <form action="/emergency/api" method="post">
          <AdminMutationFields csrfToken={csrfToken} />
          <input name="intent" type="hidden" value="set-fanout-control" />
          <input
            name="expectedCurrentRecordId"
            type="hidden"
            value={expectedCurrentRecordId}
          />
          <input name="desiredMode" type="hidden" value="enabled" />
          <label>
            Operational reason
            <textarea maxLength={500} name="reason" required rows={4} />
          </label>
          <label>
            Product-owner authorization reference
            <input
              autoComplete="off"
              maxLength={255}
              name="productOwnerApprovalReference"
              required
              type="text"
            />
          </label>
          <p className="field-help">
            Enter only a non-secret reference to fresh approval for this exact
            enablement. Never enter a credential, token, recipient, or provider
            payload.
          </p>
          <button type="submit">Re-enable with fresh authorization</button>
        </form>
      </section>
    </main>
  );
}
