import { randomUUID } from 'node:crypto';

import {
  SmsConsentReceiptSchema,
  SmsConsentStateSchema,
  SmsConsentWithdrawalReceiptSchema,
  type Actor,
  type CapabilityInput,
  type CapabilityOutput,
  type InvocationSource,
  type RegisteredCapabilityId,
  type SmsConsentReceipt,
  type SmsConsentState,
  type SmsConsentWithdrawalReceipt,
} from '@psd-eoc/contracts';
import { and, eq, isNull } from 'drizzle-orm';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type Database,
  type DatabaseConnection,
  type DatabaseQuery,
} from '../../db/client';
import { staffSmsConsents } from '../../db/schema';

import type { AuthenticatedSession } from '../auth/sessions';

import {
  CapabilityEngineError,
  executeAuditedCapabilityTransaction,
  readCapabilityTime,
  resolveHumanCapabilityInvocation,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type CapabilityHandlerContext,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from './engine';
import {
  appendSharedCapabilityAuditEntry,
  claimSharedIdempotency,
  completeSharedIdempotency,
  readSharedDatabaseTime,
} from './persistence';

/** Consent-specific persistence added to the canonical capability transaction. */
export interface SmsConsentCapabilityTransaction
  extends CapabilityEngineTransaction {
  recordSmsConsent(
    input: CapabilityInput<'record-sms-consent'>,
    actor: Extract<Actor, { kind: 'human' }>,
    source: InvocationSource,
    recordedAt: Date,
  ): Promise<SmsConsentReceipt>;
  withdrawSmsConsent(
    actor: Extract<Actor, { kind: 'human' }>,
    recordedAt: Date,
  ): Promise<SmsConsentWithdrawalReceipt>;
  readMySmsConsent(
    actor: Extract<Actor, { kind: 'human' }>,
  ): Promise<SmsConsentState>;
  loadSmsConsentReplay(
    resultReference: string,
    actor: Extract<Actor, { kind: 'human' }>,
  ): Promise<SmsConsentReceipt | null>;
  loadSmsConsentWithdrawalReplay(
    resultReference: string,
    actor: Extract<Actor, { kind: 'human' }>,
  ): Promise<SmsConsentWithdrawalReceipt | null>;
}

export type SmsConsentCapabilityStore =
  CapabilityEngineStore<SmsConsentCapabilityTransaction>;

export type SmsConsentCapabilityId = Extract<
  RegisteredCapabilityId,
  'record-sms-consent' | 'withdraw-sms-consent' | 'read-my-sms-consent'
>;

type SmsConsentQueryDatabase = DatabaseQuery;

function smsConsentQueryDatabase(database: unknown): SmsConsentQueryDatabase {
  // Both configured transports expose the shared schema-aware query surface.
  return database as SmsConsentQueryDatabase;
}

function consentConflict(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'CONFLICT',
    'PERSISTENCE_CONFLICT',
    message,
    409,
  );
}

function requireHuman(
  context: CapabilityHandlerContext<SmsConsentCapabilityTransaction>,
): Extract<Actor, { kind: 'human' }> {
  if (context.invocation.actor.kind !== 'human') {
    throw new CapabilityEngineError(
      'FORBIDDEN',
      'CAPABILITY_INVOCATION_DENIED',
      'SMS consent belongs to the staff member giving it and requires an authenticated human.',
      403,
    );
  }
  return context.invocation.actor;
}

function replayUnavailable(): CapabilityEngineError {
  return new CapabilityEngineError(
    'INTERNAL_ERROR',
    'IDEMPOTENCY_RESULT_UNAVAILABLE',
    'The original SMS consent result is unavailable.',
    500,
  );
}

function dateIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw consentConflict('A persisted SMS consent time was invalid.');
  }
  return date.toISOString();
}

const CONSENT_REFERENCE_PREFIX = 'sms-consent:';
const WITHDRAWAL_REFERENCE_PREFIX = 'sms-consent-withdrawal:';

