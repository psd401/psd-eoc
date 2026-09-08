import { relations } from 'drizzle-orm';

import * as schema from './schema';

/** Navigable district configuration graph. */
export const facilitiesRelations = relations(schema.facilities, ({ many }) => ({
  neighborhoodMemberships: many(schema.neighborhoodFacilities),
  groupSources: many(schema.groupSources),
  userFacilityScopes: many(schema.userFacilityScopes),
  rosterSourceConfigurationFacilities: many(
    schema.rosterSourceConfigurationFacilities,
  ),
  rosterSnapshotFacilities: many(schema.rosterSnapshotFacilities),
  events: many(schema.events),
  activationPreviews: many(schema.activationPreviews),
}));

export const securityAuditFacilityAnchorsRelations = relations(
  schema.securityAuditFacilityAnchors,
  ({ many }) => ({
    securityAuditEntries: many(schema.securityAuditEntries),
  }),
);

export const neighborhoodVersionsRelations = relations(
  schema.neighborhoodVersions,
  ({ many }) => ({
    facilities: many(schema.neighborhoodFacilities),
  }),
);

export const neighborhoodFacilitiesRelations = relations(
  schema.neighborhoodFacilities,
  ({ one }) => ({
    neighborhoodVersion: one(schema.neighborhoodVersions, {
      fields: [
        schema.neighborhoodFacilities.neighborhoodId,
        schema.neighborhoodFacilities.neighborhoodVersion,
      ],
      references: [
        schema.neighborhoodVersions.id,
        schema.neighborhoodVersions.version,
      ],
    }),
    facility: one(schema.facilities, {
      fields: [schema.neighborhoodFacilities.facilityId],
      references: [schema.facilities.id],
    }),
  }),
);

export const groupSourcesRelations = relations(
  schema.groupSources,
  ({ one, many }) => ({
    facility: one(schema.facilities, {
      fields: [schema.groupSources.facilityId],
      references: [schema.facilities.id],
    }),
    rosterSourceConfigurationGroups: many(
      schema.rosterSourceConfigurationGroups,
    ),
    rosterSnapshotSources: many(schema.rosterSnapshotSources),
    rosterRecipientGroupSources: many(schema.rosterRecipientGroupSources),
    rosterSyncResultSources: many(schema.rosterSyncResultSources),
    rosterSyncGroupFailures: many(schema.rosterSyncGroupFailures),
  }),
);

/** Navigable staff identity, access evidence, session, and agent-key graph. */
export const usersRelations = relations(schema.users, ({ many }) => ({
  roles: many(schema.userRoles),
  roleChanges: many(schema.userRoleChanges, {
    relationName: 'userRoleChangeTarget',
  }),
  roleChangesMade: many(schema.userRoleChanges, {
    relationName: 'userRoleChangeChanger',
  }),
  facilityScopes: many(schema.userFacilityScopes),
  deviceEnrollments: many(schema.deviceEnrollments),
  issuedAgentApiKeys: many(schema.agentApiKeys),
  agentApiKeyRevocations: many(schema.agentApiKeyRevocations),
  humanConfirmationRecords: many(schema.humanConfirmationRecords),
}));

export const userRolesRelations = relations(schema.userRoles, ({ one }) => ({
  user: one(schema.users, {
    fields: [schema.userRoles.userId],
    references: [schema.users.id],
  }),
}));

export const userRoleChangesRelations = relations(
  schema.userRoleChanges,
  ({ one }) => ({
    user: one(schema.users, {
      fields: [schema.userRoleChanges.userId],
      references: [schema.users.id],
      relationName: 'userRoleChangeTarget',
    }),
    changedBy: one(schema.users, {
      fields: [schema.userRoleChanges.changedByUserId],
      references: [schema.users.id],
      relationName: 'userRoleChangeChanger',
    }),
    changedWithSession: one(schema.sessions, {
      fields: [schema.userRoleChanges.changedWithSessionId],
      references: [schema.sessions.id],
    }),
  }),
);

