import { RenderedMessageSchema } from '@psd-eoc/contracts';

/** Multipart content passed to an email provider without changing canonical copy. */
export interface EmailMessageContent {
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
}

/** Safe failure that never reflects message text or a recipient destination. */
export class EmailMessageError extends Error {
  public constructor() {
    super('The rendered email message is invalid.');
    this.name = 'EmailMessageError';
  }
}

const MODE_PRESENTATION = Object.freeze({
  real: Object.freeze({
    heading: '[INCIDENT] REAL INCIDENT',
    bannerBackground: '#8a1c1c',
  }),
  drill: Object.freeze({
    heading: '[DRILL] TRAINING ONLY',
    bannerBackground: '#174a7e',
  }),
});

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderParagraphs(textBody: string): string {
  return textBody
    .split(/\n{2,}/u)
    .map(
      (paragraph) =>
        `<p style="margin: 0 0 16px;">${escapeHtml(paragraph).replaceAll(
          '\n',
          '<br>',
        )}</p>`,
    )
    .join('\n');
}

/**
 * Builds an accessible HTML alternative from the canonical email payload.
 * Administrator text is escaped, while the immutable mode fields own the
 * visible heading. The provider-facing subject and plaintext remain exact.
 */
export function buildEmailMessageContent(value: unknown): EmailMessageContent {
  const parsed = RenderedMessageSchema.safeParse(value);
  if (!parsed.success || parsed.data.channel !== 'email') {
    throw new EmailMessageError();
  }

  const message = parsed.data;
  const presentation = MODE_PRESENTATION[message.templateMode];
  const htmlBody = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    `<title>${escapeHtml(message.subject)}</title>`,
    '</head>',
    '<body style="margin: 0; background: #f3f4f6; color: #111827; font-family: Arial, Helvetica, sans-serif; font-size: 18px; line-height: 1.5;">',
    '<main style="box-sizing: border-box; max-width: 680px; margin: 0 auto; background: #ffffff;">',
    `<header style="padding: 24px; background: ${presentation.bannerBackground}; color: #ffffff;">`,
    `<h1 style="margin: 0; color: #ffffff; font-size: 28px; line-height: 1.25;">${presentation.heading}</h1>`,
    '</header>',
    '<section aria-label="Notification details" style="padding: 24px;">',
    renderParagraphs(message.textBody),
    '</section>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');

  return Object.freeze({
    subject: message.subject,
    textBody: message.textBody,
    htmlBody,
  });
}
