import {
  ActivationPreviewSchema,
  PreparedActivationSchema,
  type Actor,
  type ActivationPreview,
  type CapabilityOutput,
  type PreparedActivation,
} from '@psd-eoc/contracts';

import {
  CapabilityEngineError,
  executeAuditedCapabilityTransaction,
  readCapabilityTime,
  type CapabilityEngineStore,
  type CapabilityEngineTransaction,
  type ServerCapabilityRegistration,
  type TrustedCapabilityInvocation,
} from '../capabilities/engine';

export type PreparedActivationCapabilityId =
  | 'prepare-activation'
  | 'get-prepared-activation';

export interface PersistPreparedActivationInput {
  readonly preview: ActivationPreview;
  readonly preparedBy: Actor;
  readonly preparedAt: Date;
}

/** Persistence used by the canonical prepared-activation capability handlers. */
export interface PreparedActivationCapabilityTransaction
  extends CapabilityEngineTransaction {
  getActivationPreview(
    activationPreviewId: string,
  ): Promise<ActivationPreview | null>;
  getPreparedActivation(
    preparedActivationId: string,
  ): Promise<PreparedActivation | null>;
  createPreparedActivation(
    input: PersistPreparedActivationInput,
  ): Promise<PreparedActivation>;
  getPreparedActivationFacilityId(
    preparedActivationId: string,
  ): Promise<string | null>;
}

export type PreparedActivationCapabilityStore =
  CapabilityEngineStore<PreparedActivationCapabilityTransaction>;

function notFound(message: string): CapabilityEngineError {
  return new CapabilityEngineError(
    'NOT_FOUND',
    'PERSISTENCE_CONFLICT',
    message,
    404,
  );
}

function expired(): CapabilityEngineError {
  return new CapabilityEngineError(
    'FORBIDDEN',
    'CAPABILITY_INVOCATION_DENIED',
    'The activation preview has expired and must be recreated.',
    403,
  );
}

async function activationPreview(
  activationPreviewId: string,
  context: Parameters<
    ServerCapabilityRegistration<
      'prepare-activation',
      PreparedActivationCapabilityTransaction
    >['handler']
  >[1],
): Promise<ActivationPreview> {
  const cacheKey = `agent:activation-preview:${activationPreviewId}`;
  const cached = context.cache.get(cacheKey);
  if (cached !== undefined) {
    return ActivationPreviewSchema.parse(cached);
  }
  const loaded =
    await context.transaction.getActivationPreview(activationPreviewId);
  if (loaded === null) {
    throw notFound('The activation preview was not found.');
  }
  const parsed = ActivationPreviewSchema.parse(loaded);
  context.cache.set(cacheKey, parsed);
  return parsed;
}

export const prepareActivationRegistration: ServerCapabilityRegistration<
  'prepare-activation',
  PreparedActivationCapabilityTransaction
> = {
  id: 'prepare-activation',
  async resolveFacilityId(input, context) {
    return (await activationPreview(input.activationPreviewId, context))
      .facilityId;
  },
  async handler(input, context): Promise<PreparedActivation> {
    const preview = await activationPreview(input.activationPreviewId, context);
    const currentTime = await readCapabilityTime(context);
    if (currentTime.getTime() > Date.parse(preview.expiresAt)) {
      throw expired();
    }
    return PreparedActivationSchema.parse(
      await context.transaction.createPreparedActivation({
        preview,
        preparedBy: context.invocation.actor,
        preparedAt: currentTime,
      }),
    );
  },
  resultReference: (result) => result.id,
  async loadReplay(reference, context) {
    const prepared = await context.transaction.getPreparedActivation(reference);
    if (prepared === null) {
      throw new CapabilityEngineError(
        'INTERNAL_ERROR',
        'IDEMPOTENCY_RESULT_UNAVAILABLE',
        'The original prepared activation is unavailable.',
        500,
      );
    }
    return PreparedActivationSchema.parse(prepared);
  },
  resolveReplayFacilityId: (reference, context) =>
    context.transaction.getPreparedActivationFacilityId(reference),
  replayFacilityId: (result) => result.preview.facilityId,
};

export const getPreparedActivationRegistration: ServerCapabilityRegistration<
  'get-prepared-activation',
  PreparedActivationCapabilityTransaction
> = {
  id: 'get-prepared-activation',
  resolveFacilityId: (input, context) =>
    context.transaction.getPreparedActivationFacilityId(
      input.preparedActivationId,
    ),
  async handler(input, context): Promise<PreparedActivation> {
    const prepared = await context.transaction.getPreparedActivation(
      input.preparedActivationId,
    );
    if (prepared === null) {
      throw notFound('The prepared activation was not found.');
    }
    return PreparedActivationSchema.parse(prepared);
  },
};

const registrations = Object.freeze({
  'prepare-activation': prepareActivationRegistration,
  'get-prepared-activation': getPreparedActivationRegistration,
});

/** Runs preparation and retrieval through the shared server capability engine. */
export async function executePreparedActivationCapability<
  Id extends PreparedActivationCapabilityId,
>(
  capabilityId: Id,
  input: unknown,
  invocation: TrustedCapabilityInvocation,
  store: PreparedActivationCapabilityStore,
): Promise<CapabilityOutput<Id>> {
  const registration = registrations[
    capabilityId
  ] as ServerCapabilityRegistration<
    Id,
    PreparedActivationCapabilityTransaction
  >;
  return executeAuditedCapabilityTransaction(
    registration,
    input,
    invocation,
    store,
  );
}
