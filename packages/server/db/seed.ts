import {
  ChannelConfigurationSchema,
  EventTypeSchema,
  EventTypeVersionSchema,
  FacilitySchema,
  GroupSourceSchema,
  MessageTemplateCatalogSchema,
  NeighborhoodSchema,
  RosterSnapshotSchema,
  RosterSourceConfigurationSchema,
  ThreatSchema,
  type MessageTemplateCatalog,
  type NotificationChannel,
  type NotificationPurpose,
  type Recipient,
  type RosterGroupSourceRef,
} from '@psd-eoc/contracts';
import { sql } from 'drizzle-orm';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type Database,
} from './client.js';
import {
  channelConfigurations,
  eventTypeTemplates,
  eventTypeVersions,
  eventTypes,
  facilities,
  groupSources,
  neighborhoodFacilities,
  neighborhoodVersions,
  rosterEndpoints,
  rosterRecipientGroupSources,
  rosterSnapshotFacilities,
  rosterSnapshots,
  rosterSnapshotSources,
  rosterSourceConfigurationFacilities,
  rosterSourceConfigurationGroups,
  rosterSourceConfigurations,
  threats,
} from './schema.js';

const SEED_TIME = new Date('2026-08-06T12:00:00.000Z');
const SEED_TIMESTAMP = SEED_TIME.toISOString();

const ids = {
  facilityNorth: '00000000-0000-4000-8000-000000000001',
  facilitySouth: '00000000-0000-4000-8000-000000000002',
  neighborhood: '00000000-0000-4000-8000-000000000010',
  groupNorth: '00000000-0000-4000-8000-000000000030',
  groupSouth: '00000000-0000-4000-8000-000000000031',
  groupOthers: '00000000-0000-4000-8000-000000000032',
  rosterConfiguration: '00000000-0000-4000-8000-000000000040',
  rosterSnapshot: '00000000-0000-4000-8000-000000000041',
  recipientNorthOne: '00000000-0000-4000-8000-000000000050',
  recipientNorthTwo: '00000000-0000-4000-8000-000000000051',
  recipientSouthOne: '00000000-0000-4000-8000-000000000052',
  recipientSouthTwo: '00000000-0000-4000-8000-000000000053',
  endpointNorthOnePush: '00000000-0000-4000-8000-000000000060',
  endpointNorthOneEmail: '00000000-0000-4000-8000-000000000061',
  endpointNorthOneSms: '00000000-0000-4000-8000-000000000062',
  endpointNorthTwoPush: '00000000-0000-4000-8000-000000000063',
  endpointNorthTwoEmail: '00000000-0000-4000-8000-000000000064',
  endpointNorthTwoSms: '00000000-0000-4000-8000-000000000065',
  endpointSouthOnePush: '00000000-0000-4000-8000-000000000066',
  endpointSouthOneEmail: '00000000-0000-4000-8000-000000000067',
  endpointSouthOneSms: '00000000-0000-4000-8000-000000000068',
  endpointSouthTwoPush: '00000000-0000-4000-8000-000000000069',
  endpointSouthTwoEmail: '00000000-0000-4000-8000-000000000070',
  endpointSouthTwoSms: '00000000-0000-4000-8000-000000000071',
  eventTypeLockdownReal: '00000000-0000-4000-8000-000000000100',
  eventTypeLockdownDrill: '00000000-0000-4000-8000-000000000101',
  eventTypeModifiedLockdownReal: '00000000-0000-4000-8000-000000000102',
  eventTypeModifiedLockdownDrill: '00000000-0000-4000-8000-000000000103',
  // 0104–0107 and 0204–0207 once seeded Medical and Wildlife as responses.
  // They are threats now; a live database keeps those rows (an administrator
  // retires them) and the ids stay unused so no new family collides with
  // them under the seed's insert-if-absent rule.
  eventTypeEvacuationReal: '00000000-0000-4000-8000-000000000108',
  eventTypeEvacuationDrill: '00000000-0000-4000-8000-000000000109',
  eventTypeNoEvacuationReal: '00000000-0000-4000-8000-00000000010a',
  eventTypeNoEvacuationDrill: '00000000-0000-4000-8000-00000000010b',
  eventTypeShelterInPlaceReal: '00000000-0000-4000-8000-00000000010c',
  eventTypeShelterInPlaceDrill: '00000000-0000-4000-8000-00000000010d',
  eventTypeOtherReal: '00000000-0000-4000-8000-00000000010e',
  eventTypeOtherDrill: '00000000-0000-4000-8000-00000000010f',
  eventTypeVersionLockdownReal: '00000000-0000-4000-8000-000000000200',
  eventTypeVersionLockdownDrill: '00000000-0000-4000-8000-000000000201',
  eventTypeVersionModifiedLockdownReal: '00000000-0000-4000-8000-000000000202',
  eventTypeVersionModifiedLockdownDrill: '00000000-0000-4000-8000-000000000203',
  eventTypeVersionEvacuationReal: '00000000-0000-4000-8000-000000000208',
  eventTypeVersionEvacuationDrill: '00000000-0000-4000-8000-000000000209',
  eventTypeVersionNoEvacuationReal: '00000000-0000-4000-8000-00000000020a',
  eventTypeVersionNoEvacuationDrill: '00000000-0000-4000-8000-00000000020b',
  eventTypeVersionShelterInPlaceReal: '00000000-0000-4000-8000-00000000020c',
  eventTypeVersionShelterInPlaceDrill: '00000000-0000-4000-8000-00000000020d',
  eventTypeVersionOtherReal: '00000000-0000-4000-8000-00000000020e',
  eventTypeVersionOtherDrill: '00000000-0000-4000-8000-00000000020f',
  integrationS3Media: '00000000-0000-4000-8000-000000000304',
} as const;

