import { describe, expect, test } from 'bun:test';

import {
  AccessMembershipEvaluationError,
  type GoogleGroupResolver,
} from '../../../lib/auth/google-access-membership';
import { GoogleRosterConfigurationError } from '../../../lib/auth/google-roster-config';
import {
  SessionAccessError,
  type AuthenticatedSession,
} from '../../../lib/auth/sessions';
import { AdminFormError } from './admin-request';
import {
  googleGroupIdForAccessGroupUpdate,
  normalizeGroupAddress,
  resolveGoogleGroupIdForForm,
} from './google-group-id';

const PROVIDER_DETAIL = 'provider detail that must not reach the form';
const ADMIN = Object.freeze({ roles: ['admin'] as const });
const STAFF = Object.freeze({ roles: ['staff'] as const });
// Only the roles are read; the lookup and resolver are injected.
const ADMIN_SESSION = ADMIN as unknown as AuthenticatedSession;
const STAFF_SESSION = STAFF as unknown as AuthenticatedSession;

function refusing(code: string): () => GoogleGroupResolver {
  return () => ({
    resolve: async () => {
      throw new AccessMembershipEvaluationError(code, PROVIDER_DETAIL);
    },
  });
}

function resolving(id: string) {
  const asked: string[] = [];
  const factory = (): GoogleGroupResolver => ({
    resolve: async (email) => {
      asked.push(email);
      return { name: `groups/${id}`, googleGroupId: id };
    },
  });
  return { asked, factory };
}

function neverResolving(): () => GoogleGroupResolver {
  return () => {
    throw new Error('Google must not be contacted.');
  };
}

describe('Google Group ID resolution for the administration forms', () => {
  test('records the ID Google resolved for the normalized address', async () => {
    const google = resolving('01synthetic');
    const id = await resolveGoogleGroupIdForForm(
      ADMIN,
      ' PSD-EOC@Example.invalid ',
      google.factory,
    );
    expect(id).toBe('01synthetic');
    expect(google.asked).toEqual(['psd-eoc@example.invalid']);
  });

  test('refuses a session without the administrator role before any lookup', async () => {
    // A lookup answers whether a group exists in the Workspace. The
    // capability engine would refuse the write later; the question is
    // refused first, so a staff session cannot use the form as an oracle.
    await expect(
      resolveGoogleGroupIdForForm(STAFF, 'x@example.invalid', neverResolving()),
    ).rejects.toBeInstanceOf(SessionAccessError);
    await expect(
      googleGroupIdForAccessGroupUpdate(
        STAFF_SESSION,
        { id: 'source', email: 'x@example.invalid' },
        {
          lookup: async () => {
            throw new Error('The store must not be read.');
          },
          resolver: neverResolving(),
        },
      ),
    ).rejects.toBeInstanceOf(SessionAccessError);
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
        ADMIN,
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
      resolveGoogleGroupIdForForm(ADMIN, 'x@example.invalid', () => {
        throw new GoogleRosterConfigurationError(
          'GOOGLE_ROSTER_CONFIGURATION_MISSING',
          'GOOGLE_ROSTER_CONFIG is missing.',
        );
      }),
    ).rejects.toThrow(/no Google Groups credential configured/u);
  });

  test('lets an unexpected failure through unchanged', async () => {
    await expect(
      resolveGoogleGroupIdForForm(ADMIN, 'x@example.invalid', () => ({
        resolve: async () => {
          throw new TypeError('unexpected');
        },
      })),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test('normalizes an address the way the record compares it', () => {
    expect(normalizeGroupAddress('  PSD-EOC@Example.INVALID ')).toBe(
      'psd-eoc@example.invalid',
    );
  });
});

describe('the ID an access-group edit carries', () => {
  const stored = Object.freeze({
    id: 'source-1',
    email: 'psd-eoc@example.invalid',
    googleGroupId: '01stored',
  });

  test('keeps the stored ID when the address is unchanged, without asking Google', async () => {
    // Deactivating a group or renaming it must not depend on Google being
    // reachable; the address decides whether Google is consulted at all.
    const looked: string[] = [];
    const id = await googleGroupIdForAccessGroupUpdate(
      ADMIN_SESSION,
      { id: 'source-1', email: ' PSD-EOC@example.invalid ' },
      {
        lookup: async (_session, sourceId) => {
          looked.push(sourceId);
          return stored;
        },
        resolver: neverResolving(),
      },
    );
    expect(id).toBe('01stored');
    expect(looked).toEqual(['source-1']);
  });

  test('resolves a changed address through Google', async () => {
    const google = resolving('01replacement');
    const id = await googleGroupIdForAccessGroupUpdate(
      ADMIN_SESSION,
      { id: 'source-1', email: 'district-staff@example.invalid' },
      { lookup: async () => stored, resolver: google.factory },
    );
    expect(id).toBe('01replacement');
    expect(google.asked).toEqual(['district-staff@example.invalid']);
  });

  test('resolves through Google when the group is not on record', async () => {
    // The capability reports the missing source; this helper only has to
    // avoid inventing an ID for it.
    const google = resolving('01resolved');
    const id = await googleGroupIdForAccessGroupUpdate(
      ADMIN_SESSION,
      { id: 'missing', email: 'psd-eoc@example.invalid' },
      { lookup: async () => null, resolver: google.factory },
    );
    expect(id).toBe('01resolved');
  });
});
