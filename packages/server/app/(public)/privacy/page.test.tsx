import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import PrivacyPage from './page';

describe('public privacy policy', () => {
  test('discloses the complete staff-only data boundary without authentication', () => {
    const previousOrganization = process.env.PSD_EOC_ORGANIZATION_NAME;
    const previousContact = process.env.PSD_EOC_PRIVACY_CONTACT_URL;
    process.env.PSD_EOC_ORGANIZATION_NAME = 'Example Unified School District';
    process.env.PSD_EOC_PRIVACY_CONTACT_URL =
      'https://www.example.invalid/contact';
    let markup: string;
    try {
      markup = renderToStaticMarkup(<PrivacyPage />);
    } finally {
      if (previousOrganization === undefined) {
        delete process.env.PSD_EOC_ORGANIZATION_NAME;
      } else {
        process.env.PSD_EOC_ORGANIZATION_NAME = previousOrganization;
      }
      if (previousContact === undefined) {
        delete process.env.PSD_EOC_PRIVACY_CONTACT_URL;
      } else {
        process.env.PSD_EOC_PRIVACY_CONTACT_URL = previousContact;
      }
    }

    for (const text of [
      'Privacy policy',
      'Example Unified School District',
      'Staff identity and access data',
      'work notification email address or phone number',
      'authorized staff who have not signed in',
      'Device and notification data',
      'Event content, media, and foreground location',
      'staff attribution',
      'Service providers',
      'notification title and body',
      'event and facility routing identifiers',
      'Retention and deletion',
      'No advertising or sale of data',
      'Student data is outside the scope of PSD EOC',
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('href="https://www.example.invalid/contact"');
    expect(markup).toContain('encrypted in transit');
    expect(markup).toContain('append-only');
    expect(markup).not.toContain('Sign in with Google');
    expect(markup).not.toContain('recipient roster');
  });
});