const facilityRows = [
  FacilitySchema.parse({
    id: ids.facilityNorth,
    code: 'SYN-NORTH',
    name: 'Synthetic North Campus',
    active: true,
    createdAt: SEED_TIMESTAMP,
  }),
  FacilitySchema.parse({
    id: ids.facilitySouth,
    code: 'SYN-SOUTH',
    name: 'Synthetic South Campus',
    active: true,
    createdAt: SEED_TIMESTAMP,
  }),
];

/**
 * A synthetic threat vocabulary in declared order: two plain choices, one that
 * needs a typed description, and one retired entry the start flow must hide.
 */
const threatRows = [
  ThreatSchema.parse({
    id: '00000000-0000-4000-8000-000000000700',
    key: 'synthetic-wildlife',
    name: 'Synthetic wildlife',
    sortOrder: 0,
    requiresDetail: false,
    active: true,
    createdAt: SEED_TIMESTAMP,
  }),
  ThreatSchema.parse({
    id: '00000000-0000-4000-8000-000000000701',
    key: 'synthetic-earthquake',
    name: 'Synthetic earthquake',
    sortOrder: 1,
    requiresDetail: false,
    active: true,
    createdAt: SEED_TIMESTAMP,
  }),
  ThreatSchema.parse({
    id: '00000000-0000-4000-8000-000000000702',
    key: 'synthetic-other',
    name: 'Synthetic other',
    sortOrder: 2,
    requiresDetail: true,
    active: true,
    createdAt: SEED_TIMESTAMP,
  }),
  ThreatSchema.parse({
    id: '00000000-0000-4000-8000-000000000703',
    key: 'synthetic-retired',
    name: 'Synthetic retired threat',
    sortOrder: 3,
    requiresDetail: false,
    active: false,
    createdAt: SEED_TIMESTAMP,
  }),
];

const neighborhood = NeighborhoodSchema.parse({
  id: ids.neighborhood,
  name: 'Synthetic Twin Campuses',
  facilityIds: [ids.facilityNorth, ids.facilitySouth],
  version: 1,
  createdAt: SEED_TIMESTAMP,
});

const groupNorthRef = {
  id: ids.groupNorth,
  kind: 'synthetic',
  purpose: 'building',
  facilityId: ids.facilityNorth,
} as const;
const groupSouthRef = {
  id: ids.groupSouth,
  kind: 'synthetic',
  purpose: 'building',
  facilityId: ids.facilitySouth,
} as const;
const groupOthersRef = {
  id: ids.groupOthers,
  kind: 'synthetic',
  purpose: 'others',
  facilityId: null,
} as const;
const rosterGroupRefs: readonly RosterGroupSourceRef[] = [
  groupNorthRef,
  groupSouthRef,
  groupOthersRef,
];

