import { describe, expect, test } from 'bun:test';

import { AdminCapabilityError } from '../../../lib/capabilities/admin';
import {
  accessAdminStatusMessage,
  isInvalidAccessAdminQueryError,
  normalizeAccessAdminCursorState,
} from './access-page-state';
import { CapabilityEngineError } from '../../../lib/capabilities/engine';

describe('access administration page query state', () => {
  test('normalizes one independent cursor per collection', () => {
    const cursors = normalizeAccessAdminCursorState({
      accessGroupCursor: 'access-current',
      userCursor: 'user-current',
    });

    expect(cursors).toEqual({
      accessGroupCursor: 'access-current',
      userCursor: 'user-current',
    });
    expect(Object.isFrozen(cursors)).toBe(true);
    expect(normalizeAccessAdminCursorState({})).toEqual({
      accessGroupCursor: null,
      userCursor: null,
    });
  });

  test('rejects repeated cursor parameters with a typed 400', () => {
    for (const parameters of [
      { accessGroupCursor: ['first', 'second'] },
      { userCursor: ['first', 'second'] },
    ]) {
      try {
        normalizeAccessAdminCursorState(parameters);
      } catch (error) {
        expect(error).toBeInstanceOf(AdminCapabilityError);
        expect((error as AdminCapabilityError).status).toBe(400);
        expect(isInvalidAccessAdminQueryError(error)).toBe(true);
        continue;
      }
      throw new Error('Expected a repeated cursor to be rejected.');
    }
  });

  test('classifies malformed capability cursors for clean-state recovery', () => {
    expect(
      isInvalidAccessAdminQueryError(
        new CapabilityEngineError(
          'VALIDATION_ERROR',
          'CAPABILITY_INPUT_INVALID',
          'The capability input is invalid.',
          400,
        ),
      ),
    ).toBe(true);
    expect(
      isInvalidAccessAdminQueryError(
        new AdminCapabilityError(
          'FORBIDDEN',
          'District administrator access is required.',
          403,
        ),
      ),
    ).toBe(false);
    expect(isInvalidAccessAdminQueryError(new Error('unexpected'))).toBe(false);
  });

  test('maps only own allowlisted status keys', () => {
    expect(accessAdminStatusMessage('roles-updated')).toBe(
      'The staff role assignment was updated.',
    );
    expect(accessAdminStatusMessage('__proto__')).toBeNull();
    expect(accessAdminStatusMessage('constructor')).toBeNull();
    expect(accessAdminStatusMessage(['roles-updated'])).toBeNull();
  });
});
