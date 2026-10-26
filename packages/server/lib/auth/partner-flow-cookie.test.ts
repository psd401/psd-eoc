import { describe, expect, test } from 'bun:test';

import {
  clearPartnerFlowCookieHeader,
  openPartnerSignInFlow,
  PARTNER_FLOW_COOKIE_NAME,
  partnerFlowCookieHeader,
  PartnerFlowCookieError,
  readPartnerFlowCookie,
  sealPartnerSignInFlow,
  type PartnerSignInFlow,
} from './partner-flow-cookie';

/**
 * Issue #593. The between-steps cookie is the only state one partner
 * sign-in carries, and nothing in it may be chosen by the browser.
 */

const environment = Object.freeze({
  GOOGLE_OIDC_COOKIE_SECRET: Buffer.alloc(32, 7).toString('base64url'),
});
const now = new Date('2026-10-25T12:00:00.000Z');

const flow: PartnerSignInFlow = Object.freeze({
  email: 'responder@agency.example.invalid',
  flowSession: 'provider-session-handle',
  installationId: 'web.installation-identifier',
  expiresAt: now.getTime() + 5 * 60 * 1_000,
});

describe('the partner sign-in flow cookie', () => {
  test('a sealed flow opens again unchanged', () => {
    const sealed = sealPartnerSignInFlow(flow, environment);
    expect(sealed).not.toContain(flow.email);
    expect(sealed).not.toContain(flow.flowSession);
    expect(openPartnerSignInFlow(sealed, now, environment)).toEqual(flow);
  });

  test('a tampered flow does not open', () => {
    const sealed = sealPartnerSignInFlow(flow, environment);
    const parts = sealed.split('.');
    const corrupted = [
      parts[0],
      parts[1],
      `${parts[2]?.slice(0, -2) ?? ''}AA`,
      parts[3],
    ].join('.');
    expect(openPartnerSignInFlow(corrupted, now, environment)).toBeNull();
    expect(
      openPartnerSignInFlow(`${sealed}.extra`, now, environment),
    ).toBeNull();
    expect(openPartnerSignInFlow('p1.a.b.c', now, environment)).toBeNull();
  });

  test('another deployment’s secret does not open it', () => {
    const sealed = sealPartnerSignInFlow(flow, environment);
    expect(
      openPartnerSignInFlow(sealed, now, {
        GOOGLE_OIDC_COOKIE_SECRET: Buffer.alloc(32, 8).toString('base64url'),
      }),
    ).toBeNull();
  });

  test('an expired flow does not open', () => {
    const sealed = sealPartnerSignInFlow(flow, environment);
    expect(
      openPartnerSignInFlow(
        sealed,
        new Date(flow.expiresAt + 1_000),
        environment,
      ),
    ).toBeNull();
  });

  test('a flow with an unusable field does not open', () => {
    for (const broken of [
      { ...flow, email: 'Responder@Agency.Example.Invalid' },
      { ...flow, installationId: 'short' },
      { ...flow, flowSession: '' },
    ]) {
      expect(
        openPartnerSignInFlow(
          sealPartnerSignInFlow(broken, environment),
          now,
          environment,
        ),
      ).toBeNull();
    }
  });

  test('a missing or unusable secret refuses to seal anything', () => {
    expect(() => sealPartnerSignInFlow(flow, {})).toThrow(
      PartnerFlowCookieError,
    );
    expect(() =>
      sealPartnerSignInFlow(flow, { GOOGLE_OIDC_COOKIE_SECRET: 'too-short' }),
    ).toThrow(PartnerFlowCookieError);
    expect(openPartnerSignInFlow('p1.a.b.c', now, {})).toBeNull();
  });

  test('the cookie is host-locked, HttpOnly and short-lived', () => {
    const header = partnerFlowCookieHeader(flow, environment);
    expect(header.startsWith(`${PARTNER_FLOW_COOKIE_NAME}=`)).toBe(true);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('Path=/');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Max-Age=300');
    expect(clearPartnerFlowCookieHeader()).toContain('Max-Age=0');
  });

  test('exactly one cookie of this name is read', () => {
    expect(
      readPartnerFlowCookie(`${PARTNER_FLOW_COOKIE_NAME}=value; other=x`),
    ).toBe('value');
    expect(
      readPartnerFlowCookie(
        `${PARTNER_FLOW_COOKIE_NAME}=a; ${PARTNER_FLOW_COOKIE_NAME}=b`,
      ),
    ).toBeNull();
    expect(readPartnerFlowCookie(null)).toBeNull();
    expect(readPartnerFlowCookie('other=x')).toBeNull();
  });
});
