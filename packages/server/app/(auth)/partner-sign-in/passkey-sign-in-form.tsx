'use client';

import {
  PartnerPasskeySignInStartResponseSchema,
  type PartnerPasskeyRequestOptions,
} from '@psd-eoc/contracts';
import { useState, type FormEvent } from 'react';

import { assertPartnerPasskey, passkeysAvailable } from './passkey-ceremony';
import { PARTNER_PASSKEY_ACTION, PARTNER_SIGN_IN_ACTION } from './status';

/**
 * The address step, with a passkey tried first.
 *
 * The form underneath is the same plain POST it has always been, and it is
 * what submits when there is no script, no passkey, or no willing
 * authenticator. The only thing this component adds is asking, before the
 * form posts, whether this address can sign in without an inbox.
 *
 * Every path that is not a completed passkey sign-in ends in the plain form
 * submitting, so a partner can never be stranded: a cancelled ceremony, a
 * browser that refuses, a pool that answers `code`, and an address with no
 * passkey all land on the emailed code.
 *
 * Issue #599.
 */
export function PartnerPasskeySignInForm({
  organization,
}: Readonly<{ organization: string }>) {
  const [busy, setBusy] = useState(false);

  async function trySignIn(email: string): Promise<boolean> {
    let options: PartnerPasskeyRequestOptions;
    try {
      const started = await fetch(PARTNER_PASSKEY_ACTION, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ step: 'sign-in-start', email }),
      });
      if (!started.ok) {
        return false;
      }
      const answer = PartnerPasskeySignInStartResponseSchema.parse(
        await started.json(),
      );
      if (answer.method === 'code') {
        return false;
      }
      options = answer.options;
    } catch {
      return false;
    }

    const credential = await assertPartnerPasskey(options);
    if (credential === null) {
      return false;
    }
    let destination = '/';
    try {
      const finished = await fetch(PARTNER_PASSKEY_ACTION, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ step: 'sign-in-finish', credential }),
      });
      if (!finished.ok) {
        return false;
      }
      // Where the server says to go, so the two cannot drift apart. Only a
      // same-origin path is followed: the answer is this deployment's own,
      // but a redirect target is not something to take on trust.
      const answer: unknown = await finished.json();
      const location =
        answer !== null &&
        typeof answer === 'object' &&
        typeof (answer as { location?: unknown }).location === 'string'
          ? (answer as { location: string }).location
          : '/';
      destination =
        location.startsWith('/') && !location.startsWith('//') ? location : '/';
    } catch {
      return false;
    }
    // The session cookie is set; a full navigation is what picks it up.
    window.location.assign(destination);
    return true;
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    if (!passkeysAvailable() || busy) {
      return;
    }
    const element = event.currentTarget;
    const email = new FormData(element).get('email');
    if (typeof email !== 'string' || email.trim().length === 0) {
      return;
    }
    event.preventDefault();
    setBusy(true);
    void trySignIn(email.trim().toLowerCase()).then((signedIn) => {
      if (signedIn) {
        return;
      }
      // Fall back to the emailed code by letting the form post for real.
      setBusy(false);
      element.submit();
    });
  }

  return (
    <form method="post" action={PARTNER_SIGN_IN_ACTION} onSubmit={onSubmit}>
      <input type="hidden" name="step" value="send-code" />
      <label className="field-label" htmlFor="partner-email">
        Your agency email address
      </label>
      <input
        className="field-input"
        id="partner-email"
        name="email"
        type="email"
        autoComplete="email webauthn"
        maxLength={320}
        required
      />
      <button className="button-link" type="submit" disabled={busy}>
        {busy ? 'Checking for a passkey…' : 'Continue'}
      </button>
      <p className="supporting-text" aria-live="polite">
        {busy
          ? 'Confirm with your device if you are asked.'
          : `If you have set up a passkey with ${organization}, it is used. Otherwise a sign-in code is emailed to you.`}
      </p>
    </form>
  );
}
