import { describe, expect, test } from 'bun:test';

import { GOOGLE_IDENTITY_ISSUER } from '@psd-eoc/contracts';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

import {
  readPartnerPoolConfiguration,
  type PartnerPoolConfiguration,
} from './identity-providers';
import {
  CognitoPartnerOtpProvider,
  PartnerOtpError,
  resolvePartnerOtpProvider,
  syntheticPartnerOtpCode,
  syntheticPartnerOtpProvider,
  syntheticPartnerSubject,
  verifyPartnerIdToken,
} from './partner-otp';

/**
 * Issue #593. Partner identity comes from a token the pool signed, verified
 * against that pool's keys, its client, and `token_use`. A token from any
 * other issuer — Google's included — is refused.
 */

const POOL = 'us-west-2_Example1';
const POOL_ISSUER = `https://cognito-idp.us-west-2.amazonaws.com/${POOL}`;
const CLIENT_ID = 'partner-app-client';
const EMAIL = 'responder@agency.example.invalid';

const configuration: PartnerPoolConfiguration = Object.freeze({
  userPoolId: POOL,
  clientId: CLIENT_ID,
  clientSecretArn:
    'arn:aws:secretsmanager:us-west-2:111111111111:secret:/psd-eoc/partner-user-pool-client-AbCdEf',
  issuer: POOL_ISSUER,
  jwksUri: `${POOL_ISSUER}/.well-known/jwks.json`,
  synthetic: false,
});

const keys = await generateKeyPair('RS256');
const publicJwk: JWK = await exportJWK(keys.publicKey);

async function idToken(
  claims: Readonly<Record<string, unknown>> = {},
  algorithm = 'RS256',
): Promise<string> {
  return new SignJWT({
    token_use: 'id',
    email: EMAIL,
    email_verified: true,
    ...claims,
  })
    .setProtectedHeader({ alg: algorithm, kid: 'partner-key-1' })
    .setIssuer(
      typeof claims.iss === 'string' ? (claims.iss as string) : POOL_ISSUER,
    )
    .setAudience(
      typeof claims.aud === 'string' ? (claims.aud as string) : CLIENT_ID,
    )
    .setSubject(
      typeof claims.sub === 'string' ? (claims.sub as string) : 'cognito-sub-1',
    )
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);
}

