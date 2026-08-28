import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';

import { TimestampSchema } from '@psd-eoc/contracts';

/**
 * Google Cloud Identity configuration for access-group membership.
 *
 * Only staff sign-in reads directory groups. Notification rosters are curated
 * inside this application, so this is the single remaining Google boundary.
 */

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_GROUP_MEMBER_SCOPE =
  'https://www.googleapis.com/auth/cloud-identity.groups.readonly';
const GOOGLE_ROSTER_WORKSPACE_ROLE = '_GROUPS_READER_ROLE';
const DEFAULT_GOOGLE_TIMEOUT_MILLISECONDS = 10_000;

/** Refused configuration for the directory access boundary. */
export class GoogleRosterConfigurationError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'GoogleRosterConfigurationError';
    this.code = code;
  }
}

const RosterSyncError = GoogleRosterConfigurationError;
const GoogleCloudIdentityCredentialSchema = z
  .object({
    type: z.literal('service_account'),
    project_id: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u),
    private_key_id: z.string().regex(/^[a-f0-9]{40}$/u),
    private_key: z.string().min(1).max(16_384),
    client_email: z.string().trim().email().max(320),
    client_id: z.string().regex(/^\d+$/u),
    auth_uri: z.literal('https://accounts.google.com/o/oauth2/auth'),
    token_uri: z.literal(GOOGLE_TOKEN_ENDPOINT),
    auth_provider_x509_cert_url: z.literal(
      'https://www.googleapis.com/oauth2/v1/certs',
    ),
    client_x509_cert_url: z.string().url().max(2_048),
    universe_domain: z.literal('googleapis.com'),
    // Required retained-secret provenance only. Runtime source authority comes
    // from the exact versioned database configuration loaded by syncRoster.
    approved_staff_group_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    credential_created_at: TimestampSchema,
    domain_wide_delegation: z.literal(false),
    oauth_scopes: z.tuple([z.literal(GOOGLE_GROUP_MEMBER_SCOPE)]).readonly(),
    workspace_admin_role: z.literal(GOOGLE_ROSTER_WORKSPACE_ROLE),
  })
  .strict()
  .superRefine((credential, context) => {
    const serviceAccountSuffix = `@${credential.project_id}.iam.gserviceaccount.com`;
    const serviceAccountName = credential.client_email.slice(
      0,
      -serviceAccountSuffix.length,
    );
    const expectedCertificateUrl = `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(credential.client_email)}`;
    if (
      !credential.client_email.endsWith(serviceAccountSuffix) ||
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(serviceAccountName)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The service account email must belong to its GCP project.',
        path: ['client_email'],
      });
    }
    if (credential.client_x509_cert_url !== expectedCertificateUrl) {
      context.addIssue({
        code: 'custom',
        message:
          'The service account certificate URL must identify the same account.',
        path: ['client_x509_cert_url'],
      });
    }
  })
  .readonly();

export interface GoogleCloudIdentityRosterConfiguration {
  readonly serviceAccountEmail: string;
  readonly privateKeyId: string;
  readonly privateKey: string;
  readonly timeoutMilliseconds: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

function requiredEnvironmentValue(
  environment: Environment,
  name: string,
  maximumLength: number,
): string {
  const value = environment[name];
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\0\r]/u.test(value)
  ) {
    throw new RosterSyncError(
      'GOOGLE_ROSTER_CONFIGURATION_INVALID',
      `${name} must be configured for roster synchronization.`,
    );
  }
  return value;
}

export function readGoogleCloudIdentityRosterConfiguration(
  environment: Environment = process.env,
): GoogleCloudIdentityRosterConfiguration {
  const serialized = requiredEnvironmentValue(
    environment,
    'GOOGLE_ROSTER_CONFIG',
    32_768,
  );
  let rawCredential: unknown;
  try {
    rawCredential = JSON.parse(serialized) as unknown;
  } catch {
    throw new RosterSyncError(
      'GOOGLE_ROSTER_CONFIGURATION_INVALID',
      'The Google roster credential is not valid JSON.',
    );
  }
  const parsedCredential =
    GoogleCloudIdentityCredentialSchema.safeParse(rawCredential);
  if (!parsedCredential.success) {
    throw new RosterSyncError(
      'GOOGLE_ROSTER_CONFIGURATION_INVALID',
      'The Google roster credential does not match the approved Cloud Identity contract.',
    );
  }
  const timeoutRaw =
    environment.GOOGLE_ROSTER_HTTP_TIMEOUT_MS ??
    String(DEFAULT_GOOGLE_TIMEOUT_MILLISECONDS);
  const timeoutMilliseconds = Number(timeoutRaw);
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1_000 ||
    timeoutMilliseconds > 30_000
  ) {
    throw new RosterSyncError(
      'GOOGLE_ROSTER_CONFIGURATION_INVALID',
      'Google roster credentials or timeout are invalid.',
    );
  }
  try {
    const signingKey = createPrivateKey(parsedCredential.data.private_key);
    if (
      signingKey.type !== 'private' ||
      signingKey.asymmetricKeyType !== 'rsa'
    ) {
      throw new Error('The roster signing key is not an RSA private key.');
    }
  } catch {
    throw new RosterSyncError(
      'GOOGLE_ROSTER_CONFIGURATION_INVALID',
      'The Google roster signing key is invalid.',
    );
  }
  return Object.freeze({
    serviceAccountEmail: parsedCredential.data.client_email,
    privateKeyId: parsedCredential.data.private_key_id,
    privateKey: parsedCredential.data.private_key,
    timeoutMilliseconds,
  });
}
