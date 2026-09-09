import { describe, expect, test } from 'bun:test';

import { AdminForm, AdminFormError } from '../../facilities/admin-request';
import { parseSetUserFacilityScopeForm } from './request';

const IDS = Object.freeze({
  user: '20000000-0000-4000-8000-000000000001',
  facilityA: '20000000-0000-4000-8000-000000000002',
  facilityB: '20000000-0000-4000-8000-000000000003',
});

function form(fields: readonly (readonly [string, string])[]): AdminForm {
  const parameters = new URLSearchParams();
  parameters.set('csrfToken', 'csrf-token-for-request-test');
  parameters.set('idempotencyKey', 'user-scope-request-test-0001');
  parameters.set('intent', 'set-user-facility-scope');
  fields.forEach(([name, value]) => parameters.append(name, value));
  return new AdminForm(parameters);
}

function expectFormError(operation: () => unknown, message: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AdminFormError);
    expect((error as AdminFormError).message).toBe(message);
    return;
  }
  throw new Error(`Expected the form to be refused: ${message}`);
}

describe('set-user-facility-scope form parsing', () => {
  test('reads every ticked facility, as a browser submits them', () => {
    // One checkbox per facility, each named facilityIds: the browser sends
    // the name once per ticked box, so the field repeats.
    expect(
      parseSetUserFacilityScopeForm(
        form([
          ['userId', IDS.user],
          ['scopeKind', 'facilities'],
          ['facilityIds', IDS.facilityA],
          ['facilityIds', IDS.facilityB],
        ]),
      ),
    ).toEqual({
      userId: IDS.user,
      facilityScope: {
        kind: 'facilities',
        facilityIds: [IDS.facilityA, IDS.facilityB],
      },
    });
  });

  test('district-wide ignores any box left ticked', () => {
    expect(
      parseSetUserFacilityScopeForm(
        form([
          ['userId', IDS.user],
          ['scopeKind', 'district'],
          ['facilityIds', IDS.facilityA],
        ]),
      ),
    ).toEqual({ userId: IDS.user, facilityScope: { kind: 'district' } });
  });

  test('says in words when no facility was chosen', () => {
    expectFormError(
      () =>
        parseSetUserFacilityScopeForm(
          form([
            ['userId', IDS.user],
            ['scopeKind', 'facilities'],
          ]),
        ),
      'Choose at least one facility, or district-wide.',
    );
  });

  test('refuses a scope choice that is neither district nor facilities', () => {
    expectFormError(
      () =>
        parseSetUserFacilityScopeForm(
          form([
            ['userId', IDS.user],
            ['scopeKind', 'everywhere'],
            ['facilityIds', IDS.facilityA],
          ]),
        ),
      'The facility scope choice is invalid.',
    );
  });

  test('refuses an unexpected or repeated field', () => {
    expectFormError(
      () =>
        parseSetUserFacilityScopeForm(
          form([
            ['userId', IDS.user],
            ['scopeKind', 'district'],
            ['roles', 'admin'],
          ]),
        ),
      'The administration form is invalid.',
    );
    expectFormError(
      () =>
        parseSetUserFacilityScopeForm(
          form([
            ['userId', IDS.user],
            ['userId', IDS.user],
            ['scopeKind', 'district'],
          ]),
        ),
      'The administration form is invalid.',
    );
  });
});
