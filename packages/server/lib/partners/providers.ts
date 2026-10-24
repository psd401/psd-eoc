import { createHash } from 'node:crypto';

import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

import {
  buildAccountEmailContent,
  parseEmailBranding,
  type EmailBranding,
} from '../../../../workers/email/email-message';
import { applicationOrigin, organizationName } from '../config/deployment';

/**
 * The partner identity provider, as the app manages it: one account per
 * partner address, created without the provider's own invitation (the app
 * sends a branded one), and disabled and signed out everywhere when access
 * ends. Every method is idempotent so a retried reconciliation converges.
 */
export interface PartnerDirectory {
  /** Creates or re-enables the account; returns the provider subject. */
  ensureEnabled(email: string): Promise<Readonly<{ subject: string }>>;
  /** Signs the account out everywhere and disables it; absent is fine. */
  ensureDisabled(email: string): Promise<void>;
}

/** Sends one branded account email to one partner. */
export interface PartnerMailer {
  send(message: PartnerMailMessage): Promise<void>;
}

/** One account email. `replyTo` routes a reply, such as a renewal request. */
export type PartnerMailMessage = Readonly<{
  to: string | readonly string[];
  subject: string;
  textBody: string;
  replyTo?: readonly string[];
}>;

export interface PartnerProviders {
  readonly mode: 'aws' | 'synthetic';
  readonly directory: PartnerDirectory;
  readonly mailer: PartnerMailer;
}

/** Safe failure: never carries an address, a token, or a provider payload. */
export class PartnerProviderError extends Error {
  public constructor(
    public readonly code:
      | 'PARTNER_ACCESS_UNCONFIGURED'
      | 'PARTNER_DIRECTORY_FAILED'
      | 'PARTNER_MAIL_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'PartnerProviderError';
  }
}

const UNCONFIGURED = 'UNCONFIGURED';

/**
 * The pool id that selects the synthetic providers. A deployed stack can
 * never carry it: the `PartnerUserPoolId` parameter accepts only
 * `UNCONFIGURED` or a region-prefixed pool id, so this is reachable only from
 * a test or local process that sets it on purpose.
 */
export const SYNTHETIC_PARTNER_USER_POOL_ID = 'SYNTHETIC';

function providerErrorName(error: unknown): string | null {
  return error !== null &&
    typeof error === 'object' &&
    typeof (error as { name?: unknown }).name === 'string'
    ? (error as { name: string }).name
    : null;
}

/** Cognito, at the dependency boundary. SDK retries stay off; a retry is ours. */
export class CognitoPartnerDirectory implements PartnerDirectory {
  public constructor(
    private readonly userPoolId: string,
    private readonly client: Pick<
      CognitoIdentityProviderClient,
      'send'
    > = new CognitoIdentityProviderClient({ maxAttempts: 1 }),
  ) {}

  public async ensureEnabled(
    email: string,
  ): Promise<Readonly<{ subject: string }>> {
    try {
      const created = await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
          // The app sends the invitation itself, branded, through SES.
          MessageAction: 'SUPPRESS',
        }),
      );
      const subject = created.User?.Attributes?.find(
        (attribute) => attribute.Name === 'sub',
      )?.Value;
      if (subject === undefined) {
        throw new PartnerProviderError(
          'PARTNER_DIRECTORY_FAILED',
          'The partner account was created without a subject.',
        );
      }
      return Object.freeze({ subject });
    } catch (error) {
      if (providerErrorName(error) !== 'UsernameExistsException') {
        throw directoryFailure(error);
      }
    }
    // The account already exists — a re-invite, or a retry after a lost
    // response. Re-enable it if needed and report its subject.
    try {
      const existing = await this.client.send(
        new AdminGetUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
        }),
      );
      if (existing.Enabled !== true) {
        await this.client.send(
          new AdminEnableUserCommand({
            UserPoolId: this.userPoolId,
            Username: email,
          }),
        );
      }
      const subject = existing.UserAttributes?.find(
        (attribute) => attribute.Name === 'sub',
      )?.Value;
      if (subject === undefined) {
        throw new PartnerProviderError(
          'PARTNER_DIRECTORY_FAILED',
          'The partner account has no subject.',
        );
      }
      return Object.freeze({ subject });
    } catch (error) {
      throw directoryFailure(error);
    }
  }

  public async ensureDisabled(email: string): Promise<void> {
    try {
      // Sign-out first: it revokes every refresh token the provider issued,
      // and it is refused for a user who is already disabled on some pools.
      await this.client.send(
        new AdminUserGlobalSignOutCommand({
          UserPoolId: this.userPoolId,
          Username: email,
        }),
      );
      await this.client.send(
        new AdminDisableUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
        }),
      );
    } catch (error) {
      // Never created (the invitation never reached the provider): there is
      // nothing to disable, which is the state wanted.
      if (providerErrorName(error) === 'UserNotFoundException') return;
      throw directoryFailure(error);
    }
  }
}

function directoryFailure(error: unknown): PartnerProviderError {
  if (error instanceof PartnerProviderError) return error;
  return new PartnerProviderError(
    'PARTNER_DIRECTORY_FAILED',
    'The partner identity provider did not complete the change.',
  );
}