const groupSourceRows = [
  GroupSourceSchema.parse({
    ...groupNorthRef,
    grantedRole: null,
    displayName: 'Synthetic North Staff',
    active: true,
    membersCapturedAt: null,
    fixtureKey: 'synthetic-north-staff',
    createdAt: SEED_TIMESTAMP,
  }),
  GroupSourceSchema.parse({
    ...groupSouthRef,
    grantedRole: null,
    displayName: 'Synthetic South Staff',
    active: true,
    membersCapturedAt: null,
    fixtureKey: 'synthetic-south-staff',
    createdAt: SEED_TIMESTAMP,
  }),
  GroupSourceSchema.parse({
    ...groupOthersRef,
    grantedRole: null,
    displayName: 'Synthetic District Support Staff',
    active: true,
    membersCapturedAt: null,
    fixtureKey: 'synthetic-district-support-staff',
    createdAt: SEED_TIMESTAMP,
  }),
];

const rosterConfiguration = RosterSourceConfigurationSchema.parse({
  id: ids.rosterConfiguration,
  version: 1,
  population: 'synthetic',
  facilityIds: facilityRows.map((facility) => facility.id),
  groupSourceRefs: rosterGroupRefs,
  createdAt: SEED_TIMESTAMP,
});

function recipient(
  id: string,
  displayName: string,
  groupSourceRefs: readonly RosterGroupSourceRef[],
  endpointIds: readonly [string, string, string],
  endpointKey: string,
  phoneSuffix: string,
  platform: 'ios' | 'android',
): Recipient {
  return {
    id,
    population: 'synthetic',
    googleSubject: null,
    displayName,
    groupSourceRefs,
    endpoints: [
      {
        id: endpointIds[0],
        channel: 'push',
        status: 'active',
        capturedAt: SEED_TIMESTAMP,
        platform,
        provider: 'expo',
        serviceEnvironment: 'production',
        token: `synthetic-unroutable:${endpointKey}`,
      },
      {
        id: endpointIds[1],
        channel: 'email',
        status: 'active',
        capturedAt: SEED_TIMESTAMP,
        email: `${endpointKey}@example.invalid`,
      },
      {
        id: endpointIds[2],
        channel: 'sms',
        status: 'active',
        capturedAt: SEED_TIMESTAMP,
        phoneNumber: `+120255501${phoneSuffix}`,
      },
    ],
  };
}

const recipientRows = [
  recipient(
    ids.recipientNorthOne,
    'Synthetic Staff North One',
    [groupNorthRef, groupOthersRef],
    [
      ids.endpointNorthOnePush,
      ids.endpointNorthOneEmail,
      ids.endpointNorthOneSms,
    ],
    'north-one',
    '01',
    'ios',
  ),
  recipient(
    ids.recipientNorthTwo,
    'Synthetic Staff North Two',
    [groupNorthRef],
    [
      ids.endpointNorthTwoPush,
      ids.endpointNorthTwoEmail,
      ids.endpointNorthTwoSms,
    ],
    'north-two',
    '02',
    'android',
  ),
  recipient(
    ids.recipientSouthOne,
    'Synthetic Staff South One',
    [groupSouthRef, groupOthersRef],
    [
      ids.endpointSouthOnePush,
      ids.endpointSouthOneEmail,
      ids.endpointSouthOneSms,
    ],
    'south-one',
    '03',
    'ios',
  ),
  recipient(
    ids.recipientSouthTwo,
    'Synthetic Staff South Two',
    [groupSouthRef],
    [
      ids.endpointSouthTwoPush,
      ids.endpointSouthTwoEmail,
      ids.endpointSouthTwoSms,
    ],
    'south-two',
    '04',
    'android',
  ),
];

const rosterSnapshot = RosterSnapshotSchema.parse({
  id: ids.rosterSnapshot,
  version: 1,
  population: 'synthetic',
  complete: true,
  sourceConfiguration: {
    id: rosterConfiguration.id,
    version: rosterConfiguration.version,
  },
  facilityIds: facilityRows.map((facility) => facility.id),
  expectedSourceGroupRefs: rosterGroupRefs,
  sourceGroupRefs: rosterGroupRefs,
  recipients: recipientRows,
  syncStartedAt: SEED_TIMESTAMP,
  capturedAt: SEED_TIMESTAMP,
});