function consentIdFromReference(reference: string, prefix: string): string {
  if (!reference.startsWith(prefix)) {
    throw replayUnavailable();
  }
  return reference.slice(prefix.length);
}

const recordSmsConsentRegistration: ServerCapabilityRegistration<
  'record-sms-consent',
  SmsConsentCapabilityTransaction
> = {
  id: 'record-sms-consent',
  resolveFacilityId: () => null,
  async handler(input, context) {
    return context.transaction.recordSmsConsent(
      input,
      requireHuman(context),
      context.invocation.source,
      await readCapabilityTime(context),
    );
  },
  // The number is deliberately absent from the reference. A result reference is
  // stored on the idempotency record and read back on replay, so putting a
  // staff member's mobile number in it would persist contact data somewhere
  // nothing needs it.
  resultReference: (output) => `${CONSENT_REFERENCE_PREFIX}${output.consentId}`,
  resolveReplayFacilityId: () => null,
  replayFacilityId: () => null,
  async loadReplay(reference, context) {
    const replay = await context.transaction.loadSmsConsentReplay(
      reference,
      requireHuman(context),
    );
    if (replay === null) throw replayUnavailable();
    return replay;
  },
};

const withdrawSmsConsentRegistration: ServerCapabilityRegistration<
  'withdraw-sms-consent',
  SmsConsentCapabilityTransaction
> = {
  id: 'withdraw-sms-consent',
  resolveFacilityId: () => null,
  async handler(_input, context) {
    return context.transaction.withdrawSmsConsent(
      requireHuman(context),
      await readCapabilityTime(context),
    );
  },
  resultReference: (output) =>
    `${WITHDRAWAL_REFERENCE_PREFIX}${output.consentId}`,
  resolveReplayFacilityId: () => null,
  replayFacilityId: () => null,
  async loadReplay(reference, context) {
    const replay = await context.transaction.loadSmsConsentWithdrawalReplay(
      reference,
      requireHuman(context),
    );
    if (replay === null) throw replayUnavailable();
    return replay;
  },
};

const readMySmsConsentRegistration: ServerCapabilityRegistration<
  'read-my-sms-consent',
  SmsConsentCapabilityTransaction
> = {
  id: 'read-my-sms-consent',
  resolveFacilityId: () => null,
  async handler(_input, context) {
    return SmsConsentStateSchema.parse(
      await context.transaction.readMySmsConsent(requireHuman(context)),
    );
  },
};

const registrations = Object.freeze({
  'read-my-sms-consent': readMySmsConsentRegistration,
  'record-sms-consent': recordSmsConsentRegistration,
  'withdraw-sms-consent': withdrawSmsConsentRegistration,
});

/** Executes an SMS consent capability through the canonical server engine. */
export function executeSmsConsentCapability<Id extends SmsConsentCapabilityId>(
  capabilityId: Id,
  input: unknown,
  invocation: TrustedCapabilityInvocation,
  store: SmsConsentCapabilityStore,
): Promise<CapabilityOutput<Id>> {
  const registration = registrations[
    capabilityId
  ] as ServerCapabilityRegistration<Id, SmsConsentCapabilityTransaction>;
  return executeAuditedCapabilityTransaction(
    registration,
    input,
    invocation,
    store,
  );
}

const PERSISTENCE = Object.freeze({ subject: 'SMS consent' });

/**
 * Records an affirmative consent, superseding the caller's live one.
 *
 * A staff member who gives a new number has changed which number they want
 * notified, not asked to be notified twice. The previous consent is withdrawn
 * in the same transaction and the new row points back at it, so the history
 * reads as one chain rather than a set of rows a reviewer has to order by
 * timestamp and hope.
 */
