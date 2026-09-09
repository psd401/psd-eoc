import {
  EventTypeVersionSchema,
  UuidSchema,
  type MessageTemplateCatalog,
  type NotificationPurpose,
} from '@psd-eoc/contracts';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  createDatabaseClient,
  readDatabaseConfig,
  type PostgresDatabase,
} from '../../db/client';
import {
  eventTypes,
  eventTypeTemplates,
  eventTypeVersions,
  users,
} from '../../db/schema';
import { loadEffectiveAdministratorUserIds } from '../../lib/auth/role-state';
import { loadMessageTemplateSet } from '../../lib/capabilities/notification-wording';
import {
  defaultMessageTemplateCatalog,
  templateCatalogWording,
} from '../../lib/notify/default-templates';
import { describeFailure } from './failure-diagnostics';

/**
 * Publishes the default message wording as a new version of every response
 * type whose current version says something else.
 *
 * The wording an event type carries is immutable per version, and events pin
 * the version they used, so a change is always a superseding version: same
 * identity, name, description, and enabled state, one higher version number,
 * the previous version recorded as superseded. A type whose current version
 * already carries the default wording is left alone, so the script can run
 * again without effect.
 *
 * The contract lets a system actor publish only the reviewed initial seed;
 * every later version is a human administrator's publication. This script
 * writes what that administrator would publish from the Responses page, in
 * their name: the approving administrator's user id is required, must name
 * an enabled administrator, and is recorded as both author and approver
 * with the approval reference. A human actor also carries a session id, and
 * a script run has no browser session; the run's own identifier stands in
 * and is reported in the summary, so the record still says which run wrote
 * the version and which administrator answers for it.
 */

const PURPOSES = ['activation', 'all-clear', 'reactivation'] as const;
const CHANNELS = ['push', 'email', 'sms'] as const;

const ApprovalReferenceSchema = z.string().trim().min(1).max(255);

export const DEFAULT_APPROVAL_REFERENCE =
  'psd-eoc-2026-09-09-notification-wording';

/**
 * Roles are never stored: an administrator is a member of an active
 * sign-in group that grants the admin role, read the way every request
 * reads it. The approver must be that, and enabled.
 */