/**
 * The responses an operator chooses after the threat. Each family has a real
 * and a drill identity; "Other" requires the operator to describe the
 * response in their own words.
 */
const eventTypeDefinitions = [
  {
    id: ids.eventTypeLockdownReal,
    versionId: ids.eventTypeVersionLockdownReal,
    key: 'lockdown',
    familyKey: 'lockdown',
    name: 'Lockdown',
    mode: 'real',
    requiresDetail: false,
  },
  {
    id: ids.eventTypeLockdownDrill,
    versionId: ids.eventTypeVersionLockdownDrill,
    key: 'lockdown-drill',
    familyKey: 'lockdown',
    name: 'Lockdown Drill',
    mode: 'drill',
    requiresDetail: false,
  },
  {
    id: ids.eventTypeModifiedLockdownReal,
    versionId: ids.eventTypeVersionModifiedLockdownReal,
    key: 'modified-lockdown',
    familyKey: 'modified-lockdown',
    name: 'Modified Lockdown',
    mode: 'real',
    requiresDetail: false,
  },
  {
    id: ids.eventTypeModifiedLockdownDrill,
    versionId: ids.eventTypeVersionModifiedLockdownDrill,
    key: 'modified-lockdown-drill',
    familyKey: 'modified-lockdown',
    name: 'Modified Lockdown Drill',
    mode: 'drill',
    requiresDetail: false,
  },
  {
    id: ids.eventTypeEvacuationReal,
    versionId: ids.eventTypeVersionEvacuationReal,
    key: 'evacuation',
    familyKey: 'evacuation',
    name: 'Evacuation',
    mode: 'real',
    requiresDetail: false,
  },
  {
    id: ids.eventTypeEvacuationDrill,
    versionId: ids.eventTypeVersionEvacuationDrill,
    key: 'evacuation-drill',
    familyKey: 'evacuation',
    name: 'Evacuation Drill',
    mode: 'drill',
    requiresDetail: false,
  },
  {
    id: ids.eventTypeNoEvacuationReal,
    versionId: ids.eventTypeVersionNoEvacuationReal,
    key: 'no-evacuation',
    familyKey: 'no-evacuation',
    name: 'No Evacuation',
    mode: 'real',
    requiresDetail: false,
  },
  {
    id: ids.eventTypeNoEvacuationDrill,
    versionId: ids.eventTypeVersionNoEvacuationDrill,
    key: 'no-evacuation-drill',
    familyKey: 'no-evacuation',
    name: 'No Evacuation Drill',
    mode: 'drill',
    requiresDetail: false,
  },
  {
    id: ids.eventTypeShelterInPlaceReal,
    versionId: ids.eventTypeVersionShelterInPlaceReal,
    key: 'shelter-in-place',
    familyKey: 'shelter-in-place',
    name: 'Shelter in Place',
    mode: 'real',
    requiresDetail: false,
  },
  {
    id: ids.eventTypeShelterInPlaceDrill,
    versionId: ids.eventTypeVersionShelterInPlaceDrill,
    key: 'shelter-in-place-drill',
    familyKey: 'shelter-in-place',
    name: 'Shelter in Place Drill',
    mode: 'drill',
    requiresDetail: false,
  },
  {
    id: ids.eventTypeOtherReal,
    versionId: ids.eventTypeVersionOtherReal,
    key: 'other',
    familyKey: 'other',
    name: 'Other',
    mode: 'real',
    requiresDetail: true,
  },
  {
    id: ids.eventTypeOtherDrill,
    versionId: ids.eventTypeVersionOtherDrill,
    key: 'other-drill',
    familyKey: 'other',
    name: 'Other Drill',
    mode: 'drill',
    requiresDetail: true,
  },
] as const;

const purposes = [
  'activation',
  'all-clear',
  'reactivation',
] as const satisfies readonly NotificationPurpose[];
const channels = [
  'push',
  'email',
  'sms',
] as const satisfies readonly NotificationChannel[];

