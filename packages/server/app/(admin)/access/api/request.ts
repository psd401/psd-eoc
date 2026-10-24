import {
  DisablePartnerInputSchema,
  InvitePartnerInputSchema,
  ReconcilePartnerAccessInputSchema,
  AdmitAccountInputSchema,
  RevokeAdmittedAccountInputSchema,
  SetUserFacilityScopeInputSchema,
  type CapabilityInput,
} from '@psd-eoc/contracts';

import { AdminFormError, type AdminForm } from '../../facilities/admin-request';

const COMMON_FIELDS = ['csrfToken', 'idempotencyKey', 'intent'] as const;

/**
 * Reads the "Limit to facilities" form into the capability's command.
 *
 * Checkboxes arrive only when checked, and one per facility, so the facility
 * list is every value under that name, which may be none. Choosing "only
 * these facilities" and ticking nothing is a form mistake said in words,
 * not a contract error.
 */
export function parseSetUserFacilityScopeForm(
  form: AdminForm,
): CapabilityInput<'set-user-facility-scope'> {
  form.assertFields(
    [...COMMON_FIELDS, 'userId', 'scopeKind', 'facilityIds'],
    ['facilityIds'],
  );
  const scopeKind = form.required('scopeKind');
  if (scopeKind !== 'district' && scopeKind !== 'facilities') {
    throw new AdminFormError('The facility scope choice is invalid.');
  }
  const facilityIds = form.all('facilityIds');
  if (scopeKind === 'facilities' && facilityIds.length === 0) {
    throw new AdminFormError('Choose at least one facility, or district-wide.');
  }
  return SetUserFacilityScopeInputSchema.parse({
    userId: form.required('userId'),
    facilityScope:
      scopeKind === 'district'
        ? { kind: 'district' }
        : { kind: 'facilities', facilityIds },
  });
}

/** Reads the "Admit an account" form: an address and an optional note. */
export function parseAdmitAccountForm(
  form: AdminForm,
): CapabilityInput<'admit-account'> {
  form.assertFields([...COMMON_FIELDS, 'email', 'note']);
  const note = form.optional('note');
  return AdmitAccountInputSchema.parse({
    email: form.required('email'),
    ...(note === null || note.trim() === '' ? {} : { note }),
  });
}

/** Reads a row's "Revoke" form: the admission to end. */
export function parseRevokeAdmittedAccountForm(
  form: AdminForm,
): CapabilityInput<'revoke-admitted-account'> {
  form.assertFields([...COMMON_FIELDS, 'admittedAccountId']);
  return RevokeAdmittedAccountInputSchema.parse({
    admittedAccountId: form.required('admittedAccountId'),
  });
}

/**
 * Reads an invite, re-invite, or address-correction form. A blank
 * `replacesAdmissionId` is a new invitation; a filled one names the current
 * admission the corrected address replaces.
 */
export function parseInvitePartnerForm(
  form: AdminForm,
): CapabilityInput<'invite-partner'> {
  form.assertFields([
    ...COMMON_FIELDS,
    'email',
    'displayName',
    'agency',
    'replacesAdmissionId',
    'renewal',
  ]);
  const replaces = form.optional('replacesAdmissionId');
  return InvitePartnerInputSchema.parse({
    email: form.required('email'),
    displayName: form.required('displayName'),
    agency: form.required('agency'),
    replacesAdmissionId:
      replaces === null || replaces.trim() === '' ? null : replaces,
  });
}

/** Reads a partner row's disable, resend, or retry form. */
export function parsePartnerAdmissionForm(
  form: AdminForm,
): Readonly<{ partnerAdmissionId: string }> {
  form.assertFields([...COMMON_FIELDS, 'partnerAdmissionId']);
  return DisablePartnerInputSchema.parse({
    partnerAdmissionId: form.required('partnerAdmissionId'),
  });
}

export function reconcileCommand(
  partnerAdmissionId: string,
  resendInvitation: boolean,
): CapabilityInput<'reconcile-partner-access'> {
  return ReconcilePartnerAccessInputSchema.parse({
    partnerAdmissionId,
    resendInvitation,
  });
}
