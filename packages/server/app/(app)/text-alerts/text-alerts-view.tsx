'use client';

import type { SmsConsentDisclosure, SmsConsentState } from '@psd-eoc/contracts';
import { useActionState } from 'react';

export interface TextAlertsNotice {
  readonly kind: 'error' | 'success';
  readonly message: string;
}

export interface TextAlertsState {
  readonly notice: TextAlertsNotice | null;
  readonly idempotencyKey: string;
}

export type TextAlertsAction = (
  previousState: TextAlertsState,
  formData: FormData,
) => Promise<TextAlertsState>;

export interface TextAlertsViewProps {
  readonly consent: SmsConsentState;
  readonly disclosure: SmsConsentDisclosure;
  readonly consentIdempotencyKey: string;
  readonly withdrawIdempotencyKey: string;
  readonly notice: TextAlertsNotice | null;
  readonly recordConsentAction: TextAlertsAction;
  readonly withdrawConsentAction: TextAlertsAction;
}

function Notice({ notice }: Readonly<{ notice: TextAlertsNotice }>) {
  return (
    <p className={`notice notice-${notice.kind}`} role="status">
      {notice.message}
    </p>
  );
}

/**
 * The consent workflow a carrier reviews.
 *
 * The disclosure sits above the agreement control and is always visible: a
 * registration reviewer is shown this screen and asks what the person read
 * before they agreed, so it cannot be behind a disclosure toggle or a link.
 */
export function TextAlertsView({
  consent,
  disclosure,
  consentIdempotencyKey,
  withdrawIdempotencyKey,
  notice,
  recordConsentAction,
  withdrawConsentAction,
}: TextAlertsViewProps) {
  const [recordState, recordFormAction, recordPending] = useActionState(
    recordConsentAction,
    { notice, idempotencyKey: consentIdempotencyKey },
  );
  const [withdrawState, withdrawFormAction, withdrawPending] = useActionState(
    withdrawConsentAction,
    { notice: null, idempotencyKey: withdrawIdempotencyKey },
  );
  const activeNotice = recordState.notice ?? withdrawState.notice;

  return (
    <main
      className="page-shell text-alerts-page"
      id="main-content"
      tabIndex={-1}
    >
      <header className="page-heading">
        <div>
          <p className="eyebrow">My notifications</p>
          <h1>Emergency text messages</h1>
          <p className="lede">{disclosure.summary}</p>
        </div>
      </header>

      {activeNotice === null ? null : <Notice notice={activeNotice} />}

      <section
        aria-labelledby="current-heading"
        className="text-alerts-current"
      >
        <h2 id="current-heading">Your current setting</h2>
        {consent.status === 'consented' ? (
          <>
            <p>
              You are signed up to receive emergency texts at the number ending
              in <strong>{consent.lastFourDigits}</strong>.
            </p>
            <p className="text-alerts-meta">
              Agreed on{' '}
              <time dateTime={consent.consentedAt}>
                {new Date(consent.consentedAt).toISOString().slice(0, 10)}
              </time>{' '}
              to the {consent.disclosureVersion} terms below.
            </p>
            <form action={withdrawFormAction}>
              <input
                name="idempotencyKey"
                type="hidden"
                value={withdrawState.idempotencyKey}
              />
              <button
                className="button button--secondary"
                disabled={withdrawPending}
                type="submit"
              >
                {withdrawPending ? 'Stopping…' : 'Stop texting me'}
              </button>
            </form>
            <p className="text-alerts-meta">
              You can also reply STOP to any PSD EOC text. Stopping here does
              not remove your email or app notifications.
            </p>
          </>
        ) : (
          <p>
            You are not signed up for emergency texts. You will still receive
            email and app notifications.
          </p>
        )}
      </section>

      <section aria-labelledby="terms-heading" className="text-alerts-terms">
        <h2 id="terms-heading">What you are agreeing to</h2>
        <ul>
          {disclosure.terms.map((term) => (
            <li key={term}>{term}</li>
          ))}
        </ul>
        <p>
          <a
            href={disclosure.privacyPolicyUrl}
            rel="noreferrer"
            target="_blank"
          >
            Read the privacy policy
          </a>
        </p>
      </section>

      <section aria-labelledby="consent-heading">
        <h2 id="consent-heading">
          {consent.status === 'consented'
            ? 'Change your number'
            : 'Sign up for emergency texts'}
        </h2>
        <form action={recordFormAction} className="text-alerts-form">
          <input
            name="idempotencyKey"
            type="hidden"
            value={recordState.idempotencyKey}
          />
          <input
            name="disclosureVersion"
            type="hidden"
            value={disclosure.version}
          />
          <div className="field">
            <label htmlFor="phoneNumber">Mobile number</label>
            <input
              autoComplete="tel"
              id="phoneNumber"
              inputMode="tel"
              name="phoneNumber"
              placeholder="(253) 555-0123"
              required
              type="tel"
            />
            <p className="field-hint">
              A US mobile number that can receive text messages.
            </p>
          </div>
          <div className="field field--check">
            {/*
              Never defaulted to checked. A pre-ticked box is not consent under
              carrier rules, and this is the control the whole record rests on.
            */}
            <input
              id="agreed"
              name="agreed"
              required
              type="checkbox"
              value="yes"
            />
            <label htmlFor="agreed">{disclosure.agreementLabel}</label>
          </div>
          <button
            className="button button--primary"
            disabled={recordPending}
            type="submit"
          >
            {recordPending
              ? 'Saving…'
              : consent.status === 'consented'
                ? 'Use this number instead'
                : 'Sign me up'}
          </button>
        </form>
        {consent.status === 'consented' ? (
          <p className="text-alerts-meta">
            Saving a new number replaces the one on file. PSD EOC texts one
            number per person.
          </p>
        ) : null}
      </section>
    </main>
  );
}
