import { randomUUID } from 'node:crypto';

import { MySmsConsentViewSchema } from '@psd-eoc/contracts';
import type { Metadata } from 'next';

import { displayTimeZone } from '../../../lib/config/deployment';
import {
  readMySmsConsentForPage,
  recordSmsConsentAction,
  withdrawSmsConsentAction,
} from './actions';
import { TextAlertsView } from './text-alerts-view';
import '../start/styles.css';
import './styles.css';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = {
  title: { absolute: 'Emergency text messages | PSD EOC' },
  description:
    'Staff sign-up and withdrawal for emergency SMS notifications from PSD EOC.',
};

export default async function TextAlertsPage() {
  // One source for the disclosure: the same capability output the mobile app
  // renders, so the two screens cannot show different terms.
  const { consent, disclosure } = MySmsConsentViewSchema.parse(
    await readMySmsConsentForPage(),
  );
  return (
    <TextAlertsView
      consent={consent}
      consentIdempotencyKey={randomUUID()}
      displayTimeZone={displayTimeZone()}
      disclosure={disclosure}
      notice={null}
      recordConsentAction={recordSmsConsentAction}
      withdrawConsentAction={withdrawSmsConsentAction}
      withdrawIdempotencyKey={randomUUID()}
    />
  );
}
