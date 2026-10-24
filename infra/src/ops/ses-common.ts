import process from 'node:process';
import { createInterface } from 'node:readline/promises';

import {
  SES_CONFIGURATION_SET_NAME,
  SES_PARTNER_CONFIGURATION_SET_NAME,
} from '../config';
import {
  tenantAwsAccount,
  tenantAwsRegion,
  tenantString,
} from '../tenant-context';

export { SES_CONFIGURATION_SET_NAME, SES_PARTNER_CONFIGURATION_SET_NAME };
/** From cdk.local.json; the reserved unconfigured account refuses every call. */
export const TARGET_ACCOUNT_ID = tenantAwsAccount();
export const TARGET_REGION = tenantAwsRegion();
/**
 * The SES identity these scripts inspect and send from: the same
 * psdEoc:sesIdentityDomain the stack declares. They once named a separate
 * `alerts.` identity that SES never held, so every readiness check failed.
 */
export const SES_IDENTITY_DOMAIN = tenantString(
  'psdEoc:sesIdentityDomain',
  /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/u,
  { fallback: 'unconfigured.invalid' },
);
/**
 * psd-dev-standards 17 rule 5: `bounce.<identity domain>`, approved
 * 2026-10-23. Never `mail.`: a district's `mail.` host is commonly a CNAME
 * (often to a hosted mail provider), and a CNAME cannot also hold the MX and TXT
 * records a custom MAIL FROM needs. The identity owner sets it, not psd-eoc
 * (rule 2); this repository only reads it.
 */
export const SES_MAIL_FROM_DOMAIN = `bounce.${SES_IDENTITY_DOMAIN}`;
/**
 * The events psd-eoc's own configuration set must publish (standard 17
 * rule 7). The set's destination publishes more; these are the minimum.
 */
export const SES_REQUIRED_EVENT_TYPES = [
  'BOUNCE',
  'COMPLAINT',
  'REJECT',
] as const;
export const SES_CLIENT_MAX_ATTEMPTS = 1;
export const SES_TEST_FROM_ADDRESS = `verification@${SES_IDENTITY_DOMAIN}`;
/** The district's public website: the origin of its privacy contact page. */
export const DISTRICT_WEBSITE_URL = `${
  new URL(
    tenantString('psdEoc:privacyContactUrl', /^https:\/\/[^\s?#]+$/u, {
      fallback: 'https://www.unconfigured.invalid/',
    }),
  ).origin
}/`;
const ORGANIZATION_NAME = tenantString('psdEoc:organizationName', /\S/u, {
  fallback: 'The district',
});

export const PRODUCTION_ACCESS_CONFIRMATION =
  'SUBMIT SES PRODUCTION ACCESS REQUEST';
export const TEST_SEND_CONFIRMATION =
  'SEND TEST ONLY TO APPROVED SYNTHETIC TARGET';

export const PRODUCTION_ACCESS_USE_CASE = `${ORGANIZATION_NAME} will send transactional, staff-only emergency notifications to an opt-in roster of approximately 1,200 authorized district staff recipients. Messages are operational safety notices only: no marketing, no purchased lists, and no student data. Bounces and complaints will be published to the encrypted SES configuration-set SNS event destination. An approved consumer and operational handling must be connected and verified before any staff send; this setup creates no SNS subscription.`;

export const TEST_EMAIL_SUBJECT =
  'TEST ONLY — NO EMERGENCY — PSD EOC SES verification';
export const TEST_EMAIL_BODY =
  'TEST ONLY — NO EMERGENCY\nThis is an authorized synthetic delivery-path check for PSD EOC. It is neither a real incident nor a drill activation.';

export interface CallerIdentity {
  readonly accountId?: string;
  readonly arn?: string;
}

export interface SesAccountSnapshot {
  readonly productionAccessEnabled?: boolean;
  readonly reviewStatus?: string;
  readonly sendingEnabled?: boolean;
}

export interface SesEmailIdentitySnapshot {
  readonly dkimSigningEnabled?: boolean;
  readonly dkimStatus?: string;
  readonly identityType?: string;
  readonly mailFromDomain?: string;
  readonly mailFromDomainStatus?: string;
  readonly verificationStatus?: string;
  readonly verifiedForSendingStatus?: boolean;
}

export interface SesEventDestinationSnapshot {
  readonly enabled: boolean;
  readonly matchingEventTypes: readonly string[];
}

