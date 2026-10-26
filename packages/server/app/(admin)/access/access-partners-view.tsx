import type {
  PartnerAccessRecord,
  PartnerAccessStatus,
  PartnerTextAlerts,
} from '@psd-eoc/contracts';

import {
  PARTNER_INACTIVITY_DAYS,
  partnerInactivityReview,
} from '../../../lib/partners/sweep';
import { AdminMutationFields } from '../facilities/admin-form-fields';

const STATUS_LABELS: Readonly<Record<PartnerAccessStatus, string>> =
  Object.freeze({
    invited: 'Invited — has not signed in',
    active: 'Active',
    disabled: 'Disabled',
    expired: 'Expired',
    superseded: 'Replaced',
  });

/**
 * A STOP is the partner's own choice at their phone, so it reads as such:
 * the district cannot text them until they reply START to that number.
 */
const TEXT_ALERT_LABELS: Readonly<Record<PartnerTextAlerts, string>> =
  Object.freeze({
    'not-signed-up': 'Not signed up',
    'signed-up': 'Signed up',
    'opted-out': 'Opted out — replied STOP',
  });

function day(value: string | null): string {
  return value === null ? '—' : value.slice(0, 10);
}

/**
 * Disabled, expired, active, and invited-but-never-signed-in read differently
 * in words, not only in colour, so every status is distinct to a screen
 * reader and in print. An ended admission says when it ended.
 */
export function partnerStatusLabel(record: PartnerAccessRecord): string {
  const label = STATUS_LABELS[record.status];
  const ending = record.admission.ending;
  if (ending !== null) return `${label} ${day(ending.endedAt)}`;
  if (record.status === 'expired') {
    return `${label} ${day(record.admission.expiresAt)}`;
  }
  return label;
}

function providerLabel(record: PartnerAccessRecord): string {
  if (record.providerPendingStep === 'enable') {
    return 'Pending: sign-in account not yet confirmed';
  }
  if (record.providerPendingStep === 'disable') {
    return 'Pending: sign-in account not yet confirmed disabled';
  }
  return 'In sync';
}

function ActionForm({
  csrfToken,
  intent,
  admissionId,
  label,
}: Readonly<{
  csrfToken: string;
  intent: string;
  admissionId: string;
  label: string;
}>) {
  return (
    <form action="/access/api" method="post">
      <AdminMutationFields csrfToken={csrfToken} />
      <input name="intent" type="hidden" value={intent} />
      <input name="partnerAdmissionId" type="hidden" value={admissionId} />
      <button type="submit">{label}</button>
    </form>
  );
}

function InviteFields({
  idPrefix,
  defaults,
}: Readonly<{
  idPrefix: string;
  defaults?: Readonly<{ displayName: string; agency: string }>;
}>) {
  return (
    <>
      <label htmlFor={`${idPrefix}-email`}>
        Email address
        <input
          autoCapitalize="none"
          autoComplete="off"
          id={`${idPrefix}-email`}
          inputMode="email"
          maxLength={320}
          name="email"
          required
          spellCheck={false}
          type="email"
        />
      </label>
      <label htmlFor={`${idPrefix}-name`}>
        Name
        <input
          autoComplete="off"
          defaultValue={defaults?.displayName}
          id={`${idPrefix}-name`}
          maxLength={160}
          name="displayName"
          required
          type="text"
        />
      </label>
      <label htmlFor={`${idPrefix}-agency`}>
        Agency
        <input
          autoComplete="off"
          defaultValue={defaults?.agency}
          id={`${idPrefix}-agency`}
          maxLength={160}
          name="agency"
          required
          type="text"
        />
      </label>
    </>
  );
}

