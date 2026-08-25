import { Buffer } from 'node:buffer';
import { sign as signBytes } from 'node:crypto';
import { type AscCredentials, base64UrlJson } from './asc-model';
export const createAscJwt = (
  credentials: AscCredentials,
  now = new Date(),
): string => {
  const issuedAt = Math.floor(now.getTime() / 1000) - 5;
  const expiresAt = issuedAt + 1195;
  const encodedHeader = base64UrlJson({
    alg: 'ES256',
    kid: credentials.keyId,
    typ: 'JWT',
  });
  const encodedPayload = base64UrlJson({
    aud: 'appstoreconnect-v1',
    exp: expiresAt,
    iat: issuedAt,
    iss: credentials.issuerId,
  });
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = signBytes('sha256', Buffer.from(signingInput), {
    dsaEncoding: 'ieee-p1363',
    key: credentials.privateKey,
  });
  return `${signingInput}.${signature.toString('base64url')}`;
};