/**
 * SES, at the dependency boundary, sending the same branded shell as alerts.
 *
 * Every send names the partner configuration set. A send without one falls to
 * the shared identity's default set, which this deployment does not own and
 * whose bounces reach no one (psd-dev-standards 17 rule 7), so there is no way
 * to construct a mailer without it.
 */
export class SesPartnerMailer implements PartnerMailer {
  public constructor(
    private readonly configuration: Readonly<{
      fromEmailAddress: string;
      configurationSetName: string;
      branding: EmailBranding;
    }>,
    private readonly client: Pick<SESv2Client, 'send'> = new SESv2Client({
      maxAttempts: 1,
    }),
  ) {
    if (configuration.configurationSetName.trim().length === 0) {
      throw new TypeError(
        'Partner account mail requires an SES configuration set.',
      );
    }
  }

  public async send(message: PartnerMailMessage): Promise<void> {
    const content = buildAccountEmailContent(
      message,
      this.configuration.branding,
    );
    const senderDisplayName = this.configuration.branding.senderDisplayName;
    try {
      await this.client.send(
        new SendEmailCommand({
          FromEmailAddress:
            senderDisplayName === null
              ? this.configuration.fromEmailAddress
              : `"${senderDisplayName}" <${this.configuration.fromEmailAddress}>`,
          Destination: {
            ToAddresses:
              typeof message.to === 'string' ? [message.to] : [...message.to],
          },
          ...(message.replyTo === undefined || message.replyTo.length === 0
            ? {}
            : { ReplyToAddresses: [...message.replyTo] }),
          Content: {
            Simple: {
              Subject: { Data: content.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: content.textBody, Charset: 'UTF-8' },
                Html: { Data: content.htmlBody, Charset: 'UTF-8' },
              },
              Attachments: content.inlineImages.map((image) => ({
                ContentId: image.contentId,
                FileName: image.fileName,
                ContentType: image.contentType,
                ContentDisposition: 'INLINE',
                ContentTransferEncoding: 'BASE64',
                RawContent: Buffer.from(image.base64Content, 'base64'),
              })),
            },
          },
          ConfigurationSetName: this.configuration.configurationSetName,
          EmailTags: [{ Name: 'psd-eoc-message', Value: 'partner-account' }],
        }),
      );
    } catch {
      throw new PartnerProviderError(
        'PARTNER_MAIL_FAILED',
        'The partner email could not be sent.',
      );
    }
  }
}

/**
 * Stand-ins for browser tests and local development: the directory derives a
 * stable subject from the address and the mailer sends nothing. Selected only
 * by the synthetic pool id a deployed stack cannot carry.
 */
export function syntheticPartnerProviders(): PartnerProviders {
  return Object.freeze({
    mode: 'synthetic' as const,
    directory: Object.freeze({
      ensureEnabled: (email: string) =>
        Promise.resolve(
          Object.freeze({
            subject: `synthetic-${createHash('sha256').update(email).digest('hex').slice(0, 32)}`,
          }),
        ),
      ensureDisabled: () => Promise.resolve(),
    }),
    mailer: Object.freeze({ send: () => Promise.resolve() }),
  });
}

/**
 * The partner providers this deployment is configured for, or null when
 * partner access is off (the pool parameters read `UNCONFIGURED`). Real
 * providers also need the SES sender the email worker uses and the partner
 * configuration set; without either, partner access stays off rather than
 * sending mail whose bounces no one sees.
 */
export function resolvePartnerProviders(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PartnerProviders | null {
  const userPoolId = environment.PSD_EOC_PARTNER_USER_POOL_ID;
  if (
    userPoolId === undefined ||
    userPoolId === '' ||
    userPoolId === UNCONFIGURED
  ) {
    return null;
  }
  if (userPoolId === SYNTHETIC_PARTNER_USER_POOL_ID) {
    return syntheticPartnerProviders();
  }
  const fromEmailAddress = environment.PSD_EOC_SES_FROM_ADDRESS;
  if (fromEmailAddress === undefined || fromEmailAddress.length === 0) {
    return null;
  }
  const configurationSetName = environment.PSD_EOC_SES_CONFIGURATION_SET_NAME;
  if (
    configurationSetName === undefined ||
    configurationSetName.trim().length === 0
  ) {
    return null;
  }
  const branding = parseEmailBranding({
    organizationName: organizationName(environment),
    applicationOrigin: applicationOrigin(environment),
    senderDisplayName: environment.PSD_EOC_SES_FROM_DISPLAY_NAME ?? null,
  });
  return Object.freeze({
    mode: 'aws' as const,
    directory: new CognitoPartnerDirectory(userPoolId),
    mailer: new SesPartnerMailer({
      fromEmailAddress,
      configurationSetName,
      branding,
    }),
  });
}

/** The configured providers, or a refusal an administrator can read. */
export function requirePartnerProviders(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PartnerProviders {
  const providers = resolvePartnerProviders(environment);
  if (providers === null) {
    throw new PartnerProviderError(
      'PARTNER_ACCESS_UNCONFIGURED',
      'Partner access is not configured on this deployment.',
    );
  }
  return providers;
}
