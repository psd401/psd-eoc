import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ClientHttp2Session, ClientHttp2Stream } from 'node:http2';

import { decodeJwt, decodeProtectedHeader } from 'jose';

import { FCM_MESSAGING_SCOPE } from './fcm-credentials';
import {
  FcmOAuthTokenSourceError,
  NodeApnsHttp2Client,
  createApnsJwtSigner,
  createFcmServiceAccountTokenSource,
} from './provider-clients';
import type { ApnsHttp2Request } from './apns-transport';

function privateKeyPem(type: 'ec' | 'rsa'): string {
  const pair =
    type === 'ec'
      ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      : generateKeyPairSync('rsa', { modulusLength: 2048 });
  return pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

class FakeApnsStream extends EventEmitter {
  public destroyed = false;
  public requestBody: Uint8Array | null = null;

  public end(body: Uint8Array): void {
    this.requestBody = body;
  }

  public destroy(): this {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

class FakeApnsSession extends EventEmitter {
  public readonly stream = new FakeApnsStream();
  public closed = false;
  public destroyed = false;

  public request(): ClientHttp2Stream {
    return this.stream as unknown as ClientHttp2Stream;
  }

  public close(): void {
    this.closed = true;
  }

  public destroy(): void {
    this.destroyed = true;
    this.stream.destroy();
  }
}

function apnsRequest(signal: AbortSignal): ApnsHttp2Request {
  return {
    origin: 'https://api.sandbox.push.apple.com',
    method: 'POST',
    path: `/3/device/${'a'.repeat(64)}`,
    headers: { 'apns-topic': 'org.example.eoc' },
    body: new TextEncoder().encode('{}'),
    signal,
    tls: {
      alpnProtocol: 'h2',
      minimumVersion: 'TLSv1.2',
      servername: 'api.sandbox.push.apple.com',
    },
  };
}

describe('production direct-provider credential clients', () => {
  test('signs the exact APNs ES256 header and claims', async () => {
    const token = await createApnsJwtSigner()({
      algorithm: 'ES256',
      keyId: 'ABCDEFGHIJ',
      teamId: 'KLMNOPQRST',
      issuedAt: 1_700_000_000,
      privateKey: privateKeyPem('ec'),
    });
    expect(decodeProtectedHeader(token)).toEqual({
      alg: 'ES256',
      kid: 'ABCDEFGHIJ',
    });
    const claims = decodeJwt(token);
    expect(claims.iss).toBe('KLMNOPQRST');
    expect(claims.iat).toBe(1_700_000_000);
    expect(Object.keys(claims).sort()).toEqual(['iat', 'iss']);
  });

  test('pins the FCM OAuth audience, scope, identity, and bounded lifetime', async () => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    const source = createFcmServiceAccountTokenSource({
      clientEmail: 'direct-push@example-isolated.iam.gserviceaccount.com',
      privateKey: privateKeyPem('rsa'),
      clock: () => 1_700_000_000_000,
      fetch: (input, init) => {
        requestedUrl = String(input);
        requestedInit = init;
        return Promise.resolve(
          Response.json({
            access_token: 'synthetic-access-token-value',
            token_type: 'Bearer',
            expires_in: 3_600,
          }),
        );
      },
    });

    await expect(
      source({ projectId: 'example-isolated', scope: FCM_MESSAGING_SCOPE }),
    ).resolves.toEqual({
      accessToken: 'synthetic-access-token-value',
      projectId: 'example-isolated',
      expiresAt: 1_700_003_600_000,
    });
    expect(requestedUrl).toBe('https://oauth2.googleapis.com/token');
    expect(requestedInit?.method).toBe('POST');
    expect(requestedInit?.redirect).toBe('error');
    expect(requestedInit?.signal).toBeInstanceOf(AbortSignal);
    const form = new URLSearchParams(String(requestedInit?.body));
    expect(form.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
    const assertion = form.get('assertion');
    expect(assertion).not.toBeNull();
    if (assertion === null) throw new Error('OAuth assertion was absent.');
    expect(decodeProtectedHeader(assertion)).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = decodeJwt(assertion);
    expect(claims.iss).toBe(
      'direct-push@example-isolated.iam.gserviceaccount.com',
    );
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claims.iat).toBe(1_700_000_000);
    expect(claims.exp).toBe(1_700_003_600);
    expect(claims.scope).toBe(FCM_MESSAGING_SCOPE);
  });

  test('rejects a non-service-account identity before any network boundary', () => {
    expect(() =>
      createFcmServiceAccountTokenSource({
        clientEmail: 'operator@example.com',
        privateKey: 'not-used',
      }),
    ).toThrow('FCM service account identity is invalid.');
  });

  test('bounds OAuth acquisition and exposes only safe retry metadata', async () => {
    const privateKey = privateKeyPem('rsa');
    const request = {
      projectId: 'example-isolated',
      scope: FCM_MESSAGING_SCOPE,
    } as const;
    for (const testCase of [
      { status: 401, retryable: false },
      { status: 429, retryable: true },
      { status: 503, retryable: true },
    ]) {
      const hostileBody = `provider-secret-${testCase.status}`;
      const source = createFcmServiceAccountTokenSource({
        clientEmail: 'direct-push@example-isolated.iam.gserviceaccount.com',
        privateKey,
        fetch: () =>
          Promise.resolve(
            new Response(hostileBody, { status: testCase.status }),
          ),
      });
      try {
        await source(request);
        throw new Error('OAuth status unexpectedly succeeded.');
      } catch (error) {
        expect(error).toBeInstanceOf(FcmOAuthTokenSourceError);
        expect(error).toMatchObject({
          retryable: testCase.retryable,
          status: testCase.status,
        });
        expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(
          hostileBody,
        );
      }
    }

    const timedOut = createFcmServiceAccountTokenSource({
      clientEmail: 'direct-push@example-isolated.iam.gserviceaccount.com',
      privateKey,
      timeoutMilliseconds: 100,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('provider-controlled timeout detail')),
          );
        }),
    });
    await expect(timedOut(request)).rejects.toMatchObject({
      code: 'FCM_OAUTH_REQUEST_RETRYABLE',
      retryable: true,
      status: null,
    });

    for (const invalidSuccessBody of [
      'not-json',
      '{"access_token":',
      JSON.stringify({ token_type: 'Bearer', expires_in: 3_600 }),
      'x'.repeat(16 * 1_024 + 1),
    ]) {
      const invalidSuccess = createFcmServiceAccountTokenSource({
        clientEmail: 'direct-push@example-isolated.iam.gserviceaccount.com',
        privateKey,
        fetch: () => Promise.resolve(new Response(invalidSuccessBody)),
      });
      await expect(invalidSuccess(request)).rejects.toMatchObject({
        code: 'FCM_OAUTH_RESPONSE_INVALID',
        retryable: true,
        status: 200,
      });
    }
  });

  test('cleans up every APNs session on success, abort, error, and oversized response', async () => {
    const successfulSession = new FakeApnsSession();
    const successfulController = new AbortController();
    const successfulClient = new NodeApnsHttp2Client(
      () => successfulSession as unknown as ClientHttp2Session,
    );
    const successful = successfulClient.request(
      apnsRequest(successfulController.signal),
    );
    successfulSession.stream.emit('response', {
      ':status': 200,
      'apns-id': '12345678-1234-1234-1234-123456789abc',
    });
    successfulSession.stream.emit('end');
    await expect(successful).resolves.toMatchObject({ status: 200 });
    expect(successfulSession.closed).toBe(true);
    expect(successfulSession.listenerCount('error')).toBe(0);
    for (const event of ['response', 'data', 'end', 'error', 'close']) {
      expect(successfulSession.stream.listenerCount(event)).toBe(0);
    }
    successfulController.abort();
    expect(successfulSession.destroyed).toBe(false);

    const abortedSession = new FakeApnsSession();
    const abortedController = new AbortController();
    const abortedClient = new NodeApnsHttp2Client(
      () => abortedSession as unknown as ClientHttp2Session,
    );
    const aborted = abortedClient.request(
      apnsRequest(abortedController.signal),
    );
    abortedController.abort();
    await expect(aborted).rejects.toThrow('APNs request did not complete.');
    expect(abortedSession.destroyed).toBe(true);
    expect(abortedSession.stream.destroyed).toBe(true);
    expect(abortedSession.listenerCount('error')).toBe(0);
    for (const event of ['response', 'data', 'end', 'error', 'close']) {
      expect(abortedSession.stream.listenerCount(event)).toBe(0);
    }

    const failedSession = new FakeApnsSession();
    const failedClient = new NodeApnsHttp2Client(
      () => failedSession as unknown as ClientHttp2Session,
    );
    const failed = failedClient.request(
      apnsRequest(new AbortController().signal),
    );
    failedSession.stream.emit(
      'error',
      new Error('provider-controlled stream detail'),
    );
    await expect(failed).rejects.toThrow('APNs request did not complete.');
    expect(failedSession.destroyed).toBe(true);
    expect(failedSession.listenerCount('error')).toBe(0);
    for (const event of ['response', 'data', 'end', 'error', 'close']) {
      expect(failedSession.stream.listenerCount(event)).toBe(0);
    }

    const oversizedSession = new FakeApnsSession();
    const oversizedClient = new NodeApnsHttp2Client(
      () => oversizedSession as unknown as ClientHttp2Session,
    );
    const oversized = oversizedClient.request(
      apnsRequest(new AbortController().signal),
    );
    oversizedSession.stream.emit('data', new Uint8Array(16 * 1_024 + 1));
    await expect(oversized).rejects.toThrow('APNs request did not complete.');
    expect(oversizedSession.destroyed).toBe(true);
    expect(oversizedSession.stream.destroyed).toBe(true);
    expect(oversizedSession.listenerCount('error')).toBe(0);
    for (const event of ['response', 'data', 'end', 'error', 'close']) {
      expect(oversizedSession.stream.listenerCount(event)).toBe(0);
    }
  });
});
