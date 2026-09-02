import { describe, expect, test } from 'bun:test';

import {
  AccessMembershipEvaluationError,
  type GoogleGroupResolver,
} from '../../../lib/auth/google-access-membership';
import { GoogleRosterConfigurationError } from '../../../lib/auth/google-roster-config';
import { AdminFormError } from './admin-request';
import { resolveGoogleGroupIdForForm } from './google-group-id';

const PROVIDER_DETAIL = 'provider detail that must not reach the form';

function refusing(code: string): () => GoogleGroupResolver {
  return () => ({
    resolve: async () => {
      throw new AccessMembershipEvaluationError(code, PROVIDER_DETAIL);
    },
  });
}

describe('Google Group ID resolution for the administration forms', () => {
  test('records the ID Google resolved for the typed address', async () => {
    const asked: string[] = [];
    const id = await resolveGoogleGroupIdForForm(
      'PSD-EOC@example.invalid',
      () => ({
        resolve: async (email) => {
          asked.push(email);
          return { name: 'groups/01synthetic', googleGroupId: '01synthetic' };
        },
      }),
    );
    expect(id).toBe('01synthetic');
    expect(asked).toEqual(['PSD-EOC@example.invalid']);
  });

  test('explains a group Google will not resolve as a form error', async () => {
    const cases = [
      [
        'DESIGNATED_GROUP_IDENTITY_INVALID',
        /did not resolve x@example\.invalid/u,
      ],
      ['GOOGLE_REQUEST_REJECTED', /refused the lookup of x@example\.invalid/u],
      ['GOOGLE_CONFIGURATION_INVALID', /credential on this server is invalid/u],
      [
        'GOOGLE_UNAVAILABLE',
        /unavailable while looking up x@example\.invalid/u,
      ],
    ] as const;
    for (const [code, message] of cases) {
      const attempt = resolveGoogleGroupIdForForm(
        'x@example.invalid',
        refusing(code),
      );
      await expect(attempt).rejects.toBeInstanceOf(AdminFormError);
      await expect(attempt).rejects.toThrow(message);
      // The provider's own words stay out of the page.
      await expect(attempt).rejects.not.toThrow(PROVIDER_DETAIL);
    }
  });

  test('says when the server holds no Google Groups credential', async () => {
    await expect(
      resolveGoogleGroupIdForForm('x@example.invalid', () => {
        throw new GoogleRosterConfigurationError(
          'GOOGLE_ROSTER_CONFIGURATION_MISSING',
          'GOOGLE_ROSTER_CONFIG is missing.',
        );
      }),
    ).rejects.toThrow(/no Google Groups credential configured/u);
  });

  test('lets an unexpected failure through unchanged', async () => {
    await expect(
      resolveGoogleGroupIdForForm('x@example.invalid', () => ({
        resolve: async () => {
          throw new TypeError('unexpected');
        },
      })),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
