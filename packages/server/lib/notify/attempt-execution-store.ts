/**
 * Durable execution leases for channel attempts.
 *
 * A channel worker must call a provider at most once for a given attempt, and
 * must survive its own death: if the process holding an attempt disappears
 * between claiming and completing, that attempt has to become workable again,
 * and it must not be sent twice in the meantime. This is the store that decides
 * both, and it is the piece every channel worker needs before it can exist.
 *
 * The behaviour is fixed by `AttemptExecutionStore` in `workers/shared`, which
 * this implements directly so the type checker proves conformance rather than
 * two definitions drifting apart. Only one thing is added beyond the in-memory
 * reference used by the worker tests: lease expiry. `claim` takes
 * `leaseMilliseconds`, which is meaningless unless an expired lease can be
 * taken over, and without it one crashed worker strands an activation's
 * notification permanently.
 *
 * Time comes from `clock_timestamp()` rather than the application, matching the
 * outbox dispatcher. Two workers on two machines then compare leases against
 * one clock instead of their own.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import type {
  AttemptExecutionClaim,
  AttemptExecutionClaimRequest,
  AttemptExecutionCompletion,
  AttemptExecutionLookup,
  AttemptExecutionLookupRequest,
  AttemptExecutionStore,
  CompleteAttemptExecutionRequest,
  ReleaseAttemptExecutionRequest,
} from '../../../../workers/shared/processor';
import { channelAttemptExecutions } from '../../db/schema';
import type { Database } from '../../db/client';

export type AttemptExecutionStoreErrorCode =
  /** The stored fingerprint disagrees with the caller's. */
  | 'ATTEMPT_FINGERPRINT_CONFLICT'
  /** The caller does not hold the lease it claims to hold. */
  | 'ATTEMPT_LEASE_CONFLICT'
  /** A stored completion could not be read back as one. */
  | 'ATTEMPT_COMPLETION_CORRUPT';

export class AttemptExecutionStoreError extends Error {
  public constructor(public readonly code: AttemptExecutionStoreCode) {
    super('The channel attempt execution could not be recorded safely.');
    this.name = 'AttemptExecutionStoreError';
  }
}

type AttemptExecutionStoreCode = AttemptExecutionStoreErrorCode;

const AttemptIdSchema = z.string().uuid();
const FingerprintSchema = z.string().trim().min(1).max(200);
const LeaseTokenSchema = z.string().uuid();
const LeaseMillisecondsSchema = z
  .number()
  .int()
  .positive()
  .max(10 * 60 * 1_000);

/**
 * Validates a completion on the way out of the database.
 *
 * The outcome itself stays opaque here: the worker owns what a provider result
 * means and already refuses one it cannot read. This checks only the envelope,
 * so a corrupt row is refused loudly instead of being handed back as a
 * plausible-looking send result.
 */
const StoredCompletionSchema = z.union([
  z
    .object({ kind: z.literal('final'), outcome: z.object({}).passthrough() })
    .passthrough(),
  z
    .object({
      kind: z.literal('retry'),
      outcome: z.object({}).passthrough(),
      delayMilliseconds: z.number().int().nonnegative(),
      nextAttemptNumber: z.number().int().positive(),
      reasonCode: z.string().min(1),
    })
    .passthrough(),
]);

function readCompletion(value: unknown): AttemptExecutionCompletion {
  const parsed = StoredCompletionSchema.safeParse(value);
  if (!parsed.success) {
    throw new AttemptExecutionStoreError('ATTEMPT_COMPLETION_CORRUPT');
  }
  return parsed.data as unknown as AttemptExecutionCompletion;
}

