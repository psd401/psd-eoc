import {
  SetPartnerAlertSettingsInputSchema,
  type CapabilityInput,
} from '@psd-eoc/contracts';

import type { AdminForm } from '../../facilities/admin-request';

/**
 * Reads the settings form. Checkboxes arrive only when checked, one per
 * response or threat, so either list may be empty; a blank base version
 * means no version had been saved when the page was opened.
 */
export function parsePartnerAlertSettingsForm(
  form: AdminForm,
): CapabilityInput<'set-partner-alert-settings'> {
  form.assertFields(
    [
      'csrfToken',
      'idempotencyKey',
      'intent',
      'baseVersionId',
      'responseFamilyKeys',
      'excludedThreatKeys',
    ],
    ['responseFamilyKeys', 'excludedThreatKeys'],
  );
  return SetPartnerAlertSettingsInputSchema.parse({
    responseFamilyKeys: form.all('responseFamilyKeys'),
    excludedThreatKeys: form.all('excludedThreatKeys'),
    baseVersionId: form.optional('baseVersionId'),
  });
}