export const userFacilityScopesRelations = relations(
  schema.userFacilityScopes,
  ({ one }) => ({
    user: one(schema.users, {
      fields: [schema.userFacilityScopes.userId],
      references: [schema.users.id],
    }),
    facility: one(schema.facilities, {
      fields: [schema.userFacilityScopes.facilityId],
      references: [schema.facilities.id],
    }),
  }),
);

export const deviceEnrollmentsRelations = relations(
  schema.deviceEnrollments,
  ({ one, many }) => ({
    user: one(schema.users, {
      fields: [schema.deviceEnrollments.userId],
      references: [schema.users.id],
    }),
    sessions: many(schema.sessions),
    pushTokenRegistrations: many(schema.devicePushTokenRegistrations),
  }),
);

export const accessMembershipSnapshotsRelations = relations(
  schema.accessMembershipSnapshots,
  ({ many }) => ({
    sessions: many(schema.sessions),
  }),
);

export const agentApiKeysRelations = relations(
  schema.agentApiKeys,
  ({ one, many }) => ({
    agent: one(schema.agents, {
      fields: [schema.agentApiKeys.agentId],
      references: [schema.agents.id],
    }),
    issuedBy: one(schema.users, {
      fields: [schema.agentApiKeys.issuedByUserId],
      references: [schema.users.id],
    }),
    facilities: many(schema.agentApiKeyFacilities),
    grants: many(schema.agentApiKeyGrants),
    revocations: many(schema.agentApiKeyRevocations),
  }),
);

export const agentApiKeyFacilitiesRelations = relations(
  schema.agentApiKeyFacilities,
  ({ one }) => ({
    apiKey: one(schema.agentApiKeys, {
      fields: [schema.agentApiKeyFacilities.apiKeyId],
      references: [schema.agentApiKeys.id],
    }),
    facility: one(schema.facilities, {
      fields: [schema.agentApiKeyFacilities.facilityId],
      references: [schema.facilities.id],
    }),
  }),
);

export const agentApiKeyGrantsRelations = relations(
  schema.agentApiKeyGrants,
  ({ one }) => ({
    apiKey: one(schema.agentApiKeys, {
      fields: [schema.agentApiKeyGrants.apiKeyId],
      references: [schema.agentApiKeys.id],
    }),
  }),
);

export const agentApiKeyRevocationsRelations = relations(
  schema.agentApiKeyRevocations,
  ({ one }) => ({
    apiKey: one(schema.agentApiKeys, {
      fields: [schema.agentApiKeyRevocations.apiKeyId],
      references: [schema.agentApiKeys.id],
    }),
    revokedBy: one(schema.users, {
      fields: [schema.agentApiKeyRevocations.revokedByUserId],
      references: [schema.users.id],
    }),
  }),
);

/** Navigable immutable roster graph. */
export const rosterSourceConfigurationsRelations = relations(
  schema.rosterSourceConfigurations,
  ({ many }) => ({
    facilities: many(schema.rosterSourceConfigurationFacilities),
    groupSources: many(schema.rosterSourceConfigurationGroups),
    snapshots: many(schema.rosterSnapshots),
    syncResults: many(schema.rosterSyncResults),
  }),
);

export const rosterSourceConfigurationFacilitiesRelations = relations(
  schema.rosterSourceConfigurationFacilities,
  ({ one }) => ({
    configuration: one(schema.rosterSourceConfigurations, {
      fields: [
        schema.rosterSourceConfigurationFacilities.configurationId,
        schema.rosterSourceConfigurationFacilities.configurationVersion,
      ],
      references: [
        schema.rosterSourceConfigurations.id,
        schema.rosterSourceConfigurations.version,
      ],
    }),
    facility: one(schema.facilities, {
      fields: [schema.rosterSourceConfigurationFacilities.facilityId],
      references: [schema.facilities.id],
    }),
  }),
);