async function recordSmsConsentWithDatabase(
  database: SmsConsentQueryDatabase,
  input: CapabilityInput<'record-sms-consent'>,
  actor: Extract<Actor, { kind: 'human' }>,
  source: InvocationSource,
  recordedAt: Date,
): Promise<SmsConsentReceipt> {
  // Locked so two devices consenting at once cannot both read "no live
  // consent" and race the one-live-per-user index into an opaque failure.
  const [live] = await database
    .select({ id: staffSmsConsents.id })
    .from(staffSmsConsents)
    .where(
      and(
        eq(staffSmsConsents.userId, actor.userId),
        isNull(staffSmsConsents.withdrawnAt),
      ),
    )
    .for('update')
    .limit(1);
  if (live !== undefined) {
    const [withdrawn] = await database
      .update(staffSmsConsents)
      .set({ withdrawnAt: recordedAt })
      .where(
        and(
          eq(staffSmsConsents.id, live.id),
          isNull(staffSmsConsents.withdrawnAt),
        ),
      )
      .returning({ id: staffSmsConsents.id });
    if (withdrawn === undefined) {
      throw consentConflict(
        'The previous consent changed while this one was being recorded.',
      );
    }
  }
  const [inserted] = await database
    .insert(staffSmsConsents)
    .values({
      userId: actor.userId,
      phoneNumber: input.phoneNumber,
      disclosureVersion: input.disclosureVersion,
      source,
      supersedesConsentId: live?.id ?? null,
      consentedAt: recordedAt,
    })
    .returning({
      id: staffSmsConsents.id,
      disclosureVersion: staffSmsConsents.disclosureVersion,
      consentedAt: staffSmsConsents.consentedAt,
    });
  if (inserted === undefined) {
    throw consentConflict('The consent could not be recorded.');
  }
  return SmsConsentReceiptSchema.parse({
    consentId: inserted.id,
    disclosureVersion: inserted.disclosureVersion,
    status: 'consented',
    recordedAt: dateIso(inserted.consentedAt),
  });
}

/** Withdraws the caller's live consent, leaving the row as evidence. */
async function withdrawSmsConsentWithDatabase(
  database: SmsConsentQueryDatabase,
  actor: Extract<Actor, { kind: 'human' }>,
  recordedAt: Date,
): Promise<SmsConsentWithdrawalReceipt> {
  const [withdrawn] = await database
    .update(staffSmsConsents)
    .set({ withdrawnAt: recordedAt })
    .where(
      and(
        eq(staffSmsConsents.userId, actor.userId),
        isNull(staffSmsConsents.withdrawnAt),
      ),
    )
    .returning({
      id: staffSmsConsents.id,
      withdrawnAt: staffSmsConsents.withdrawnAt,
    });
  if (withdrawn === undefined) {
    throw new CapabilityEngineError(
      'NOT_FOUND',
      'PERSISTENCE_CONFLICT',
      'There is no live SMS consent to withdraw.',
      404,
    );
  }
  if (withdrawn.withdrawnAt === null) {
    throw consentConflict('The withdrawal time was not persisted.');
  }
  return SmsConsentWithdrawalReceiptSchema.parse({
    consentId: withdrawn.id,
    status: 'withdrawn',
    recordedAt: dateIso(withdrawn.withdrawnAt),
  });
}

/** Reads the caller's own consent, exposing only the last four digits. */
async function readMySmsConsentWithDatabase(
  database: SmsConsentQueryDatabase,
  actor: Extract<Actor, { kind: 'human' }>,
): Promise<SmsConsentState> {
  const [live] = await database
    .select({
      phoneNumber: staffSmsConsents.phoneNumber,
      disclosureVersion: staffSmsConsents.disclosureVersion,
      consentedAt: staffSmsConsents.consentedAt,
    })
    .from(staffSmsConsents)
    .where(
      and(
        eq(staffSmsConsents.userId, actor.userId),
        isNull(staffSmsConsents.withdrawnAt),
      ),
    )
    .limit(1);
  if (live === undefined) {
    return SmsConsentStateSchema.parse({ status: 'none' });
  }
  return SmsConsentStateSchema.parse({
    status: 'consented',
    lastFourDigits: live.phoneNumber.slice(-4),
    disclosureVersion: live.disclosureVersion,
    consentedAt: dateIso(live.consentedAt),
  });
}

