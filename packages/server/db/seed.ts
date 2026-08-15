import {
  AudienceConfigSchema,
  ChannelConfigurationSchema,
  EventTypeSchema,
  EventTypeVersionSchema,
  FacilitySchema,
  GroupSourceSchema,
  IntegrationStatusSchema,
  MessageTemplateCatalogSchema,
  NeighborhoodSchema,
  RosterSnapshotSchema,
  RosterSourceConfigurationSchema,
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
  audienceConfigurations,
  audienceTargets,
  channelConfigurations,
  eventTypeTemplates,
  eventTypeVersions,
  eventTypes,
  facilities,
  groupSources,
  integrationStatuses,
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
} from './schema.js';

const SEED_TIME = new Date('2026-08-06T12:00:00.000Z');
const SEED_TIMESTAMP = SEED_TIME.toISOString();

const ids = {
  facilityNorth: '00000000-0000-4000-8000-000000000001',
  facilitySouth: '00000000-0000-4000-8000-000000000002',
  neighborhood: '00000000-0000-4000-8000-000000000010',
  audienceNorth: '00000000-0000-4000-8000-000000000020',
  audienceSouth: '00000000-0000-4000-8000-000000000021',
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
  eventTypeMedicalReal: '00000000-0000-4000-8000-000000000104',
  eventTypeMedicalDrill: '00000000-0000-4000-8000-000000000105',
  eventTypeWildlifeReal: '00000000-0000-4000-8000-000000000106',
  eventTypeWildlifeDrill: '00000000-0000-4000-8000-000000000107',
  eventTypeVersionLockdownReal: '00000000-0000-4000-8000-000000000200',
  eventTypeVersionLockdownDrill: '00000000-0000-4000-8000-000000000201',
  eventTypeVersionModifiedLockdownReal: '00000000-0000-4000-8000-000000000202',
  eventTypeVersionModifiedLockdownDrill: '00000000-0000-4000-8000-000000000203',
  eventTypeVersionMedicalReal: '00000000-0000-4000-8000-000000000204',
  eventTypeVersionMedicalDrill: '00000000-0000-4000-8000-000000000205',
  eventTypeVersionWildlifeReal: '00000000-0000-4000-8000-000000000206',
  eventTypeVersionWildlifeDrill: '00000000-0000-4000-8000-000000000207',
  integrationGoogleGroups: '00000000-0000-4000-8000-000000000300',
  integrationExpoPush: '00000000-0000-4000-8000-000000000301',
  integrationSesEmail: '00000000-0000-4000-8000-000000000302',
  integrationAwsEumSms: '00000000-0000-4000-8000-000000000303',
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
    displayName: 'Synthetic North Staff',
    active: true,
    fixtureKey: 'synthetic-north-staff',
    createdAt: SEED_TIMESTAMP,
  }),
  GroupSourceSchema.parse({
    ...groupSouthRef,
    displayName: 'Synthetic South Staff',
    active: true,
    fixtureKey: 'synthetic-south-staff',
    createdAt: SEED_TIMESTAMP,
  }),
  GroupSourceSchema.parse({
    ...groupOthersRef,
    displayName: 'Synthetic District Support Staff',
    active: true,
    fixtureKey: 'synthetic-district-support-staff',
    createdAt: SEED_TIMESTAMP,
  }),
];

const audienceConfigRows = facilityRows.map((facility, index) =>
  AudienceConfigSchema.parse({
    id: index === 0 ? ids.audienceNorth : ids.audienceSouth,
    facilityId: facility.id,
    version: 1,
    targets: [
      { kind: 'building', facilityId: facility.id },
      {
        kind: 'neighborhood',
        neighborhood: { id: neighborhood.id, version: neighborhood.version },
      },
      { kind: 'others', groupSourceRef: groupOthersRef },
    ],
    createdAt: SEED_TIMESTAMP,
  }),
);

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

