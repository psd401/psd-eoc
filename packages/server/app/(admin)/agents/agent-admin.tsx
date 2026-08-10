'use client';

import type {
  AgentApiKeyIssuance,
  AgentApiKeySummary,
  AgentCapabilityGrant,
  AgentId,
  Facility,
  SecurityAuditEntry,
} from '@psd-eoc/contracts';
import { isHumanOnlyActionId } from '@psd-eoc/contracts';
import { useActionState, useEffect, useRef } from 'react';

export interface AgentAdminIssueState {
  readonly issuedKey: AgentApiKeyIssuance | null;
  readonly idempotencyKey: string;
  readonly notice: AgentAdminNotice | null;
}

export interface AgentAdminRevokeState {
  readonly notice: AgentAdminNotice | null;
}

export type AgentAdminIssueAction = (
  previousState: AgentAdminIssueState,
  formData: FormData,
) => Promise<AgentAdminIssueState>;

export type AgentAdminRevokeAction = (
  previousState: AgentAdminRevokeState,
  formData: FormData,
) => Promise<AgentAdminRevokeState>;

export type AgentAdminFacility = Readonly<
  Pick<Facility, 'id' | 'code' | 'name' | 'active'>
>;

export interface AgentCapabilityOption {
  readonly id: AgentCapabilityGrant;
  readonly label: string;
  readonly description: string;
}

type AgentAuditPrincipal = Extract<
  SecurityAuditEntry['principal'],
  Readonly<{ kind: 'agent' }>
>;

/**
 * Deliberately omits both audit-chain hashes and any credential verifier.
 * The page needs only minimized facts useful for one agent's access review.
 */
export type AgentAdminAuditRecord = Readonly<
  Pick<
    SecurityAuditEntry,
    | 'id'
    | 'sequence'
    | 'action'
    | 'outcome'
    | 'source'
    | 'facilityId'
    | 'reasonCode'
    | 'occurredAt'
  > &
    Readonly<{ principal: AgentAuditPrincipal }>
>;

export interface AgentAdminAgent {
  readonly id: AgentId;
  readonly displayName: string;
  readonly keys: readonly AgentApiKeySummary[];
  readonly auditRecords: readonly AgentAdminAuditRecord[];
}

export interface AgentAdminNotice {
  readonly kind: 'error' | 'info' | 'success';
  readonly message: string;
}

export interface AgentAdminProps {
  readonly agents: readonly AgentAdminAgent[];
  readonly facilities: readonly AgentAdminFacility[];
  readonly grantOptions: readonly AgentCapabilityOption[];
  readonly issueIdempotencyKey: string;
  readonly issuedKey: AgentApiKeyIssuance | null;
  readonly notice: AgentAdminNotice | null;
  readonly renderedAt: string;
  readonly issueKeyAction: AgentAdminIssueAction;
  readonly revokeKeyAction: AgentAdminRevokeAction;
}

function AdminNotice({ notice }: Readonly<{ notice: AgentAdminNotice }>) {
  return (
    <p
      className={`notice notice-${notice.kind}`}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      {notice.message}
    </p>
  );
}

function readableDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function keyStatus(
  key: AgentApiKeySummary,
  renderedAt: string,
): 'Active' | 'Expired' | 'Revoked' {
  if (key.revokedAt !== null) {
    return 'Revoked';
  }
  if (
    key.expiresAt !== null &&
    Date.parse(renderedAt) >= Date.parse(key.expiresAt)
  ) {
    return 'Expired';
  }
  return 'Active';
}

function facilityName(
  facilityId: string,
  facilities: readonly AgentAdminFacility[],
): string {
  const facility = facilities.find((candidate) => candidate.id === facilityId);
  return facility === undefined
    ? `Unlisted facility (${facilityId})`
    : `${facility.name} (${facility.code})`;
}

function FacilityScopeDisplay({
  apiKey,
  facilities,
}: Readonly<{
  apiKey: AgentApiKeySummary;
  facilities: readonly AgentAdminFacility[];
}>) {
  if (apiKey.facilityScope.kind === 'district') {
    return <span>District-wide</span>;
  }
  return (
    <ul className="compact-list">
      {apiKey.facilityScope.facilityIds.map((facilityId) => (
        <li key={facilityId}>{facilityName(facilityId, facilities)}</li>
      ))}
    </ul>
  );
}

