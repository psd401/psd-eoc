import {
  MessageTemplateSetSchema,
  type Actor,
  type ActivationThreat,
  type MessageTemplateSet,
  type NotificationPurpose,
  type TemplateMode,
} from '@psd-eoc/contracts';
import { and, eq } from 'drizzle-orm';

import type { DatabaseQuery, PostgresDatabase } from '../../db/client';
import {
  eventTypeTemplates,
  eventTypeVersions,
  facilities,
} from '../../db/schema';
import type { TemplateRenderVariables } from '../notify/render';
import { resolveActorDisplayName } from './journal-author-names';

/**
 * Composes what staff read for the threat: the catalog name, plus the
 * operator's own words when the threat required a description. A record that
 * predates the catalog names no threat, so the copy says so rather than
 * leaving the sentence dangling.
 */
export function renderedThreatLabel(threat: ActivationThreat | null): string {
  if (threat === null) return 'Not recorded';
  return threat.detail === null
    ? threat.name
    : `${threat.name} — ${threat.detail}`;
}

/**
 * Composes what staff read for the response: the versioned response name,
 * plus the operator's own words when the response required a description.
 */
export function renderedResponseLabel(
  name: string,
  responseDetail: string | null,
): string {
  return responseDetail === null ? name : `${name} — ${responseDetail}`;
}

/**
 * What a preview shows where the time of the action will go. A preview is
 * built before the operator confirms, so the activation's start time and a
 * lifecycle action's time do not exist yet; the payload the workers carry is
 * rendered again at confirmation with the real time (see
 * `notificationVariables`), so no message ever says this.
 */
export const CONFIRMATION_BOUND_TIME_COPY = 'the time you confirm';

/** Shown when an actor has no display name on record; never a real name. */
export const RECORDED_INITIATOR_FALLBACK = 'the recorded initiator';
export const RECORDED_OPERATOR_FALLBACK = 'the recorded operator';

/** What the event itself does not carry and the wording needs. */
export interface NotificationWording {
  readonly templates: MessageTemplateSet;
  readonly facilityName: string;
  readonly eventTypeName: string;
  /** Who started the event; null when the record names nobody. */
  readonly initiatorDisplayName: string | null;
  /** Who performs the action this notification announces. */
  readonly actorDisplayName: string | null;
}

export interface NotificationWordingInput {
  readonly eventTypeVersionId: string;
  readonly templateMode: TemplateMode;
  readonly purpose: NotificationPurpose;
  readonly facilityId: string;
  readonly initiator: Actor;
  readonly actor: Actor;
}

type WordingDatabase = DatabaseQuery | PostgresDatabase;

/**
 * The one template set an event type version holds for a purpose, or null
 * when the version is missing, is of another mode, or the set is incomplete.
 */
export async function loadMessageTemplateSet(
  database: WordingDatabase,
  eventTypeVersionId: string,
  purpose: NotificationPurpose,
  templateMode: TemplateMode,
): Promise<Readonly<{ name: string; templates: MessageTemplateSet }> | null> {
  const [versionRow] = await database
    .select({
      name: eventTypeVersions.name,
      templateMode: eventTypeVersions.templateMode,
    })
    .from(eventTypeVersions)
    .where(eq(eventTypeVersions.id, eventTypeVersionId))
    .limit(1);
  if (versionRow === undefined || versionRow.templateMode !== templateMode) {
    return null;
  }
  const rows = await database
    .select()
    .from(eventTypeTemplates)
    .where(
      and(
        eq(eventTypeTemplates.eventTypeVersionId, eventTypeVersionId),
        eq(eventTypeTemplates.purpose, purpose),
      ),
    );
  const rowFor = (channel: 'push' | 'email' | 'sms') => {
    const matching = rows.filter((row) => row.channel === channel);
    return matching.length === 1 ? matching[0] : undefined;
  };
  const push = rowFor('push');
  const email = rowFor('email');
  const sms = rowFor('sms');
  if (
    push?.title == null ||
    push.body == null ||
    email?.subject == null ||
    email.textBody == null ||
    sms?.body == null
  ) {
    return null;
  }
  const parsed = MessageTemplateSetSchema.safeParse({
    templateMode,
    purpose,
    push: {
      channel: 'push',
      templateMode: push.templateMode,
      purpose: push.purpose,
      classificationMarker: push.classificationMarker,
      title: push.title,
      body: push.body,
    },
    email: {
      channel: 'email',
      templateMode: email.templateMode,
      purpose: email.purpose,
      classificationMarker: email.classificationMarker,
      subject: email.subject,
      textBody: email.textBody,
    },
    sms: {
      channel: 'sms',
      templateMode: sms.templateMode,
      purpose: sms.purpose,
      classificationMarker: sms.classificationMarker,
      body: sms.body,
    },
  });
  return parsed.success
    ? { name: versionRow.name, templates: parsed.data }
    : null;
}

