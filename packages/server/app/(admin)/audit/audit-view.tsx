'use client';

import { useActionState } from 'react';

import { queryAuditAction } from './actions';
import type {
  AuditDisplayPage,
  AuditFilterState,
  AuditViewState,
} from './filters';

type AuditFormAction = (payload: FormData) => void;

function filterFormKey(filters: AuditFilterState): string {
  return [
    filters.actorKind,
    filters.actorReference,
    filters.action,
    filters.from,
    filters.through,
  ].join('\u001f');
}

function HiddenAuditFilters({
  filters,
}: Readonly<{ filters: AuditFilterState }>) {
  return (
    <>
      <input type="hidden" name="actorKind" value={filters.actorKind} />
      <input
        type="hidden"
        name="actorReference"
        value={filters.actorReference}
      />
      <input type="hidden" name="action" value={filters.action} />
      <input type="hidden" name="from" value={filters.from} />
      <input type="hidden" name="through" value={filters.through} />
    </>
  );
}

function AuditFilterForm({
  filters,
  formAction,
  pending,
}: Readonly<{
  filters: AuditFilterState;
  formAction: AuditFormAction;
  pending: boolean;
}>) {
  return (
    <form
      action={formAction}
      aria-label="Audit filters"
      className="filters"
      key={filterFormKey(filters)}
    >
      <fieldset disabled={pending}>
        <legend>Filter audit records</legend>
        <div className="filter-grid">
          <label>
            Actor type
            <select name="actorKind" defaultValue={filters.actorKind}>
              <option value="">All actor types</option>
              <option value="human">Human</option>
              <option value="agent">Agent</option>
              <option value="system">System</option>
              <option value="unauthenticated">Unauthenticated</option>
            </select>
          </label>
          <label>
            Actor identifier
            <input
              aria-describedby="actor-reference-help"
              autoComplete="off"
              defaultValue={filters.actorReference}
              maxLength={255}
              name="actorReference"
              placeholder="Internal UUID, service ID, or subject digest"
              spellCheck={false}
            />
            <span className="field-help" id="actor-reference-help">
              Optional. Select an actor type first. Use only the internal
              identifier shown in this log; never enter a name or email.
            </span>
          </label>
          <label>
            Action
            <input
              autoCapitalize="none"
              autoComplete="off"
              defaultValue={filters.action}
              maxLength={120}
              name="action"
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              placeholder="query-security-audit"
              spellCheck={false}
            />
          </label>
          <label>
            From (UTC)
            <input
              defaultValue={filters.from}
              name="from"
              step="1"
              type="datetime-local"
            />
          </label>
          <label>
            Through (UTC)
            <input
              defaultValue={filters.through}
              name="through"
              step="1"
              type="datetime-local"
            />
          </label>
        </div>
        <div className="actions">
          <button name="intent" type="submit" value="filter">
            Apply filters
          </button>
          <button
            className="secondary-action"
            formNoValidate
            name="intent"
            type="submit"
            value="clear"
          >
            Clear filters
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function AuditResults({ page }: Readonly<{ page: AuditDisplayPage }>) {
  if (page.items.length === 0) {
    return (
      <p className="notice" role="status">
        No security audit records match these filters.
      </p>
    );
  }

  return (
    <section aria-labelledby="audit-results-heading">
      <h2 id="audit-results-heading">Audit records</h2>
      <div
        aria-label="Security audit records"
        className="table-region"
        role="region"
        tabIndex={0}
      >
        <table>
          <caption>
            Highest sequence first. Hashes shown are recorded chain hashes, not
            a claim that this page ran verification.
          </caption>
          <thead>
            <tr>
              <th scope="col">Sequence</th>
              <th scope="col">Time</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Outcome</th>
              <th scope="col">Facility</th>
              <th scope="col">Reason</th>
              <th scope="col">Recorded chain hash</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((entry) => (
              <tr key={entry.sequence}>
                <td>{entry.sequence}</td>
                <td>
                  <time dateTime={entry.occurredAt}>{entry.occurredAt}</time>
                </td>
                <td>
                  <span>{entry.actorKind}</span>
                  <code>{entry.actorReference}</code>
                </td>
                <td>
                  <code>{entry.action}</code>
                </td>
                <td>{entry.outcome}</td>
                <td>
                  {entry.facilityId === null ? (
                    'Not facility-specific'
                  ) : (
                    <code>{entry.facilityId}</code>
                  )}
                </td>
                <td>{entry.reasonCode ?? 'None'}</td>
                <td>
                  <code>{entry.entryHash}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export interface AuditViewContentProps {
  readonly state: AuditViewState;
  readonly formAction: AuditFormAction;
  readonly pending: boolean;
}

function queryStatus(state: AuditViewState, pending: boolean): string {
  if (pending) return 'Loading security audit records…';
  if (
    state.forbidden ||
    state.errorMessage !== null ||
    state.page === null ||
    state.page.items.length === 0
  ) {
    return '';
  }
  const count = state.page.items.length;
  return `${count} security audit ${count === 1 ? 'record' : 'records'} displayed.`;
}

/** Pure presentation exported so semantic and privacy boundaries stay tested. */
export function AuditViewContent({
  state,
  formAction,
  pending,
}: AuditViewContentProps) {
  const { filters, page, errorMessage, forbidden } = state;
  return (
    <main id="main-content" tabIndex={-1} aria-busy={pending}>
      <header>
        <p className="eyebrow">Administration</p>
        <h1>Security audit log</h1>
        <p>
          This tamper-evident security log is separate from incident and drill
          journals. It records minimized identity, authorization, and
          administrative facts; it never contains message content.
        </p>
      </header>

      {forbidden ? (
        <section className="notice error" aria-labelledby="audit-denied">
          <h2 id="audit-denied">Administrator access required</h2>
          <p role="alert">
            Your session is active, but it is not authorized to read security
            audit records.
          </p>
        </section>
      ) : (
        <>
          <AuditFilterForm
            filters={filters}
            formAction={formAction}
            pending={pending}
          />

          <p aria-live="polite" className="query-status" role="status">
            {queryStatus(state, pending)}
          </p>

          {errorMessage === null ? null : (
            <p className="notice error" role="alert">
              {errorMessage}
            </p>
          )}

          {page === null || errorMessage !== null ? null : (
            <>
              <AuditResults page={page} />
              {page.pageInfo.hasMore && page.pageInfo.nextCursor !== null ? (
                <form action={formAction} className="pagination">
                  <HiddenAuditFilters filters={filters} />
                  <input
                    type="hidden"
                    name="cursor"
                    value={page.pageInfo.nextCursor}
                  />
                  <button
                    className="next-page"
                    disabled={pending}
                    name="intent"
                    type="submit"
                    value="page"
                  >
                    Next page of audit records
                  </button>
                </form>
              ) : null}
            </>
          )}
        </>
      )}
    </main>
  );
}

export function AuditView({
  initialState,
}: Readonly<{ initialState: AuditViewState }>) {
  const [state, formAction, pending] = useActionState(
    queryAuditAction,
    initialState,
  );
  return (
    <AuditViewContent state={state} formAction={formAction} pending={pending} />
  );
}
