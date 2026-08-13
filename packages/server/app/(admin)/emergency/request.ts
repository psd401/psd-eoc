import { SetFanoutControlInputSchema } from '@psd-eoc/contracts';

import { AdminFormError, type AdminForm } from '../facilities/admin-request';

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
