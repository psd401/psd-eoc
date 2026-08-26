import { describe, expect, test } from 'bun:test';

import {
  APNS_JWT_ALGORITHM,
  APNS_JWT_MAXIMUM_AGE_MILLISECONDS,
  APNS_JWT_MINIMUM_REFRESH_MILLISECONDS,
  APNS_JWT_REFRESH_MILLISECONDS,
  ApnsJwtCredential,
  type ApnsJwtSigningInput,
} from './apns-credentials';

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(128)}\n-----END PRIVATE KEY-----`;

describe('APNs ES256 credential cache', () => {
  test('binds key/team/iat and refreshes between the official 20 and 60 minute bounds', async () => {
    let now = Date.parse('2026-08-26T12:00:00.000Z');
    const inputs: ApnsJwtSigningInput[] = [];
    const credential = new ApnsJwtCredential({
      teamId: 'TEAMID1234',
      keyId: 'KEYID12345',
      privateKey: PRIVATE_KEY,
      clock: () => now,
      signer: (input) => {
        inputs.push(input);
        return `header.payload.signature${inputs.length}`;
      },
    });

    const first = await credential.getToken();
    now += APNS_JWT_MINIMUM_REFRESH_MILLISECONDS;
    expect(await credential.getToken()).toBe(first);
    now +=
      APNS_JWT_REFRESH_MILLISECONDS - APNS_JWT_MINIMUM_REFRESH_MILLISECONDS - 1;
    expect(await credential.getToken()).toBe(first);
    now += 1;
    expect(await credential.getToken()).not.toBe(first);

    expect(APNS_JWT_REFRESH_MILLISECONDS).toBeGreaterThanOrEqual(
      APNS_JWT_MINIMUM_REFRESH_MILLISECONDS,
    );
    expect(APNS_JWT_REFRESH_MILLISECONDS).toBeLessThan(
      APNS_JWT_MAXIMUM_AGE_MILLISECONDS,
    );
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toEqual({
      algorithm: APNS_JWT_ALGORITHM,
      keyId: 'KEYID12345',
      teamId: 'TEAMID1234',
      issuedAt: Date.parse('2026-08-26T12:00:00.000Z') / 1_000,
      privateKey: PRIVATE_KEY,
    });
  });

  test('coalesces concurrent signing and rejects malformed secrets or signer output', async () => {
    let release!: (value: string) => void;
    let calls = 0;
    const credential = new ApnsJwtCredential({
      teamId: 'TEAMID1234',
      keyId: 'KEYID12345',
      privateKey: PRIVATE_KEY,
      signer: () => {
        calls += 1;
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
    });
    const left = credential.getToken();
    const right = credential.getToken();
    release('header.payload.signature');
    await expect(left).resolves.toBe('header.payload.signature');
    await expect(right).resolves.toBe('header.payload.signature');
    expect(calls).toBe(1);

    expect(
      () =>
        new ApnsJwtCredential({
          teamId: 'short',
          keyId: 'KEYID12345',
          privateKey: PRIVATE_KEY,
          signer: () => 'header.payload.signature',
        }),
    ).toThrow('APNs team identifier is invalid.');
    const malformed = new ApnsJwtCredential({
      teamId: 'TEAMID1234',
      keyId: 'KEYID12345',
      privateKey: PRIVATE_KEY,
      signer: () => 'not-a-jwt',
    });
    await expect(malformed.getToken()).rejects.toThrow(
      'APNs JWT signer returned an invalid token.',
    );
  });

  test('accepts one standard trailing PEM newline and rejects additional trailing data', async () => {
    const signingInputs: ApnsJwtSigningInput[] = [];
    const credential = new ApnsJwtCredential({
      teamId: 'TEAMID1234',
      keyId: 'KEYID12345',
      privateKey: `${PRIVATE_KEY}\n`,
      signer: (input) => {
        signingInputs.push(input);
        return 'header.payload.signature';
      },
    });

    await expect(credential.getToken()).resolves.toBe(
      'header.payload.signature',
    );
    expect(signingInputs[0]?.privateKey).toBe(PRIVATE_KEY);
    for (const privateKey of [
      `${PRIVATE_KEY}\n\n`,
      ` ${PRIVATE_KEY}\n`,
      `${PRIVATE_KEY}\r\n`,
      PRIVATE_KEY.replace('AAAA', 'AA\0AA'),
      PRIVATE_KEY.replace('AAAA', 'AA\tAA'),
      PRIVATE_KEY.replace('AAAA', 'AA\u007fAA'),
    ]) {
      expect(
        () =>
          new ApnsJwtCredential({
            teamId: 'TEAMID1234',
            keyId: 'KEYID12345',
            privateKey,
            signer: () => 'header.payload.signature',
          }),
      ).toThrow('APNs private key is invalid.');
    }
  });
});
