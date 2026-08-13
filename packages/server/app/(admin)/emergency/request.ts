import { SetFanoutControlInputSchema } from '@psd-eoc/contracts';

import { AdminFormError, type AdminForm } from '../facilities/admin-request';

export const EMERGENCY_CONTROL_RESOLVED_STATUS = 'fanout-control-resolved';

/**
 * Returns replay-safe feedback. The authoritative state is read separately;
 * this message never claims that the submitted transition was newly appended
 * or remains current because an exact idempotent retry can replay old output.
 */
export function emergencyControlStatusMessage(
  value: string | string[] | undefined,
): string | null {
  if (value !== EMERGENCY_CONTROL_RESOLVED_STATUS) return null;
  return 'Emergency-control request resolved. Review the authoritative current state and any immutable current record below; an exact retry may have replayed an earlier result.';
}

/** Parses one strict native form into the canonical compare-and-append input. */
export function parseEmergencyControlMutation(form: AdminForm) {
  form.assertFields([
    'csrfToken',
    'idempotencyKey',
    'intent',
    'expectedCurrentRecordId',
    'desiredMode',
    'reason',
    'productOwnerApprovalReference',
  ]);
  if (form.required('intent') !== 'set-fanout-control') {
    throw new AdminFormError('The emergency control action is invalid.');
  }
  const desiredMode = form.required('desiredMode');
  const common = {
    expectedCurrentRecordId: form.optional('expectedCurrentRecordId'),
    reason: form.required('reason'),
  };
  if (desiredMode === 'emergency-disabled') {
    if (form.optional('productOwnerApprovalReference') !== null) {
      throw new AdminFormError(
        'Emergency disablement does not accept an approval reference.',
      );
    }
    return SetFanoutControlInputSchema.parse({
      ...common,
      desiredMode,
    });
  }
  if (desiredMode === 'enabled') {
    return SetFanoutControlInputSchema.parse({
      ...common,
      desiredMode,
      productOwnerApprovalReference: form.required(
        'productOwnerApprovalReference',
      ),
    });
  }
  throw new AdminFormError('The requested fan-out state is invalid.');
}
