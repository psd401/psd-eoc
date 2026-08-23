import {
  CreateFacilityInputSchema,
  CreateGroupSourceInputSchema,
  CreateNeighborhoodVersionInputSchema,
  UpdateFacilityInputSchema,
  UpdateGroupSourceInputSchema,
  type CreateFacilityInput,
  type CreateGroupSourceInput,
  type CreateNeighborhoodVersionInput,
  type UpdateFacilityInput,
  type UpdateGroupSourceInput,
} from '@psd-eoc/contracts';

import { AdminFormError, type AdminForm } from '../admin-request';

const COMMON_FIELDS = ['csrfToken', 'idempotencyKey', 'intent'] as const;

export type FacilitiesAdminMutation =
  | Readonly<{
      intent: 'create-facility';
      command: CreateFacilityInput;
      status: 'facility-created';
    }>
  | Readonly<{
      intent: 'update-facility';
      command: UpdateFacilityInput;
      status: 'facility-updated';
    }>
  | Readonly<{
      intent:
        | 'create-google-building-group'
        | 'create-google-others-group'
        | 'create-synthetic-building-group'
        | 'create-synthetic-others-group';
      command: CreateGroupSourceInput;
      status: 'building-group-created' | 'others-group-created';
    }>
  | Readonly<{
      intent:
        | 'replace-google-building-group'
        | 'replace-google-others-group'
        | 'replace-synthetic-building-group'
        | 'replace-synthetic-others-group';
      command: UpdateGroupSourceInput;
      status: 'building-group-replaced' | 'others-group-replaced';
    }>
  | Readonly<{
      intent: 'create-neighborhood-version';
      command: CreateNeighborhoodVersionInput;
      status: 'neighborhood-version-created';
    }>;

function parseActive(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new AdminFormError('The facility status is invalid.');
}

function parseGoogleGroup(
  form: AdminForm,
  intent: 'create-google-building-group' | 'create-google-others-group',
): FacilitiesAdminMutation {
  const building = intent === 'create-google-building-group';
  form.assertFields([
    ...COMMON_FIELDS,
    ...(building ? (['facilityId'] as const) : []),
    'displayName',
    'googleGroupId',
    'email',
  ]);
  const command = CreateGroupSourceInputSchema.parse({
    kind: 'google-group',
    purpose: building ? 'building' : 'others',
    facilityId: building ? form.required('facilityId') : null,
    displayName: form.required('displayName'),
    active: true,
    googleGroupId: form.required('googleGroupId'),
    email: form.required('email'),
  });
  return {
    intent,
    command,
    status: building ? 'building-group-created' : 'others-group-created',
  };
}

function parseSyntheticGroup(
  form: AdminForm,
  intent: 'create-synthetic-building-group' | 'create-synthetic-others-group',
): FacilitiesAdminMutation {
  const building = intent === 'create-synthetic-building-group';
  form.assertFields([
    ...COMMON_FIELDS,
    ...(building ? (['facilityId'] as const) : []),
    'displayName',
    'fixtureKey',
  ]);
  const command = CreateGroupSourceInputSchema.parse({
    kind: 'synthetic',
    purpose: building ? 'building' : 'others',
    facilityId: building ? form.required('facilityId') : null,
    displayName: form.required('displayName'),
    active: true,
    fixtureKey: form.required('fixtureKey'),
  });
  return {
    intent,
    command,
    status: building ? 'building-group-created' : 'others-group-created',
  };
}

function parseGoogleGroupReplacement(
  form: AdminForm,
  intent: 'replace-google-building-group' | 'replace-google-others-group',
): FacilitiesAdminMutation {
  const building = intent === 'replace-google-building-group';
  form.assertFields([
    ...COMMON_FIELDS,
    'sourceId',
    ...(building ? (['facilityId'] as const) : []),
    'displayName',
    'googleGroupId',
    'email',
  ]);
  return {
    intent,
    command: UpdateGroupSourceInputSchema.parse({
      id: form.required('sourceId'),
      kind: 'google-group',
      purpose: building ? 'building' : 'others',
      facilityId: building ? form.required('facilityId') : null,
      displayName: form.required('displayName'),
      active: true,
      googleGroupId: form.required('googleGroupId'),
      email: form.required('email'),
    }),
    status: building ? 'building-group-replaced' : 'others-group-replaced',
  };
}

function parseSyntheticGroupReplacement(
  form: AdminForm,
  intent: 'replace-synthetic-building-group' | 'replace-synthetic-others-group',
): FacilitiesAdminMutation {
  const building = intent === 'replace-synthetic-building-group';
  form.assertFields([
    ...COMMON_FIELDS,
    'sourceId',
    ...(building ? (['facilityId'] as const) : []),
    'displayName',
    'fixtureKey',
  ]);
  return {
    intent,
    command: UpdateGroupSourceInputSchema.parse({
      id: form.required('sourceId'),
      kind: 'synthetic',
      purpose: building ? 'building' : 'others',
      facilityId: building ? form.required('facilityId') : null,
      displayName: form.required('displayName'),
      active: true,
      fixtureKey: form.required('fixtureKey'),
    }),
    status: building ? 'building-group-replaced' : 'others-group-replaced',
  };
}

/** Strictly parses one whitelisted native-form mutation into contract input. */
export function parseFacilitiesAdminMutation(
  form: AdminForm,
): FacilitiesAdminMutation {
  const intent = form.required('intent');
  switch (intent) {
    case 'create-facility':
      form.assertFields([...COMMON_FIELDS, 'code', 'name']);
      return {
        intent,
        command: CreateFacilityInputSchema.parse({
          code: form.required('code'),
          name: form.required('name'),
        }),
        status: 'facility-created',
      };
    case 'update-facility':
      form.assertFields([
        ...COMMON_FIELDS,
        'facilityId',
        'code',
        'name',
        'active',
      ]);
      return {
        intent,
        command: UpdateFacilityInputSchema.parse({
          facilityId: form.required('facilityId'),
          code: form.required('code'),
          name: form.required('name'),
          active: parseActive(form.required('active')),
        }),
        status: 'facility-updated',
      };
    case 'create-google-building-group':
    case 'create-google-others-group':
      return parseGoogleGroup(form, intent);
    case 'create-synthetic-building-group':
    case 'create-synthetic-others-group':
      return parseSyntheticGroup(form, intent);
    case 'replace-google-building-group':
    case 'replace-google-others-group':
      return parseGoogleGroupReplacement(form, intent);
    case 'replace-synthetic-building-group':
    case 'replace-synthetic-others-group':
      return parseSyntheticGroupReplacement(form, intent);
    case 'create-neighborhood-version':
      form.assertFields(
        [...COMMON_FIELDS, 'neighborhoodId', 'name', 'facilityIds'],
        ['facilityIds'],
      );
      return {
        intent,
        command: CreateNeighborhoodVersionInputSchema.parse({
          neighborhoodId: form.optional('neighborhoodId'),
          name: form.required('name'),
          facilityIds: form.all('facilityIds'),
        }),
        status: 'neighborhood-version-created',
      };
    default:
      throw new AdminFormError(
        'The facilities administration action is invalid.',
      );
  }
}
