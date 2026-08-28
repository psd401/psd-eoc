import { OrganizationNameSchema } from '@psd-eoc/contracts';
import { isIP } from 'node:net';

/**
 * The deployed CloudFormation stack's name.
 *
 * This was `PsdEocExplorationSmoke` until 2026-08-21 — a leftover from the
 * system's first week that meant nothing, since it is neither exploratory nor a
 * smoke test and it serves production traffic. CloudFormation identifies a
 * stack by name, so the value could not simply be corrected: changing it does
 * not rename anything, it creates a second stack and orphans the first. The
 * rename was therefore done by deleting the old stack and creating this one,
 * reissuing every physical name derived from it below.
 *
 * Renaming them is a planned migration with downtime, tracked separately. Until
 * then this constant carries the old value deliberately, and every identifier
 * around it has been renamed so the misleading word stops spreading.
 */
export const STACK_NAME = 'PsdEoc';

// Physical resource names remain stable while the deployed environment moves
// from the initial synthetic fixture to staff-only live operation.
export const DEPLOYMENT_ENVIRONMENT = 'live-pilot';
export const DATA_CLASSIFICATION = 'staff-minimized';
export const DATABASE_NAME = 'psd_eoc';
export const DATABASE_IDENTIFIER = 'psd-eoc';
export const DATABASE_PORT = 5_432;
export const HEALTH_PATH = '/api/health';
export const SERVER_REPOSITORY_NAME = 'psd-eoc/server';
export const HEALTH_QUEUE_NAME = 'psd-eoc-health';
export const EMAIL_QUEUE_NAME = 'psd-eoc-email';
export const EMAIL_DEAD_LETTER_QUEUE_NAME = 'psd-eoc-email-dlq';
export const EMAIL_CALLBACK_QUEUE_NAME = 'psd-eoc-email-callback';
export const EMAIL_CALLBACK_DEAD_LETTER_QUEUE_NAME =
  'psd-eoc-email-callback-dlq';
export const EMAIL_WORKER_LOG_GROUP_NAME = '/psd-eoc/workers/email';
export const EMAIL_CALLBACK_WORKER_LOG_GROUP_NAME =
  '/psd-eoc/workers/email-callback';

/**
 * The notification delivery queues.
 *
 * An authorized notification lands on the delivery queue as one batch, and is
 * split from there onto the per-channel queues a worker drains. Every queue is
 * paired with a retained dead-letter queue: work that cannot be delivered has
 * to be inspectable afterwards, never silently dropped.
 *
 * The channel queue names match the channel names in `NOTIFICATION_CHANNELS`,
 * which is what makes the alarm names (`psd-eoc-<channel>-queue-age`) line up
 * with the runbooks.
 */
export const DELIVERY_QUEUE_NAME = 'psd-eoc-delivery';
export const DELIVERY_DEAD_LETTER_QUEUE_NAME = 'psd-eoc-delivery-dlq';
export const SMS_QUEUE_NAME = 'psd-eoc-sms';
export const SMS_DEAD_LETTER_QUEUE_NAME = 'psd-eoc-sms-dlq';
export const SMS_RECEIPT_QUEUE_NAME = 'psd-eoc-sms-receipts';
export const SMS_RECEIPT_DEAD_LETTER_QUEUE_NAME = 'psd-eoc-sms-receipts-dlq';
export const SMS_WORKER_LOG_GROUP_NAME = '/psd-eoc/workers/sms';
export const PUSH_QUEUE_NAME = 'psd-eoc-push';
export const PUSH_DEAD_LETTER_QUEUE_NAME = 'psd-eoc-push-dlq';
export const PUSH_WORKER_LOG_GROUP_NAME = '/psd-eoc/workers/push';
/** Redelivery attempts before a batch is retained for human inspection. */
export const DELIVERY_QUEUE_MAX_RECEIVES = 5;
export const SES_VERIFICATION_REFERENCE = 'UNVERIFIED';
export const BOOTSTRAP_LOG_GROUP_NAME = '/psd-eoc/bootstrap';
export const DATABASE_SSL_ROOT_CERT =
  '/app/packages/server/certs/aws-rds-global-bundle.pem';

export const IMAGE_DIGEST_SENTINEL = `sha256:${'0'.repeat(64)}`;

export interface DeploymentTarget {
  readonly account: string;
  readonly accountAlias: string;
  readonly monitoringRunbookBaseUrl: string;
  readonly region: string;
  readonly sesFromAddress: string;
  readonly sesIdentityDomain: string;
  readonly sourceRepositoryUrl: string;
}

