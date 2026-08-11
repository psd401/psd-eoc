interface OperationWithCleanupInput<Result> {
  readonly operation: () => Promise<Result>;
  readonly cleanup: () => Promise<void>;
  readonly failureMessage: string;
}

interface OwnedDatabaseCreationInput {
  /**
   * Calls `recordCreated` immediately after CREATE DATABASE succeeds, then
   * applies and verifies the exact immutable ownership marker.
   */
  readonly createAndVerify: (recordCreated: () => void) => Promise<void>;
  readonly closeCreator: () => Promise<void>;
  /**
   * Uses a fresh connection and permits deletion only after exact marker
   * readback. An absent database is harmless; a null or mismatched marker
   * must fail closed.
   */
  readonly rollbackWithFreshMarkerProof: () => Promise<void>;
  readonly failureMessage: string;
}

function throwCapturedErrors(
  errors: readonly unknown[],
  message: string,
): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

/**
 * Runs cleanup after either success or failure without letting cleanup replace
 * the primary rejection value. Explicit arrays preserve `throw undefined`.
 */
export async function executeOperationWithCleanup<Result>(
  input: OperationWithCleanupInput<Result>,
): Promise<Result> {
  let operationCompleted = false;
  let result!: Result;
  const errors: unknown[] = [];
  try {
    result = await input.operation();
    operationCompleted = true;
  } catch (error) {
    errors.push(error);
  }

  try {
    await input.cleanup();
  } catch (error) {
    errors.push(error);
  }

  throwCapturedErrors(errors, input.failureMessage);
  if (!operationCompleted) {
    throw new Error('The owned database operation lost its rejection value.');
  }
  return result;
}

/**
 * Closes the creator before any rollback connection is opened. Every failure
 * after a successful CREATE attempts cleanup, but the cleanup callback itself
 * is the sole deletion authority and must freshly prove the exact marker.
 */
export async function executeOwnedDatabaseCreation(
  input: OwnedDatabaseCreationInput,
): Promise<void> {
  let created = false;
  let operationCompleted = false;
  const errors: unknown[] = [];
  try {
    await input.createAndVerify(() => {
      created = true;
    });
    operationCompleted = true;
    if (!created) {
      errors.push(
        new Error(
          'Owned database creation completed without recording CREATE DATABASE.',
        ),
      );
    }
  } catch (error) {
    errors.push(error);
  }

  try {
    await input.closeCreator();
  } catch (error) {
    errors.push(error);
  }

  if (errors.length > 0 && created) {
    try {
      await input.rollbackWithFreshMarkerProof();
    } catch (error) {
      errors.push(error);
    }
  }

  throwCapturedErrors(errors, input.failureMessage);
  if (!operationCompleted) {
    throw new Error('Owned database creation lost its rejection value.');
  }
}
