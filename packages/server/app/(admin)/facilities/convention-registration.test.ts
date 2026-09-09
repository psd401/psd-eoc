import type { Facility } from '@psd-eoc/contracts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { AuthenticatedSession } from '../../../lib/auth/sessions';
import { AdminFormError } from './admin-request';
import {
  registerConventionBuildingGroups,
  type ConventionRegistrationSteps,
} from './convention-registration';

// Only the roles are read; both steps are injected.
const ADMIN = { roles: ['admin'] } as unknown as AuthenticatedSession;

function school(code: string, index: number): Facility {
  return Object.freeze({
    id: `00000000-0000-4000-8000-00000000070${index}`,
    code,
    name: `${code} School`,
    active: true,
    isolated: false,
    createdAt: '2026-09-01T00:00:00.000Z',
  });
}

type Created = Parameters<ConventionRegistrationSteps['create']>[0];

describe('registering building groups by naming convention', () => {
  let priorDomain: string | undefined;
  beforeAll(() => {
    priorDomain = process.env.GOOGLE_OIDC_HOSTED_DOMAIN;
    process.env.GOOGLE_OIDC_HOSTED_DOMAIN = 'example.invalid';
  });
  afterAll(() => {
    if (priorDomain === undefined) delete process.env.GOOGLE_OIDC_HOSTED_DOMAIN;
    else process.env.GOOGLE_OIDC_HOSTED_DOMAIN = priorDomain;
  });

  test('registers each school at its convention address, waiting when Google holds no group', async () => {
    const created: Created[] = [];
    await registerConventionBuildingGroups(
      {
        authenticated: ADMIN,
        facilities: [school('HHE', 1), school('PHS', 2)],
        idempotencyKey: 'form-key',
      },
      {
        resolve: async (_session, email) =>
          email === 'phs-eoc@example.invalid' ? 'phs_group' : null,
        create: async (input) => {
          created.push(input);
          return {};
        },
      },
    );
    expect(created.map(({ command }) => command)).toEqual([
      {
        kind: 'google-group',
        purpose: 'building',
        facilityId: '00000000-0000-4000-8000-000000000701',
        displayName: 'HHE School staff',
        active: true,
        googleGroupId: null,
        email: 'hhe-eoc@example.invalid',
      },
      {
        kind: 'google-group',
        purpose: 'building',
        facilityId: '00000000-0000-4000-8000-000000000702',
        displayName: 'PHS School staff',
        active: true,
        googleGroupId: 'phs_group',
        email: 'phs-eoc@example.invalid',
      },
    ]);
    // Each school has its own key under the form's, so a replayed form
    // registers nothing twice and two schools never share a key.
    const keys = created.map(({ metadata }) => metadata.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(
      keys.every((key) => key.endsWith(':convention-building-group')),
    ).toBe(true);
  });

  test('says how many schools were registered when a later lookup fails', async () => {
    // Each school is its own committed capability call: the first two are
    // registered when Google fails on the third, and the page must not read
    // as if nothing had happened.
    const created: string[] = [];
    const attempt = registerConventionBuildingGroups(
      {
        authenticated: ADMIN,
        facilities: [school('HHE', 1), school('PHS', 2), school('GHS', 3)],
        idempotencyKey: 'form-key',
      },
      {
        resolve: async (_session, email) => {
          if (email === 'ghs-eoc@example.invalid') {
            throw new AdminFormError(
              'Google was unavailable while looking up ghs-eoc@example.invalid. Nothing was saved; try again.',
            );
          }
          return null;
        },
        create: async (input) => {
          created.push(
            input.command.kind === 'google-group' ? input.command.email : '',
          );
          return {};
        },
      },
    );
    await expect(attempt).rejects.toBeInstanceOf(AdminFormError);
    await expect(attempt).rejects.toThrow(
      '2 schools were registered before this stopped at GHS: Google was unavailable while looking up ghs-eoc@example.invalid. Nothing was saved; try again. Press "Register building groups by naming convention" again to continue with the schools still without a source.',
    );
    expect(created).toEqual([
      'hhe-eoc@example.invalid',
      'phs-eoc@example.invalid',
    ]);
  });

  test('passes a failure on the first school, and any unexpected failure, through unchanged', async () => {
    const formError = new AdminFormError('Google refused the lookup.');
    const failing = (error: Error): ConventionRegistrationSteps => ({
      resolve: async () => {
        throw error;
      },
      create: async () => ({}),
    });
    await expect(
      registerConventionBuildingGroups(
        {
          authenticated: ADMIN,
          facilities: [school('HHE', 1)],
          idempotencyKey: 'k',
        },
        failing(formError),
      ),
    ).rejects.toBe(formError);
    const unexpected = new TypeError('unexpected');
    let registered = 0;
    await expect(
      registerConventionBuildingGroups(
        {
          authenticated: ADMIN,
          facilities: [school('HHE', 1), school('PHS', 2)],
          idempotencyKey: 'k',
        },
        {
          resolve: async () => {
            if (registered > 0) throw unexpected;
            return null;
          },
          create: async () => {
            registered += 1;
            return {};
          },
        },
      ),
    ).rejects.toBe(unexpected);
  });
});