/** Reloads a recorded consent for replay, scoped to the caller who gave it. */
async function loadSmsConsentReplayFromDatabase(
  database: SmsConsentQueryDatabase,
  reference: string,
  actor: Extract<Actor, { kind: 'human' }>,
): Promise<SmsConsentReceipt | null> {
  const [row] = await database
    .select({
      id: staffSmsConsents.id,
      disclosureVersion: staffSmsConsents.disclosureVersion,
      consentedAt: staffSmsConsents.consentedAt,
    })
    .from(staffSmsConsents)
    .where(
      and(
        eq(
          staffSmsConsents.id,
          consentIdFromReference(reference, CONSENT_REFERENCE_PREFIX),
        ),
        // Scoped to the caller so a replay can never read another staff
        // member's consent, even with a guessed reference.
        eq(staffSmsConsents.userId, actor.userId),
      ),
    )
    .limit(1);
  if (row === undefined) return null;
  return SmsConsentReceiptSchema.parse({
    consentId: row.id,
    disclosureVersion: row.disclosureVersion,
    status: 'consented',
    recordedAt: dateIso(row.consentedAt),
  });
}

/** Reloads a withdrawal for replay, scoped to the caller who withdrew it. */
async function loadSmsConsentWithdrawalReplayFromDatabase(
  database: SmsConsentQueryDatabase,
  reference: string,
  actor: Extract<Actor, { kind: 'human' }>,
): Promise<SmsConsentWithdrawalReceipt | null> {
  const [row] = await database
    .select({
      id: staffSmsConsents.id,
      withdrawnAt: staffSmsConsents.withdrawnAt,
    })
    .from(staffSmsConsents)
    .where(
      and(
        eq(
          staffSmsConsents.id,
          consentIdFromReference(reference, WITHDRAWAL_REFERENCE_PREFIX),
        ),
        eq(staffSmsConsents.userId, actor.userId),
      ),
    )
    .limit(1);
  if (row === undefined || row.withdrawnAt === null) return null;
  return SmsConsentWithdrawalReceiptSchema.parse({
    consentId: row.id,
    status: 'withdrawn',
    recordedAt: dateIso(row.withdrawnAt),
  });
}

function createDrizzleSmsConsentTransaction(
  database: SmsConsentQueryDatabase,
): SmsConsentCapabilityTransaction {
  return {
    readCurrentTime: () => readSharedDatabaseTime(database, PERSISTENCE),
    claimIdempotency: (input) =>
      claimSharedIdempotency(database, input, PERSISTENCE),
    completeIdempotency: (input) =>
      completeSharedIdempotency(database, input, PERSISTENCE),
    // Consent carries no human-confirmation policy by contract: the agreement
    // itself is the affirmative act, and a second confirmation step would only
    // train staff to click through the one that matters.
    getHumanConfirmation: async () => null,
    consumeHumanConfirmation: async () => false,
    appendCapabilityAudit: (event) =>
      appendSharedCapabilityAuditEntry(database, event, PERSISTENCE),
    recordSmsConsent: (input, actor, source, recordedAt) =>
      recordSmsConsentWithDatabase(database, input, actor, source, recordedAt),
    withdrawSmsConsent: (actor, recordedAt) =>
      withdrawSmsConsentWithDatabase(database, actor, recordedAt),
    readMySmsConsent: (actor) => readMySmsConsentWithDatabase(database, actor),
    loadSmsConsentReplay: (reference, actor) =>
      loadSmsConsentReplayFromDatabase(database, reference, actor),
    loadSmsConsentWithdrawalReplay: (reference, actor) =>
      loadSmsConsentWithdrawalReplayFromDatabase(database, reference, actor),
  };
}

