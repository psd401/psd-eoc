import type { PartnerAdmission } from '@psd-eoc/contracts';

import {
  applicationOrigin,
  displayTimeZone,
  organizationName,
} from '../config/deployment';

/** What a partner email needs to say who it is from and where to go. */
export interface PartnerMessageContext {
  readonly organizationName: string;
  readonly applicationOrigin: string;
  readonly displayTimeZone: string;
}

/** The deployment's own identity, as partner email states it. */
export function partnerMessageContext(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PartnerMessageContext {
  return Object.freeze({
    organizationName: organizationName(environment),
    applicationOrigin: applicationOrigin(environment),
    displayTimeZone: displayTimeZone(environment),
  });
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

/**
 * The one notice a partner receives 14 days before their admission expires.
 * Replying reaches the district's PSD EOC administrators, who renew it.
 */
export function partnerExpiryNoticeMessage(
  admission: Pick<PartnerAdmission, 'displayName' | 'agency' | 'expiresAt'>,
  context: PartnerMessageContext,
): Readonly<{ subject: string; textBody: string }> {
  const expires = readableDate(admission.expiresAt, context.displayTimeZone);
  return Object.freeze({
    subject: `Your PSD EOC access ends on ${expires}`,
    textBody: [
      `${admission.displayName},`,
      `Your access to PSD EOC for ${context.organizationName}, as a responder for ${admission.agency}, ends on ${expires}. After that you will not be able to sign in or receive alerts.`,
      `To keep access, reply to this email and say so. Your reply goes to ${context.organizationName}'s PSD EOC administrators, who can renew it for another year. Nothing changes until they do.`,
      `If you no longer need access, you do not need to do anything.`,
    ].join('\n\n'),
  });
}

/** One partner in the quarterly review: who, and when they last signed in. */
export interface PartnerReviewLine {
  readonly displayName: string;
  readonly agency: string;
  readonly email: string;
  readonly admittedAt: string;
  readonly lastSignInAt: string | null;
}

/**
 * The quarterly review administrators receive: partners invited but never
 * signed in, and partners with no sign-in in 90 days. Review only — nothing
 * here disables anyone; the Access page is where an administrator acts.
 */
export function partnerAccessReviewMessage(
  review: Readonly<{
    neverSignedIn: readonly PartnerReviewLine[];
    inactive: readonly PartnerReviewLine[];
  }>,
  context: PartnerMessageContext,
): Readonly<{ subject: string; textBody: string }> {
  const line = (partner: PartnerReviewLine, signedIn: boolean) =>
    `- ${partner.displayName} (${partner.agency}), ${partner.email}: ${
      signedIn && partner.lastSignInAt !== null
        ? `last signed in ${readableDate(partner.lastSignInAt, context.displayTimeZone)}`
        : `invited ${readableDate(partner.admittedAt, context.displayTimeZone)}, never signed in`
    }`;
  const section = (
    heading: string,
    partners: readonly PartnerReviewLine[],
    signedIn: boolean,
  ) =>
    `${heading}\n${
      partners.length === 0
        ? '- None.'
        : partners.map((partner) => line(partner, signedIn)).join('\n')
    }`;
  return Object.freeze({
    subject: `Quarterly partner access review for ${context.organizationName}`,
    textBody: [
      `This is the quarterly review of partner (outside-agency) access to PSD EOC. It lists partners who may no longer need access. Nobody has been disabled; review the list and disable anyone who should not keep access on the Access page: ${context.applicationOrigin}/access`,
      section(
        `Invited but never signed in (${review.neverSignedIn.length}):`,
        review.neverSignedIn,
        false,
      ),
      section(
        `No sign-in in the last 90 days (${review.inactive.length}):`,
        review.inactive,
        true,
      ),
    ].join('\n\n'),
  });
}