export const rosterSourceConfigurationGroupsRelations = relations(
  schema.rosterSourceConfigurationGroups,
  ({ one }) => ({
    configuration: one(schema.rosterSourceConfigurations, {
      fields: [
        schema.rosterSourceConfigurationGroups.configurationId,
        schema.rosterSourceConfigurationGroups.configurationVersion,
      ],
      references: [
        schema.rosterSourceConfigurations.id,
        schema.rosterSourceConfigurations.version,
      ],
    }),
    groupSource: one(schema.groupSources, {
      fields: [schema.rosterSourceConfigurationGroups.groupSourceId],
      references: [schema.groupSources.id],
    }),
  }),
);

export const rosterSnapshotsRelations = relations(
  schema.rosterSnapshots,
  ({ one, many }) => ({
    sourceConfiguration: one(schema.rosterSourceConfigurations, {
      fields: [
        schema.rosterSnapshots.sourceConfigurationId,
        schema.rosterSnapshots.sourceConfigurationVersion,
      ],
      references: [
        schema.rosterSourceConfigurations.id,
        schema.rosterSourceConfigurations.version,
      ],
    }),
    facilities: many(schema.rosterSnapshotFacilities),
    sources: many(schema.rosterSnapshotSources),
    recipients: many(schema.rosterRecipients),
    events: many(schema.events),
    activationPreviews: many(schema.activationPreviews),
    lifecycleConsequencePreviews: many(schema.lifecycleConsequencePreviews),
    notificationIntents: many(schema.notificationIntents),
    outboxRecords: many(schema.outbox),
    dispatchBatches: many(schema.dispatchBatches),
    channelAttempts: many(schema.channelAttempts),
    publishedBySyncResults: many(schema.rosterSyncResults),
  }),
);

export const rosterSnapshotFacilitiesRelations = relations(
  schema.rosterSnapshotFacilities,
  ({ one }) => ({
    snapshot: one(schema.rosterSnapshots, {
      fields: [schema.rosterSnapshotFacilities.rosterSnapshotId],
      references: [schema.rosterSnapshots.id],
    }),
    facility: one(schema.facilities, {
      fields: [schema.rosterSnapshotFacilities.facilityId],
      references: [schema.facilities.id],
    }),
  }),
);

export const rosterSnapshotSourcesRelations = relations(
  schema.rosterSnapshotSources,
  ({ one }) => ({
    snapshot: one(schema.rosterSnapshots, {
      fields: [schema.rosterSnapshotSources.rosterSnapshotId],
      references: [schema.rosterSnapshots.id],
    }),
    groupSource: one(schema.groupSources, {
      fields: [schema.rosterSnapshotSources.groupSourceId],
      references: [schema.groupSources.id],
    }),
  }),
);

export const rosterSyncResultsRelations = relations(
  schema.rosterSyncResults,
  ({ one, many }) => ({
    sourceConfiguration: one(schema.rosterSourceConfigurations, {
      fields: [
        schema.rosterSyncResults.sourceConfigurationId,
        schema.rosterSyncResults.sourceConfigurationVersion,
      ],
      references: [
        schema.rosterSourceConfigurations.id,
        schema.rosterSourceConfigurations.version,
      ],
    }),
    publishedSnapshot: one(schema.rosterSnapshots, {
      fields: [schema.rosterSyncResults.publishedSnapshotId],
      references: [schema.rosterSnapshots.id],
    }),
    sources: many(schema.rosterSyncResultSources),
    groupFailures: many(schema.rosterSyncGroupFailures),
  }),
);