function OneTimeCredential({
  issuance,
}: Readonly<{ issuance: AgentApiKeyIssuance }>) {
  const credentialAlertRef = useRef<HTMLElement>(null);
  const helpId = `credential-help-${issuance.key.id}`;

  useEffect(() => {
    credentialAlertRef.current?.focus();
  }, [issuance.key.id]);

  return (
    <section
      aria-labelledby="one-time-credential-heading"
      className="credential-alert"
      ref={credentialAlertRef}
      role="alert"
      tabIndex={-1}
    >
      <h2 id="one-time-credential-heading">Store this API key now</h2>
      <p id={helpId}>
        This credential is shown once and cannot be recovered. Copy it into the
        approved secret store before leaving or refreshing this page. Do not
        paste it into tickets, chat, email, source code, or event records.
      </p>
      <label className="credential-field">
        One-time credential
        <input
          aria-describedby={helpId}
          autoCapitalize="none"
          autoComplete="off"
          data-1p-ignore
          readOnly
          spellCheck={false}
          type="text"
          value={issuance.oneTimeCredential}
        />
      </label>
      <dl className="credential-summary">
        <dt>Agent</dt>
        <dd>{issuance.key.displayName}</dd>
        <dt>Key prefix</dt>
        <dd>
          <code>{issuance.key.keyPrefix}</code>
        </dd>
      </dl>
    </section>
  );
}

function ScopeEditor({
  facilities,
}: Readonly<{ facilities: readonly AgentAdminFacility[] }>) {
  return (
    <fieldset>
      <legend>Facility scope</legend>
      <p className="field-help" id="facility-scope-help">
        Select the smallest scope this agent needs. The server validates the
        selected scope on every call.
      </p>
      <label className="choice-row">
        <input
          aria-describedby="facility-scope-help"
          defaultChecked
          name="facilityScopeKind"
          type="radio"
          value="facilities"
        />
        Selected facilities only
      </label>
      <div className="choice-grid facility-choices">
        {facilities.map((facility) => (
          <label className="choice-card" key={facility.id}>
            <input
              disabled={!facility.active}
              name="facilityIds"
              type="checkbox"
              value={facility.id}
            />
            <span>
              <strong>{facility.name}</strong>
              <small>
                {facility.code}
                {facility.active ? '' : ' — inactive'}
              </small>
            </span>
          </label>
        ))}
      </div>
      <label className="choice-row district-choice">
        <input
          aria-describedby="district-scope-warning"
          name="facilityScopeKind"
          type="radio"
          value="district"
        />
        District-wide access
      </label>
      <p className="field-help warning-text" id="district-scope-warning">
        District-wide scope is broad. Use it only when every facility is
        required for the agent's documented purpose.
      </p>
    </fieldset>
  );
}