function purposeLabel(purpose: NotificationPurpose): string {
  switch (purpose) {
    case 'activation':
      return 'ACTIVATION';
    case 'all-clear':
      return 'ALL-CLEAR';
    case 'reactivation':
      return 'REACTIVATION';
  }
}

function makeTemplateCatalog(
  eventTypeName: string,
  templateMode: 'real' | 'drill',
): MessageTemplateCatalog {
  const classificationMarker = templateMode === 'real' ? 'INCIDENT' : 'DRILL';
  const visibleMode =
    templateMode === 'real' ? 'REAL INCIDENT' : 'DRILL — TRAINING ONLY';

  const sets = Object.fromEntries(
    purposes.map((purpose) => {
      const action = purposeLabel(purpose);
      return [
        purpose,
        {
          templateMode,
          purpose,
          push: {
            templateMode,
            purpose,
            classificationMarker,
            channel: 'push',
            title: `${visibleMode} ${action}: ${eventTypeName}`,
            body: `${visibleMode} ${action} at {{site}}. Threat: {{threat}}. Started {{startTime}} by {{initiator}}. Open PSD EOC for current instructions.`,
          },
          email: {
            templateMode,
            purpose,
            classificationMarker,
            channel: 'email',
            subject: `${visibleMode} ${action}: ${eventTypeName} at {{site}}`,
            textBody: `${visibleMode} ${action}\n\nResponse: {{eventType}}\nThreat: {{threat}}\nSite: {{site}}\nStarted: {{startTime}}\nInitiated by: {{initiator}}\n\nOpen PSD EOC for current instructions. Call 911 first when emergency assistance is needed.`,
          },
          sms: {
            templateMode,
            purpose,
            classificationMarker,
            channel: 'sms',
            body: `${visibleMode} ${action}: {{eventType}} at {{site}}. Threat: {{threat}}. Open PSD EOC for current instructions.`,
          },
        },
      ];
    }),
  );

  return MessageTemplateCatalogSchema.parse(sets);
}

export const eventTypeRows = eventTypeDefinitions.map((definition) =>
  EventTypeSchema.parse({
    id: definition.id,
    key: definition.key,
    familyKey: definition.familyKey,
    templateMode: definition.mode,
    requiresDetail: definition.requiresDetail,
    createdAt: SEED_TIMESTAMP,
  }),
);

const eventTypeVersionRows = eventTypeDefinitions.map((definition) =>
  EventTypeVersionSchema.parse({
    id: definition.versionId,
    eventTypeId: definition.id,
    version: 1,
    templateMode: definition.mode,
    name: definition.name,
    description:
      definition.mode === 'real'
        ? `Seeded real ${definition.name} incident type.`
        : `Seeded synthetic ${definition.name} training type.`,
    enabled: true,
    templates: makeTemplateCatalog(definition.name, definition.mode),
    supersedesVersionId: null,
    createdBy: { kind: 'system', serviceId: 'database-seed' },
    publicationAuthorization: {
      kind: 'repository-seed',
      approvalReference: 'github-issue-5-reviewed-defaults',
    },
    createdAt: SEED_TIMESTAMP,
  }),
);

const templateRows = eventTypeVersionRows.flatMap((version) =>
  purposes.flatMap((purpose) =>
    channels.map((channel) => {
      const template = version.templates[purpose][channel];
      return {
        eventTypeVersionId: version.id,
        templateMode: template.templateMode,
        purpose: template.purpose,
        channel: template.channel,
        classificationMarker: template.classificationMarker,
        title: template.channel === 'push' ? template.title : null,
        subject: template.channel === 'email' ? template.subject : null,
        body: template.channel === 'email' ? null : template.body,
        textBody: template.channel === 'email' ? template.textBody : null,
      };
    }),
  ),
);

const channelConfigurationRows = [
  ChannelConfigurationSchema.parse({
    integrationId: 'mobile-push',
    enabled: false,
    changedAt: SEED_TIMESTAMP,
  }),
  ChannelConfigurationSchema.parse({
    integrationId: 'ses-email',
    enabled: false,
    changedAt: SEED_TIMESTAMP,
  }),
  ChannelConfigurationSchema.parse({
    integrationId: 'aws-eum-sms',
    enabled: false,
    changedAt: SEED_TIMESTAMP,
  }),
];

