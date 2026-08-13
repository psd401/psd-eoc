import { describe, expect, test } from 'bun:test';

import { AdminForm, AdminFormError } from '../facilities/admin-request';
import {
  EMERGENCY_CONTROL_RESOLVED_STATUS,
  emergencyControlStatusMessage,
  parseEmergencyControlMutation,
} from './request';

const CURRENT = '00000000-0000-4000-8000-000000003450';

function form(values: Record<string, string>): AdminForm {
  return new AdminForm(
    new URLSearchParams({
      csrfToken: 'synthetic-csrf',
      idempotencyKey: 'synthetic-idempotency',
      intent: 'set-fanout-control',
      expectedCurrentRecordId: CURRENT,
      ...values,
    }),
  );
}

describe('emergency-control native form parser', () => {
  test('accepts only neutral replay-safe completion feedback', () => {
    const message = emergencyControlStatusMessage(
      EMERGENCY_CONTROL_RESOLVED_STATUS,
    );
    expect(message).toContain('authoritative current state');
    expect(message).toContain('exact retry may have replayed');
    expect(message).not.toContain('re-enabled');
    expect(message).not.toContain('was appended');
    expect(emergencyControlStatusMessage('fanout-enabled')).toBeNull();
    expect(
      emergencyControlStatusMessage('fanout-emergency-disabled'),
    ).toBeNull();
    expect(
      emergencyControlStatusMessage([EMERGENCY_CONTROL_RESOLVED_STATUS]),
    ).toBeNull();
    expect(emergencyControlStatusMessage(undefined)).toBeNull();
  });

  test('parses disable without accepting approval provenance', () => {
    expect(
      parseEmergencyControlMutation(
        form({
          desiredMode: 'emergency-disabled',
          reason: 'Provider behavior is uncertain; fail closed now.',
        }),
      ),
    ).toEqual({
      expectedCurrentRecordId: CURRENT,
      desiredMode: 'emergency-disabled',
      reason: 'Provider behavior is uncertain; fail closed now.',
    });
    expect(() =>
      parseEmergencyControlMutation(
        form({
          desiredMode: 'emergency-disabled',
          reason: 'Disable now.',
          productOwnerApprovalReference: 'not-applicable',
        }),
      ),
    ).toThrow(AdminFormError);
  });

  test('requires a fresh non-secret approval reference for every enable', () => {
    expect(
      parseEmergencyControlMutation(
        form({
          desiredMode: 'enabled',
          reason: 'Synthetic recovery checks completed.',
          productOwnerApprovalReference: 'synthetic-po-approval-reference',
        }),
      ),
    ).toEqual({
      expectedCurrentRecordId: CURRENT,
      desiredMode: 'enabled',
      reason: 'Synthetic recovery checks completed.',
      productOwnerApprovalReference: 'synthetic-po-approval-reference',
    });
    expect(() =>
      parseEmergencyControlMutation(
        form({ desiredMode: 'enabled', reason: 'Unsafe incomplete request.' }),
      ),
    ).toThrow(AdminFormError);
  });

  test('rejects unknown, repeated, or side-door form fields', () => {
    expect(() =>
      parseEmergencyControlMutation(
        form({ desiredMode: 'unknown', reason: 'Invalid.' }),
      ),
    ).toThrow(AdminFormError);
    expect(() =>
      parseEmergencyControlMutation(
        form({
          desiredMode: 'emergency-disabled',
          reason: 'Invalid extra field.',
          agentAuthorization: 'forbidden',
        }),
      ),
    ).toThrow(AdminFormError);
  });
});
