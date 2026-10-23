import type { PartnerAdmission } from '@psd-eoc/contracts';

/** What a partner email needs to say who it is from and where to go. */
export interface PartnerMessageContext {
  readonly organizationName: string;
  readonly applicationOrigin: string;
  readonly displayTimeZone: string;
}

function readableDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeZone,
  }).format(new Date(value));
}

/**
 * The invitation a partner receives when an administrator admits them. It
 * says how to sign in, how long access lasts, and that renewal goes through
 * the district — never a credential: the sign-in code arrives separately,
 * from the identity provider, each time the partner signs in.
 */
export function partnerInvitationMessage(
  admission: Pick<PartnerAdmission, 'displayName' | 'agency' | 'expiresAt'>,
  context: PartnerMessageContext,
): Readonly<{ subject: string; textBody: string }> {
  return Object.freeze({
    subject: `You have access to PSD EOC for ${context.organizationName}`,
    textBody: [
      `${admission.displayName},`,
      `${context.organizationName} has given you access to PSD EOC, its emergency notification and operations system, as a responder for ${admission.agency}.`,
      `To sign in, go to ${context.applicationOrigin}/auth/sign-in, choose partner agency sign-in, and enter this email address. A one-time code is emailed to you each time you sign in; nobody from the district will ever ask you for it.`,
      `Your access lasts until ${readableDate(admission.expiresAt, context.displayTimeZone)}. You will be emailed before then with how to ask for it to be renewed.`,
      `If you were not expecting this, you can ignore it; nothing happens unless you sign in.`,
    ].join('\n\n'),
  });
}
