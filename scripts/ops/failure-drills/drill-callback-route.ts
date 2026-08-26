import { and, eq } from 'drizzle-orm';

import { UuidSchema } from '@psd-eoc/contracts';
import {
  createDatabaseClient,
  readDatabaseConfig,
} from '@psd-eoc/server/db/client';
import {
  channelAttempts,
  deliveryEvidence,
  idempotencyRecords,
} from '@psd-eoc/server/db/schema';
import {
  createDrizzleSesWebhookStore,
  createSesWebhookRouteHandler,
} from '@psd-eoc/server/app/api/webhooks/ses/runtime';
import {
  authorizeSyntheticCallbackRequest,
  createSyntheticCallbackRequest,
} from './drill-callback-boundary';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const { accountId, origin, region } =
      authorizeSyntheticCallbackRequest(request);
    const body = (await request.json()) as Readonly<Record<string, unknown>>;
    const attemptId = UuidSchema.parse(body.attemptId);
    const callbackId = UuidSchema.parse(body.callbackId);
    const connection = createDatabaseClient(readDatabaseConfig());
    try {
      const store = createDrizzleSesWebhookStore(connection.db);
      const attempt = await store.loadAttempt(attemptId);
      if (
        attempt === null ||
        attempt.channel !== 'email' ||
        attempt.rosterPopulation !== 'synthetic' ||
        attempt.templateMode !== 'drill'
      ) {
        throw new Error('The callback attempt is not synthetic email work.');
      }
      const topicArn = `arn:aws:sns:${region}:${accountId}:synthetic-failure-drill`;
      const handler = createSesWebhookRouteHandler({
        readExpectedTopicArn: () => topicArn,
        verifySignature: () => Promise.resolve(),
        createStore: () => Promise.resolve(store),
      });
      const timestamp = new Date().toISOString();
      const first = await handler(
        createSyntheticCallbackRequest(
          origin,
          accountId,
          region,
          topicArn,
          callbackId,
          timestamp,
          attempt,
        ),
      );
      const replay = await handler(
        createSyntheticCallbackRequest(
          origin,
          accountId,
          region,
          topicArn,
          callbackId,
          timestamp,
          attempt,
        ),
      );
      if (first.status !== 204 || replay.status !== 204) {
        throw new Error('The exact callback replay was not acknowledged.');
      }
      const providerReference = `mock-provider-${callbackId}`;
      const [persistedAttempt] = await connection.db
        .select({
          id: channelAttempts.id,
          endpointId: channelAttempts.endpointId,
        })
        .from(channelAttempts)
        .where(eq(channelAttempts.id, attemptId))
        .limit(1);
      const evidence = await connection.db
        .select({
          id: deliveryEvidence.id,
          sequence: deliveryEvidence.sequence,
        })
        .from(deliveryEvidence)
        .where(
          and(
            eq(deliveryEvidence.attemptId, attemptId),
            eq(deliveryEvidence.provider, 'ses'),
            eq(deliveryEvidence.providerReference, providerReference),
          ),
        );
      const claims = await connection.db
        .select({
          id: idempotencyRecords.id,
          resultReference: idempotencyRecords.resultReference,
          status: idempotencyRecords.status,
        })
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.capabilityId, 'record-delivery-evidence'),
            eq(idempotencyRecords.resultReference, `ses-sns:${callbackId}`),
          ),
        );
      if (
        persistedAttempt === undefined ||
        evidence.length !== 1 ||
        claims.length !== 1 ||
        claims[0]?.status !== 'completed'
      ) {
        throw new Error('The callback replay evidence did not reconcile.');
      }
      const identity = `callback:${callbackId}:attempt:${persistedAttempt.id}:endpoint:${persistedAttempt.endpointId}`;
      return Response.json({
        observedSideEffects: [identity],
        facts: {
          attemptId: persistedAttempt.id,
          callbackId,
          callbackClaimId: claims[0].id,
          capabilityEvidenceId: evidence[0]?.id,
          capabilityEvidenceSequence: evidence[0]?.sequence,
          endpointId: persistedAttempt.endpointId,
          firstStatus: first.status,
          replayStatus: replay.status,
        },
      });
    } finally {
      await connection.close();
    }
  } catch {
    return Response.json(
      { code: 'FAILURE_DRILL_CALLBACK_REFUSED' },
      { status: 403 },
    );
  }
}