/** `exists: false` is SES's NotFoundException, reported rather than thrown. */
export type SesConfigurationSetSnapshot =
  | { readonly exists: false }
  | {
      readonly eventDestinations: readonly SesEventDestinationSnapshot[];
      readonly exists: true;
      readonly sendingEnabled?: boolean;
      /** Undefined when the set does not override account suppression. */
      readonly suppressedReasons?: readonly string[];
    };

export interface ProductionAccessRequest {
  readonly additionalContactEmailAddresses: string[];
  readonly contactLanguage: 'EN';
  readonly mailType: 'TRANSACTIONAL';
  readonly productionAccessEnabled: true;
  readonly useCaseDescription: string;
  readonly websiteUrl: string;
}

export interface TestEmailRequest {
  readonly configurationSetName: string;
  readonly fromAddress: string;
  readonly recipientAddress: string;
  readonly subject: string;
  readonly textBody: string;
}

export interface SesOperationsApi {
  getAccount(): Promise<SesAccountSnapshot>;
  getCallerIdentity(): Promise<CallerIdentity>;
  getConfigurationSet(name: string): Promise<SesConfigurationSetSnapshot>;
  getEmailIdentity(identity: string): Promise<SesEmailIdentitySnapshot>;
  putAccountDetails(input: ProductionAccessRequest): Promise<void>;
  sendTestEmail(
    input: TestEmailRequest,
  ): Promise<{ readonly messageId?: string }>;
}

export interface CliRuntime {
  readonly confirm: (prompt: string) => Promise<string>;
  readonly createApi: () => Promise<SesOperationsApi>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isInteractive: boolean;
  readonly stderr: (message: string) => void;
  readonly stdout: (message: string) => void;
}

export function terminalSafeText(value: string, maxLength = 1_000): string {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isUnsafe =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
    result += isUnsafe ? '?' : character;
    if (result.length >= maxLength) {
      break;
    }
  }
  return result.slice(0, maxLength);
}

export function errorMessage(error: unknown): string {
  return terminalSafeText(
    error instanceof Error ? error.message : String(error),
  );
}

export function isEmailAddress(value: string): boolean {
  return (
    value.length <= 254 &&
    terminalSafeText(value) === value &&
    /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/u.test(value)
  );
}

export function assertConfirmedTarget(
  confirmedAccount: string | undefined,
  confirmedRegion: string | undefined,
): void {
  if (confirmedAccount !== TARGET_ACCOUNT_ID) {
    throw new Error(
      `--confirm-account must exactly equal ${TARGET_ACCOUNT_ID}.`,
    );
  }
  if (confirmedRegion !== TARGET_REGION) {
    throw new Error(`--confirm-region must exactly equal ${TARGET_REGION}.`);
  }
}

export function assertMutationAllowed(runtime: CliRuntime): void {
  if (runtime.env.CI !== undefined) {
    throw new Error('Provider mutations are disabled when CI is set.');
  }
  if (!runtime.isInteractive) {
    throw new Error(
      'Provider mutations require an interactive stdin and stdout terminal.',
    );
  }
}

export async function assertTargetAccount(
  api: SesOperationsApi,
): Promise<void> {
  const caller = await api.getCallerIdentity();
  if (caller.accountId !== TARGET_ACCOUNT_ID) {
    throw new Error(
      `Refusing AWS operation: expected account ${TARGET_ACCOUNT_ID}, received ${terminalSafeText(caller.accountId ?? 'unknown')}.`,
    );
  }
}

export function createDefaultRuntime(): CliRuntime {
  return {
    confirm: async (message) => {
      const readline = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await readline.question(`${terminalSafeText(message)}\n> `);
      } finally {
        readline.close();
      }
    },
    createApi: createAwsSesOperationsApi,
    env: process.env,
    isInteractive:
      process.stdin.isTTY === true && process.stdout.isTTY === true,
    stderr: (message) => process.stderr.write(`${terminalSafeText(message)}\n`),
    stdout: (message) => process.stdout.write(`${terminalSafeText(message)}\n`),
  };
}

export function sesClientConfig(): {
  readonly maxAttempts: typeof SES_CLIENT_MAX_ATTEMPTS;
  readonly region: typeof TARGET_REGION;
} {
  return { maxAttempts: SES_CLIENT_MAX_ATTEMPTS, region: TARGET_REGION };
}