export function createDrizzleAttemptExecutionStore(
  database: Database,
): AttemptExecutionStore {
  const now = sql<Date>`clock_timestamp()`;

  return Object.freeze({
    async lookup(
      request: AttemptExecutionLookupRequest,
    ): Promise<AttemptExecutionLookup> {
      const attemptId = AttemptIdSchema.parse(request.attemptId);
      const fingerprint = FingerprintSchema.parse(request.fingerprint);
      const [row] = await database
        .select()
        .from(channelAttemptExecutions)
        .where(eq(channelAttemptExecutions.attemptId, attemptId))
        .limit(1);
      if (row === undefined) {
        return Object.freeze({ kind: 'missing' as const });
      }
      if (row.fingerprint !== fingerprint) {
        throw new AttemptExecutionStoreError('ATTEMPT_FINGERPRINT_CONFLICT');
      }
      // A lookup never acquires permission to call a provider, so an expired
      // lease is still reported as in-progress here. Only `claim` may take one
      // over.
      return row.completion === null
        ? Object.freeze({ kind: 'in-progress' as const })
        : Object.freeze({
            kind: 'completed' as const,
            completion: readCompletion(row.completion),
          });
    },

    claim(
      request: AttemptExecutionClaimRequest,
    ): Promise<AttemptExecutionClaim> {
      const attemptId = AttemptIdSchema.parse(request.attemptId);
      const fingerprint = FingerprintSchema.parse(request.fingerprint);
      const leaseMilliseconds = LeaseMillisecondsSchema.parse(
        request.leaseMilliseconds,
      );
      const expiresAt = sql<Date>`clock_timestamp() + make_interval(secs => ${leaseMilliseconds} / 1000.0)`;

      return database.transaction(async (transaction) => {
        // Serialize claimants for this attempt. Without the row lock two
        // workers can both read "expired" and both take the lease, which is the
        // duplicate send this store exists to prevent.
        const [row] = await transaction
          .select()
          .from(channelAttemptExecutions)
          .where(eq(channelAttemptExecutions.attemptId, attemptId))
          .limit(1)
          .for('update');

        if (row === undefined) {
          const [inserted] = await transaction
            .insert(channelAttemptExecutions)
            .values({
              attemptId,
              fingerprint,
              leaseToken: sql`gen_random_uuid()`,
              leaseExpiresAt: expiresAt,
            })
            .returning();
          return Object.freeze({
            kind: 'acquired' as const,
            leaseToken: String(inserted?.leaseToken),
          });
        }

        if (row.fingerprint !== fingerprint) {
          throw new AttemptExecutionStoreError('ATTEMPT_FINGERPRINT_CONFLICT');
        }
        if (row.completion !== null) {
          return Object.freeze({
            kind: 'completed' as const,
            completion: readCompletion(row.completion),
          });
        }

        // Still held by a live worker.
        const [live] = await transaction
          .select({
            held: sql<boolean>`${channelAttemptExecutions.leaseExpiresAt} > ${now}`,
          })
          .from(channelAttemptExecutions)
          .where(eq(channelAttemptExecutions.attemptId, attemptId))
          .limit(1);
        if (live?.held === true) {
          return Object.freeze({ kind: 'in-progress' as const });
        }

        // The previous holder's lease expired. Take it over under a new token
        // so its late `complete` or `release` is refused.
        const [reclaimed] = await transaction
          .update(channelAttemptExecutions)
          .set({
            leaseToken: sql`gen_random_uuid()`,
            leaseExpiresAt: expiresAt,
          })
          .where(eq(channelAttemptExecutions.attemptId, attemptId))
          .returning();
        return Object.freeze({
          kind: 'acquired' as const,
          leaseToken: String(reclaimed?.leaseToken),
        });
      });
    },

    async complete(request: CompleteAttemptExecutionRequest): Promise<void> {
      const attemptId = AttemptIdSchema.parse(request.attemptId);
      const fingerprint = FingerprintSchema.parse(request.fingerprint);
      const leaseToken = LeaseTokenSchema.parse(request.leaseToken);
      const updated = await database
        .update(channelAttemptExecutions)
        .set({ completion: request.completion, completedAt: now })
        .where(
          and(
            eq(channelAttemptExecutions.attemptId, attemptId),
            eq(channelAttemptExecutions.fingerprint, fingerprint),
            eq(channelAttemptExecutions.leaseToken, leaseToken),
          ),
        )
        .returning();
      if (updated.length !== 1) {
        throw new AttemptExecutionStoreError('ATTEMPT_LEASE_CONFLICT');
      }
    },

    async release(request: ReleaseAttemptExecutionRequest): Promise<void> {
      const attemptId = AttemptIdSchema.parse(request.attemptId);
      const fingerprint = FingerprintSchema.parse(request.fingerprint);
      const leaseToken = LeaseTokenSchema.parse(request.leaseToken);
      // Only an uncompleted attempt may be released. Deleting a completed row
      // would let the same attempt be sent a second time.
      const deleted = await database
        .delete(channelAttemptExecutions)
        .where(
          and(
            eq(channelAttemptExecutions.attemptId, attemptId),
            eq(channelAttemptExecutions.fingerprint, fingerprint),
            eq(channelAttemptExecutions.leaseToken, leaseToken),
            isNull(channelAttemptExecutions.completion),
          ),
        )
        .returning();
      if (deleted.length !== 1) {
        throw new AttemptExecutionStoreError('ATTEMPT_LEASE_CONFLICT');
      }
    },
  });
}