export const rosterSyncResultSourcesRelations = relations(
  schema.rosterSyncResultSources,
  ({ one, many }) => ({
    syncResult: one(schema.rosterSyncResults, {
      fields: [schema.rosterSyncResultSources.syncResultId],
      references: [schema.rosterSyncResults.id],
    }),
    groupSource: one(schema.groupSources, {
      fields: [schema.rosterSyncResultSources.groupSourceId],
      references: [schema.groupSources.id],
    }),
    expectedSource: one(schema.rosterSyncResultSources, {
      fields: [
        schema.rosterSyncResultSources.syncResultId,
        schema.rosterSyncResultSources.population,
        schema.rosterSyncResultSources.groupSourceId,
        schema.rosterSyncResultSources.groupSourceKind,
        schema.rosterSyncResultSources.groupPurpose,
        schema.rosterSyncResultSources.expectedSetKind,
      ],
      references: [
        schema.rosterSyncResultSources.syncResultId,
        schema.rosterSyncResultSources.population,
        schema.rosterSyncResultSources.groupSourceId,
        schema.rosterSyncResultSources.groupSourceKind,
        schema.rosterSyncResultSources.groupPurpose,
        schema.rosterSyncResultSources.setKind,
      ],
      relationName: 'rosterSyncExpectedSource',
    }),
    completedSources: many(schema.rosterSyncResultSources, {
      relationName: 'rosterSyncExpectedSource',
    }),
    groupFailures: many(schema.rosterSyncGroupFailures),
  }),
);

export const rosterSyncGroupFailuresRelations = relations(
  schema.rosterSyncGroupFailures,
  ({ one }) => ({
    syncResult: one(schema.rosterSyncResults, {
      fields: [schema.rosterSyncGroupFailures.syncResultId],
      references: [schema.rosterSyncResults.id],
    }),
    groupSource: one(schema.groupSources, {
      fields: [schema.rosterSyncGroupFailures.groupSourceId],
      references: [schema.groupSources.id],
    }),
    expectedSource: one(schema.rosterSyncResultSources, {
      fields: [
        schema.rosterSyncGroupFailures.syncResultId,
        schema.rosterSyncGroupFailures.population,
        schema.rosterSyncGroupFailures.groupSourceId,
        schema.rosterSyncGroupFailures.groupSourceKind,
        schema.rosterSyncGroupFailures.groupPurpose,
        schema.rosterSyncGroupFailures.expectedSetKind,
      ],
      references: [
        schema.rosterSyncResultSources.syncResultId,
        schema.rosterSyncResultSources.population,
        schema.rosterSyncResultSources.groupSourceId,
        schema.rosterSyncResultSources.groupSourceKind,
        schema.rosterSyncResultSources.groupPurpose,
        schema.rosterSyncResultSources.setKind,
      ],
    }),
  }),
);

export const rosterRecipientsRelations = relations(
  schema.rosterRecipients,
  ({ one, many }) => ({
    snapshot: one(schema.rosterSnapshots, {
      fields: [schema.rosterRecipients.rosterSnapshotId],
      references: [schema.rosterSnapshots.id],
    }),
    groupSources: many(schema.rosterRecipientGroupSources),
    endpoints: many(schema.rosterEndpoints),
    attempts: many(schema.channelAttempts),
    endpointStatusRecords: many(schema.endpointStatusRecords),
    smsOptOutRecords: many(schema.smsOptOutRecords),
  }),
);

export const rosterRecipientGroupSourcesRelations = relations(
  schema.rosterRecipientGroupSources,
  ({ one }) => ({
    recipient: one(schema.rosterRecipients, {
      fields: [
        schema.rosterRecipientGroupSources.rosterSnapshotId,
        schema.rosterRecipientGroupSources.recipientId,
      ],
      references: [
        schema.rosterRecipients.rosterSnapshotId,
        schema.rosterRecipients.id,
      ],
    }),
    groupSource: one(schema.groupSources, {
      fields: [schema.rosterRecipientGroupSources.groupSourceId],
      references: [schema.groupSources.id],
    }),
  }),
);

export const rosterEndpointsRelations = relations(
  schema.rosterEndpoints,
  ({ one, many }) => ({
    recipient: one(schema.rosterRecipients, {
      fields: [
        schema.rosterEndpoints.rosterSnapshotId,
        schema.rosterEndpoints.recipientId,
      ],
      references: [
        schema.rosterRecipients.rosterSnapshotId,
        schema.rosterRecipients.id,
      ],
    }),
    attempts: many(schema.channelAttempts),
    statusRecords: many(schema.endpointStatusRecords),
    smsOptOutRecords: many(schema.smsOptOutRecords),
  }),
);

