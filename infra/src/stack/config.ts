export const AWS_ACCOUNT_ALIAS = 'psd401';
export const AWS_ACCOUNT = '338414773271';
export const AWS_REGION = 'us-west-2';
/**
 * The deployed CloudFormation stack's name.
 *
 * "ExplorationSmoke" is a leftover from this system's first week and means
 * nothing — it is not exploratory and it is not a smoke test, it serves
 * production traffic. The value cannot simply be corrected: CloudFormation
 * identifies a stack by name, so changing it does not rename anything, it
 * creates a second stack and orphans the first, including the Aurora cluster
 * holding the live data. The same is true of the physical names derived from
 * it throughout this file.
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
export const EMAIL_WORKER_LOG_GROUP_NAME = '/psd-eoc/workers/email';

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
export const PUSH_QUEUE_NAME = 'psd-eoc-push';
export const PUSH_DEAD_LETTER_QUEUE_NAME = 'psd-eoc-push-dlq';
/** Redelivery attempts before a batch is retained for human inspection. */
export const DELIVERY_QUEUE_MAX_RECEIVES = 5;
export const SES_IDENTITY_DOMAIN = 'psd401.net';
export const SES_FROM_ADDRESS = 'eoc-alerts@psd401.net';
export const SES_VERIFICATION_REFERENCE = 'UNVERIFIED';
export const BOOTSTRAP_LOG_GROUP_NAME = '/psd-eoc/bootstrap';
export const DATABASE_SSL_ROOT_CERT =
  '/app/packages/server/certs/aws-rds-global-bundle.pem';

export const IMAGE_DIGEST_SENTINEL = `sha256:${'0'.repeat(64)}`;

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
  readonly hostedDomain: string;
  readonly iosBundleId: string;
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
  return Object.freeze({
    applicationOrigin: read(
      'psdEoc:applicationOrigin',
      /^https:\/\/[^\s/?#]+$/u,
    ),
    hostedDomain: read(
      'psdEoc:hostedDomain',
      /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/u,
    ),
    iosBundleId: read(
      'psdEoc:iosBundleId',
      /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/u,
    ),
  });
}