export async function createAwsSesOperationsApi(): Promise<SesOperationsApi> {
  const [sesSdk, stsSdk] = await Promise.all([
    import('@aws-sdk/client-sesv2'),
    import('@aws-sdk/client-sts'),
  ]);
  const ses = new sesSdk.SESv2Client(sesClientConfig());
  const sts = new stsSdk.STSClient({ region: TARGET_REGION });

  return {
    async getAccount() {
      const output = await ses.send(new sesSdk.GetAccountCommand({}));
      const reviewStatus = output.Details?.ReviewDetails?.Status;
      return {
        ...(output.ProductionAccessEnabled === undefined
          ? {}
          : { productionAccessEnabled: output.ProductionAccessEnabled }),
        ...(reviewStatus === undefined ? {} : { reviewStatus }),
        ...(output.SendingEnabled === undefined
          ? {}
          : { sendingEnabled: output.SendingEnabled }),
      };
    },

    async getCallerIdentity() {
      const output = await sts.send(new stsSdk.GetCallerIdentityCommand({}));
      return {
        ...(output.Account === undefined ? {} : { accountId: output.Account }),
        ...(output.Arn === undefined ? {} : { arn: output.Arn }),
      };
    },

    async getConfigurationSet(name) {
      const read = Promise.all([
        ses.send(
          new sesSdk.GetConfigurationSetCommand({
            ConfigurationSetName: name,
          }),
        ),
        ses.send(
          new sesSdk.GetConfigurationSetEventDestinationsCommand({
            ConfigurationSetName: name,
          }),
        ),
      ]);
      let set: Awaited<typeof read>[0];
      let destinations: Awaited<typeof read>[1];
      try {
        [set, destinations] = await read;
      } catch (error) {
        if (error instanceof sesSdk.NotFoundException) {
          return { exists: false };
        }
        throw error;
      }
      const suppressedReasons = set.SuppressionOptions?.SuppressedReasons;
      return {
        eventDestinations: (destinations.EventDestinations ?? []).map(
          (destination) => ({
            enabled: destination.Enabled === true,
            matchingEventTypes: destination.MatchingEventTypes ?? [],
          }),
        ),
        exists: true,
        ...(set.SendingOptions?.SendingEnabled === undefined
          ? {}
          : { sendingEnabled: set.SendingOptions.SendingEnabled }),
        ...(suppressedReasons === undefined ? {} : { suppressedReasons }),
      };
    },

    async getEmailIdentity(identity) {
      const output = await ses.send(
        new sesSdk.GetEmailIdentityCommand({ EmailIdentity: identity }),
      );
      return {
        ...(output.DkimAttributes?.SigningEnabled === undefined
          ? {}
          : { dkimSigningEnabled: output.DkimAttributes.SigningEnabled }),
        ...(output.DkimAttributes?.Status === undefined
          ? {}
          : { dkimStatus: output.DkimAttributes.Status }),
        ...(output.IdentityType === undefined
          ? {}
          : { identityType: output.IdentityType }),
        ...(output.MailFromAttributes?.MailFromDomain === undefined
          ? {}
          : { mailFromDomain: output.MailFromAttributes.MailFromDomain }),
        ...(output.MailFromAttributes?.MailFromDomainStatus === undefined
          ? {}
          : {
              mailFromDomainStatus:
                output.MailFromAttributes.MailFromDomainStatus,
            }),
        ...(output.VerificationStatus === undefined
          ? {}
          : { verificationStatus: output.VerificationStatus }),
        ...(output.VerifiedForSendingStatus === undefined
          ? {}
          : { verifiedForSendingStatus: output.VerifiedForSendingStatus }),
      };
    },

    async putAccountDetails(input) {
      await ses.send(
        new sesSdk.PutAccountDetailsCommand({
          AdditionalContactEmailAddresses:
            input.additionalContactEmailAddresses,
          ContactLanguage: input.contactLanguage,
          MailType: input.mailType,
          ProductionAccessEnabled: input.productionAccessEnabled,
          UseCaseDescription: input.useCaseDescription,
          WebsiteURL: input.websiteUrl,
        }),
      );
    },

    async sendTestEmail(input) {
      const output = await ses.send(
        new sesSdk.SendEmailCommand({
          ConfigurationSetName: input.configurationSetName,
          Content: {
            Simple: {
              Body: {
                Text: { Charset: 'UTF-8', Data: input.textBody },
              },
              Subject: { Charset: 'UTF-8', Data: input.subject },
            },
          },
          Destination: { ToAddresses: [input.recipientAddress] },
          EmailTags: [
            { Name: 'psd-eoc-purpose', Value: 'synthetic-verification' },
          ],
          FromEmailAddress: input.fromAddress,
        }),
      );
      return output.MessageId === undefined
        ? {}
        : { messageId: output.MessageId };
    },
  };
}
