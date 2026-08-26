import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { eq } from 'drizzle-orm';

import {
  createDatabaseClient,
  readDatabaseConfig,
} from '../../../packages/server/db/client';
import { sessions } from '../../../packages/server/db/schema';
import {
  createDrizzleDeliveryEvidenceStore,
  parseDeliveryStateWriteRequest,
  type DeliveryEvidenceStore,
} from '../../../packages/server/app/api/internal/delivery-state/runtime';
import { createDrizzleAttemptExecutionStore } from '../../../packages/server/lib/notify/attempt-execution-store';
import {
  DrizzleSessionStore,
  SessionService,
} from '../../../packages/server/lib/auth/sessions';
import { MockSesEmailAdapter } from '../../../workers/email/mock-ses-adapter';
import { MockExpoPushAdapter } from '../../../workers/push/mock';
import { parseWorkerAttemptWorkItem } from '../../../workers/shared/attempt';
import {
  WorkerAttemptProcessor,
  WorkerProcessingError,
  type AttemptIdempotentProviderAdapter,
  type AttemptExecutionStore,
  type ProviderSendOutcome,
  type ProviderSendRequest,
} from '../../../workers/shared/processor';
import type { AttemptEvidenceWriter } from '../../../workers/shared/delivery-state-client';

type WorkerMode =
  | 'crash-after-provider'
  | 'recover-after-crash'
  | 'revoked-device';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required by the deployed mock worker.`);
  return value;
}

function mode(): WorkerMode {
  const value = requiredEnvironment('PSD_EOC_FAILURE_DRILL_WORKER_MODE');
  if (
    value !== 'crash-after-provider' &&
    value !== 'recover-after-crash' &&
    value !== 'revoked-device'
  ) {
    throw new Error('The deployed mock worker mode is invalid.');
  }
  return value;
}

function assertBoundary(): void {
  if (
    requiredEnvironment('PSD_EOC_FAILURE_DRILL_DEPLOYMENT_CLASS') !==
      'non-production' ||
    requiredEnvironment('PSD_EOC_FAILURE_DRILL_PROVIDER_MODE') !== 'mocked' ||
    requiredEnvironment('PSD_EOC_FAILURE_DRILL_ROSTER_POPULATION') !==
      'synthetic' ||
    requiredEnvironment('GOOGLE_OIDC_HOSTED_DOMAIN') !== 'example.invalid'
  ) {
    throw new Error('The deployed mock worker boundary is unavailable.');
  }
  for (const forbidden of [
    'DATABASE_ADMIN_PASSWORD',
    'DATABASE_ADMIN_USERNAME',
    'PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN',
  ]) {
    if (Object.hasOwn(process.env, forbidden)) {
      throw new Error(
        `The deployed mock worker must not receive ${forbidden}.`,
      );
    }
  }
}

class FifoMockSesAdapter implements AttemptIdempotentProviderAdapter {
  public readonly channel = 'email' as const;
  public readonly integrationId = 'ses-email' as const;
  public readonly truthLabel = 'mocked' as const;
  public readonly provider = 'mock-ses' as const;
  public readonly deliverySemantics = 'attempt-id-idempotent' as const;
  readonly #validator = new MockSesEmailAdapter();
  readonly #client = new SQSClient({
    region: requiredEnvironment('AWS_REGION'),
    maxAttempts: 3,
  });

  public constructor(private readonly terminateAfterSend: boolean) {}

  public async send(
    request: ProviderSendRequest,
  ): Promise<ProviderSendOutcome> {
    await this.#validator.send(request);
    const workItem = parseWorkerAttemptWorkItem(request.workItem);
    const sent = await this.#client.send(
      new SendMessageCommand({
        MessageBody: JSON.stringify({
          attemptId: workItem.attempt.id,
          endpointId: workItem.attempt.endpointId,
          eventId: workItem.attempt.eventId,
          kind: 'failure-drill-mock-provider-side-effect',
          runId: requiredEnvironment('PSD_EOC_FAILURE_DRILL_RUN_ID'),
        }),
        MessageDeduplicationId: workItem.attempt.id,
        MessageGroupId: `worker-${requiredEnvironment('PSD_EOC_FAILURE_DRILL_RUN_ID')}`,
        QueueUrl: requiredEnvironment(
          'PSD_EOC_FAILURE_DRILL_MOCK_PROVIDER_QUEUE_URL',
        ),
      }),
    );
    if (!sent.MessageId) {
      throw new Error('The mock provider did not return a message identity.');
    }
    console.log(
      JSON.stringify({
        kind: 'failure-drill-mock-provider-accepted',
        attemptId: workItem.attempt.id,
        endpointId: workItem.attempt.endpointId,
        messageId: sent.MessageId,
      }),
    );
    if (this.terminateAfterSend) {
      console.log(
        JSON.stringify({
          kind: 'failure-drill-injected-worker-termination',
          attemptId: workItem.attempt.id,
        }),
      );
      process.exit(86);
    }
    return Object.freeze({
      state: 'provider-accepted',
      provider: this.provider,
      providerReference: `mock-ses-fifo:${sent.MessageId}`,
      proof: null,
      reasonCode: null,
      diagnosticDigest: null,
    });
  }
}

function revocationAwareWriter(
  store: DeliveryEvidenceStore,
  sessionId: string,
  database: ReturnType<typeof createDatabaseClient>['db'],
): AttemptEvidenceWriter {
  return Object.freeze({
    async recordAttemptEvidence(
      request: Parameters<AttemptEvidenceWriter['recordAttemptEvidence']>[0],
    ) {
      const parsed = parseDeliveryStateWriteRequest(request);
      const evidence = await store.recordAttemptEvidence(parsed);
      if (parsed.evidence.state !== 'attempted') return evidence;
      const deadline = Date.now() + 2 * 60_000;
      while (Date.now() < deadline) {
        const [session] = await database
          .select({ revokedAt: sessions.revokedAt })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        if (session?.revokedAt !== null && session?.revokedAt !== undefined) {
          return evidence;
        }
        await Bun.sleep(1_000);
      }
      throw new Error('The deployed device revocation did not arrive.');
    },
  });
}

async function main(): Promise<void> {
  assertBoundary();
  const workerMode = mode();
  const workItemValue: unknown = JSON.parse(
    requiredEnvironment('PSD_EOC_FAILURE_DRILL_WORK_ITEM'),
  );
  if (!Array.isArray(workItemValue) || workItemValue.length === 0) {
    throw new Error('The deployed mock worker requires a work-item set.');
  }
  const workItems = workItemValue.map((item) =>
    parseWorkerAttemptWorkItem(item),
  );
  if (
    (workerMode === 'revoked-device') !== (workItems.length === 1) ||
    (workerMode !== 'revoked-device' && workItems.length < 2)
  ) {
    throw new Error('The deployed mock worker fan-out shape is invalid.');
  }
  const connection = createDatabaseClient(readDatabaseConfig());
  if (connection.driver !== 'postgres') {
    throw new Error('The deployed mock worker requires PostgreSQL.');
  }
  try {
    const evidenceStore = createDrizzleDeliveryEvidenceStore(connection.db);
    const sessionId = process.env.PSD_EOC_FAILURE_DRILL_SESSION_ID;
    const sessionCredential =
      process.env.PSD_EOC_FAILURE_DRILL_SESSION_CREDENTIAL;
    const revocationMode = workerMode === 'revoked-device';
    if (
      revocationMode !==
      (sessionId !== undefined && sessionCredential !== undefined)
    ) {
      throw new Error('The deployed revocation fixture is incomplete.');
    }
    const sessionService = revocationMode
      ? new SessionService(new DrizzleSessionStore(connection.db))
      : undefined;
    const adapter: AttemptIdempotentProviderAdapter = revocationMode
      ? new MockExpoPushAdapter()
      : new FifoMockSesAdapter(workerMode === 'crash-after-provider');
    const processor = new WorkerAttemptProcessor({
      adapter,
      executionStore: createDrizzleAttemptExecutionStore(
        connection.db,
      ) as unknown as AttemptExecutionStore,
      evidenceWriter: revocationMode
        ? revocationAwareWriter(evidenceStore, sessionId!, connection.db)
        : evidenceStore,
      leaseMilliseconds: 1_000,
      authorizeProviderSend: revocationMode
        ? async () => {
            try {
              await sessionService!.authenticate(
                sessionCredential!,
                'web',
                new Date(),
              );
              return true;
            } catch {
              return false;
            }
          }
        : () => true,
    });
    for (const workItem of workItems) {
      try {
        const result = await processor.process(workItem);
        if (revocationMode) {
          throw new Error(
            'A revoked device reached the mock provider boundary.',
          );
        }
        if (result.kind !== 'completed') {
          throw new Error('The recovered worker did not complete its attempt.');
        }
        console.log(
          JSON.stringify({
            kind: 'failure-drill-deployed-worker-complete',
            attemptId: workItem.attempt.id,
            endpointId: workItem.attempt.endpointId,
            evidenceIds: [
              result.attemptedEvidence.id,
              result.outcomeEvidence.id,
            ],
          }),
        );
      } catch (error) {
        if (
          revocationMode &&
          error instanceof WorkerProcessingError &&
          error.code === 'PROVIDER_SEND_DISABLED'
        ) {
          console.log(
            JSON.stringify({
              kind: 'failure-drill-deployed-revocation-blocked',
              attemptId: workItem.attempt.id,
              endpointId: workItem.attempt.endpointId,
              sessionId,
            }),
          );
          return;
        }
        throw error;
      }
    }
  } finally {
    await connection.close();
  }
}

await main();