/** Navigable event-type, lifecycle, media, and operational journal graph. */
export const eventTypesRelations = relations(schema.eventTypes, ({ many }) => ({
  versions: many(schema.eventTypeVersions),
  drafts: many(schema.eventTypeVersionDrafts),
}));

export const eventTypeVersionsRelations = relations(
  schema.eventTypeVersions,
  ({ one, many }) => ({
    eventType: one(schema.eventTypes, {
      fields: [schema.eventTypeVersions.eventTypeId],
      references: [schema.eventTypes.id],
    }),
    supersedes: one(schema.eventTypeVersions, {
      fields: [schema.eventTypeVersions.supersedesVersionId],
      references: [schema.eventTypeVersions.id],
      relationName: 'eventTypeVersionSupersession',
    }),
    supersededBy: many(schema.eventTypeVersions, {
      relationName: 'eventTypeVersionSupersession',
    }),
    templates: many(schema.eventTypeTemplates),
    activationPreviews: many(schema.activationPreviews),
    events: many(schema.events),
    lifecycleConsequencePreviews: many(schema.lifecycleConsequencePreviews),
    notificationIntents: many(schema.notificationIntents),
    outboxRecords: many(schema.outbox),
    dispatchBatches: many(schema.dispatchBatches),
    channelAttempts: many(schema.channelAttempts),
  }),
);

export const eventTypeTemplatesRelations = relations(
  schema.eventTypeTemplates,
  ({ one }) => ({
    eventTypeVersion: one(schema.eventTypeVersions, {
      fields: [schema.eventTypeTemplates.eventTypeVersionId],
      references: [schema.eventTypeVersions.id],
    }),
  }),
);

export const eventTypeVersionDraftsRelations = relations(
  schema.eventTypeVersionDrafts,
  ({ one, many }) => ({
    eventType: one(schema.eventTypes, {
      fields: [schema.eventTypeVersionDrafts.eventTypeId],
      references: [schema.eventTypes.id],
    }),
    templates: many(schema.eventTypeDraftTemplates),
  }),
);

export const eventTypeDraftTemplatesRelations = relations(
  schema.eventTypeDraftTemplates,
  ({ one }) => ({
    draft: one(schema.eventTypeVersionDrafts, {
      fields: [schema.eventTypeDraftTemplates.eventTypeVersionDraftId],
      references: [schema.eventTypeVersionDrafts.id],
    }),
  }),
);

export const activationPreviewsRelations = relations(
  schema.activationPreviews,
  ({ one, many }) => ({
    facility: one(schema.facilities, {
      fields: [schema.activationPreviews.facilityId],
      references: [schema.facilities.id],
    }),
    eventTypeVersion: one(schema.eventTypeVersions, {
      fields: [schema.activationPreviews.eventTypeVersionId],
      references: [schema.eventTypeVersions.id],
    }),
    rosterSnapshot: one(schema.rosterSnapshots, {
      fields: [schema.activationPreviews.rosterSnapshotId],
      references: [schema.rosterSnapshots.id],
    }),
    preparedActivations: many(schema.preparedActivations),
  }),
);

export const preparedActivationsRelations = relations(
  schema.preparedActivations,
  ({ one, many }) => ({
    preview: one(schema.activationPreviews, {
      fields: [schema.preparedActivations.activationPreviewId],
      references: [schema.activationPreviews.id],
    }),
    consumptions: many(schema.preparedActivationConsumptions),
  }),
);

