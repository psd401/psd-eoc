import { describe, expect, test } from 'bun:test';

import { EmailMessageError, buildEmailMessageContent } from './email-message';

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
    expect(content.htmlBody).not.toContain('<img');
    expect(content.htmlBody).not.toContain('<table');
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
