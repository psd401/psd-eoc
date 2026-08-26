import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { authorizeSyntheticSessionRequest } from './drill-session-boundary';

const ENVIRONMENT = {
  GOOGLE_OIDC_APPLICATION_ORIGIN:
    'https://synthetic.us-west-2.awsapprunner.com',
  GOOGLE_OIDC_HOSTED_DOMAIN: 'example.invalid',
  PSD_EOC_FAILURE_DRILL_DEPLOYMENT_CLASS: 'non-production',
  PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN: 'synthetic-operator-token',
  PSD_EOC_FAILURE_DRILL_PROVIDER_MODE: 'mocked',
  PSD_EOC_FAILURE_DRILL_ROSTER_POPULATION: 'synthetic',
  PSD_EOC_FAILURE_DRILL_RUN_ID: 'issue-31-synthetic',
} as const;
const previous = new Map<string, string | undefined>();

beforeEach(() => {
  for (const [name, value] of Object.entries(ENVIRONMENT)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
});

afterEach(() => {
  for (const name of Object.keys(ENVIRONMENT)) {
    const value = previous.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  previous.clear();
});

function request(
  origin: string = ENVIRONMENT.GOOGLE_OIDC_APPLICATION_ORIGIN,
): Request {
  return new Request('http://169.254.172.2:3000/api/failure-drills/session', {
    headers: {
      Authorization: `Bearer ${ENVIRONMENT.PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN}`,
      Origin: origin,
    },
    method: 'POST',
  });
}

describe('deployed synthetic session boundary', () => {
  test('accepts the exact configured App Runner origin behind an internal proxy URL', () => {
    expect(authorizeSyntheticSessionRequest(request())).toBe(
      ENVIRONMENT.GOOGLE_OIDC_APPLICATION_ORIGIN,
    );
  });

  test('fails closed when the explicit origin is missing or changed', () => {
    const missing = new Request(
      'http://169.254.172.2:3000/api/failure-drills/session',
      {
        headers: {
          Authorization: `Bearer ${ENVIRONMENT.PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN}`,
        },
        method: 'POST',
      },
    );
    expect(() => authorizeSyntheticSessionRequest(missing)).toThrow(
      'boundary is unavailable',
    );
    expect(() =>
      authorizeSyntheticSessionRequest(request('https://example.invalid')),
    ).toThrow('boundary is unavailable');
  });

  test('fails closed when the operator credential changes', () => {
    const changed = new Request(
      'http://169.254.172.2:3000/api/failure-drills/session',
      {
        headers: {
          Authorization: 'Bearer changed-token',
          Origin: ENVIRONMENT.GOOGLE_OIDC_APPLICATION_ORIGIN,
        },
        method: 'POST',
      },
    );
    expect(() => authorizeSyntheticSessionRequest(changed)).toThrow(
      'credential was refused',
    );
  });
});