function CapabilityEditor({
  grantOptions,
}: Readonly<{ grantOptions: readonly AgentCapabilityOption[] }>) {
  const safeGrantOptions = grantOptions.filter(
    (option) => !isHumanOnlyActionId(option.id),
  );
  return (
    <fieldset>
      <legend>Capability scope</legend>
      <p className="field-help" id="capability-scope-help">
        Grant only the operations required for this agent. At least one
        capability is required.
      </p>
      <div
        aria-describedby="capability-scope-help"
        className="choice-grid capability-choices"
      >
        {safeGrantOptions.map((option) => (
          <label className="choice-card" key={option.id}>
            <input name="capabilityIds" type="checkbox" value={option.id} />
            <span>
              <strong>{option.label}</strong>
              <small>{option.description}</small>
              <code>{option.id}</code>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function IssueKeyForm({
  action,
  agents,
  facilities,
  grantOptions,
  initialIdempotencyKey,
}: Readonly<{
  action: AgentAdminIssueAction;
  agents: readonly AgentAdminAgent[];
  facilities: readonly AgentAdminFacility[];
  grantOptions: readonly AgentCapabilityOption[];
  initialIdempotencyKey: string;
}>) {
  const [state, formAction, pending] = useActionState(action, {
    issuedKey: null,
    idempotencyKey: initialIdempotencyKey,
    notice: null,
  });
  return (
    <>
      {state.notice === null ? null : <AdminNotice notice={state.notice} />}
      {state.issuedKey === null ? null : (
        <OneTimeCredential issuance={state.issuedKey} />
      )}
      <form
        action={formAction}
        aria-label="Issue agent API key"
        className="admin-form"
      >
        <input
          name="idempotencyKey"
          type="hidden"
          value={state.idempotencyKey}
        />
        <fieldset>
          <legend>Agent and key</legend>
          <div className="form-grid">
            <label>
              Agent identity
              <select defaultValue="" name="agentId">
                <option value="">Create a new agent identity</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.displayName}
                  </option>
                ))}
              </select>
              <span className="field-help">
                Select an existing identity when rotating or narrowing its key.
              </span>
            </label>
            <label>
              Key display name
              <input
                autoComplete="off"
                maxLength={160}
                name="displayName"
                placeholder="Facilities reporting agent"
                required
              />
              <span className="field-help">
                Use a purpose, not a person's name or email address.
              </span>
            </label>
            <label>
              Expiration
              <select defaultValue="7776000" name="expiresInSeconds">
                <option value="2592000">30 days</option>
                <option value="7776000">90 days (recommended)</option>
                <option value="31536000">1 year</option>
                <option value="">No automatic expiration</option>
              </select>
            </label>
          </div>
        </fieldset>
        <ScopeEditor facilities={facilities} />
        <CapabilityEditor grantOptions={grantOptions} />
        <button className="primary-action" disabled={pending} type="submit">
          {pending ? 'Issuing…' : 'Issue API key'}
        </button>
      </form>
    </>
  );
}

function RevokeKeyForm({
  action,
  apiKey,
}: Readonly<{
  action: AgentAdminRevokeAction;
  apiKey: AgentApiKeySummary;
}>) {
  const confirmationId = `confirm-revoke-${apiKey.id}`;
  const [state, formAction, pending] = useActionState(action, { notice: null });
  return (
    <details className="revoke-disclosure">
      <summary>Revoke key</summary>
      {state.notice === null ? null : <AdminNotice notice={state.notice} />}
      <form action={formAction} className="revoke-form">
        <input name="apiKeyId" type="hidden" value={apiKey.id} />
        <input
          name="idempotencyKey"
          type="hidden"
          value={`revoke-agent-key:${apiKey.id}`}
        />
        <label>
          Reason
          <select defaultValue="ADMIN_KEY_ROTATION" name="reasonCode">
            <option value="ADMIN_KEY_ROTATION">Routine key rotation</option>
            <option value="AGENT_RETIRED">Agent retired</option>
            <option value="SCOPE_REPLACED">Scope replaced</option>
            <option value="SUSPECTED_EXPOSURE">Suspected exposure</option>
          </select>
        </label>
        <label className="choice-row" htmlFor={confirmationId}>
          <input
            id={confirmationId}
            name="confirmRevocation"
            required
            type="checkbox"
            value="confirmed"
          />
          I understand this key will stop authenticating immediately.
        </label>
        <button className="danger-action" disabled={pending} type="submit">
          {pending ? 'Revoking…' : 'Confirm revocation'}
        </button>
      </form>
    </details>
  );
}

function KeyTable({
  action,
  agent,
  facilities,
  renderedAt,
}: Readonly<{
  action: AgentAdminRevokeAction;
  agent: AgentAdminAgent;
  facilities: readonly AgentAdminFacility[];
  renderedAt: string;
}>) {
  const keys = agent.keys.filter((apiKey) => apiKey.agentId === agent.id);
  if (keys.length === 0) {
    return <p role="status">This agent has no retained API keys.</p>;
  }
  return (
    <div
      aria-label={`API keys for ${agent.displayName}`}
      className="table-region"
      role="region"
      tabIndex={0}
    >
      <table>
        <caption>Issued keys and current authorization scope</caption>
        <thead>
          <tr>
            <th scope="col">Key</th>
            <th scope="col">Facility scope</th>
            <th scope="col">Capability scope</th>
            <th scope="col">Lifetime</th>
            <th scope="col">Status</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((apiKey) => {
            const status = keyStatus(apiKey, renderedAt);
            return (
              <tr key={apiKey.id}>
                <td>
                  <strong>{apiKey.displayName}</strong>
                  <span className="stacked-detail">
                    Prefix <code>{apiKey.keyPrefix}</code>
                  </span>
                </td>
                <td>
                  <FacilityScopeDisplay
                    apiKey={apiKey}
                    facilities={facilities}
                  />
                </td>
                <td>
                  <ul className="compact-list capability-list">
                    {apiKey.capabilityIds.map((capabilityId) => (
                      <li key={capabilityId}>
                        <code>{capabilityId}</code>
                      </li>
                    ))}
                  </ul>
                </td>
                <td>
                  <span className="stacked-detail">
                    Issued{' '}
                    <time dateTime={apiKey.issuedAt}>
                      {readableDate(apiKey.issuedAt)}
                    </time>
                  </span>
                  <span className="stacked-detail">
                    {apiKey.expiresAt === null ? (
                      'No automatic expiration'
                    ) : (
                      <>
                        Expires{' '}
                        <time dateTime={apiKey.expiresAt}>
                          {readableDate(apiKey.expiresAt)}
                        </time>
                      </>
                    )}
                  </span>
                </td>
                <td>
                  <span
                    className={`status-badge status-${status.toLowerCase()}`}
                  >
                    {status}
                  </span>
                  {apiKey.revokedAt === null ? null : (
                    <span className="stacked-detail">
                      <time dateTime={apiKey.revokedAt}>
                        {readableDate(apiKey.revokedAt)}
                      </time>
                    </span>
                  )}
                </td>
                <td>
                  {status === 'Active' ? (
                    <RevokeKeyForm action={action} apiKey={apiKey} />
                  ) : (
                    <span>No action available</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AgentAuditTable({
  agent,
  facilities,
}: Readonly<{
  agent: AgentAdminAgent;
  facilities: readonly AgentAdminFacility[];
}>) {
  const records = agent.auditRecords.filter(
    (record) => record.principal.agentId === agent.id,
  );
  if (records.length === 0) {
    return <p role="status">No agent calls are present in this audit view.</p>;
  }
  return (
    <div
      aria-label={`Agent call audit for ${agent.displayName}`}
      className="table-region"
      role="region"
      tabIndex={0}
    >
      <table>
        <caption>
          Recent append-only security-log facts for calls attributed to this
          agent
        </caption>
        <thead>
          <tr>
            <th scope="col">Sequence</th>
            <th scope="col">Time</th>
            <th scope="col">API key</th>
            <th scope="col">Capability</th>
            <th scope="col">Source</th>
            <th scope="col">Facility</th>
            <th scope="col">Outcome</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id}>
              <td>{record.sequence}</td>
              <td>
                <time dateTime={record.occurredAt}>
                  {readableDate(record.occurredAt)}
                </time>
              </td>
              <td>
                <code>{record.principal.apiKeyId}</code>
              </td>
              <td>
                <code>{record.action}</code>
              </td>
              <td>{record.source}</td>
              <td>
                {record.facilityId === null
                  ? 'District or not facility-specific'
                  : facilityName(record.facilityId, facilities)}
              </td>
              <td>{record.outcome}</td>
              <td>{record.reasonCode ?? 'None'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgentRecord({
  agent,
  facilities,
  renderedAt,
  revokeKeyAction,
}: Readonly<{
  agent: AgentAdminAgent;
  facilities: readonly AgentAdminFacility[];
  renderedAt: string;
  revokeKeyAction: AgentAdminRevokeAction;
}>) {
  const headingId = `agent-${agent.id}`;
  const keysHeadingId = `agent-keys-${agent.id}`;
  const auditHeadingId = `agent-audit-${agent.id}`;
  return (
    <article aria-labelledby={headingId} className="agent-card">
      <header>
        <p className="eyebrow">Agent identity</p>
        <h2 id={headingId}>{agent.displayName}</h2>
        <p className="agent-id">
          Internal agent ID: <code>{agent.id}</code>
        </p>
      </header>
      <section aria-labelledby={keysHeadingId}>
        <h3 id={keysHeadingId}>API keys</h3>
        <KeyTable
          action={revokeKeyAction}
          agent={agent}
          facilities={facilities}
          renderedAt={renderedAt}
        />
      </section>
      <section aria-labelledby={auditHeadingId}>
        <h3 id={auditHeadingId}>Agent call audit</h3>
        <AgentAuditTable agent={agent} facilities={facilities} />
      </section>
    </article>
  );
}

/** Pure presentation boundary; authentication, validation, and writes stay in server actions. */
export function AgentAdmin({
  agents,
  facilities,
  grantOptions,
  issueIdempotencyKey,
  issuedKey,
  notice,
  renderedAt,
  issueKeyAction,
  revokeKeyAction,
}: AgentAdminProps) {
  return (
    <main id="main-content" tabIndex={-1}>
      <header className="page-header">
        <p className="eyebrow">PSD EOC administration</p>
        <h1>Agent access</h1>
        <p className="lede">
          Issue narrowly scoped API keys, revoke access, and review recent
          audited calls attributed to a district agent.
        </p>
      </header>

      <aside aria-labelledby="human-only-boundary" className="safety-notice">
        <h2 id="human-only-boundary">Human-only safety boundary</h2>
        <p>
          An agent key can never start a real incident, send a real
          notification, issue an all-clear, or close a real event. The server
          enforces this boundary regardless of the facilities or capabilities
          selected below.
        </p>
      </aside>

      {notice === null ? null : <AdminNotice notice={notice} />}

      {issuedKey === null ? null : <OneTimeCredential issuance={issuedKey} />}

      <section aria-labelledby="issue-key-heading" className="page-section">
        <h2 id="issue-key-heading">Issue an API key</h2>
        <IssueKeyForm
          action={issueKeyAction}
          agents={agents}
          facilities={facilities}
          grantOptions={grantOptions}
          initialIdempotencyKey={issueIdempotencyKey}
        />
      </section>

      <section
        aria-labelledby="retained-agents-heading"
        className="page-section"
      >
        <h2 id="retained-agents-heading">Retained agent access</h2>
        {agents.length === 0 ? (
          <p className="empty-state" role="status">
            No agent identities have been issued keys.
          </p>
        ) : (
          <div className="agent-list">
            {agents.map((agent) => (
              <AgentRecord
                agent={agent}
                facilities={facilities}
                key={agent.id}
                renderedAt={renderedAt}
                revokeKeyAction={revokeKeyAction}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
