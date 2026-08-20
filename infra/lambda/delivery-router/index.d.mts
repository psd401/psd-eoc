export function routeDeliveryBatches(
  event: unknown,
  dependencies?: Readonly<{
    send?: (command: unknown) => Promise<unknown>;
    environment?: Readonly<Record<string, string | undefined>>;
  }>,
): Promise<{ batchItemFailures: readonly { itemIdentifier: string }[] }>;

export function handler(
  event: unknown,
): Promise<{ batchItemFailures: readonly { itemIdentifier: string }[] }>;