/** Reads cloud and provider identity from the same CDK context as the tenant. */
export function readDeploymentTarget(node: {
  tryGetContext(key: string): unknown;
}): DeploymentTarget {
  const read = (key: string, pattern: RegExp): string => {
    const value = node.tryGetContext(key);
    if (typeof value !== 'string' || !pattern.test(value.trim())) {
      throw new Error(`CDK context ${key} is required and invalid.`);
    }
    return value.trim();
  };
  const sesIdentityDomain = read(
    'psdEoc:sesIdentityDomain',
    /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/u,
  );
  const sesFromAddress = read(
    'psdEoc:sesFromAddress',
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9][a-z0-9.-]+$/u,
  );
  if (!sesFromAddress.toLowerCase().endsWith(`@${sesIdentityDomain}`)) {
    throw new Error(
      'CDK context psdEoc:sesFromAddress must use psdEoc:sesIdentityDomain.',
    );
  }
  return Object.freeze({
    account: read('psdEoc:awsAccount', /^\d{12}$/u),
    accountAlias: read('psdEoc:awsAccountAlias', /^[a-z0-9][a-z0-9-]{1,62}$/u),
    monitoringRunbookBaseUrl: read(
      'psdEoc:monitoringRunbookBaseUrl',
      /^https:\/\/[^\s?#]+[^\s?#/]$/u,
    ),
    region: read('psdEoc:awsRegion', /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u),
    sesFromAddress,
    sesIdentityDomain,
    sourceRepositoryUrl: read(
      'psdEoc:sourceRepositoryUrl',
      /^https:\/\/[^\s/]+\/[^\s]+$/u,
    ),
  });
}

/**
 * Who this deployment serves.
 *
 * These three describe the district running this stack, and the application
 * reads them at runtime: the origin it redirects to after sign-in, the email
 * domain its staff belong to, and the identifier of the iOS app it ships. They
 * were literals in application source, which is what stopped anyone else from
 * running this repository.
 *
 * They live in `cdk.json` context, which is data a district edits without
 * touching code. Missing context fails the synth rather than defaulting to
 * somebody else's district.
 */
export interface DeploymentIdentity {
  readonly applicationOrigin: string;
  readonly displayTimeZone: string;
  readonly hostedDomain: string;
  /**
   * The Route 53 zone that answers for the hosted domain.
   *
   * The public name was a hand-made record, so nothing kept it pointing at the
   * service it names. Declaring the zone lets the deployment own the record and
   * removes the chance of the two disagreeing.
   */
  readonly hostedZoneId: string;
  readonly iosBundleId: string;
  readonly organizationName: string;
  readonly privacyContactUrl: string;
}

/**
 * The district's facilities, read from CDK context.
 *
 * These were rows only the admin UI could create, which meant nothing in this
 * repository could produce them and a rebuilt deployment came up with no
 * schools at all. A district's sites are configuration, so they are declared
 * here and seeded by the bootstrap task.
 *
 * Absent context is allowed: a deployment that manages facilities through the
 * admin UI is legitimate. Malformed context is not, because the failure would
 * otherwise be a deployment that silently has nowhere to declare an incident.
 */
/**
 * The synthetic population, as CDK context.
 *
 * Validated only for shape here. Whether an address is safe to use as a
 * synthetic recipient is decided in `bootstrap-synthetic-groups.ts`, which
 * requires a reserved domain that cannot resolve — that check belongs next to
 * the insert, not next to the deploy.
 */
export function readSyntheticGroupContext(node: {
  tryGetContext(key: string): unknown;
}): string {
  const value = node.tryGetContext('psdEoc:syntheticGroups');
  if (value === undefined || value === null) {
    return '';
  }
  if (!Array.isArray(value)) {
    throw new Error('CDK context psdEoc:syntheticGroups must be an array.');
  }
  for (const entry of value) {
    const group = entry as Record<string, unknown>;
    if (
      typeof group?.facilityCode !== 'string' ||
      !/^[A-Z0-9-]{1,32}$/u.test(group.facilityCode) ||
      !Array.isArray(group.members) ||
      group.members.length === 0
    ) {
      throw new Error(
        'Each psdEoc:syntheticGroups entry needs a facilityCode and at least one member.',
      );
    }
  }
  return JSON.stringify(value);
}

export function readFacilityContext(node: {
  tryGetContext(key: string): unknown;
}): string {
  const value = node.tryGetContext('psdEoc:facilities');
  if (value === undefined || value === null) {
    return '';
  }
  if (!Array.isArray(value)) {
    throw new Error('CDK context psdEoc:facilities must be an array.');
  }
  for (const entry of value) {
    const facility = entry as Record<string, unknown>;
    if (
      typeof facility?.code !== 'string' ||
      !/^[A-Z0-9-]{1,32}$/u.test(facility.code) ||
      typeof facility.name !== 'string' ||
      facility.name.trim().length === 0
    ) {
      throw new Error(
        'Each psdEoc:facilities entry needs an upper-case code and a name.',
      );
    }
  }
  // Passed through as JSON so the container reads exactly what was declared.
  return JSON.stringify(value);
}

