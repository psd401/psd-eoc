'use client';

import { PartnerPasskeyRegisterStartResponseSchema } from '@psd-eoc/contracts';
import Link from 'next/link';
import { useState } from 'react';

import { createPartnerPasskey, passkeysAvailable } from '../passkey-ceremony';
import { PARTNER_PASSKEY_ACTION } from '../status';

/**
 * The passkey enrollment offer.
 *
 * Offered once, right after a code sign-in, because the pool authorizes
 * enrollment with its own access token for that sign-in and that token does
 * not outlive the offer. Declining costs nothing: the partner is already
 * signed in, and the next sign-in offers again.
 *
 * Nothing here can fail in a way that matters. A cancelled ceremony, an
 * unwilling authenticator, an expired hand-off, and a pool that refuses all
 * end the same way — the partner continues into the application with the
 * session they already hold, and their emailed code still works.
 *
 * Issue #599.
 */

type Outcome = 'offered' | 'working' | 'registered' | 'unavailable';

export function PartnerPasskeyEnrollment() {
  const [outcome, setOutcome] = useState<Outcome>('offered');

  async function enroll(): Promise<void> {
    setOutcome('working');
    let options;
    try {
      const started = await fetch(PARTNER_PASSKEY_ACTION, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ step: 'register-start' }),
      });
      if (!started.ok) {
        setOutcome('unavailable');
        return;
      }
      options = PartnerPasskeyRegisterStartResponseSchema.parse(
        await started.json(),
      ).options;
    } catch {
      setOutcome('unavailable');
      return;
    }

    const credential = await createPartnerPasskey(options);
    if (credential === null) {
      // Cancelled, or no authenticator would take it. Offer again rather
      // than claiming a failure the partner did not cause.
      setOutcome('offered');
      return;
    }
    try {
      const finished = await fetch(PARTNER_PASSKEY_ACTION, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ step: 'register-finish', credential }),
      });
      setOutcome(finished.ok ? 'registered' : 'unavailable');
    } catch {
      setOutcome('unavailable');
    }
  }

  if (!passkeysAvailable()) {
    return (
      <>
        <p className="supporting-text" data-testid="passkey-outcome">
          This browser cannot store a passkey. You will keep signing in with an
          emailed code.
        </p>
        <Link className="button-link" href="/">
          Continue
        </Link>
      </>
    );
  }

  if (outcome === 'registered') {
    return (
      <>
        <p className="form-message" role="status" data-testid="passkey-outcome">
          Passkey saved. Next time, signing in will ask for your device instead
          of an emailed code.
        </p>
        <Link className="button-link" href="/">
          Continue
        </Link>
      </>
    );
  }

  return (
    <>
      {outcome === 'unavailable' ? (
        <p role="alert" className="form-message" data-testid="passkey-outcome">
          That passkey could not be saved. You are signed in, and an emailed
          code still works.
        </p>
      ) : null}
      <button
        className="button-link"
        type="button"
        disabled={outcome === 'working'}
        onClick={() => void enroll()}
      >
        {outcome === 'working'
          ? 'Waiting for your device…'
          : 'Set up a passkey'}
      </button>
      <p className="supporting-text">
        <Link href="/">Not now</Link>
      </p>
    </>
  );
}