export const eventsRelations = relations(schema.events, ({ one, many }) => ({
  facility: one(schema.facilities, {
    fields: [schema.events.facilityId],
    references: [schema.facilities.id],
  }),
  eventTypeVersion: one(schema.eventTypeVersions, {
    fields: [schema.events.eventTypeVersionId],
    references: [schema.eventTypeVersions.id],
  }),
  rosterSnapshot: one(schema.rosterSnapshots, {
    fields: [schema.events.rosterSnapshotId],
    references: [schema.rosterSnapshots.id],
  }),
  correctionOf: one(schema.events, {
    fields: [schema.events.correctionOfEventId],
    references: [schema.events.id],
    relationName: 'eventCorrection',
  }),
  corrections: many(schema.events, { relationName: 'eventCorrection' }),
  lifecyclePreviews: many(schema.lifecycleConsequencePreviews),
  transitions: many(schema.eventTransitions, {
    relationName: 'eventTransitionEvent',
  }),
  correctionSourceTransitions: many(schema.eventTransitions, {
    relationName: 'eventTransitionSource',
  }),
  correctionResultTransitions: many(schema.eventTransitions, {
    relationName: 'eventTransitionCorrection',
  }),
  preparedActivationConsumptions: many(schema.preparedActivationConsumptions),
  mediaUploadIntents: many(schema.mediaUploadIntents),
  mediaRecords: many(schema.mediaRecords),
  journalEntries: many(schema.journalEntries),
  notificationIntents: many(schema.notificationIntents),
  outboxRecords: many(schema.outbox),
  dispatchBatches: many(schema.dispatchBatches),
  channelAttempts: many(schema.channelAttempts),
}));

export const lifecycleConsequencePreviewsRelations = relations(
  schema.lifecycleConsequencePreviews,
  ({ one }) => ({
    event: one(schema.events, {
      fields: [schema.lifecycleConsequencePreviews.eventId],
      references: [schema.events.id],
    }),
    eventTypeVersion: one(schema.eventTypeVersions, {
      fields: [schema.lifecycleConsequencePreviews.eventTypeVersionId],
      references: [schema.eventTypeVersions.id],
    }),
    rosterSnapshot: one(schema.rosterSnapshots, {
      fields: [schema.lifecycleConsequencePreviews.rosterSnapshotId],
      references: [schema.rosterSnapshots.id],
    }),
  }),
);

export const eventTransitionsRelations = relations(
  schema.eventTransitions,
  ({ one, many }) => ({
    event: one(schema.events, {
      fields: [schema.eventTransitions.eventId],
      references: [schema.events.id],
      relationName: 'eventTransitionEvent',
    }),
    sourceEvent: one(schema.events, {
      fields: [schema.eventTransitions.sourceEventId],
      references: [schema.events.id],
      relationName: 'eventTransitionSource',
    }),
    correctionEvent: one(schema.events, {
      fields: [schema.eventTransitions.correctionEventId],
      references: [schema.events.id],
      relationName: 'eventTransitionCorrection',
    }),
    confirmation: one(schema.humanConfirmationRecords, {
      fields: [schema.eventTransitions.confirmationId],
      references: [schema.humanConfirmationRecords.id],
    }),
    journalEntries: many(schema.journalEntries),
  }),
);

export const preparedActivationConsumptionsRelations = relations(
  schema.preparedActivationConsumptions,
  ({ one }) => ({
    preparedActivation: one(schema.preparedActivations, {
      fields: [schema.preparedActivationConsumptions.preparedActivationId],
      references: [schema.preparedActivations.id],
    }),
    event: one(schema.events, {
      fields: [schema.preparedActivationConsumptions.eventId],
      references: [schema.events.id],
    }),
  }),
);

export const mediaUploadIntentsRelations = relations(
  schema.mediaUploadIntents,
  ({ one, many }) => ({
    event: one(schema.events, {
      fields: [schema.mediaUploadIntents.eventId],
      references: [schema.events.id],
    }),
    mediaRecords: many(schema.mediaRecords),
  }),
);

export const mediaRecordsRelations = relations(
  schema.mediaRecords,
  ({ one, many }) => ({
    uploadIntent: one(schema.mediaUploadIntents, {
      fields: [schema.mediaRecords.uploadIntentId],
      references: [schema.mediaUploadIntents.id],
    }),
    event: one(schema.events, {
      fields: [schema.mediaRecords.eventId],
      references: [schema.events.id],
    }),
    journalEntries: many(schema.journalEntries),
  }),
);