const eventTypeDefinitions = [
  {
    id: ids.eventTypeLockdownReal,
    versionId: ids.eventTypeVersionLockdownReal,
    key: 'lockdown',
    familyKey: 'lockdown',
    name: 'Lockdown',
    mode: 'real',
  },
  {
    id: ids.eventTypeLockdownDrill,
    versionId: ids.eventTypeVersionLockdownDrill,
    key: 'lockdown-drill',
    familyKey: 'lockdown',
    name: 'Lockdown Drill',
    mode: 'drill',
  },
  {
    id: ids.eventTypeModifiedLockdownReal,
    versionId: ids.eventTypeVersionModifiedLockdownReal,
    key: 'modified-lockdown',
    familyKey: 'modified-lockdown',
    name: 'Modified Lockdown',
    mode: 'real',
  },
  {
    id: ids.eventTypeModifiedLockdownDrill,
    versionId: ids.eventTypeVersionModifiedLockdownDrill,
    key: 'modified-lockdown-drill',
    familyKey: 'modified-lockdown',
    name: 'Modified Lockdown Drill',
    mode: 'drill',
  },
  {
    id: ids.eventTypeMedicalReal,
    versionId: ids.eventTypeVersionMedicalReal,
    key: 'medical',
    familyKey: 'medical',
    name: 'Medical',
    mode: 'real',
  },
  {
    id: ids.eventTypeMedicalDrill,
    versionId: ids.eventTypeVersionMedicalDrill,
    key: 'medical-drill',
    familyKey: 'medical',
    name: 'Medical Drill',
    mode: 'drill',
  },
  {
    id: ids.eventTypeWildlifeReal,
    versionId: ids.eventTypeVersionWildlifeReal,
    key: 'wildlife',
    familyKey: 'wildlife',
    name: 'Wildlife',
    mode: 'real',
  },
  {
    id: ids.eventTypeWildlifeDrill,
    versionId: ids.eventTypeVersionWildlifeDrill,
    key: 'wildlife-drill',
    familyKey: 'wildlife',
    name: 'Wildlife Drill',
    mode: 'drill',
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
            body: `${visibleMode} ${action} at {{site}}. Started {{startTime}} by {{initiator}}. Open PSD EOC for current instructions.`,
          },
          email: {
            templateMode,
            purpose,
            classificationMarker,
            channel: 'email',
            subject: `${visibleMode} ${action}: ${eventTypeName} at {{site}}`,
            textBody: `${visibleMode} ${action}\n\nEvent type: {{eventType}}\nSite: {{site}}\nStarted: {{startTime}}\nInitiated by: {{initiator}}\n\nOpen PSD EOC for current instructions. Call 911 first when emergency assistance is needed.`,
          },
          sms: {
            templateMode,
            purpose,
            classificationMarker,
            channel: 'sms',
            body: `${visibleMode} ${action}: {{eventType}} at {{site}}. Open PSD EOC for current instructions.`,
          },
        },
      ];
    }),
  );

  return MessageTemplateCatalogSchema.parse(sets);
}

