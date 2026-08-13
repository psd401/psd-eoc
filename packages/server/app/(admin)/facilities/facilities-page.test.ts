import { describe, expect, test } from 'bun:test';

import { CapabilityEngineError } from '../../../lib/capabilities/engine';
import { AdminCapabilityError } from './admin-core';
import {
  facilitiesAdminQueryRecoveryPath,
  facilitiesAdminStatusMessage,
  isInvalidFacilitiesAdminQueryError,
  normalizeFacilitiesAdminCursorState,
} from './facilities-page-state';
import { redirectInvalidFacilitiesAdminQuery } from './facilities-page-state';

describe('facilities administration page query state', () => {
  test('normalizes one independent cursor per collection', () => {
    const cursors = normalizeFacilitiesAdminCursorState({
      buildingGroupCursor: 'building-current',
      facilityCursor: 'facility-current',
      neighborhoodCursor: 'neighborhood-current',
      othersGroupCursor: 'others-current',
    });

    expect(cursors).toEqual({
      buildingGroupCursor: 'building-current',
      facilityCursor: 'facility-current',
      neighborhoodCursor: 'neighborhood-current',
      othersGroupCursor: 'others-current',
    });
    expect(Object.isFrozen(cursors)).toBe(true);
    expect(normalizeFacilitiesAdminCursorState({})).toEqual({
      buildingGroupCursor: null,
      facilityCursor: null,
      neighborhoodCursor: null,
      othersGroupCursor: null,
    });
  });

  test('rejects every repeated cursor parameter with a typed 400', () => {
    for (const parameters of [
      { buildingGroupCursor: ['first', 'second'] },
      { facilityCursor: ['first', 'second'] },
      { neighborhoodCursor: ['first', 'second'] },
      { othersGroupCursor: ['first', 'second'] },
    ]) {
      expect(() => normalizeFacilitiesAdminCursorState(parameters)).toThrow(
        AdminCapabilityError,
      );
      try {
        normalizeFacilitiesAdminCursorState(parameters);
      } catch (error) {
        expect(error).toMatchObject({
          code: 'VALIDATION_ERROR',
          reasonCode: 'CAPABILITY_INPUT_INVALID',
          status: 400,
        });
        expect(isInvalidFacilitiesAdminQueryError(error)).toBe(true);
      }
    }
  });

  test('classifies both engine and admin validation errors for clean recovery', () => {
    const engineError = new CapabilityEngineError(
      'VALIDATION_ERROR',
      'CAPABILITY_INPUT_INVALID',
      'The capability input is invalid.',
      400,
    );
    const adminError = new AdminCapabilityError(
      'VALIDATION_ERROR',
      'The pagination cursor is invalid.',
      400,
    );

    expect(isInvalidFacilitiesAdminQueryError(engineError)).toBe(true);
    expect(isInvalidFacilitiesAdminQueryError(adminError)).toBe(true);
    expect(facilitiesAdminQueryRecoveryPath(engineError)).toBe('/facilities');
    expect(facilitiesAdminQueryRecoveryPath(adminError)).toBe('/facilities');
    expect(adminError.reasonCode).toBe('CAPABILITY_INPUT_INVALID');
    const forbidden = new AdminCapabilityError(
      'FORBIDDEN',
      'District administrator access is required.',
      403,
    );
    expect(isInvalidFacilitiesAdminQueryError(forbidden)).toBe(false);
    expect(facilitiesAdminQueryRecoveryPath(forbidden)).toBeNull();
    expect(isInvalidFacilitiesAdminQueryError(new Error('unexpected'))).toBe(
      false,
    );
    expect(
      facilitiesAdminQueryRecoveryPath(new Error('unexpected')),
    ).toBeNull();
  });

  test('redirects every typed validation 400 to the clean facilities URL', () => {
    for (const error of [
      new CapabilityEngineError(
        'VALIDATION_ERROR',
        'CAPABILITY_INPUT_INVALID',
        'The capability input is invalid.',
        400,
      ),
      new AdminCapabilityError(
        'VALIDATION_ERROR',
        'The pagination cursor is invalid.',
        400,
      ),
    ]) {
      try {
        redirectInvalidFacilitiesAdminQuery(error);
        throw new Error('The invalid facilities query did not redirect.');
      } catch (redirectError) {
        expect(redirectError).toMatchObject({
          digest: expect.stringContaining('/facilities'),
        });
      }
    }

    expect(() =>
      redirectInvalidFacilitiesAdminQuery(
        new AdminCapabilityError(
          'FORBIDDEN',
          'District administrator access is required.',
          403,
        ),
      ),
    ).not.toThrow();
  });

  test('accepts only own scalar status-message keys', () => {
    expect(facilitiesAdminStatusMessage('facility-created')).toBe(
      'The facility was added.',
    );
    expect(facilitiesAdminStatusMessage(undefined)).toBeNull();
    expect(facilitiesAdminStatusMessage('unknown-status')).toBeNull();
    expect(facilitiesAdminStatusMessage('constructor')).toBeNull();
    expect(facilitiesAdminStatusMessage('toString')).toBeNull();
    expect(facilitiesAdminStatusMessage('__proto__')).toBeNull();
    expect(facilitiesAdminStatusMessage(['facility-created'])).toBeNull();
  });
});
