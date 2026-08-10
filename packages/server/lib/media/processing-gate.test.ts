import { describe, expect, test } from 'bun:test';

import {
  MediaProcessingCapacityError,
  createMediaProcessingGate,
} from './processing-gate';

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

describe('media processing admission', () => {
  test('rejects concurrent work instead of queueing untrusted media', async () => {
    const gate = createMediaProcessingGate();
    const release = deferred();
    const first = gate.run(async () => {
      await release.promise;
      return 'first';
    });

    await expect(gate.run(async () => 'second')).rejects.toBeInstanceOf(
      MediaProcessingCapacityError,
    );
    release.resolve();
    expect(await first).toBe('first');
    expect(await gate.run(async () => 'after-release')).toBe('after-release');
  });

  test('always releases capacity after processing rejects', async () => {
    const gate = createMediaProcessingGate();
    await expect(
      gate.run(async () => {
        throw new Error('synthetic processing failure');
      }),
    ).rejects.toThrow('synthetic processing failure');
    expect(await gate.run(async () => 'recovered')).toBe('recovered');
  });

  test('rejects invalid concurrency configuration', () => {
    expect(() => createMediaProcessingGate(0)).toThrow(RangeError);
    expect(() => createMediaProcessingGate(1.5)).toThrow(RangeError);
  });
});
