import { describe, expect, test } from 'bun:test';

import { EMAIL_LOGO_PNG_BASE64 } from './email-logo';
import {
  EMAIL_LOGO_CONTENT_ID,
  EmailBrandingError,
  EmailMessageError,
  buildEmailMessageContent as buildWithBranding,
  parseEmailBranding,
} from './email-message';

const BRANDING = parseEmailBranding({
  organizationName: 'Example School District',
  applicationOrigin: 'https://eoc.example.invalid',
  senderDisplayName: 'PSD EOC Alerts',
});

function buildEmailMessageContent(value: unknown) {
  return buildWithBranding(value, BRANDING);
}

type EmailEventKind = 'incident' | 'drill' | 'test';
type EmailPurpose = 'activation' | 'all-clear' | 'reactivation';

function renderedEmail(
  eventKind: EmailEventKind,
  purpose: EmailPurpose = 'activation',
) {
  const real = eventKind === 'incident';
  const templateMode = real ? ('real' as const) : ('drill' as const);
  const classificationMarker = real
    ? ('INCIDENT' as const)
    : ('DRILL' as const);
  const heading = real ? 'REAL INCIDENT' : 'TRAINING ONLY';
  const purposeLabel = {
    activation: 'ACTIVATION',
    'all-clear': 'ALL CLEAR',
    reactivation: 'REACTIVATION',
  }[purpose];
  const prefix = `[${classificationMarker}] ${heading} - ${purposeLabel}:`;

  return {
    eventKind,
    templateMode,
    purpose,
    classificationMarker,
    channel: 'email' as const,
    subject: `${prefix} Synthetic response at Harbor School [${classificationMarker}]`,
    textBody: `${prefix} Follow the recorded response plan.\n\nOpen PSD EOC for current instructions. [${classificationMarker}]`,
  };
}

