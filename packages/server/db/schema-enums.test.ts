import { readFileSync } from 'node:fs';

import {
  AGENT_GRANTABLE_CAPABILITY_IDS,
  ActorKindSchema,
  ClassificationMarkerSchema,
  DeliveryEvidenceSubjectKindSchema,
  DeliveryTruthStateSchema,
  DevicePlatformSchema,
  DeviceUnlockMethodSchema,
  EndpointStatusSchema,
  EventKindSchema,
  EventStatusSchema,
  EventTransitionKindSchema,
  FacilityScopeKindSchema,
  GroupCompletionKindSchema,
  GroupPurposeSchema,
  GroupSourceKindSchema,
  HUMAN_ONLY_ACTION_IDS,
  HumanConfirmationStatusSchema,
  IdempotencyStatusSchema,
  IntegrationTruthLabelSchema,
  InvocationSourceSchema,
  JournalEntryKindSchema,
  JournalSupersessionKindSchema,
  MediaContentTypeSchema,
  MonthlyDeliveryTestReportStatusSchema,
  MUTATION_CAPABILITY_IDS,
  NotificationChannelSchema,
  NotificationPurposeSchema,
  OutboxStatusSchema,
  PushPlatformSchema,
  RoleSchema,
  RosterPopulationSchema,
  RosterSyncOutcomeSchema,
  SecurityAuditCategorySchema,
  SecurityAuditOutcomeSchema,
  TemplateModeSchema,
} from '@psd-eoc/contracts';
import { describe, expect, test } from 'bun:test';

import {
  actorKindEnum,
  agentCapabilityGrantEnum,
  classificationMarkerEnum,
  deliveryEvidenceSubjectKindEnum,
  deliveryTestReportStatusEnum,
  deliveryTruthStateEnum,
  devicePlatformEnum,
  deviceUnlockMethodEnum,
  endpointStatusEnum,
  eventKindEnum,
  eventStatusEnum,
  eventTransitionKindEnum,
  facilityScopeKindEnum,
  groupCompletionKindEnum,
  groupPurposeEnum,
  groupSourceKindEnum,
  humanConfirmationStatusEnum,
  humanOnlyActionEnum,
  idempotencyStatusEnum,
  integrationTruthLabelEnum,
  invocationSourceEnum,
  journalEntryKindEnum,
  journalSupersessionKindEnum,
  listContractDerivedDatabaseEnums,
  mediaContentTypeEnum,
  mutationCapabilityEnum,
  notificationChannelEnum,
  notificationPurposeEnum,
  outboxStatusEnum,
  pushPlatformEnum,
  roleEnum,
  rosterPopulationEnum,
  rosterSyncOutcomeEnum,
  securityAuditCategoryEnum,
  securityAuditOutcomeEnum,
  templateModeEnum,
} from './schema';

const enumExpectations = [
  [actorKindEnum, ActorKindSchema.options],
  [roleEnum, RoleSchema.options],
  [facilityScopeKindEnum, FacilityScopeKindSchema.options],
  [devicePlatformEnum, DevicePlatformSchema.options],
  [deviceUnlockMethodEnum, DeviceUnlockMethodSchema.options],
  [groupSourceKindEnum, GroupSourceKindSchema.options],
  [groupPurposeEnum, GroupPurposeSchema.options],
  [groupCompletionKindEnum, GroupCompletionKindSchema.options],
  [rosterPopulationEnum, RosterPopulationSchema.options],
  [endpointStatusEnum, EndpointStatusSchema.options],
  [notificationChannelEnum, NotificationChannelSchema.options],
  [pushPlatformEnum, PushPlatformSchema.options],
  [eventKindEnum, EventKindSchema.options],
  [templateModeEnum, TemplateModeSchema.options],
  [notificationPurposeEnum, NotificationPurposeSchema.options],
  [classificationMarkerEnum, ClassificationMarkerSchema.options],
  [eventStatusEnum, EventStatusSchema.options],
  [eventTransitionKindEnum, EventTransitionKindSchema.options],
  [invocationSourceEnum, InvocationSourceSchema.options],
  [journalEntryKindEnum, JournalEntryKindSchema.options],
  [journalSupersessionKindEnum, JournalSupersessionKindSchema.options],
  [mediaContentTypeEnum, MediaContentTypeSchema.options],
  [deliveryTruthStateEnum, DeliveryTruthStateSchema.options],
  [deliveryEvidenceSubjectKindEnum, DeliveryEvidenceSubjectKindSchema.options],
  [deliveryTestReportStatusEnum, MonthlyDeliveryTestReportStatusSchema.options],
  [outboxStatusEnum, OutboxStatusSchema.options],
  [integrationTruthLabelEnum, IntegrationTruthLabelSchema.options],
  [securityAuditCategoryEnum, SecurityAuditCategorySchema.options],
  [securityAuditOutcomeEnum, SecurityAuditOutcomeSchema.options],
  [agentCapabilityGrantEnum, AGENT_GRANTABLE_CAPABILITY_IDS],
  [mutationCapabilityEnum, MUTATION_CAPABILITY_IDS],
  [humanOnlyActionEnum, HUMAN_ONLY_ACTION_IDS],
  [idempotencyStatusEnum, IdempotencyStatusSchema.options],
  [humanConfirmationStatusEnum, HumanConfirmationStatusSchema.options],
  [rosterSyncOutcomeEnum, RosterSyncOutcomeSchema.options],
] as const;