/**
 * Deterministic row counts owned by this fixture, not totals for an ambient
 * database that may already contain unrelated records.
 */
export interface ReferenceSeedSummary {
  readonly eventTypes: 12;
  readonly eventTypeVersions: 12;
  readonly eventTypeTemplates: 108;
  readonly channelConfigurations: 3;
  readonly events: 0;
  readonly outboxMessages: 0;
}

export interface SeedSummary extends ReferenceSeedSummary {
  readonly facilities: 2;
  readonly threats: 4;
  readonly neighborhoods: 1;
  readonly neighborhoodFacilities: 2;
  readonly groupSources: 3;
  readonly rosterSourceConfigurations: 1;
  readonly rosterSnapshots: 1;
  readonly rosterRecipients: 4;
  readonly rosterEndpoints: 12;
}

const referenceSeedSummary: ReferenceSeedSummary = {
  eventTypes: 12,
  eventTypeVersions: 12,
  eventTypeTemplates: 108,
  channelConfigurations: 3,
  events: 0,
  outboxMessages: 0,
};

const seedSummary: SeedSummary = {
  facilities: 2,
  threats: 4,
  neighborhoods: 1,
  neighborhoodFacilities: 2,
  groupSources: 3,
  rosterSourceConfigurations: 1,
  rosterSnapshots: 1,
  rosterRecipients: 4,
  rosterEndpoints: 12,
  ...referenceSeedSummary,
};

/**
 * Loads only production-safe reference catalogs and fail-closed integration
 * labels. It never creates facilities, rosters, recipients, events,
 * notifications, or outbox work and is safe to run repeatedly at bootstrap.
 */
export async function seedReferenceData(
  database: Database,
  options: ReferenceSeedOptions = {},
): Promise<ReferenceSeedSummary> {
  await database.transaction(async (transaction) => {
    if (options.insertEventTypes !== undefined) {
      await options.insertEventTypes(transaction);
    } else {
      await transaction
        .insert(eventTypes)
        .values(
          eventTypeRows.map((eventType) => ({
            ...eventType,
            createdAt: SEED_TIME,
          })),
        )
        .onConflictDoNothing();
    }
    await transaction
      .insert(eventTypeVersions)
      .values(
        eventTypeVersionRows.map((version) => ({
          id: version.id,
          eventTypeId: version.eventTypeId,
          version: version.version,
          templateMode: version.templateMode,
          name: version.name,
          description: version.description,
          enabled: version.enabled,
          supersedesVersionId: version.supersedesVersionId,
          createdBy: version.createdBy,
          publicationAuthorization: version.publicationAuthorization,
          createdAt: SEED_TIME,
        })),
      )
      .onConflictDoNothing();
    await transaction
      .insert(eventTypeTemplates)
      .values(templateRows)
      .onConflictDoNothing();

    if (options.insertChannelConfigurations !== undefined) {
      await options.insertChannelConfigurations(transaction);
    } else {
      await transaction
        .insert(channelConfigurations)
        .values(
          channelConfigurationRows.map((configuration) => ({
            integrationId: configuration.integrationId,
            enabled: configuration.enabled,
            changedAt: SEED_TIME,
          })),
        )
        .onConflictDoNothing();
    }
  });

  return referenceSeedSummary;
}

/**
 * Loads a completely synthetic, contract-validated district fixture for local
 * development and isolated tests, then loads production-safe reference data.
 *
 * Fixed keys plus conflict-safe inserts make repeated runs idempotent. The
 * fixture deliberately creates no user/session, event, notification, attempt,
 * or outbox row, and every provider channel remains disabled and mocked or
 * blocked. Active synthetic endpoints are reserved, provably unroutable values.
 */
/**
 * Options for seeding a database that is deliberately not at the current
 * schema.
 *
 * `skipGroupSources` exists for the historical-migration fixture, which holds a
 * database at migration 0004 and then upgrades it. Drizzle emits every column
 * of a table it inserts into, so seeding group sources through the current
 * schema fails there the moment that table gains a column — as it did when
 * access groups started carrying the role they grant. The fixture inserts those
 * rows itself with the columns its schema actually has.
 */