/** Creates the production one-transaction SMS consent persistence. */
export function createDrizzleSmsConsentCapabilityStore(
  database: Database,
): SmsConsentCapabilityStore {
  return {
    transaction<Result>(
      operation: (
        transaction: SmsConsentCapabilityTransaction,
      ) => Promise<Result>,
    ): Promise<Result> {
      return database.transaction(async (transaction) =>
        operation(
          createDrizzleSmsConsentTransaction(
            smsConsentQueryDatabase(transaction),
          ),
        ),
      );
    },
    appendCapabilityAudit(event) {
      return database.transaction(async (transaction) =>
        appendSharedCapabilityAuditEntry(
          smsConsentQueryDatabase(transaction),
          event,
          PERSISTENCE,
        ),
      );
    },
  };
}

/** Runtime shared by the authenticated SMS consent routes. */
export interface SmsConsentCapabilityRuntime {
  readonly store: SmsConsentCapabilityStore;
  execute<Id extends SmsConsentCapabilityId>(
    capabilityId: Id,
    input: unknown,
    invocation: TrustedCapabilityInvocation,
  ): Promise<CapabilityOutput<Id>>;
  close(): Promise<void>;
}

/** Builds an SMS consent runtime around one managed DB connection. */
export function createSmsConsentCapabilityRuntime(
  connection: DatabaseConnection,
): SmsConsentCapabilityRuntime {
  const store = createDrizzleSmsConsentCapabilityStore(connection.db);
  return {
    store,
    execute: (capabilityId, input, invocation) =>
      executeSmsConsentCapability(capabilityId, input, invocation, store),
    close: () => connection.close(),
  };
}

let defaultSmsConsentCapabilityRuntime: SmsConsentCapabilityRuntime | undefined;

/** Lazily creates the database-backed runtime used by consent routes. */
export function getDefaultSmsConsentCapabilityRuntime(): SmsConsentCapabilityRuntime {
  defaultSmsConsentCapabilityRuntime ??= createSmsConsentCapabilityRuntime(
    createDatabaseClient(readDatabaseConfig()),
  );
  return defaultSmsConsentCapabilityRuntime;
}

/** Closes and clears the lazily created default consent runtime. */
export async function closeDefaultSmsConsentCapabilityRuntime(): Promise<void> {
  const runtime = defaultSmsConsentCapabilityRuntime;
  defaultSmsConsentCapabilityRuntime = undefined;
  await runtime?.close();
}

/** One authenticated web session's SMS consent execution. */
export interface SmsConsentSessionExecution<Id extends SmsConsentCapabilityId> {
  readonly authenticated: AuthenticatedSession;
  readonly capabilityId: Id;
  readonly command: unknown;
  readonly metadata?: Readonly<{
    requestId?: string;
    now?: Date;
    idempotencyKey?: string;
  }>;
  readonly runtime?: SmsConsentCapabilityRuntime;
}

/**
 * Executes a consent capability for a server component or server action.
 *
 * Web pages hold a session rather than a bearer token, so they resolve the
 * invocation here instead of going back out through the REST route the mobile
 * app uses. Both paths land on the same capability and the same audit.
 */
export function executeSmsConsentForSession<Id extends SmsConsentCapabilityId>(
  input: SmsConsentSessionExecution<Id>,
): Promise<CapabilityOutput<Id>> {
  const mutation =
    input.metadata?.idempotencyKey === undefined
      ? null
      : {
          idempotencyKey: input.metadata.idempotencyKey,
          humanConfirmationId: null,
        };
  const invocation = resolveHumanCapabilityInvocation(input.authenticated, {
    requestId: input.metadata?.requestId ?? randomUUID(),
    mutation,
    ...(input.metadata?.now === undefined
      ? {}
      : { serverTime: input.metadata.now }),
  });
  const runtime = input.runtime ?? getDefaultSmsConsentCapabilityRuntime();
  return runtime.execute(input.capabilityId, input.command, invocation);
}