interface MigrationSnapshot {
  readonly enums: Readonly<
    Record<
      string,
      { readonly name: string; readonly values: readonly string[] }
    >
  >;
}

interface MigrationJournal {
  readonly entries: readonly {
    readonly idx: number;
    readonly tag: string;
  }[];
}

function strings(values: readonly string[]): string[] {
  return [...values];
}

describe('database enum ownership', () => {
  test('registers every PostgreSQL enum through the contract-derived helper', () => {
    const registered = listContractDerivedDatabaseEnums();
    expect(registered.map((value) => value.enumName).sort()).toEqual(
      enumExpectations.map(([value]) => value.enumName).sort(),
    );
    const schemaSource = readFileSync(
      new URL('./schema/enums.ts', import.meta.url),
      'utf8',
    );
    expect(schemaSource.match(/\bpgEnum\(/gu)).toHaveLength(1);
  });

  test('every schema enum is derived from its contracts vocabulary', () => {
    for (const [databaseEnum, contractValues] of enumExpectations) {
      expect(strings(databaseEnum.enumValues)).toEqual(strings(contractValues));
    }
  });

  test('the journal-selected latest snapshot matches every enum', () => {
    const journal = JSON.parse(
      readFileSync(
        new URL('../drizzle/migrations/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as MigrationJournal;
    const latest = journal.entries.at(-1);
    if (latest === undefined) throw new Error('Migration journal is empty.');
    const snapshot = JSON.parse(
      readFileSync(
        new URL(
          `../drizzle/migrations/meta/${String(latest.idx).padStart(4, '0')}_snapshot.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    ) as MigrationSnapshot;

    for (const [databaseEnum] of enumExpectations) {
      const persisted = snapshot.enums[`public.${databaseEnum.enumName}`];
      expect(persisted?.name).toBe(databaseEnum.enumName);
      expect(persisted?.values).toEqual(strings(databaseEnum.enumValues));
    }
  });

  test('the latest capability retirement migration matches derived IDs', () => {
    const migration = readFileSync(
      new URL(
        '../drizzle/migrations/0030_retire_audience_configurations.sql',
        import.meta.url,
      ),
      'utf8',
    );
    for (const databaseEnum of [
      agentCapabilityGrantEnum,
      mutationCapabilityEnum,
    ]) {
      const expression = new RegExp(
        `CREATE TYPE "public"\\."${databaseEnum.enumName}" AS ENUM\\(([^;]+)\\);`,
        'gu',
      );
      const declarations = [...migration.matchAll(expression)];
      expect(declarations).toHaveLength(1);
      const declaration = declarations[0]?.[1] ?? '';
      const values = [...declaration.matchAll(/'([^']+)'/gu)].map(
        (match) => match[1],
      );
      expect(values).toEqual(strings(databaseEnum.enumValues));
    }
  });
});