const eventTypeRows = eventTypeDefinitions.map((definition) =>
  EventTypeSchema.parse({
    id: definition.id,
    key: definition.key,
    familyKey: definition.familyKey,
    templateMode: definition.mode,
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

const integrationStatusRows = [
  IntegrationStatusSchema.parse({
    integrationId: 'google-groups',
    label: 'mocked',
    verifiedAt: null,
    verifiedByUserId: null,
    authorizationReference: null,
    reasonCode: null,
    observedAt: SEED_TIMESTAMP,
  }),
  IntegrationStatusSchema.parse({
    integrationId: 'expo-push',
    label: 'mocked',
    verifiedAt: null,
    verifiedByUserId: null,
    authorizationReference: null,
    reasonCode: null,
    observedAt: SEED_TIMESTAMP,
  }),
  IntegrationStatusSchema.parse({
    integrationId: 'ses-email',
    label: 'mocked',
    verifiedAt: null,
    verifiedByUserId: null,
    authorizationReference: null,
    reasonCode: null,
    observedAt: SEED_TIMESTAMP,
  }),
  IntegrationStatusSchema.parse({
    integrationId: 'aws-eum-sms',
    label: 'blocked',
    verifiedAt: null,
    verifiedByUserId: null,
    authorizationReference: null,
    reasonCode: 'CARRIER_REGISTRATION_PENDING',
    observedAt: SEED_TIMESTAMP,
  }),
  IntegrationStatusSchema.parse({
    integrationId: 's3-media',
    label: 'mocked',
    verifiedAt: null,
    verifiedByUserId: null,
    authorizationReference: null,
    reasonCode: null,
    observedAt: SEED_TIMESTAMP,
  }),
];

const integrationStatusIds = [
  ids.integrationGoogleGroups,
  ids.integrationExpoPush,
  ids.integrationSesEmail,
  ids.integrationAwsEumSms,
  ids.integrationS3Media,
] as const;

const channelConfigurationRows = [
  ChannelConfigurationSchema.parse({
    integrationId: 'expo-push',
    enabled: false,
    status: integrationStatusRows[1],
    changedAt: SEED_TIMESTAMP,
  }),
  ChannelConfigurationSchema.parse({
    integrationId: 'ses-email',
    enabled: false,
    status: integrationStatusRows[2],
    changedAt: SEED_TIMESTAMP,
  }),
  ChannelConfigurationSchema.parse({
    integrationId: 'aws-eum-sms',
    enabled: false,
    status: integrationStatusRows[3],
    changedAt: SEED_TIMESTAMP,
  }),
];

/**
 * Deterministic row counts owned by this fixture, not totals for an ambient
 * database that may already contain unrelated records.
 */
export interface SeedSummary {
  readonly facilities: 2;
  readonly neighborhoods: 1;
  readonly neighborhoodFacilities: 2;
  readonly audienceConfigurations: 2;
  readonly audienceTargets: 6;
  readonly groupSources: 3;
  readonly rosterSourceConfigurations: 1;
  readonly rosterSnapshots: 1;
  readonly rosterRecipients: 4;
  readonly rosterEndpoints: 12;
  readonly eventTypes: 8;
  readonly eventTypeVersions: 8;
  readonly eventTypeTemplates: 72;
  readonly integrationStatuses: 5;
  readonly channelConfigurations: 3;
  readonly events: 0;
  readonly outboxMessages: 0;
}

const seedSummary: SeedSummary = {
  facilities: 2,
  neighborhoods: 1,
  neighborhoodFacilities: 2,
  audienceConfigurations: 2,
  audienceTargets: 6,
  groupSources: 3,
  rosterSourceConfigurations: 1,
  rosterSnapshots: 1,
  rosterRecipients: 4,
  rosterEndpoints: 12,
  eventTypes: 8,
  eventTypeVersions: 8,
  eventTypeTemplates: 72,
  integrationStatuses: 5,
  channelConfigurations: 3,
  events: 0,
  outboxMessages: 0,
};

/**
 * Loads a completely synthetic, contract-validated district fixture.
 *
 * Fixed keys plus conflict-safe inserts make repeated runs idempotent. The
 * fixture deliberately creates no user/session, event, notification, attempt,
 * or outbox row, and every provider channel remains disabled and mocked or
 * blocked. Active synthetic endpoints are reserved, provably unroutable values.
 */
export async function seedDatabase(database: Database): Promise<SeedSummary> {
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

    await transaction
      .insert(audienceConfigurations)
      .values(
        audienceConfigRows.map((configuration) => ({
          id: configuration.id,
          facilityId: configuration.facilityId,
          version: configuration.version,
          createdAt: SEED_TIME,
        })),
      )
      .onConflictDoNothing();
    await transaction
      .insert(audienceTargets)
      .values(
        audienceConfigRows.flatMap((configuration) =>
          configuration.targets.map((target, index) => ({
            audienceConfigId: configuration.id,
            audienceConfigVersion: configuration.version,
            ordinal: index + 1,
            targetKind: target.kind,
            targetFacilityId:
              target.kind === 'building' ? target.facilityId : null,
            neighborhoodId:
              target.kind === 'neighborhood' ? target.neighborhood.id : null,
            neighborhoodVersion:
              target.kind === 'neighborhood'
                ? target.neighborhood.version
                : null,
            groupSourceId:
              target.kind === 'others' ? target.groupSourceRef.id : null,
          })),
        ),
      )
      .onConflictDoNothing();

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
            token: endpoint.channel === 'push' ? endpoint.token : null,
            email: endpoint.channel === 'email' ? endpoint.email : null,
            phoneNumber:
              endpoint.channel === 'sms' ? endpoint.phoneNumber : null,
          })),
        ),
      )
      .onConflictDoNothing();

    await transaction
      .insert(eventTypes)
      .values(
        eventTypeRows.map((eventType) => ({
          ...eventType,
          createdAt: SEED_TIME,
        })),
      )
      .onConflictDoNothing();
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

    await transaction
      .insert(integrationStatuses)
      .values(
        integrationStatusRows.map((status, index) => ({
          id: integrationStatusIds[index],
          integrationId: status.integrationId,
          label: status.label,
          verifiedAt: null,
          verifiedByUserId: null,
          authorizationReference: null,
          reasonCode: status.reasonCode,
          observedAt: SEED_TIME,
        })),
      )
      .onConflictDoNothing();
    await transaction
      .insert(channelConfigurations)
      .values(
        channelConfigurationRows.map((configuration) => ({
          integrationId: configuration.integrationId,
          enabled: configuration.enabled,
          statusId:
            configuration.integrationId === 'expo-push'
              ? ids.integrationExpoPush
              : configuration.integrationId === 'ses-email'
                ? ids.integrationSesEmail
                : ids.integrationAwsEumSms,
          statusLabel: configuration.status.label,
          changedAt: SEED_TIME,
        })),
      )
      .onConflictDoNothing();
  });

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
