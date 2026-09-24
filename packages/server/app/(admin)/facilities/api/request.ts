import {
  CreateFacilityInputSchema,
  CreateGroupSourceInputSchema,
  CreateNeighborhoodVersionInputSchema,
  canonicalManualRosterEmails,
  SetManualRosterMembersInputSchema,
  UpdateFacilityInputSchema,
  UpdateGroupSourceInputSchema,
  type CreateFacilityInput,
  type CreateGroupSourceInput,
  type CreateNeighborhoodVersionInput,
  type SetManualRosterMembersInput,
  type UpdateFacilityInput,
  type UpdateGroupSourceInput,
} from '@psd-eoc/contracts';

import { AdminFormError, type AdminForm } from '../admin-request';
import {
  normalizeGroupAddress,
  type GoogleGroupIdResolver,
  type WaitingGoogleGroupIdResolver,
} from '../google-group-id';

/**
 * How the form turns a Google Group address into the ID the server records.
 * A building source may be registered while Google does not hold its group
 * yet; an access or others source must resolve.
 */
export interface GoogleGroupIdResolvers {
  readonly resolve: GoogleGroupIdResolver;
  readonly resolveOrWaiting: WaitingGoogleGroupIdResolver;
}
/** A lone resolver answers both ways: it never lets a building source wait. */
export type GoogleGroupIdResolution =
  GoogleGroupIdResolver | GoogleGroupIdResolvers;
function googleGroupIdResolvers(
  resolution: GoogleGroupIdResolution,
): GoogleGroupIdResolvers {
  return typeof resolution === 'function'
    ? { resolve: resolution, resolveOrWaiting: resolution }
    : resolution;
}

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
        | 'create-manual-building-group'
        | 'create-manual-others-group'
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
    }>
  | Readonly<{
      intent: 'set-manual-roster-members';
      command: SetManualRosterMembersInput;
      status: 'manual-members-saved';
    }>
  | Readonly<{
      intent: 'publish-roster-snapshot';
      command: null;
      status: 'roster-snapshot-published';
    }>
  | Readonly<{
      intent: 'register-building-groups-by-convention';
      command: null;
      status: 'building-groups-registered';
    }>
  | Readonly<{
      intent: 'check-waiting-groups';
      command: null;
      status: 'waiting-groups-checked';
    }>;

function parseActive(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new AdminFormError('The facility status is invalid.');
}

/**
 * A Google source is registered by its address alone. The Google Group ID is
 * not the form's to supply: it is resolved from the address, and a group that
 * Google cannot resolve is refused before anything is saved.
 */
