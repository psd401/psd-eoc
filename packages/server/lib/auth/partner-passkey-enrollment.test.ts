import { describe, expect, test } from 'bun:test';

import {
  clearPartnerPasskeyCookieHeader,
  openPartnerPasskeyEnrollment,
  PARTNER_PASSKEY_COOKIE_NAME,
  partnerPasskeyCookieHeader,
  readPartnerPasskeyCookie,
  sealPartnerPasskeyEnrollment,
  type PartnerPasskeyEnrollment,
} from './partner-passkey-enrollment';
import { sealPartnerSignInFlow } from './partner-flow-cookie';

/**
 * Issue #599. The passkey enrollment hand-off carries the partner pool's own
 * access token between the two round trips a WebAuthn registration needs. It
 * must be unreadable by anything but the deployment that sealed it, must not
 * be openable as the sign-in flow cookie beside it, and must stop working on
 * its own.
 */

const environment = Object.freeze({
  GOOGLE_OIDC_COOKIE_SECRET: Buffer.alloc(32, 19).toString('base64url'),
});
const now = new Date('2026-10-31T12:00:00.000Z');

const enrollment: PartnerPasskeyEnrollment = Object.freeze({
  email: 'responder@agency.example.invalid',
  accessToken: 'pool-access-token-value',
  expiresAt: now.getTime() + 10 * 60 * 1_000,
});

describe('the partner passkey enrollment hand-off', () => {
  test('a sealed enrollment opens again unchanged', () => {
    const sealed = sealPartnerPasskeyEnrollment(enrollment, environment);
    expect(sealed.startsWith('k1.')).toBe(true);
    // Neither the address nor the pool's token is readable in the cookie.
    expect(sealed).not.toContain(enrollment.email);
    expect(sealed).not.toContain(enrollment.accessToken);
    expect(openPartnerPasskeyEnrollment(sealed, now, environment)).toEqual(
      enrollment,
    );
  });

  test('a tampered enrollment does not open', () => {
    const parts = sealPartnerPasskeyEnrollment(enrollment, environment).split(
      '.',
    );
    const corrupted = [
      parts[0],
      parts[1],
      `${parts[2]?.slice(0, -2) ?? ''}AA`,
      parts[3],
    ].join('.');
    expect(
      openPartnerPasskeyEnrollment(corrupted, now, environment),
    ).toBeNull();
  });

  test('another deployment’s secret does not open it', () => {
    const sealed = sealPartnerPasskeyEnrollment(enrollment, environment);
    expect(
      openPartnerPasskeyEnrollment(sealed, now, {
        GOOGLE_OIDC_COOKIE_SECRET: Buffer.alloc(32, 20).toString('base64url'),
      }),
    ).toBeNull();
  });

  test('an expired enrollment does not open', () => {
    const sealed = sealPartnerPasskeyEnrollment(enrollment, environment);
    expect(
      openPartnerPasskeyEnrollment(
        sealed,
        new Date(enrollment.expiresAt + 1),
        environment,
      ),
    ).toBeNull();
  });

  test('the sign-in flow cookie cannot be opened as an enrollment', () => {
    // Both hang off one deployment secret, so this is the property that keeps
    // them apart: each derives its own key with its own salt and label.
    const flowSeal = sealPartnerSignInFlow(
      {
        email: enrollment.email,
        flowSession: 'provider-session-handle',
        installationId: 'web.installation-identifier',
        expiresAt: enrollment.expiresAt,
      },
      environment,
    );
    expect(openPartnerPasskeyEnrollment(flowSeal, now, environment)).toBeNull();
  });

  test('an enrollment with no token does not open', () => {
    const sealed = sealPartnerPasskeyEnrollment(
      { ...enrollment, accessToken: '' },
      environment,
    );
    expect(openPartnerPasskeyEnrollment(sealed, now, environment)).toBeNull();
  });

  test('an address that is not lower-cased does not open', () => {
    // The address is the pool username, and the pool is addressed in one
    // casing throughout, so a mixed-case seal is not one this server wrote.
    const sealed = sealPartnerPasskeyEnrollment(
      { ...enrollment, email: 'Responder@Agency.Example.Invalid' },
      environment,
    );
    expect(openPartnerPasskeyEnrollment(sealed, now, environment)).toBeNull();
  });

  test('an invalid deployment secret is a failure, never a silent pass', () => {
    expect(() =>
      sealPartnerPasskeyEnrollment(enrollment, {
        GOOGLE_OIDC_COOKIE_SECRET: 'too-short',
      }),
    ).toThrow();
  });

  test("the two surfaces cannot open each other's hand-off", () => {
    // Issue #647. The app is handed the identical sealed value as an opaque
    // token, under its own label, so neither surface can finish the other's
    // enrollment even though both derive the same key.
    const native = sealPartnerPasskeyEnrollment(
      enrollment,
      environment,
      'native',
    );
    expect(native.startsWith('e1.')).toBe(true);
    expect(
      openPartnerPasskeyEnrollment(native, now, environment, 'native'),
    ).toEqual(enrollment);
    expect(openPartnerPasskeyEnrollment(native, now, environment)).toBeNull();
    const web = sealPartnerPasskeyEnrollment(enrollment, environment);
    expect(
      openPartnerPasskeyEnrollment(web, now, environment, 'native'),
    ).toBeNull();
    // Relabelling one is not enough either: the label is authenticated.
    expect(
      openPartnerPasskeyEnrollment(
        `e1.${web.slice('k1.'.length)}`,
        now,
        environment,
        'native',
      ),
    ).toBeNull();
  });

  test('the cookie is host-locked, HttpOnly and not sent across sites', () => {
    const header = partnerPasskeyCookieHeader(enrollment, environment);
    expect(header.startsWith(`${PARTNER_PASSKEY_COOKIE_NAME}=`)).toBe(true);
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    // Strict, not Lax: every request that reads this cookie is a same-origin
    // fetch from the enrollment page, never a navigation from elsewhere.
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Max-Age=600');
  });

  test('clearing the cookie expires it', () => {
    const header = clearPartnerPasskeyCookieHeader();
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('Expires=Thu, 01 Jan 1970');
  });

  test('a duplicated cookie is read as no cookie at all', () => {
    expect(
      readPartnerPasskeyCookie(
        `${PARTNER_PASSKEY_COOKIE_NAME}=a; ${PARTNER_PASSKEY_COOKIE_NAME}=b`,
      ),
    ).toBeNull();
    expect(
      readPartnerPasskeyCookie(`${PARTNER_PASSKEY_COOKIE_NAME}=only`),
    ).toBe('only');
    expect(readPartnerPasskeyCookie(null)).toBeNull();
  });
});
