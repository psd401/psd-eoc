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

function declaredEnumValues(source: string, enumName: string): string[] {
  const expression = new RegExp(
    `CREATE TYPE "public"\\."${enumName}" AS ENUM\\(([^;]+)\\);`,
    'gu',
  );
  const declarations = [...source.matchAll(expression)];
  expect(declarations).toHaveLength(1);
  const declaration = declarations[0]?.[1] ?? '';
  return [...declaration.matchAll(/'([^']+)'/gu)].map((match) => {
    const value = match[1];
    if (value === undefined) throw new Error(`Invalid ${enumName} value.`);
    return value;
  });
}

function applyEnumAdditions(
  values: string[],
  source: string,
  enumName: string,
): void {
  const expression = new RegExp(
    `ALTER TYPE "public"\\."${enumName}" ADD VALUE(?: IF NOT EXISTS)? '([^']+)'(?: (BEFORE|AFTER) '([^']+)')?;`,
    'gu',
  );
  for (const match of source.matchAll(expression)) {
    const value = match[1];
    if (value === undefined || values.includes(value)) continue;
    const placement = match[2];
    const anchor = match[3];
    if (placement === undefined || anchor === undefined) {
      values.push(value);
      continue;
    }
    const anchorIndex = values.indexOf(anchor);
    if (anchorIndex === -1) {
      throw new Error(
        `Migration adds ${value} ${placement} missing ${enumName} value ${anchor}.`,
      );
    }
    values.splice(anchorIndex + (placement === 'AFTER' ? 1 : 0), 0, value);
  }
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

  test('the forward capability migration chain matches derived IDs', () => {
    const retirementTag = '0030_retire_audience_configurations';
    const journal = JSON.parse(
      readFileSync(
        new URL('../drizzle/migrations/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as MigrationJournal;
    const retirementIndex = journal.entries.findIndex(
      ({ tag }) => tag === retirementTag,
    );
    expect(retirementIndex).not.toBe(-1);
    const retirementMigration = readFileSync(
      new URL(`../drizzle/migrations/${retirementTag}.sql`, import.meta.url),
      'utf8',
    );
    for (const databaseEnum of [
      agentCapabilityGrantEnum,
      mutationCapabilityEnum,
    ]) {
      const values = declaredEnumValues(
        retirementMigration,
        databaseEnum.enumName,
      );
      for (const { tag } of journal.entries.slice(retirementIndex + 1)) {
        const migration = readFileSync(
          new URL(`../drizzle/migrations/${tag}.sql`, import.meta.url),
          'utf8',
        );
        applyEnumAdditions(values, migration, databaseEnum.enumName);
      }
      expect(values).toEqual(strings(databaseEnum.enumValues));
    }
  });
});
