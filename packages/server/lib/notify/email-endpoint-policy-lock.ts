import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Database } from '../../db/client';

const EMAIL_ENDPOINT_POLICY_LOCK_NAMESPACE = 4_014;

/**
 * Serializes the final email send admission check with permanent endpoint
 * suppression. The provider-I/O claim is the send-side linearization point.
 */
export async function lockEmailEndpointPolicy(
  database: Database,
  emailAddress: string,
): Promise<void> {
  if (
    emailAddress.length < 3 ||
    emailAddress.length > 320 ||
    emailAddress.trim() !== emailAddress ||
    emailAddress !== emailAddress.toLowerCase() ||
    !emailAddress.includes('@') ||
    /[\p{Cc}\p{Cs}]/u.test(emailAddress)
  ) {
    throw new TypeError('The email endpoint policy key is invalid.');
  }
  const addressDigest = createHash('sha256')
    .update(emailAddress, 'utf8')
    .digest('hex');
  const key = `email-address-policy:${addressDigest}`;
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, ${EMAIL_ENDPOINT_POLICY_LOCK_NAMESPACE}))`,
  );
}