/** The Access page's Partners section: who is let in from outside the district. */
function ReviewGroup({
  heading,
  records,
  empty,
}: Readonly<{
  heading: string;
  records: readonly PartnerAccessRecord[];
  empty: string;
}>) {
  return (
    <>
      <h4>
        {heading} ({records.length})
      </h4>
      {records.length === 0 ? (
        <p>{empty}</p>
      ) : (
        <ul>
          {records.map((record) => (
            <li key={record.admission.id}>
              {record.admission.displayName}, {record.admission.agency} (
              {record.admission.email}) — invited{' '}
              {day(record.admission.admittedAt)}, last sign-in{' '}
              {record.lastSignInAt === null
                ? 'never'
                : day(record.lastSignInAt)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function PartnerAccessSection({
  partners,
  configured,
  csrfToken,
  reviewedAt,
}: Readonly<{
  partners: readonly PartnerAccessRecord[];
  /** False when this deployment has no partner identity provider. */
  configured: boolean;
  csrfToken: string;
  /** The instant the inactivity review is computed for. */
  reviewedAt: string;
}>) {
  const review = partnerInactivityReview(partners, new Date(reviewedAt));
  const current = partners.filter((record) => record.admission.ending === null);
  const currentEmails = new Set(
    current.map((record) => record.admission.email),
  );
  // One re-invite per address: its most recent ended admission, and only when
  // no admission for it is current.
  const reinvitable = partners.filter(
    (record, index) =>
      record.admission.ending !== null &&
      record.admission.ending.reason !== 'superseded' &&
      !currentEmails.has(record.admission.email) &&
      partners.findIndex(
        (other) => other.admission.email === record.admission.email,
      ) === index,
  );
  return (
    <section aria-labelledby="partners-heading">
      <h2 id="partners-heading">Partners</h2>
      <p>
        Partners are responders from outside the district — police, fire, and
        other agencies — who sign in with a one-time code sent to their email
        instead of a district Google account. Each admission lasts one year.
        Disabling a partner ends their access at once: their sessions are signed
        out and they stop receiving alerts. An address is never edited;
        correcting one replaces the admission, and every admission stays listed
        as the record of who was let in and when it ended.
      </p>
      {configured ? null : (
        <p className="notice" role="note">
          Partner access is not configured on this deployment, so partners
          cannot be invited or signed in. Existing records are shown below.
        </p>
      )}
      <div
        aria-label="Partners"
        className="table-region"
        role="region"
        tabIndex={0}
      >
        <table>
          <caption>Partner admissions, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Agency</th>
              <th scope="col">Address</th>
              <th scope="col">Status</th>
              <th scope="col">Expires</th>
              <th scope="col">Last sign-in</th>
              <th scope="col">Invitation sent</th>
              <th scope="col">Sign-in account</th>
              <th scope="col">Text alerts</th>
            </tr>
          </thead>
          <tbody>
            {partners.length === 0 ? (
              <tr>
                <td colSpan={9}>No partner has been invited.</td>
              </tr>
            ) : (
              partners.map((record) => (
                <tr
                  data-partner-status={record.status}
                  key={record.admission.id}
                >
                  <th scope="row">{record.admission.displayName}</th>
                  <td>{record.admission.agency}</td>
                  <td>{record.admission.email}</td>
                  <td>{partnerStatusLabel(record)}</td>
                  <td>{day(record.admission.expiresAt)}</td>
                  <td>{day(record.lastSignInAt)}</td>
                  <td>{day(record.invitationSentAt)}</td>
                  <td>{providerLabel(record)}</td>
                  <td>{TEXT_ALERT_LABELS[record.textAlerts]}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <section aria-labelledby="partner-review-heading">
        <h3 id="partner-review-heading">Partner access review</h3>
        <p>
          Partners who may no longer need access. This list is for review only;
          nobody is disabled automatically. Administrators also receive it by
          email each quarter.
        </p>
        <ReviewGroup
          empty="Every current partner has signed in."
          heading="Invited but never signed in"
          records={review.neverSignedIn}
        />
        <ReviewGroup
          empty={`Every partner who has signed in did so in the last ${PARTNER_INACTIVITY_DAYS} days.`}
          heading={`No sign-in in the last ${PARTNER_INACTIVITY_DAYS} days`}
          records={review.inactive}
        />
      </section>
      {configured ? (
        <>
          {current.map((record) => (
            <div
              aria-label={`Manage ${record.admission.displayName} (${record.admission.email})`}
              key={record.admission.id}
              role="group"
            >
              <h3>
                {record.admission.displayName}, {record.admission.agency}
              </h3>
              <ActionForm
                admissionId={record.admission.id}
                csrfToken={csrfToken}
                intent="resend-partner-invitation"
                label={`Resend invitation to ${record.admission.email}`}
              />
              <ActionForm
                admissionId={record.admission.id}
                csrfToken={csrfToken}
                intent="disable-partner"
                label={`Disable ${record.admission.email}`}
              />
              <form action="/access/api" method="post">
                <AdminMutationFields csrfToken={csrfToken} />
                <input name="intent" type="hidden" value="invite-partner" />
                <input
                  name="replacesAdmissionId"
                  type="hidden"
                  value={record.admission.id}
                />
                <input
                  name="email"
                  type="hidden"
                  value={record.admission.email}
                />
                <input
                  name="displayName"
                  type="hidden"
                  value={record.admission.displayName}
                />
                <input
                  name="agency"
                  type="hidden"
                  value={record.admission.agency}
                />
                <input name="renewal" type="hidden" value="true" />
                <button type="submit">
                  Renew {record.admission.email} for one year
                </button>
              </form>
              <form action="/access/api" method="post">
                <AdminMutationFields csrfToken={csrfToken} />
                <input name="intent" type="hidden" value="invite-partner" />
                <input
                  name="replacesAdmissionId"
                  type="hidden"
                  value={record.admission.id}
                />
                <fieldset>
                  <legend>
                    Correct the address of {record.admission.email}
                  </legend>
                  <InviteFields
                    defaults={record.admission}
                    idPrefix={`correct-${record.admission.id}`}
                  />
                  <button type="submit">Replace with corrected address</button>
                </fieldset>
              </form>
            </div>
          ))}
          <div aria-label="Pending sign-in account changes" role="group">
            {partners
              .filter((record) => record.providerPendingStep !== null)
              .map((record) => (
                <ActionForm
                  admissionId={record.admission.id}
                  csrfToken={csrfToken}
                  intent="reconcile-partner"
                  key={record.admission.id}
                  label={`Retry pending change for ${record.admission.email}`}
                />
              ))}
          </div>
          <div aria-label="Re-invite partners" role="group">
            {reinvitable.map((record) => (
              <form
                action="/access/api"
                key={record.admission.id}
                method="post"
              >
                <AdminMutationFields csrfToken={csrfToken} />
                <input name="intent" type="hidden" value="invite-partner" />
                <input name="replacesAdmissionId" type="hidden" value="" />
                <input
                  name="email"
                  type="hidden"
                  value={record.admission.email}
                />
                <input
                  name="displayName"
                  type="hidden"
                  value={record.admission.displayName}
                />
                <input
                  name="agency"
                  type="hidden"
                  value={record.admission.agency}
                />
                <button type="submit">
                  Re-invite {record.admission.email}
                </button>
              </form>
            ))}
          </div>
          <form action="/access/api" method="post">
            <AdminMutationFields csrfToken={csrfToken} />
            <input name="intent" type="hidden" value="invite-partner" />
            <input name="replacesAdmissionId" type="hidden" value="" />
            <fieldset aria-describedby="invite-partner-help">
              <legend>Invite a partner</legend>
              <p className="field-help" id="invite-partner-help">
                The partner gets an email explaining how to sign in. Their
                access lasts one year from today. A district address cannot be
                invited as a partner.
              </p>
              <InviteFields idPrefix="invite-partner" />
              <button type="submit">Invite partner</button>
            </fieldset>
          </form>
        </>
      ) : null}
    </section>
  );
}
