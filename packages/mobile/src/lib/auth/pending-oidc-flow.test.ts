import { describe, expect, test } from 'bun:test';

import {
  createPendingOidcFlowStore,
  parsePendingOidcFlow,
  serializePendingOidcFlow,
  type PendingOidcFlow,
  type PendingOidcFlowBackend,
} from './pending-oidc-flow';

const OIDC_STATE = `m1.${'S'.repeat(43)}`;
const FLOW_TOKEN = `m1.${'F'.repeat(16)}.${'T'.repeat(80)}`;
const CODE_VERIFIER = 'v'.repeat(43);

const flow: PendingOidcFlow = Object.freeze({
  state: OIDC_STATE,
  codeVerifier: CODE_VERIFIER,
  flowToken: FLOW_TOKEN,
  expiresAt: '2026-08-10T18:05:00.000Z',
});

function memoryBackend(
  initial: string | null = null,
): PendingOidcFlowBackend & {
  readonly reads: number[];
  value: string | null;
} {
  const calls: number[] = [];
  const backend = {
    reads: calls,
    value: initial,
    async read() {
      calls.push(1);
      return backend.value;
    },
    async write(value: string) {
      backend.value = value;
    },
    async remove() {
      backend.value = null;
    },
  };
  return backend;
}

describe('pending native OIDC flow record', () => {
  test('round-trips a contract-valid attempt', () => {
    expect(parsePendingOidcFlow(serializePendingOidcFlow(flow))).toEqual(flow);
  });

  test('refuses a record carrying an unexpected field', () => {
    const value = JSON.stringify({ ...flow, authorizationCode: 'smuggled' });
    expect(() => parsePendingOidcFlow(value)).toThrow(
      'The stored sign-in attempt is invalid.',
    );
  });

  test('refuses a state that is not a native OIDC state', () => {
    // A web-flow state must never satisfy the native resume path.
    const value = JSON.stringify({ ...flow, state: 'w1.' + 'S'.repeat(43) });
    expect(() => parsePendingOidcFlow(value)).toThrow();
  });

  test('refuses a verifier shorter than RFC 7636 allows', () => {
    const value = JSON.stringify({ ...flow, codeVerifier: 'v'.repeat(42) });
    expect(() => parsePendingOidcFlow(value)).toThrow();
  });

  test('refuses a malformed flow token', () => {
    const value = JSON.stringify({ ...flow, flowToken: 'not-a-flow-token' });
    expect(() => parsePendingOidcFlow(value)).toThrow();
  });

  test('refuses a non-object record', () => {
    expect(() => parsePendingOidcFlow('"a string"')).toThrow(
      'The stored sign-in attempt is invalid.',
    );
    expect(() => parsePendingOidcFlow('[]')).toThrow(
      'The stored sign-in attempt is invalid.',
    );
  });
});

describe('pending native OIDC flow store', () => {
  test('saves an attempt the next launch can read', async () => {
    const backend = memoryBackend();
    const store = createPendingOidcFlowStore(backend);
    await store.save(flow);
    expect(backend.value).not.toBeNull();
    expect(await store.take()).toEqual(flow);
  });

  test('take is single-use, so a redelivered deep link cannot replay it', async () => {
    const backend = memoryBackend();
    const store = createPendingOidcFlowStore(backend);
    await store.save(flow);

    expect(await store.take()).toEqual(flow);
    // Second delivery of the same psdeoc://auth/callback intent.
    expect(await store.take()).toBeNull();
  });

  test('take removes an unreadable record instead of leaving it to be retried', async () => {
    const backend = memoryBackend('{ not json');
    const store = createPendingOidcFlowStore(backend);

    expect(await store.take()).toBeNull();
    expect(backend.value).toBeNull();
  });

  test('take removes a record that parses but violates the contract', async () => {
    const backend = memoryBackend(
      JSON.stringify({ ...flow, codeVerifier: 'short' }),
    );
    const store = createPendingOidcFlowStore(backend);

    expect(await store.take()).toBeNull();
    expect(backend.value).toBeNull();
  });

  test('reports no attempt when nothing was ever started', async () => {
    const store = createPendingOidcFlowStore(memoryBackend());
    expect(await store.take()).toBeNull();
  });

  test('clear discards an attempt without reading it', async () => {
    const backend = memoryBackend();
    const store = createPendingOidcFlowStore(backend);
    await store.save(flow);
    await store.clear();

    expect(backend.value).toBeNull();
    expect(backend.reads).toHaveLength(0);
  });

  test('refuses to save an attempt that violates the contract', async () => {
    const backend = memoryBackend();
    const store = createPendingOidcFlowStore(backend);

    await expect(
      store.save({ ...flow, flowToken: 'not-a-flow-token' }),
    ).rejects.toThrow();
    expect(backend.value).toBeNull();
  });
});