async function requireAdministrator(
  database: PostgresDatabase,
  userId: string,
): Promise<void> {
  const [row] = await database
    .select({ id: users.id, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const administrators = await loadEffectiveAdministratorUserIds(database);
  if (
    row === undefined ||
    row.disabledAt !== null ||
    !administrators.includes(userId)
  ) {
    throw new Error(
      'The approving user must be an enabled administrator on record.',
    );
  }
}

export interface PublishedVersion {
  readonly key: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly enabled: boolean;
}

export interface PublishMessageTemplatesSummary {
  readonly event: 'message-templates-published';
  readonly approvalReference: string;
  readonly approvedByUserId: string;
  /** The run identifier recorded as the publishing actor's session. */
  readonly runSessionId: string;
  readonly published: readonly PublishedVersion[];
  readonly unchanged: readonly string[];
}

async function currentCatalog(
  database: PostgresDatabase,
  versionId: string,
  templateMode: 'real' | 'drill',
): Promise<MessageTemplateCatalog | null> {
  const sets: Partial<
    Record<NotificationPurpose, MessageTemplateCatalog[NotificationPurpose]>
  > = {};
  for (const purpose of PURPOSES) {
    const loaded = await loadMessageTemplateSet(
      database,
      versionId,
      purpose,
      templateMode,
    );
    if (loaded === null) return null;
    sets[purpose] = loaded.templates;
  }
  return sets as MessageTemplateCatalog;
}

export async function publishDefaultMessageTemplates(
  database: PostgresDatabase,
  input: Readonly<{
    approvedByUserId: string;
    approvalReference?: string;
    now?: Date;
  }>,
): Promise<PublishMessageTemplatesSummary> {
  const approvedByUserId = UuidSchema.parse(input.approvedByUserId);
  const approvalReference = ApprovalReferenceSchema.parse(
    input.approvalReference ?? DEFAULT_APPROVAL_REFERENCE,
  );
  const now = input.now ?? new Date();
  const runSessionId = randomUUID();
  return database.transaction(async (transaction) => {
    await requireAdministrator(transaction, approvedByUserId);
    const types = await transaction
      .select({
        id: eventTypes.id,
        key: eventTypes.key,
        templateMode: eventTypes.templateMode,
      })
      .from(eventTypes)
      .orderBy(asc(eventTypes.key));
    const published: PublishedVersion[] = [];
    const unchanged: string[] = [];
    for (const type of types) {
      const versions = await transaction
        .select()
        .from(eventTypeVersions)
        .where(eq(eventTypeVersions.eventTypeId, type.id))
        .orderBy(asc(eventTypeVersions.version));
      const superseded = new Set(
        versions.flatMap((row) =>
          row.supersedesVersionId === null ? [] : [row.supersedesVersionId],
        ),
      );
      const current = versions.filter((row) => !superseded.has(row.id)).at(-1);
      if (current === undefined) {
        throw new Error(`Response type ${type.key} has no current version.`);
      }
      const templates = defaultMessageTemplateCatalog(current.templateMode);
      const existing = await currentCatalog(
        transaction,
        current.id,
        current.templateMode,
      );
      if (
        existing !== null &&
        templateCatalogWording(existing) === templateCatalogWording(templates)
      ) {
        unchanged.push(type.key);
        continue;
      }
      const version = EventTypeVersionSchema.parse({
        id: randomUUID(),
        eventTypeId: current.eventTypeId,
        version: current.version + 1,
        templateMode: current.templateMode,
        name: current.name,
        description: current.description,
        enabled: current.enabled,
        templates,
        supersedesVersionId: current.id,
        createdBy: {
          kind: 'human',
          userId: approvedByUserId,
          sessionId: runSessionId,
        },
        publicationAuthorization: {
          kind: 'human-admin',
          approvedByUserId,
          approvalReference,
        },
        createdAt: now.toISOString(),
      });
      await transaction.insert(eventTypeVersions).values({
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
        createdAt: now,
      });
      await transaction.insert(eventTypeTemplates).values(
        PURPOSES.flatMap((purpose) =>
          CHANNELS.map((channel) => {
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
      published.push({
        key: type.key,
        fromVersion: current.version,
        toVersion: version.version,
        enabled: version.enabled,
      });
    }
    return Object.freeze({
      event: 'message-templates-published' as const,
      approvalReference,
      approvedByUserId,
      runSessionId,
      published: Object.freeze(published),
      unchanged: Object.freeze(unchanged),
    });
  });
}

async function runFromCommandLine(): Promise<void> {
  const connection = createDatabaseClient(readDatabaseConfig());
  if (connection.driver !== 'postgres') {
    throw new Error('Publishing message templates requires PostgreSQL.');
  }
  try {
    const approvedByUserId = process.env.MESSAGE_TEMPLATES_APPROVED_BY_USER_ID;
    if (approvedByUserId === undefined) {
      throw new Error(
        'MESSAGE_TEMPLATES_APPROVED_BY_USER_ID must name the approving administrator.',
      );
    }
    const approvalReference = process.env.MESSAGE_TEMPLATES_APPROVAL_REFERENCE;
    const summary = await publishDefaultMessageTemplates(connection.db, {
      approvedByUserId,
      ...(approvalReference === undefined ? {} : { approvalReference }),
    });
    console.info(JSON.stringify(summary));
  } finally {
    await connection.close();
  }
}

export const PUBLISH_FAILURE_PREFIX = 'Message template publication failed.';

if (import.meta.main) {
  try {
    await runFromCommandLine();
  } catch (error) {
    console.error(describeFailure(PUBLISH_FAILURE_PREFIX, error));
    process.exitCode = 1;
  }
}