async function parseGoogleGroup(
  form: AdminForm,
  intent: 'create-google-building-group' | 'create-google-others-group',
  resolvers: GoogleGroupIdResolvers,
): Promise<FacilitiesAdminMutation> {
  const building = intent === 'create-google-building-group';
  form.assertFields([
    ...COMMON_FIELDS,
    ...(building ? (['facilityId'] as const) : []),
    'displayName',
    'email',
  ]);
  const email = normalizeGroupAddress(form.required('email'));
  // A building source may wait for Google to hold its group; it names nobody
  // until then and the scheduled sync records the ID once the group exists.
  const command = CreateGroupSourceInputSchema.parse({
    kind: 'google-group',
    purpose: building ? 'building' : 'others',
    facilityId: building ? form.required('facilityId') : null,
    displayName: form.required('displayName'),
    active: true,
    googleGroupId: building
      ? await resolvers.resolveOrWaiting(email)
      : await resolvers.resolve(email),
    email,
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

/**
 * A manual source has no provider identifier to supply. The display name and,
 * for a building source, the facility binding are the whole record; its
 * members are curated separately so a source can exist before anyone is added
 * to it. A manual others source binds to no facility: it names the people who
 * belong at every event.
 */
function parseManualGroup(
  form: AdminForm,
  intent: 'create-manual-building-group' | 'create-manual-others-group',
): FacilitiesAdminMutation {
  const building = intent === 'create-manual-building-group';
  form.assertFields([
    ...COMMON_FIELDS,
    ...(building ? (['facilityId'] as const) : []),
    'displayName',
  ]);
  const command = CreateGroupSourceInputSchema.parse({
    kind: 'manual',
    purpose: building ? 'building' : 'others',
    facilityId: building ? form.required('facilityId') : null,
    displayName: form.required('displayName'),
    active: true,
    googleGroupId: null,
    email: null,
    fixtureKey: null,
  });
  return {
    intent,
    command,
    status: building ? 'building-group-created' : 'others-group-created',
  };
}

async function parseGoogleGroupReplacement(
  form: AdminForm,
  intent: 'replace-google-building-group' | 'replace-google-others-group',
  resolvers: GoogleGroupIdResolvers,
): Promise<FacilitiesAdminMutation> {
  const building = intent === 'replace-google-building-group';
  form.assertFields([
    ...COMMON_FIELDS,
    'sourceId',
    ...(building ? (['facilityId'] as const) : []),
    'displayName',
    'email',
  ]);
  const email = normalizeGroupAddress(form.required('email'));
  return {
    intent,
    command: UpdateGroupSourceInputSchema.parse({
      id: form.required('sourceId'),
      kind: 'google-group',
      purpose: building ? 'building' : 'others',
      facilityId: building ? form.required('facilityId') : null,
      displayName: form.required('displayName'),
      active: true,
      googleGroupId: building
        ? await resolvers.resolveOrWaiting(email)
        : await resolvers.resolve(email),
      email,
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

/**
 * Strictly parses one whitelisted native-form mutation into contract input.
 * Only a Google source consults the resolver, to turn its address into the
 * Google Group ID the record carries.
 */
export async function parseFacilitiesAdminMutation(
  form: AdminForm,
  resolution: GoogleGroupIdResolution,
): Promise<FacilitiesAdminMutation> {
  const resolvers = googleGroupIdResolvers(resolution);
  const intent = form.required('intent');
  switch (intent) {
    case 'register-building-groups-by-convention':
      form.assertFields([...COMMON_FIELDS]);
      return { intent, command: null, status: 'building-groups-registered' };
    case 'check-waiting-groups':
      form.assertFields([...COMMON_FIELDS]);
      return { intent, command: null, status: 'waiting-groups-checked' };
    case 'create-facility':
      form.assertFields([...COMMON_FIELDS, 'code', 'name', 'isolated']);
      return {
        intent,
        command: CreateFacilityInputSchema.parse({
          code: form.required('code'),
          name: form.required('name'),
          // A checkbox is present only when checked.
          isolated: form.optional('isolated') === 'on',
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
      return parseGoogleGroup(form, intent, resolvers);
    case 'create-manual-building-group':
    case 'create-manual-others-group':
      return parseManualGroup(form, intent);
    case 'publish-roster-snapshot':
      form.assertFields([...COMMON_FIELDS]);
      return { intent, command: null, status: 'roster-snapshot-published' };
    case 'set-manual-roster-members':
      form.assertFields([...COMMON_FIELDS, 'sourceId', 'emails']);
      return {
        intent,
        command: SetManualRosterMembersInputSchema.parse({
          groupSourceId: form.required('sourceId'),
          // One address per line is what an administrator can paste from a
          // list and read back; blank lines are ignored rather than rejected.
          emails: canonicalManualRosterEmails(
            form.required('emails').split(/[\n,;]/u),
          ),
        }),
        status: 'manual-members-saved',
      };
    case 'create-synthetic-building-group':
    case 'create-synthetic-others-group':
      return parseSyntheticGroup(form, intent);
    case 'replace-google-building-group':
    case 'replace-google-others-group':
      return parseGoogleGroupReplacement(form, intent, resolvers);
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