export interface SeedDatabaseOptions {
  /**
   * Writes the group sources in place of the seed, at the point in the
   * transaction where they must exist: after facilities, before the roster
   * source configuration that references them.
   */
  readonly insertGroupSources?: (
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
  ) => Promise<void>;
  /** Writes historical endpoint rows when the current provider columns do not exist. */
  readonly insertRosterEndpoints?: (
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
  ) => Promise<void>;
  /**
   * Writes the threats in place of the seed. A fixture held at a migration
   * before `0046_threat_catalog` has no `threats` table, so it supplies a no-op
   * here rather than letting the seed fail on a relation that does not exist.
   */
  readonly insertThreats?: (
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
  ) => Promise<void>;
  /**
   * Writes the event types in place of the seed. A fixture held at a migration
   * before `0047_threat_on_activation` has no `requires_detail` column, and
   * Drizzle emits every column of a table it inserts into, so the fixture
   * writes the rows with the columns its schema actually has.
   */
  readonly insertEventTypes?: (
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
  ) => Promise<void>;
  /**
   * Writes the channel configurations in place of the seed. A fixture held at
   * a migration before `0049_gut_delivery_tests_and_truth_labels` still has
   * the retired `status_id` and `status_label` columns, which the seed no
   * longer writes, so the fixture writes the rows its schema actually needs.
   */
  readonly insertChannelConfigurations?: (
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
  ) => Promise<void>;
}

/** The reference seed only ever needs the held-back schema overrides. */
export type ReferenceSeedOptions = Pick<
  SeedDatabaseOptions,
  'insertEventTypes' | 'insertChannelConfigurations'
>;

