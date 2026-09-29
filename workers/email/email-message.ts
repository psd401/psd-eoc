import {
  OrganizationNameSchema,
  RenderedMessageSchema,
  SenderDisplayNameSchema,
} from '@psd-eoc/contracts';

import { EMAIL_LOGO_PNG_BASE64 } from './email-logo';

/** Deployment identity shown around, never inside, the canonical copy. */
export interface EmailBranding {
  /** Tenant display name, such as "Example School District". */
  readonly organizationName: string;
  /** Exact https origin of the deployed web app, linked from the footer. */
  readonly applicationOrigin: string;
  /** Inbox sender name; null sends from the bare address. */
  readonly senderDisplayName: string | null;
}

/** An image the HTML references by `cid:`, carried inside the message. */
export interface EmailInlineImage {
  readonly contentId: string;
  readonly fileName: string;
  readonly contentType: 'image/png';
  readonly base64Content: string;
}

/** Multipart content passed to an email provider without changing canonical copy. */
export interface EmailMessageContent {
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
  readonly inlineImages: readonly EmailInlineImage[];
}

/** Safe failure that never reflects message text or a recipient destination. */
export class EmailMessageError extends Error {
  public constructor() {
    super('The rendered email message is invalid.');
    this.name = 'EmailMessageError';
  }
}

export class EmailBrandingError extends Error {
  public constructor() {
    super('The email branding configuration is invalid.');
    this.name = 'EmailBrandingError';
  }
}

export const EMAIL_LOGO_CONTENT_ID = 'psd-eoc-logo';

const EMAIL_LOGO: EmailInlineImage = Object.freeze({
  contentId: EMAIL_LOGO_CONTENT_ID,
  fileName: 'psd-eoc-logo.png',
  contentType: 'image/png',
  base64Content: EMAIL_LOGO_PNG_BASE64,
});

/** Matches the app icon's background so the logo sits flush in the bar. */
const BRAND_BAR_BACKGROUND = '#022345';

function validSesFromDisplayName(value: unknown): value is string {
  return SenderDisplayNameSchema.safeParse(value).success;
}

function exactHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

/** Validates deployment branding once, at construction, and freezes it. */
export function parseEmailBranding(value: unknown): EmailBranding {
  if (value === null || typeof value !== 'object') {
    throw new EmailBrandingError();
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  const organizationName = OrganizationNameSchema.safeParse(
    candidate.organizationName,
  );
  if (
    !organizationName.success ||
    organizationName.data !== candidate.organizationName ||
    !exactHttpsOrigin(candidate.applicationOrigin) ||
    (candidate.senderDisplayName !== null &&
      !validSesFromDisplayName(candidate.senderDisplayName))
  ) {
    throw new EmailBrandingError();
  }
  return Object.freeze({
    organizationName: organizationName.data,
    applicationOrigin: candidate.applicationOrigin,
    senderDisplayName: candidate.senderDisplayName,
  });
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
 * visible heading. The provider-facing subject and plaintext remain exact;
 * the brand bar and footer exist only in the HTML alternative.
 */
export function buildEmailMessageContent(
  value: unknown,
  branding: EmailBranding,
): EmailMessageContent {
  const parsed = RenderedMessageSchema.safeParse(value);
  if (!parsed.success || parsed.data.channel !== 'email') {
    throw new EmailMessageError();
  }

  const message = parsed.data;
  const presentation = MODE_PRESENTATION[message.templateMode];
  const organizationName = escapeHtml(branding.organizationName);
  const applicationOrigin = escapeHtml(branding.applicationOrigin);
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
    `<header style="padding: 16px 24px; background: ${BRAND_BAR_BACKGROUND}; color: #ffffff;">`,
    // Decorative: the product name beside it carries the identity when a
    // client blocks images.
    `<img src="cid:${EMAIL_LOGO_CONTENT_ID}" width="48" height="48" alt="" style="display: inline-block; width: 48px; height: 48px; border: 0; border-radius: 10px; vertical-align: middle;">`,
    '<span style="display: inline-block; margin-left: 12px; vertical-align: middle;">',
    '<span style="display: block; color: #ffffff; font-size: 20px; font-weight: bold; line-height: 1.2;">PSD EOC</span>',
    `<span style="display: block; color: #cbd5e1; font-size: 14px; line-height: 1.4;">Emergency notification from ${organizationName}</span>`,
    '</span>',
    '</header>',
    `<div style="padding: 24px; background: ${presentation.bannerBackground}; color: #ffffff;">`,
    `<h1 style="margin: 0; color: #ffffff; font-size: 28px; line-height: 1.25;">${presentation.heading}</h1>`,
    '</div>',
    '<section aria-label="Notification details" style="padding: 24px;">',
    renderParagraphs(message.textBody),
    '</section>',
    '<footer style="padding: 16px 24px 24px; border-top: 1px solid #e5e7eb; color: #4b5563; font-size: 14px; line-height: 1.5;">',
    `<p style="margin: 0 0 8px;">Sent by PSD EOC, ${organizationName}'s staff emergency notification system. You are receiving this because you are on the emergency notification roster.</p>`,
    `<p style="margin: 0;"><a href="${applicationOrigin}" style="color: #174a7e;">Open PSD EOC</a></p>`,
    '</footer>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');

  return Object.freeze({
    subject: message.subject,
    textBody: message.textBody,
    htmlBody,
    inlineImages: Object.freeze([EMAIL_LOGO]),
  });
}