describe('email message content', () => {
  test('preserves canonical real subject and plaintext exactly', () => {
    const message = renderedEmail('incident');
    const content = buildEmailMessageContent(message);

    expect(content.subject).toBe(message.subject);
    expect(content.textBody).toBe(message.textBody);
    expect(Object.isFrozen(content)).toBe(true);
    expect(content.htmlBody).toContain('<!doctype html>');
    expect(content.htmlBody).toContain('<html lang="en">');
    expect(content.htmlBody).toContain('<meta charset="utf-8">');
    expect(content.htmlBody).toContain('<main ');
    expect(content.htmlBody).toContain('>[INCIDENT] REAL INCIDENT</h1>');
    expect(content.htmlBody).toContain(
      '[INCIDENT] REAL INCIDENT - ACTIVATION: Follow the recorded',
    );
    expect(content.htmlBody).not.toContain('[DRILL]');
  });

  for (const eventKind of ['drill', 'test'] as const) {
    test(`${eventKind} email is unmistakably training-only in every alternative`, () => {
      const message = renderedEmail(eventKind);
      const content = buildEmailMessageContent(message);

      expect(content.subject).toBe(message.subject);
      expect(content.textBody).toBe(message.textBody);
      expect(content.subject).toContain('[DRILL] TRAINING ONLY');
      expect(content.textBody).toContain('[DRILL] TRAINING ONLY');
      expect(content.htmlBody).toContain('>[DRILL] TRAINING ONLY</h1>');
      expect(content.htmlBody).toContain('[DRILL] TRAINING ONLY');
      expect(content.htmlBody).not.toContain('[INCIDENT]');
    });
  }

  test('keeps mode and purpose visible for every lifecycle purpose', () => {
    for (const purpose of [
      'activation',
      'all-clear',
      'reactivation',
    ] as const) {
      const message = renderedEmail('drill', purpose);
      const content = buildEmailMessageContent(message);

      expect(content.subject).toBe(message.subject);
      expect(content.textBody).toBe(message.textBody);
      expect(content.htmlBody).toContain('>[DRILL] TRAINING ONLY</h1>');
      expect(content.htmlBody).toContain(
        purpose === 'activation'
          ? 'ACTIVATION'
          : purpose === 'all-clear'
            ? 'ALL CLEAR'
            : 'REACTIVATION',
      );
    }
  });

  test('escapes administrator text in both title and body HTML', () => {
    const base = renderedEmail('drill');
    const message = {
      ...base,
      subject: '[DRILL] TRAINING ONLY - ACTIVATION: A & B <response> [DRILL]',
      textBody:
        '[DRILL] TRAINING ONLY - ACTIVATION: <script>alert("x")</script> & O\'Reilly\nSecond line [DRILL]',
    };

    const content = buildEmailMessageContent(message);

    expect(content.subject).toBe(message.subject);
    expect(content.textBody).toBe(message.textBody);
    expect(content.htmlBody).toContain(
      '<title>[DRILL] TRAINING ONLY - ACTIVATION: A &amp; B &lt;response&gt; [DRILL]</title>',
    );
    expect(content.htmlBody).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; O&#39;Reilly',
    );
    expect(content.htmlBody).toContain('<br>Second line [DRILL]');
    expect(content.htmlBody).not.toContain('<script>');
    // The only image is the embedded logo, never administrator content.
    expect(content.htmlBody.match(/<img /gu)).toHaveLength(1);
    expect(content.htmlBody).not.toContain('<table');
  });

  test('brands the HTML alternative without touching canonical copy', () => {
    for (const eventKind of ['incident', 'drill'] as const) {
      const message = renderedEmail(eventKind);
      const content = buildEmailMessageContent(message);

      expect(content.subject).toBe(message.subject);
      expect(content.textBody).toBe(message.textBody);
      expect(content.textBody).not.toContain('Example School District');
      expect(content.htmlBody).toContain(
        `<img src="cid:${EMAIL_LOGO_CONTENT_ID}" width="48" height="48" alt=""`,
      );
      expect(content.htmlBody).toContain('>PSD EOC</span>');
      expect(content.htmlBody).toContain(
        'Emergency notification from Example School District',
      );
      expect(content.htmlBody).toContain(
        "Sent by PSD EOC, Example School District's staff emergency notification system.",
      );
      expect(content.htmlBody).toContain(
        'You are receiving this because you are on the emergency notification roster.',
      );
      expect(content.htmlBody).toContain(
        '<a href="https://eoc.example.invalid" ',
      );
      // Brand bar, then mode banner, then details, then footer.
      const order = [
        'cid:psd-eoc-logo',
        '</h1>',
        'aria-label="Notification details"',
        '<footer ',
      ].map((marker) => content.htmlBody.indexOf(marker));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(content.inlineImages).toEqual([
        {
          contentId: EMAIL_LOGO_CONTENT_ID,
          fileName: 'psd-eoc-logo.png',
          contentType: 'image/png',
          base64Content: EMAIL_LOGO_PNG_BASE64,
        },
      ]);
    }
  });

  test('embeds a real PNG logo', () => {
    const bytes = Buffer.from(EMAIL_LOGO_PNG_BASE64, 'base64');
    expect([...bytes.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    // IHDR width and height.
    expect(bytes.readUInt32BE(16)).toBe(128);
    expect(bytes.readUInt32BE(20)).toBe(128);
    expect(bytes.byteLength).toBeLessThan(16_384);
  });

  test('escapes the organization name in the brand bar and footer', () => {
    const content = buildWithBranding(
      renderedEmail('drill'),
      parseEmailBranding({
        organizationName: 'A & B <School> District',
        applicationOrigin: 'https://eoc.example.invalid',
        senderDisplayName: null,
      }),
    );

    expect(content.htmlBody).toContain('A &amp; B &lt;School&gt; District');
    expect(content.htmlBody).not.toContain('<School>');
  });

  test('rejects unsafe branding before any message is built', () => {
    for (const invalid of [
      null,
      { ...BRANDING, organizationName: '  Padded  ' },
      { ...BRANDING, applicationOrigin: 'https://eoc.example.invalid/' },
      { ...BRANDING, applicationOrigin: 'javascript:alert(1)' },
      { ...BRANDING, senderDisplayName: 'Alerts\\' },
      { ...BRANDING, senderDisplayName: ' Alerts' },
      { ...BRANDING, senderDisplayName: 'x'.repeat(65) },
      { ...BRANDING, senderDisplayName: undefined },
    ]) {
      expect(() => parseEmailBranding(invalid)).toThrow(EmailBrandingError);
    }
    expect(
      parseEmailBranding({ ...BRANDING, senderDisplayName: 'x'.repeat(64) })
        .senderDisplayName,
    ).toHaveLength(64);
  });

  test('rejects non-email and classification-drift payloads safely', () => {
    const drill = renderedEmail('drill');
    const nonEmail = {
      eventKind: 'test',
      templateMode: 'drill',
      purpose: 'activation',
      classificationMarker: 'DRILL',
      channel: 'push',
      title: '[DRILL] Synthetic training title',
      body: '[DRILL] Synthetic training body',
    };
    const drifted = {
      ...drill,
      eventKind: 'incident',
    };

    expect(() => buildEmailMessageContent(nonEmail)).toThrow(EmailMessageError);
    expect(() => buildEmailMessageContent(drifted)).toThrow(EmailMessageError);
    expect(() => buildEmailMessageContent(drifted)).toThrow(
      'The rendered email message is invalid.',
    );
    expect(() => buildEmailMessageContent(drifted)).not.toThrow(
      /Synthetic response|Harbor School/u,
    );
  });
});
