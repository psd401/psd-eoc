import { describe, expect, test } from 'bun:test';

import {
  MediaProviderCapacityError,
  MediaProcessingCapacityError,
  createMediaProviderGate,
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
    const first = gate.run('facility-a', async () => {
      await release.promise;
      return 'first';
    });

    await expect(
      gate.run('facility-a', async () => 'second'),
    ).rejects.toBeInstanceOf(MediaProcessingCapacityError);
    release.resolve();
    expect(await first).toBe('first');
    expect(await gate.run('facility-a', async () => 'after-release')).toBe(
      'after-release',
    );
  });

  test('reserves independent slots for two facilities within the per-instance ceiling', async () => {
    const gate = createMediaProcessingGate();
    const release = deferred();
    let entered = 0;
    const run = (facilityId: string) =>
      gate.run(facilityId, async () => {
        entered += 1;
        await release.promise;
        return facilityId;
      });
    const first = run('facility-a');
    const second = run('facility-b');

    await expect(run('facility-c')).rejects.toBeInstanceOf(
      MediaProcessingCapacityError,
    );
    expect(entered).toBe(2);
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      'facility-a',
      'facility-b',
    ]);
  });

  test('always releases capacity after processing rejects', async () => {
    const gate = createMediaProcessingGate();
    await expect(
      gate.run('facility-a', async () => {
        throw new Error('synthetic processing failure');
      }),
    ).rejects.toThrow('synthetic processing failure');
    expect(await gate.run('facility-a', async () => 'recovered')).toBe(
      'recovered',
    );
  });

  test('rejects invalid concurrency configuration', () => {
    expect(() => createMediaProcessingGate(0)).toThrow(RangeError);
    expect(() => createMediaProcessingGate(1.5)).toThrow(RangeError);
    expect(() => createMediaProcessingGate(2, 1)).toThrow(RangeError);
    expect(() => createMediaProcessingGate(1, 2.5)).toThrow(RangeError);
  });
});

describe('media provider admission', () => {
  test('uses two slots and rejects excess provider work without queueing', async () => {
    const gate = createMediaProviderGate();
    const release = deferred();
    let providerEntries = 0;
    const enterProvider = (result: string) =>
      gate.run(async () => {
        providerEntries += 1;
        await release.promise;
        return result;
      });
    const first = enterProvider('first');
    const second = enterProvider('second');

    await expect(enterProvider('excess')).rejects.toBeInstanceOf(
      MediaProviderCapacityError,
    );
    expect(providerEntries).toBe(2);

    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      'first',
      'second',
    ]);
    await expect(gate.run(async () => 'after-release')).resolves.toBe(
      'after-release',
    );
  });

  test('recovers both slots after provider timeout failures', async () => {
    const gate = createMediaProviderGate();
    const rejectAsTimedOut = deferred();
    const timedOutProviderCall = () =>
      gate.run(async () => {
        await rejectAsTimedOut.promise;
        throw new Error('synthetic provider timeout');
      });
    const first = timedOutProviderCall();
    const second = timedOutProviderCall();

    await expect(gate.run(async () => 'queued')).rejects.toBeInstanceOf(
      MediaProviderCapacityError,
    );
    const captureFailure = (operation: Promise<unknown>) =>
      operation.then(
        () => new Error('Expected the provider operation to time out.'),
        (error: unknown) => error,
      );
    const firstFailure = captureFailure(first);
    const secondFailure = captureFailure(second);
    rejectAsTimedOut.resolve();
    expect(await firstFailure).toEqual(
      expect.objectContaining({ message: 'synthetic provider timeout' }),
    );
    expect(await secondFailure).toEqual(
      expect.objectContaining({ message: 'synthetic provider timeout' }),
    );
    await expect(
      Promise.all([
        gate.run(async () => 'recovered-first'),
        gate.run(async () => 'recovered-second'),
      ]),
    ).resolves.toEqual(['recovered-first', 'recovered-second']);
  });

  test('rejects invalid provider concurrency configuration', () => {
    expect(() => createMediaProviderGate(0)).toThrow(RangeError);
    expect(() => createMediaProviderGate(2.5)).toThrow(RangeError);
  });
});