export async function seedDatabase(
  database: Database,
  options: SeedDatabaseOptions = {},
): Promise<SeedSummary> {
  await database.transaction(async (transaction) => {
    await transaction
      .insert(facilities)
      .values(
        facilityRows.map((facility) => ({
          ...facility,
          createdAt: SEED_TIME,
        })),
      )
      .onConflictDoNothing();

    if (options.insertThreats !== undefined) {
      await options.insertThreats(transaction);
    } else {
      await transaction
        .insert(threats)
        .values(
          threatRows.map((threat) => ({
            ...threat,
            createdAt: SEED_TIME,
          })),
        )
        .onConflictDoNothing();
    }

    await transaction
      .insert(neighborhoodVersions)
      .values({
        id: neighborhood.id,
        version: neighborhood.version,
        name: neighborhood.name,
        createdAt: SEED_TIME,
      })
      .onConflictDoNothing();
    await transaction
      .insert(neighborhoodFacilities)
      .values(
        neighborhood.facilityIds.map((facilityId) => ({
          neighborhoodId: neighborhood.id,
          neighborhoodVersion: neighborhood.version,
          facilityId,
        })),
      )
      .onConflictDoNothing();

    if (options.insertGroupSources !== undefined) {
      await options.insertGroupSources(transaction);
    } else {
      await transaction
        .insert(groupSources)
        .values(
          groupSourceRows.map((source) => ({
            id: source.id,
            kind: source.kind,
            purpose: source.purpose,
            facilityId: source.facilityId,
            displayName: source.displayName,
            active: source.active,
            googleGroupId: null,
            email: null,
            fixtureKey: source.kind === 'synthetic' ? source.fixtureKey : null,
            createdAt: SEED_TIME,
          })),
        )
        .onConflictDoNothing();
    }

    await transaction
      .insert(rosterSourceConfigurations)
      .values({
        id: rosterConfiguration.id,
        version: rosterConfiguration.version,
        population: rosterConfiguration.population,
        createdAt: SEED_TIME,
      })
      .onConflictDoNothing();
    await transaction
      .insert(rosterSourceConfigurationFacilities)
      .values(
        rosterConfiguration.facilityIds.map((facilityId) => ({
          configurationId: rosterConfiguration.id,
          configurationVersion: rosterConfiguration.version,
          facilityId,
        })),
      )
      .onConflictDoNothing();
    await transaction
      .insert(rosterSourceConfigurationGroups)
      .values(
        rosterConfiguration.groupSourceRefs.map((groupSource) => ({
          configurationId: rosterConfiguration.id,
          configurationVersion: rosterConfiguration.version,
          groupSourceId: groupSource.id,
          population: rosterConfiguration.population,
          groupSourceKind: groupSource.kind,
          groupPurpose: groupSource.purpose,
        })),
      )
      .onConflictDoNothing();

    await transaction
      .insert(rosterSnapshots)
      .values({
        id: rosterSnapshot.id,
        version: rosterSnapshot.version,
        population: rosterSnapshot.population,
        complete: rosterSnapshot.complete,
        sourceConfigurationId: rosterSnapshot.sourceConfiguration.id,
        sourceConfigurationVersion: rosterSnapshot.sourceConfiguration.version,
        syncStartedAt: SEED_TIME,
        capturedAt: SEED_TIME,
      })
      .onConflictDoNothing();
    await transaction
      .insert(rosterSnapshotFacilities)
      .values(
        rosterSnapshot.facilityIds.map((facilityId) => ({
          rosterSnapshotId: rosterSnapshot.id,
          facilityId,
        })),
      )
      .onConflictDoNothing();
    await transaction
      .insert(rosterSnapshotSources)
      .values(
        rosterSnapshot.expectedSourceGroupRefs.flatMap((source) => [
          {
            rosterSnapshotId: rosterSnapshot.id,
            groupSourceId: source.id,
            completionKind: 'expected' as const,
            population: rosterSnapshot.population,
            groupSourceKind: source.kind,
            groupPurpose: source.purpose,
          },
          {
            rosterSnapshotId: rosterSnapshot.id,
            groupSourceId: source.id,
            completionKind: 'completed' as const,
            population: rosterSnapshot.population,
            groupSourceKind: source.kind,
            groupPurpose: source.purpose,
          },
        ]),
      )
      .onConflictDoNothing();
    for (const rosterRecipient of rosterSnapshot.recipients) {
      await transaction.execute(sql`
        insert into roster_recipients (
          id,
          roster_snapshot_id,
          population,
          google_subject,
          display_name
        ) values (
          ${rosterRecipient.id}::uuid,
          ${rosterSnapshot.id}::uuid,
          ${rosterRecipient.population}::roster_population,
          ${rosterRecipient.googleSubject}::varchar(255),
          ${rosterRecipient.displayName}::varchar(160)
        )
        on conflict do nothing
      `);
    }
    await transaction
      .insert(rosterRecipientGroupSources)
      .values(
        rosterSnapshot.recipients.flatMap((rosterRecipient) =>
          rosterRecipient.groupSourceRefs.map((source) => ({
            rosterSnapshotId: rosterSnapshot.id,
            recipientId: rosterRecipient.id,
            groupSourceId: source.id,
            population: rosterRecipient.population,
            groupSourceKind: source.kind,
            groupPurpose: source.purpose,
          })),
        ),
      )
      .onConflictDoNothing();
    if (options.insertRosterEndpoints !== undefined) {
      await options.insertRosterEndpoints(transaction);
    } else {
      await transaction
        .insert(rosterEndpoints)
        .values(
          rosterSnapshot.recipients.flatMap((rosterRecipient) =>
            rosterRecipient.endpoints.map((endpoint) => ({
              id: endpoint.id,
              rosterSnapshotId: rosterSnapshot.id,
              recipientId: rosterRecipient.id,
              population: rosterRecipient.population,
              channel: endpoint.channel,
              status: endpoint.status,
              capturedAt: SEED_TIME,
              platform: endpoint.channel === 'push' ? endpoint.platform : null,
              provider: endpoint.channel === 'push' ? endpoint.provider : null,
              serviceEnvironment:
                endpoint.channel === 'push'
                  ? endpoint.serviceEnvironment
                  : null,
              token: endpoint.channel === 'push' ? endpoint.token : null,
              email: endpoint.channel === 'email' ? endpoint.email : null,
              phoneNumber:
                endpoint.channel === 'sms' ? endpoint.phoneNumber : null,
            })),
          ),
        )
        .onConflictDoNothing();
    }
  });

  await seedReferenceData(database, options);

  return seedSummary;
}

async function runSeed(): Promise<void> {
  const connection = createDatabaseClient(readDatabaseConfig());
  try {
    const summary = await seedDatabase(connection.db);
    console.info(JSON.stringify(summary));
  } finally {
    await connection.close();
  }
}

if (import.meta.main) {
  await runSeed();
}