describe('partner identity token verification', () => {
  test('accepts the pool’s own identity token', async () => {
    const token = await idToken();
    expect(
      await verifyPartnerIdToken(configuration, token, {
        keys: keys.publicKey,
      }),
    ).toMatchObject({
      issuer: POOL_ISSUER,
      audience: CLIENT_ID,
      subject: 'cognito-sub-1',
      email: EMAIL,
    });
  });

  test('refuses an access token presented as an identity', async () => {
    const token = await idToken({ token_use: 'access' });
    await expect(
      verifyPartnerIdToken(configuration, token, { keys: keys.publicKey }),
    ).rejects.toBeInstanceOf(PartnerOtpError);
  });

  test('refuses another pool, another client, and another issuer', async () => {
    for (const claims of [
      { iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other' },
      { aud: 'someone-elses-client' },
      { iss: GOOGLE_IDENTITY_ISSUER },
    ]) {
      const token = await idToken(claims);
      await expect(
        verifyPartnerIdToken(configuration, token, { keys: keys.publicKey }),
      ).rejects.toBeInstanceOf(PartnerOtpError);
    }
  });

  test('refuses a token signed by another key', async () => {
    const other = await generateKeyPair('RS256');
    const token = await idToken();
    await expect(
      verifyPartnerIdToken(configuration, token, { keys: other.publicKey }),
    ).rejects.toBeInstanceOf(PartnerOtpError);
    // The pool's published key material is what the production path uses.
    expect(publicJwk.kty).toBe('RSA');
  });

  test('refuses an expired token and an empty one', async () => {
    const expired = await new SignJWT({ token_use: 'id', email: EMAIL })
      .setProtectedHeader({ alg: 'RS256', kid: 'partner-key-1' })
      .setIssuer(POOL_ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject('cognito-sub-1')
      .setIssuedAt(Math.floor(Date.now() / 1_000) - 7_200)
      .setExpirationTime(Math.floor(Date.now() / 1_000) - 3_600)
      .sign(keys.privateKey);
    await expect(
      verifyPartnerIdToken(configuration, expired, { keys: keys.publicKey }),
    ).rejects.toBeInstanceOf(PartnerOtpError);
    await expect(
      verifyPartnerIdToken(configuration, '', { keys: keys.publicKey }),
    ).rejects.toBeInstanceOf(PartnerOtpError);
  });
});

describe('the Cognito partner provider', () => {
  function provider(
    responses: readonly unknown[],
    sent: unknown[] = [],
  ): CognitoPartnerOtpProvider {
    let index = 0;
    return new CognitoPartnerOtpProvider(
      configuration,
      {
        send: (command: unknown) => {
          sent.push(command);
          const response = responses[index];
          index += 1;
          if (response instanceof Error) throw response;
          return Promise.resolve(response);
        },
      } as never,
      () => Promise.resolve('partner-client-secret'),
    );
  }

  test('asks the pool for an email code and carries its session', async () => {
    const sent: unknown[] = [];
    const started = await provider(
      [{ ChallengeName: 'EMAIL_OTP', Session: 'cognito-session-1' }],
      sent,
    ).start(EMAIL);
    expect(started).toEqual({ flowSession: 'cognito-session-1' });
    const parameters = (
      sent[0] as { input: { AuthParameters: Record<string, string> } }
    ).input.AuthParameters;
    expect(parameters.PREFERRED_CHALLENGE).toBe('EMAIL_OTP');
    // The confidential client's credential proves the call came from us.
    expect(parameters.SECRET_HASH).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
  });

  test('an unenrolled address gets a challenge too, and its code is refused', async () => {
    // The pool's client hides user existence (prevent_user_existence_errors
    // in infra/terraform/stateful/main.tf); if it ever said so anyway, the
    // address must still get the same "code sent" step and the same refusal.
    const notFound = Object.assign(new Error('User does not exist.'), {
      name: 'UserNotFoundException',
    });
    const started = await provider([notFound]).start(EMAIL);
    expect(started.flowSession.length).toBeGreaterThan(20);

    const sent: unknown[] = [];
    await expect(
      provider([], sent).verify({
        email: EMAIL,
        flowSession: started.flowSession,
        code: '123456',
      }),
    ).rejects.toMatchObject({ code: 'PARTNER_SIGN_IN_REFUSED' });
    expect(sent).toHaveLength(0);

    // Every other failure is still the provider being unavailable.
    await expect(
      provider([new Error('ThrottlingException')]).start(EMAIL),
    ).rejects.toMatchObject({ code: 'PARTNER_PROVIDER_UNAVAILABLE' });
  });

  test('reports a provider that offers no email code as unavailable', async () => {
    await expect(
      provider([{ ChallengeName: 'WEB_AUTHN', Session: 's' }]).start(EMAIL),
    ).rejects.toMatchObject({ code: 'PARTNER_PROVIDER_UNAVAILABLE' });
  });

  test('a wrong code, an expired flow, and a disabled account are one refusal', async () => {
    for (const response of [
      new Error('CodeMismatchException'),
      new Error('NotAuthorizedException'),
      {},
    ]) {
      await expect(
        provider([response]).verify({
          email: EMAIL,
          flowSession: 'cognito-session-1',
          code: '123456',
        }),
      ).rejects.toMatchObject({ code: 'PARTNER_SIGN_IN_REFUSED' });
    }
  });

  test('refuses a code that is not a code before contacting the pool', async () => {
    const sent: unknown[] = [];
    await expect(
      provider([], sent).verify({
        email: EMAIL,
        flowSession: 'cognito-session-1',
        code: 'not-a-code',
      }),
    ).rejects.toMatchObject({ code: 'PARTNER_SIGN_IN_REFUSED' });
    expect(sent).toHaveLength(0);
  });

  test('a pool without a credential ARN cannot be addressed at all', () => {
    expect(
      () =>
        new CognitoPartnerOtpProvider({
          ...configuration,
          clientSecretArn: null,
        }),
    ).toThrow(PartnerOtpError);
  });
});

describe('the synthetic partner provider', () => {
  const synthetic = readPartnerPoolConfiguration({
    PSD_EOC_PARTNER_USER_POOL_ID: 'SYNTHETIC',
    PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN: 'allowed',
  });
  if (synthetic === null) throw new Error('No synthetic pool.');
  const provider = syntheticPartnerOtpProvider(synthetic);

  test('the derived code admits and every other code is refused', async () => {
    const { flowSession } = await provider.start(EMAIL);
    expect(
      await provider.verify({
        email: EMAIL,
        flowSession,
        code: syntheticPartnerOtpCode(EMAIL),
      }),
    ).toMatchObject({
      issuer: synthetic.issuer,
      subject: syntheticPartnerSubject(EMAIL),
      email: EMAIL,
    });
    await expect(
      provider.verify({ email: EMAIL, flowSession, code: '999999' }),
    ).rejects.toMatchObject({ code: 'PARTNER_SIGN_IN_REFUSED' });
  });

  test('a code is useless with another address’s flow', async () => {
    const { flowSession } = await provider.start(EMAIL);
    await expect(
      provider.verify({
        email: 'someone-else@agency.example.invalid',
        flowSession,
        code: syntheticPartnerOtpCode('someone-else@agency.example.invalid'),
      }),
    ).rejects.toMatchObject({ code: 'PARTNER_SIGN_IN_REFUSED' });
  });

  test('each address gets its own code', () => {
    expect(syntheticPartnerOtpCode(EMAIL)).toMatch(/^[0-9]{6}$/u);
    expect(syntheticPartnerOtpCode(EMAIL)).not.toBe(
      syntheticPartnerOtpCode('other@agency.example.invalid'),
    );
  });
});

describe('provider resolution', () => {
  test('no partner provider exists until a pool is configured', () => {
    expect(resolvePartnerOtpProvider({})).toBeNull();
    expect(
      resolvePartnerOtpProvider({
        PSD_EOC_PARTNER_USER_POOL_ID: 'UNCONFIGURED',
      }),
    ).toBeNull();
  });

  test('the synthetic pool selects the stand-in', () => {
    expect(
      resolvePartnerOtpProvider({
        PSD_EOC_PARTNER_USER_POOL_ID: 'SYNTHETIC',
        PSD_EOC_SYNTHETIC_PARTNER_SIGN_IN: 'allowed',
      })?.issuer,
    ).toBe('https://cognito-idp.example.invalid/synthetic-partner-pool');
  });

  test('a configured pool resolves to one provider per process', () => {
    // The route resolves the provider on every POST. One instance keeps the
    // app-client credential read once per process instead of once a request.
    const environment = {
      PSD_EOC_PARTNER_USER_POOL_ID: 'us-west-2_Example1',
      PSD_EOC_PARTNER_USER_POOL_CLIENT_ID: 'partner-app-client',
      PSD_EOC_PARTNER_USER_POOL_CLIENT_SECRET_ARN:
        'arn:aws:secretsmanager:us-west-2:111111111111:secret:/psd-eoc/partner-user-pool-client-AbCdEf',
    };
    const first = resolvePartnerOtpProvider(environment);
    expect(first).not.toBeNull();
    expect(resolvePartnerOtpProvider({ ...environment })).toBe(first);
    expect(
      resolvePartnerOtpProvider({
        ...environment,
        PSD_EOC_PARTNER_USER_POOL_CLIENT_ID: 'another-app-client',
      }),
    ).not.toBe(first);
  });
});