/** The district's facility groupings, read from CDK context. */
export function readNeighborhoodContext(node: {
  tryGetContext(key: string): unknown;
}): string {
  const value = node.tryGetContext('psdEoc:neighborhoods');
  if (value === undefined || value === null) {
    return '';
  }
  if (!Array.isArray(value)) {
    throw new Error('CDK context psdEoc:neighborhoods must be an array.');
  }
  for (const entry of value) {
    const neighborhood = entry as Record<string, unknown>;
    if (
      typeof neighborhood?.name !== 'string' ||
      neighborhood.name.trim().length === 0 ||
      !Array.isArray(neighborhood.facilityCodes) ||
      neighborhood.facilityCodes.length === 0
    ) {
      throw new Error(
        'Each psdEoc:neighborhoods entry needs a name and at least one facility code.',
      );
    }
  }
  return JSON.stringify(value);
}

export function readDeploymentIdentity(node: {
  tryGetContext(key: string): unknown;
}): DeploymentIdentity {
  const read = (key: string, pattern: RegExp): string => {
    const value = node.tryGetContext(key);
    if (typeof value !== 'string' || !pattern.test(value.trim())) {
      throw new Error(
        `CDK context ${key} must be set for this deployment. See docs/guides/first-administrator.md.`,
      );
    }
    return value.trim();
  };
  const organizationName = OrganizationNameSchema.safeParse(
    node.tryGetContext('psdEoc:organizationName'),
  );
  if (!organizationName.success) {
    throw new Error(
      'CDK context psdEoc:organizationName must be a display-safe name of at most 160 UTF-16 code units and 320 UTF-8 bytes.',
    );
  }
  const displayTimeZone = read(
    'psdEoc:displayTimeZone',
    /^[A-Za-z0-9_+\-/]+$/u,
  );
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: displayTimeZone }).format(0);
  } catch {
    throw new Error(
      'CDK context psdEoc:displayTimeZone must be a valid IANA time zone.',
    );
  }
  const privacyContactUrl = read(
    'psdEoc:privacyContactUrl',
    /^https:\/\/[^\s?#]+$/u,
  );
  let parsedPrivacyContactUrl: URL;
  try {
    parsedPrivacyContactUrl = new URL(privacyContactUrl);
  } catch {
    throw new Error(
      'CDK context psdEoc:privacyContactUrl must be a valid HTTPS URL.',
    );
  }
  const privacyContactHostname = parsedPrivacyContactUrl.hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '');
  if (
    parsedPrivacyContactUrl.username.length > 0 ||
    parsedPrivacyContactUrl.password.length > 0 ||
    isIP(privacyContactHostname) !== 0 ||
    privacyContactHostname === 'localhost' ||
    privacyContactHostname.endsWith('.localhost') ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
      privacyContactHostname,
    )
  ) {
    throw new Error(
      'CDK context psdEoc:privacyContactUrl must use a public hostname and contain no credentials.',
    );
  }
  return Object.freeze({
    applicationOrigin: read(
      'psdEoc:applicationOrigin',
      /^https:\/\/[^\s/?#]+$/u,
    ),
    displayTimeZone,
    hostedDomain: read(
      'psdEoc:hostedDomain',
      /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/u,
    ),
    hostedZoneId: read('psdEoc:hostedZoneId', /^[A-Z0-9]{1,32}$/u),
    iosBundleId: read(
      'psdEoc:iosBundleId',
      /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/u,
    ),
    organizationName: organizationName.data,
    privacyContactUrl,
  });
}

export interface ProtectedDeploymentEnvironment {
  readonly APP_PUBLIC_ORIGIN: string | undefined;
  readonly AWS_ACCOUNT_ID: string | undefined;
  readonly AWS_REGION: string | undefined;
  readonly PSD_EOC_ENFORCE_DEPLOYMENT_TARGET: string | undefined;
}

/** Binds automatic production deployment to its protected repository values. */
export function assertProtectedDeploymentTarget(
  target: DeploymentTarget,
  identity: DeploymentIdentity,
  environment: ProtectedDeploymentEnvironment,
): void {
  if (environment.PSD_EOC_ENFORCE_DEPLOYMENT_TARGET !== 'true') return;
  const expectedAccount = environment.AWS_ACCOUNT_ID?.trim();
  const expectedRegion = environment.AWS_REGION?.trim();
  const expectedOrigin = environment.APP_PUBLIC_ORIGIN?.trim();
  if (
    expectedAccount === undefined ||
    expectedRegion === undefined ||
    expectedOrigin === undefined ||
    target.account !== expectedAccount ||
    target.region !== expectedRegion ||
    identity.applicationOrigin !== expectedOrigin
  ) {
    throw new Error(
      'CDK deployment target does not match the protected production environment.',
    );
  }
  const originHostname = new URL(expectedOrigin).hostname;
  const isSameOrSubdomain = (value: string, domain: string): boolean =>
    value === domain || value.endsWith(`.${domain}`);
  if (
    !isSameOrSubdomain(originHostname, identity.hostedDomain) ||
    !isSameOrSubdomain(target.sesIdentityDomain, identity.hostedDomain)
  ) {
    throw new Error(
      'Configured application and SES identities must remain within the protected hosted domain.',
    );
  }
}
