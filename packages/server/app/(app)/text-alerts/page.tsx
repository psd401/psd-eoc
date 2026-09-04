import { randomUUID } from 'node:crypto';

import {
  smsConsentDisclosure,
  SmsConsentStateSchema,
} from '@psd-eoc/contracts';
import type { Metadata } from 'next';

import {
  organizationName,
  privacyContactUrl,
  smsSupportEmail,
  smsSupportPhone,
} from '../../../lib/config/deployment';
import {
  readMySmsConsentForPage,
  recordSmsConsentAction,
  withdrawSmsConsentAction,
} from './actions';
import { TextAlertsView } from './text-alerts-view';
import './styles.css';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = {
  title: { absolute: 'Emergency text messages | PSD EOC' },
  description:
    'Staff sign-up and withdrawal for emergency SMS notifications from PSD EOC.',
};

export default async function TextAlertsPage() {
  const consent = SmsConsentStateSchema.parse(await readMySmsConsentForPage());
  const disclosure = smsConsentDisclosure({
    organizationName: organizationName(),
    privacyPolicyUrl: privacyContactUrl(),
    supportEmail: smsSupportEmail(),
    supportPhone: smsSupportPhone(),
  });
  return (
    <TextAlertsView
      consent={consent}
      consentIdempotencyKey={randomUUID()}
      disclosure={disclosure}
      notice={null}
      recordConsentAction={recordSmsConsentAction}
      withdrawConsentAction={withdrawSmsConsentAction}
      withdrawIdempotencyKey={randomUUID()}
    />
  );
}