export const journalEntriesRelations = relations(
  schema.journalEntries,
  ({ one, many }) => ({
    event: one(schema.events, {
      fields: [schema.journalEntries.eventId],
      references: [schema.events.id],
    }),
    media: one(schema.mediaRecords, {
      fields: [schema.journalEntries.mediaId],
      references: [schema.mediaRecords.id],
    }),
    transition: one(schema.eventTransitions, {
      fields: [schema.journalEntries.transitionId],
      references: [schema.eventTransitions.id],
    }),
    supersedes: one(schema.journalEntries, {
      fields: [schema.journalEntries.supersedesEntryId],
      references: [schema.journalEntries.id],
      relationName: 'journalSupersession',
    }),
    supersededBy: many(schema.journalEntries, {
      relationName: 'journalSupersession',
    }),
  }),
);

/** Navigable notification, outbox, attempt, and evidence graph. */
export const notificationIntentsRelations = relations(
  schema.notificationIntents,
  ({ one, many }) => ({
    event: one(schema.events, {
      fields: [schema.notificationIntents.eventId],
      references: [schema.events.id],
    }),
    eventTypeVersion: one(schema.eventTypeVersions, {
      fields: [schema.notificationIntents.eventTypeVersionId],
      references: [schema.eventTypeVersions.id],
    }),
    rosterSnapshot: one(schema.rosterSnapshots, {
      fields: [schema.notificationIntents.rosterSnapshotId],
      references: [schema.rosterSnapshots.id],
    }),
    channels: many(schema.notificationIntentChannels),
    outboxRecords: many(schema.outbox),
    dispatchBatches: many(schema.dispatchBatches),
    attempts: many(schema.channelAttempts),
    deliveryEvidence: many(schema.deliveryEvidence),
  }),
);

export const notificationIntentChannelsRelations = relations(
  schema.notificationIntentChannels,
  ({ one }) => ({
    intent: one(schema.notificationIntents, {
      fields: [schema.notificationIntentChannels.intentId],
      references: [schema.notificationIntents.id],
    }),
  }),
);

export const outboxRelations = relations(schema.outbox, ({ one, many }) => ({
  intent: one(schema.notificationIntents, {
    fields: [schema.outbox.intentId],
    references: [schema.notificationIntents.id],
  }),
  event: one(schema.events, {
    fields: [schema.outbox.eventId],
    references: [schema.events.id],
  }),
  eventTypeVersion: one(schema.eventTypeVersions, {
    fields: [schema.outbox.eventTypeVersionId],
    references: [schema.eventTypeVersions.id],
  }),
  rosterSnapshot: one(schema.rosterSnapshots, {
    fields: [schema.outbox.rosterSnapshotId],
    references: [schema.rosterSnapshots.id],
  }),
  dispatchBatches: many(schema.dispatchBatches),
}));

export const dispatchBatchesRelations = relations(
  schema.dispatchBatches,
  ({ one, many }) => ({
    outboxRecord: one(schema.outbox, {
      fields: [schema.dispatchBatches.outboxId],
      references: [schema.outbox.id],
    }),
    intent: one(schema.notificationIntents, {
      fields: [schema.dispatchBatches.intentId],
      references: [schema.notificationIntents.id],
    }),
    event: one(schema.events, {
      fields: [schema.dispatchBatches.eventId],
      references: [schema.events.id],
    }),
    eventTypeVersion: one(schema.eventTypeVersions, {
      fields: [schema.dispatchBatches.eventTypeVersionId],
      references: [schema.eventTypeVersions.id],
    }),
    rosterSnapshot: one(schema.rosterSnapshots, {
      fields: [schema.dispatchBatches.rosterSnapshotId],
      references: [schema.rosterSnapshots.id],
    }),
    attempts: many(schema.channelAttempts),
  }),
);