/** Loads everything the wording needs in independent sequential reads. */
export async function loadNotificationWording(
  database: WordingDatabase,
  input: NotificationWordingInput,
): Promise<NotificationWording | null> {
  // The AWS Data API rejects concurrent statements carrying one transaction
  // ID, so these reads stay sequential.
  const [facilityRow] = await database
    .select({ name: facilities.name })
    .from(facilities)
    .where(eq(facilities.id, input.facilityId))
    .limit(1);
  if (facilityRow === undefined) return null;
  const loaded = await loadMessageTemplateSet(
    database,
    input.eventTypeVersionId,
    input.purpose,
    input.templateMode,
  );
  if (loaded === null) return null;
  const initiatorDisplayName = await resolveActorDisplayName(
    database,
    input.initiator,
  );
  const actorDisplayName =
    input.purpose === 'activation'
      ? initiatorDisplayName
      : await resolveActorDisplayName(database, input.actor);
  return Object.freeze({
    templates: loaded.templates,
    facilityName: facilityRow.name,
    eventTypeName: loaded.name,
    initiatorDisplayName,
    actorDisplayName,
  });
}

/**
 * The templates as a preview renders them: the token for the time of the
 * action, which does not exist until confirmation, reads as what it is.
 */
export function confirmationBoundTemplates(
  templates: MessageTemplateSet,
): MessageTemplateSet {
  const token =
    templates.purpose === 'activation' ? '{{startTime}}' : '{{updatedAt}}';
  const bind = (text: string) =>
    text.replaceAll(token, CONFIRMATION_BOUND_TIME_COPY);
  return Object.freeze({
    ...templates,
    push: Object.freeze({
      ...templates.push,
      title: bind(templates.push.title),
      body: bind(templates.push.body),
    }),
    email: Object.freeze({
      ...templates.email,
      subject: bind(templates.email.subject),
      textBody: bind(templates.email.textBody),
    }),
    sms: Object.freeze({ ...templates.sms, body: bind(templates.sms.body) }),
  });
}

/**
 * The variables a notification renders with. An activation names who started
 * the event and when; an all-clear or reactivation also names who performed
 * that action and when. `at` is the moment of the action being rendered:
 * the activation time for an activation, the transition time otherwise; a
 * preview passes null and its templates carry the bound copy instead.
 */
export function notificationVariables(input: {
  readonly wording: NotificationWording;
  readonly purpose: NotificationPurpose;
  readonly responseDetail: string | null;
  readonly threat: ActivationThreat | null;
  readonly activatedAt: string;
  readonly at: string | null;
}): TemplateRenderVariables {
  const initiator =
    input.wording.initiatorDisplayName ?? RECORDED_INITIATOR_FALLBACK;
  const base = {
    site: input.wording.facilityName,
    eventType: renderedResponseLabel(
      input.wording.eventTypeName,
      input.responseDetail,
    ),
    threat: renderedThreatLabel(input.threat),
    startTime: input.activatedAt,
    initiator,
  };
  if (input.purpose === 'activation') return Object.freeze(base);
  return Object.freeze({
    ...base,
    updatedBy: input.wording.actorDisplayName ?? RECORDED_OPERATOR_FALLBACK,
    ...(input.at === null ? {} : { updatedAt: input.at }),
  });
}