export const channelAttemptsRelations = relations(
  schema.channelAttempts,
  ({ one, many }) => ({
    batch: one(schema.dispatchBatches, {
      fields: [schema.channelAttempts.batchId],
      references: [schema.dispatchBatches.id],
    }),
    intent: one(schema.notificationIntents, {
      fields: [schema.channelAttempts.intentId],
      references: [schema.notificationIntents.id],
    }),
    event: one(schema.events, {
      fields: [schema.channelAttempts.eventId],
      references: [schema.events.id],
    }),
    eventTypeVersion: one(schema.eventTypeVersions, {
      fields: [schema.channelAttempts.eventTypeVersionId],
      references: [schema.eventTypeVersions.id],
    }),
    rosterSnapshot: one(schema.rosterSnapshots, {
      fields: [schema.channelAttempts.rosterSnapshotId],
      references: [schema.rosterSnapshots.id],
    }),
    recipient: one(schema.rosterRecipients, {
      fields: [
        schema.channelAttempts.rosterSnapshotId,
        schema.channelAttempts.recipientId,
      ],
      references: [
        schema.rosterRecipients.rosterSnapshotId,
        schema.rosterRecipients.id,
      ],
    }),
    endpoint: one(schema.rosterEndpoints, {
      fields: [
        schema.channelAttempts.rosterSnapshotId,
        schema.channelAttempts.endpointId,
      ],
      references: [
        schema.rosterEndpoints.rosterSnapshotId,
        schema.rosterEndpoints.id,
      ],
    }),
    deliveryEvidence: many(schema.deliveryEvidence),
  }),
);

export const deliveryEvidenceRelations = relations(
  schema.deliveryEvidence,
  ({ one, many }) => ({
    intent: one(schema.notificationIntents, {
      fields: [schema.deliveryEvidence.intentId],
      references: [schema.notificationIntents.id],
    }),
    attempt: one(schema.channelAttempts, {
      fields: [schema.deliveryEvidence.attemptId],
      references: [schema.channelAttempts.id],
    }),
    previousEvidence: one(schema.deliveryEvidence, {
      fields: [schema.deliveryEvidence.previousEvidenceId],
      references: [schema.deliveryEvidence.id],
      relationName: 'deliveryEvidenceChain',
    }),
    nextEvidence: many(schema.deliveryEvidence, {
      relationName: 'deliveryEvidenceChain',
    }),
  }),
);

export const endpointStatusRecordsRelations = relations(
  schema.endpointStatusRecords,
  ({ one }) => ({
    recipient: one(schema.rosterRecipients, {
      fields: [
        schema.endpointStatusRecords.rosterSnapshotId,
        schema.endpointStatusRecords.recipientId,
      ],
      references: [
        schema.rosterRecipients.rosterSnapshotId,
        schema.rosterRecipients.id,
      ],
    }),
    endpoint: one(schema.rosterEndpoints, {
      fields: [
        schema.endpointStatusRecords.rosterSnapshotId,
        schema.endpointStatusRecords.endpointId,
      ],
      references: [
        schema.rosterEndpoints.rosterSnapshotId,
        schema.rosterEndpoints.id,
      ],
    }),
  }),
);

export const smsOptOutRecordsRelations = relations(
  schema.smsOptOutRecords,
  ({ one }) => ({
    recipient: one(schema.rosterRecipients, {
      fields: [
        schema.smsOptOutRecords.rosterSnapshotId,
        schema.smsOptOutRecords.recipientId,
      ],
      references: [
        schema.rosterRecipients.rosterSnapshotId,
        schema.rosterRecipients.id,
      ],
    }),
    endpoint: one(schema.rosterEndpoints, {
      fields: [
        schema.smsOptOutRecords.rosterSnapshotId,
        schema.smsOptOutRecords.endpointId,
      ],
      references: [
        schema.rosterEndpoints.rosterSnapshotId,
        schema.rosterEndpoints.id,
      ],
    }),
  }),
);

export const securityAuditEntriesRelations = relations(
  schema.securityAuditEntries,
  ({ one }) => ({
    facilityAnchor: one(schema.securityAuditFacilityAnchors, {
      fields: [schema.securityAuditEntries.facilityId],
      references: [schema.securityAuditFacilityAnchors.facilityId],
    }),
    confirmation: one(schema.humanConfirmationRecords, {
      fields: [schema.securityAuditEntries.confirmationId],
      references: [schema.humanConfirmationRecords.id],
    }),
  }),
);
