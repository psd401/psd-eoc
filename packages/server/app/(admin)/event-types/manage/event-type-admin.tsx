'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  ApiErrorSchema,
  CreateEventTypeDraftInputSchema,
  EventTypeRenderingPreviewSchema,
  EventTypeVersionDraftSchema,
  EventTypeVersionSchema,
  PublishEventTypeVersionInputSchema,
  UpdateEventTypeDraftInputSchema,
  type CreateEventTypeDraftInput,
  type EventTypePage,
  type EventTypeRenderingPreview,
  type EventTypeVersion,
  type EventTypeVersionDraft,
  type MessageTemplateCatalog,
  type MessageTemplateSet,
  type NotificationPurpose,
  type PublishEventTypeVersionInput,
  type TemplateMode,
  type UpdateEventTypeDraftInput,
} from '@psd-eoc/contracts';

type EventTypeListItem = EventTypePage['items'][number];

type EventTypeCommand =
  | Readonly<{
      action: 'create-draft';
      input: CreateEventTypeDraftInput;
    }>
  | Readonly<{
      action: 'update-draft';
      input: UpdateEventTypeDraftInput;
    }>
  | Readonly<{
      action: 'publish-version';
      input: PublishEventTypeVersionInput;
    }>;

type CommandSuccess =
  | Readonly<{
      kind: 'draft';
      draft: EventTypeVersionDraft;
    }>
  | Readonly<{
      kind: 'version';
      version: EventTypeVersion;
    }>;

interface FieldIssue {
  readonly fieldId: string | null;
  readonly label: string;
  readonly message: string;
}

interface UiError {
  readonly heading: string;
  readonly message: string;
  readonly fieldIssues: readonly FieldIssue[];
}

type RequestOutcome = 'ambiguous' | 'definite';

class EventTypeRequestError extends Error {
  public constructor(
    message: string,
    public readonly outcome: RequestOutcome,
    public readonly fieldIssues: readonly FieldIssue[] = [],
    public readonly commandWasDefinitivelyRejected = false,
  ) {
    super(message);
    this.name = 'EventTypeRequestError';
  }
}

class BrowserRecoveryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BrowserRecoveryError';
  }
}

interface RetainedCommand {
  readonly version: 1;
  readonly sessionId: string;
  readonly editorId: string;
  readonly idempotencyKey: string;
  readonly bodyJson: string;
  readonly createdAt: string;
  readonly command: EventTypeCommand;
}

interface RetainedDraft {
  readonly version: 1;
  readonly sessionId: string;
  readonly editorId: string;
  readonly draftId: string;
  readonly eventTypeId: string;
  readonly savedAt: string;
}

type PendingAction = 'publish' | 'restore' | 'retry' | 'save' | null;

const PURPOSES = [
  'activation',
  'all-clear',
  'reactivation',
] as const satisfies readonly NotificationPurpose[];

const PURPOSE_LABELS = {
  activation: 'Activation',
  'all-clear': 'All-clear',
  reactivation: 'Reactivation',
} as const satisfies Record<NotificationPurpose, string>;

const PENDING_STORAGE_PREFIX = 'psd-eoc:event-type-admin:pending:v1:';
const DRAFT_STORAGE_PREFIX = 'psd-eoc:event-type-admin:draft:v1:';
const MAX_RETAINED_COMMAND_LENGTH = 100_000;

function storageKey(prefix: string, sessionId: string): string {
  return `${prefix}${encodeURIComponent(sessionId)}`;
}

function getSessionStorage(): Storage {
  if (typeof window === 'undefined') {
    throw new BrowserRecoveryError(
      'Browser recovery storage is not available. No change was sent.',
    );
  }
  try {
    return window.sessionStorage;
  } catch {
    throw new BrowserRecoveryError(
      'Browser recovery storage is unavailable. No change was sent.',
    );
  }
}

function parseCommand(value: unknown): EventTypeCommand | null {
  if (typeof value !== 'object' || value === null || !('action' in value)) {
    return null;
  }
  const input = 'input' in value ? value.input : undefined;
  switch (value.action) {
    case 'create-draft': {
      const parsed = CreateEventTypeDraftInputSchema.safeParse(input);
      return parsed.success
        ? { action: 'create-draft', input: parsed.data }
        : null;
    }
    case 'update-draft': {
      const parsed = UpdateEventTypeDraftInputSchema.safeParse(input);
      return parsed.success
        ? { action: 'update-draft', input: parsed.data }
        : null;
    }
    case 'publish-version': {
      const parsed = PublishEventTypeVersionInputSchema.safeParse(input);
      return parsed.success
        ? { action: 'publish-version', input: parsed.data }
        : null;
    }
    default:
      return null;
  }
}

function parseRetainedCommand(
  rawValue: string,
  sessionId: string,
): RetainedCommand {
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    throw new BrowserRecoveryError(
      'The saved browser recovery record is damaged. No change was sent.',
    );
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('sessionId' in value) ||
    value.sessionId !== sessionId ||
    !('editorId' in value) ||
    typeof value.editorId !== 'string' ||
    !('idempotencyKey' in value) ||
    typeof value.idempotencyKey !== 'string' ||
    !('bodyJson' in value) ||
    typeof value.bodyJson !== 'string' ||
    value.bodyJson.length === 0 ||
    value.bodyJson.length > MAX_RETAINED_COMMAND_LENGTH ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'string'
  ) {
    throw new BrowserRecoveryError(
      'The saved browser recovery record is invalid. No change was sent.',
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(value.bodyJson);
  } catch {
    throw new BrowserRecoveryError(
      'The saved browser recovery command is damaged. No change was sent.',
    );
  }
  const command = parseCommand(body);
  if (command === null) {
    throw new BrowserRecoveryError(
      'The saved browser recovery command is invalid. No change was sent.',
    );
  }
  return {
    version: 1,
    sessionId,
    editorId: value.editorId,
    idempotencyKey: value.idempotencyKey,
    bodyJson: value.bodyJson,
    createdAt: value.createdAt,
    command,
  };
}

function readRetainedCommand(sessionId: string): RetainedCommand | null {
  const value = getSessionStorage().getItem(
    storageKey(PENDING_STORAGE_PREFIX, sessionId),
  );
  return value === null ? null : parseRetainedCommand(value, sessionId);
}

function retainNewCommand(
  sessionId: string,
  editorId: string,
  command: EventTypeCommand,
): RetainedCommand {
  const storage = getSessionStorage();
  const key = storageKey(PENDING_STORAGE_PREFIX, sessionId);
  if (storage.getItem(key) !== null) {
    throw new BrowserRecoveryError(
      'A previous event-type change has an unresolved outcome. Use the recovery button before sending another change.',
    );
  }
  const bodyJson = JSON.stringify(command);
  if (bodyJson.length > MAX_RETAINED_COMMAND_LENGTH) {
    throw new BrowserRecoveryError(
      'The event-type change is too large to retain safely. No change was sent.',
    );
  }
  const record: RetainedCommand = {
    version: 1,
    sessionId,
    editorId,
    idempotencyKey: `event-type-ui-${crypto.randomUUID()}`,
    bodyJson,
    createdAt: new Date().toISOString(),
    command,
  };
  const serialized = JSON.stringify({
    version: record.version,
    sessionId: record.sessionId,
    editorId: record.editorId,
    idempotencyKey: record.idempotencyKey,
    bodyJson: record.bodyJson,
    createdAt: record.createdAt,
  });
  try {
    storage.setItem(key, serialized);
    const verified = storage.getItem(key);
    if (
      verified === null ||
      parseRetainedCommand(verified, sessionId).idempotencyKey !==
        record.idempotencyKey
    ) {
      throw new Error('Recovery verification failed.');
    }
  } catch (error) {
    try {
      storage.removeItem(key);
    } catch {
      // The original bounded error below remains the actionable failure.
    }
    throw new BrowserRecoveryError(
      error instanceof BrowserRecoveryError
        ? error.message
        : 'PSD EOC could not retain this change for a safe retry. No change was sent.',
    );
  }
  return record;
}

function clearRetainedCommand(
  sessionId: string,
  expectedIdempotencyKey: string,
): void {
  const storage = getSessionStorage();
  const key = storageKey(PENDING_STORAGE_PREFIX, sessionId);
  const existing = storage.getItem(key);
  if (existing === null) {
    return;
  }
  if (
    parseRetainedCommand(existing, sessionId).idempotencyKey !==
    expectedIdempotencyKey
  ) {
    throw new BrowserRecoveryError(
      'A different browser recovery record is active. No additional change was sent.',
    );
  }
  try {
    storage.removeItem(key);
  } catch {
    throw new BrowserRecoveryError(
      'PSD EOC could not clear the completed browser recovery record.',
    );
  }
}

function parseRetainedDraft(
  rawValue: string,
  sessionId: string,
): RetainedDraft {
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    throw new BrowserRecoveryError(
      'The saved draft recovery record is damaged. No change was sent.',
    );
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('sessionId' in value) ||
    value.sessionId !== sessionId ||
    !('editorId' in value) ||
    typeof value.editorId !== 'string' ||
    !('draftId' in value) ||
    typeof value.draftId !== 'string' ||
    !('eventTypeId' in value) ||
    typeof value.eventTypeId !== 'string' ||
    !('savedAt' in value) ||
    typeof value.savedAt !== 'string'
  ) {
    throw new BrowserRecoveryError(
      'The saved draft recovery record is invalid. No change was sent.',
    );
  }
  return {
    version: 1,
    sessionId,
    editorId: value.editorId,
    draftId: value.draftId,
    eventTypeId: value.eventTypeId,
    savedAt: value.savedAt,
  };
}

function readRetainedDraft(sessionId: string): RetainedDraft | null {
  const value = getSessionStorage().getItem(
    storageKey(DRAFT_STORAGE_PREFIX, sessionId),
  );
  return value === null ? null : parseRetainedDraft(value, sessionId);
}

function retainDraft(
  sessionId: string,
  editorId: string,
  draft: EventTypeVersionDraft,
): RetainedDraft {
  const storage = getSessionStorage();
  const key = storageKey(DRAFT_STORAGE_PREFIX, sessionId);
  const existingValue = storage.getItem(key);
  if (existingValue !== null) {
    const existing = parseRetainedDraft(existingValue, sessionId);
    if (
      existing.editorId !== editorId ||
      existing.draftId !== draft.id ||
      existing.eventTypeId !== draft.eventTypeId
    ) {
      throw new BrowserRecoveryError(
        'Another unpublished event-type draft is already retained in this browser session. Finish that draft before creating another.',
      );
    }
  }
  const record: RetainedDraft = {
    version: 1,
    sessionId,
    editorId,
    draftId: draft.id,
    eventTypeId: draft.eventTypeId,
    savedAt: new Date().toISOString(),
  };
  try {
    storage.setItem(key, JSON.stringify(record));
    const verified = storage.getItem(key);
    if (
      verified === null ||
      parseRetainedDraft(verified, sessionId).draftId !== draft.id
    ) {
      throw new Error('Draft recovery verification failed.');
    }
  } catch {
    throw new BrowserRecoveryError(
      'The draft was saved, but PSD EOC could not retain its recovery ID. Use the explicit recovery button before leaving this page.',
    );
  }
  return record;
}

function clearRetainedDraft(sessionId: string, expectedDraftId: string): void {
  const storage = getSessionStorage();
  const key = storageKey(DRAFT_STORAGE_PREFIX, sessionId);
  const existingValue = storage.getItem(key);
  if (existingValue === null) {
    return;
  }
  if (
    parseRetainedDraft(existingValue, sessionId).draftId !== expectedDraftId
  ) {
    throw new BrowserRecoveryError(
      'A different unpublished draft is retained in this browser session.',
    );
  }
  try {
    storage.removeItem(key);
  } catch {
    throw new BrowserRecoveryError(
      'The version was published, but PSD EOC could not clear its draft recovery record.',
    );
  }
}

function csrfToken(cookieName: string): string | null {
  const cookie = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  return cookie === undefined
    ? null
    : decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
}

function fieldIdForPath(path: readonly (string | number)[]): string | null {
  const parts = path.map(String);
  if (parts[0] === 'input') {
    parts.shift();
  }
  const joined = parts.join('.');
  const directIds: Readonly<Record<string, string>> = {
    name: 'event-type-name',
    description: 'event-type-description',
    'target.key': 'new-event-type-key',
    'target.familyKey': 'new-event-type-family',
    'target.templateMode': 'new-event-type-mode',
  };
  const direct = directIds[joined];
  if (direct !== undefined) {
    return direct;
  }
  if (parts[0] === 'templates') {
    parts.shift();
  }
  const [purpose, channel, field, ...remaining] = parts;
  if (
    remaining.length > 0 ||
    (purpose !== 'activation' &&
      purpose !== 'all-clear' &&
      purpose !== 'reactivation')
  ) {
    return null;
  }
  if (channel === 'push' && (field === 'title' || field === 'body')) {
    return `${purpose}-push-${field}`;
  }
  if (channel === 'sms' && field === 'body') {
    return `${purpose}-sms-body`;
  }
  if (channel === 'email' && field === 'subject') {
    return `${purpose}-email-subject`;
  }
  if (channel === 'email' && field === 'textBody') {
    return `${purpose}-email-body`;
  }
  return null;
}

function apiFieldIssues(value: unknown): readonly FieldIssue[] {
  const parsed = ApiErrorSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.fieldErrors.map((fieldError) => {
    const pathLabel = fieldError.path.map(String).join('.');
    return {
      fieldId: fieldIdForPath(fieldError.path),
      label: pathLabel.length > 0 ? pathLabel : 'Event-type request',
      message: fieldError.message,
    };
  });
}

function validationFieldIssues(
  issues: readonly Readonly<{
    path: readonly PropertyKey[];
    message: string;
  }>[],
): readonly FieldIssue[] {
  return issues.map((issue) => {
    const path = issue.path.filter(
      (part): part is string | number =>
        typeof part === 'string' || typeof part === 'number',
    );
    const pathLabel = path.map(String).join('.');
    return {
      fieldId: fieldIdForPath(path),
      label: pathLabel.length > 0 ? pathLabel : 'Event-type request',
      message: issue.message,
    };
  });
}

function validateCommand(command: EventTypeCommand): EventTypeCommand {
  switch (command.action) {
    case 'create-draft': {
      const parsed = CreateEventTypeDraftInputSchema.safeParse(command.input);
      if (!parsed.success) {
        throw new EventTypeRequestError(
          'Review the highlighted event-type fields and try again.',
          'definite',
          validationFieldIssues(parsed.error.issues),
        );
      }
      return { action: 'create-draft', input: parsed.data };
    }
    case 'update-draft': {
      const parsed = UpdateEventTypeDraftInputSchema.safeParse(command.input);
      if (!parsed.success) {
        throw new EventTypeRequestError(
          'Review the highlighted event-type fields and try again.',
          'definite',
          validationFieldIssues(parsed.error.issues),
        );
      }
      return { action: 'update-draft', input: parsed.data };
    }
    case 'publish-version': {
      const parsed = PublishEventTypeVersionInputSchema.safeParse(
        command.input,
      );
      if (!parsed.success) {
        throw new EventTypeRequestError(
          'Review the highlighted event-type fields and try again.',
          'definite',
          validationFieldIssues(parsed.error.issues),
        );
      }
      return { action: 'publish-version', input: parsed.data };
    }
  }
}

function apiErrorMessage(value: unknown): string {
  const parsed = ApiErrorSchema.safeParse(value);
  return parsed.success
    ? parsed.data.message
    : 'PSD EOC could not complete the event-type request.';
}

function commandWasDefinitivelyRejected(value: unknown): boolean {
  const parsed = ApiErrorSchema.safeParse(value);
  return (
    parsed.success &&
    (parsed.data.code === 'VALIDATION_ERROR' ||
      parsed.data.code === 'NOT_FOUND' ||
      parsed.data.code === 'CONFLICT' ||
      parsed.data.code === 'IDEMPOTENCY_CONFLICT')
  );
}

type JsonReadResult =
  | Readonly<{ parsed: true; value: unknown }>
  | Readonly<{ parsed: false }>;

async function readJson(response: Response): Promise<JsonReadResult> {
  try {
    return { parsed: true, value: await response.json() };
  } catch {
    return { parsed: false };
  }
}

async function sendCommand(
  csrfCookieName: string,
  bodyJson: string,
  idempotencyKey: string,
): Promise<unknown> {
  const csrf = csrfToken(csrfCookieName);
  if (csrf === null) {
    throw new EventTypeRequestError(
      'Your session is missing its request-protection cookie. Sign in again before saving.',
      'definite',
    );
  }
  let response: Response;
  try {
    response = await fetch('/event-types/api', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'X-PSD-EOC-CSRF': csrf,
      },
      body: bodyJson,
    });
  } catch {
    throw new EventTypeRequestError(
      'The connection ended before PSD EOC could confirm the result. Retry the exact retained change below.',
      'ambiguous',
    );
  }
  const json = await readJson(response);
  if (!response.ok) {
    const value = json.parsed ? json.value : null;
    const definitelyRejected = commandWasDefinitivelyRejected(value);
    const outcome: RequestOutcome = definitelyRejected
      ? 'definite'
      : 'ambiguous';
    throw new EventTypeRequestError(
      apiErrorMessage(value),
      outcome,
      apiFieldIssues(value),
      definitelyRejected,
    );
  }
  if (!json.parsed) {
    throw new EventTypeRequestError(
      'PSD EOC returned an incomplete success response. Retry the exact retained change below.',
      'ambiguous',
    );
  }
  return json.value;
}

function parseCommandSuccess(
  command: EventTypeCommand,
  value: unknown,
): CommandSuccess {
  if (command.action === 'publish-version') {
    const parsed = EventTypeVersionSchema.safeParse(value);
    if (parsed.success) {
      return { kind: 'version', version: parsed.data };
    }
  } else {
    const parsed = EventTypeVersionDraftSchema.safeParse(value);
    if (parsed.success) {
      return { kind: 'draft', draft: parsed.data };
    }
  }
  throw new EventTypeRequestError(
    'PSD EOC returned a success response that could not be verified. Retry the exact retained change below.',
    'ambiguous',
  );
}

async function requestJson(
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'same-origin',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new EventTypeRequestError(
      'PSD EOC could not load the requested event-type data.',
      'definite',
    );
  }
  const json = await readJson(response);
  const value = json.parsed ? json.value : null;
  if (!response.ok) {
    throw new EventTypeRequestError(
      apiErrorMessage(value),
      'definite',
      apiFieldIssues(value),
    );
  }
  if (!json.parsed) {
    throw new EventTypeRequestError(
      'PSD EOC returned incomplete event-type data.',
      'definite',
    );
  }
  return json.value;
}

async function requestPreviews(
  draft: EventTypeVersionDraft,
  signal?: AbortSignal,
): Promise<readonly EventTypeRenderingPreview[]> {
  const eventKind = draft.templateMode === 'real' ? 'incident' : 'drill';
  return Promise.all(
    PURPOSES.map(async (purpose) => {
      const parameters = new URLSearchParams({
        operation: 'preview',
        draftId: draft.id,
        eventKind,
        purpose,
      });
      try {
        const value = await requestJson(
          `/event-types/api?${parameters.toString()}`,
          signal,
        );
        const parsed = EventTypeRenderingPreviewSchema.safeParse(value);
        if (
          !parsed.success ||
          parsed.data.draftId !== draft.id ||
          parsed.data.templateMode !== draft.templateMode ||
          parsed.data.purpose !== purpose
        ) {
          throw new EventTypeRequestError(
            `${PURPOSE_LABELS[purpose]} preview returned incomplete data.`,
            'definite',
          );
        }
        return parsed.data;
      } catch (error) {
        if (error instanceof EventTypeRequestError) {
          throw new EventTypeRequestError(
            `${PURPOSE_LABELS[purpose]} preview: ${error.message}`,
            error.outcome,
            error.fieldIssues.length > 0
              ? error.fieldIssues
              : [
                  {
                    fieldId: `${purpose}-push-title`,
                    label: `${PURPOSE_LABELS[purpose]} messages`,
                    message: error.message,
                  },
                ],
          );
        }
        throw error;
      }
    }),
  );
}

function templateSet(
  mode: TemplateMode,
  purpose: NotificationPurpose,
): MessageTemplateSet {
  const classificationMarker = mode === 'real' ? 'INCIDENT' : 'DRILL';
  const purposeCopy = {
    activation:
      mode === 'real'
        ? {
            title: 'REAL INCIDENT: {{eventType}} at {{site}}',
            body: 'Follow district safety procedures. Started {{startTime}} by {{initiator}}. Open PSD EOC for current instructions.',
            email:
              'A real {{eventType}} was started at {{site}} at {{startTime}} by {{initiator}}.\n\nFollow district safety procedures and open PSD EOC for current instructions. PSD EOC does not contact 911; call 911 first if emergency assistance is needed.',
            sms: 'REAL INCIDENT: {{eventType}} at {{site}}. Follow district safety procedures. Open PSD EOC.',
          }
        : {
            title: 'TRAINING ONLY: {{eventType}} at {{site}}',
            body: 'This is a drill, not a real incident alert. Started {{startTime}} by {{initiator}}. Open PSD EOC for drill instructions.',
            email:
              'TRAINING ONLY. A {{eventType}} was started at {{site}} at {{startTime}} by {{initiator}}. This message is a drill, not a real incident alert.\n\nFollow district drill procedures and open PSD EOC for drill instructions.',
            sms: 'TRAINING ONLY: {{eventType}} at {{site}}. This is a drill, not a real incident alert. Open PSD EOC.',
          },
    'all-clear':
      mode === 'real'
        ? {
            title: 'ALL CLEAR: {{eventType}} at {{site}}',
            body: 'The event is all clear. Open PSD EOC for current information.',
            email:
              'The {{eventType}} at {{site}} is all clear. The event began {{startTime}}. Open PSD EOC for current information.',
            sms: 'ALL CLEAR: {{eventType}} at {{site}}. Open PSD EOC for current information.',
          }
        : {
            title: 'TRAINING ONLY: DRILL COMPLETE at {{site}}',
            body: 'The drill is complete. This is not a real incident all-clear.',
            email:
              'TRAINING ONLY. The {{eventType}} at {{site}} is complete. The drill began {{startTime}}. This message closes the drill only.',
            sms: 'TRAINING ONLY: DRILL COMPLETE at {{site}}. This closes the drill only.',
          },
    reactivation:
      mode === 'real'
        ? {
            title: 'REACTIVATED: {{eventType}} at {{site}}',
            body: 'The event is active again. Open PSD EOC for current instructions.',
            email:
              'The {{eventType}} at {{site}} is active again. The event originally began {{startTime}} and was initiated by {{initiator}}. Open PSD EOC for current instructions.',
            sms: 'REACTIVATED: {{eventType}} at {{site}}. Open PSD EOC for current instructions.',
          }
        : {
            title: 'TRAINING ONLY: DRILL REACTIVATED at {{site}}',
            body: 'The drill is active again. This is not a real incident alert.',
            email:
              'TRAINING ONLY. The {{eventType}} at {{site}} is active again. The drill originally began {{startTime}} and was initiated by {{initiator}}. This message concerns the drill only.',
            sms: 'TRAINING ONLY: DRILL REACTIVATED at {{site}}. This concerns the drill only.',
          },
  }[purpose];
  return {
    templateMode: mode,
    purpose,
    push: {
      channel: 'push',
      templateMode: mode,
      purpose,
      classificationMarker,
      title: purposeCopy.title,
      body: purposeCopy.body,
    },
    email: {
      channel: 'email',
      templateMode: mode,
      purpose,
      classificationMarker,
      subject: purposeCopy.title,
      textBody: purposeCopy.email,
    },
    sms: {
      channel: 'sms',
      templateMode: mode,
      purpose,
      classificationMarker,
      body: purposeCopy.sms,
    },
  };
}

function defaultCatalog(mode: TemplateMode): MessageTemplateCatalog {
  return {
    activation: templateSet(mode, 'activation'),
    'all-clear': templateSet(mode, 'all-clear'),
    reactivation: templateSet(mode, 'reactivation'),
  };
}

function requiredText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function catalogFromForm(
  form: FormData,
  mode: TemplateMode,
): MessageTemplateCatalog {
  const classificationMarker = mode === 'real' ? 'INCIDENT' : 'DRILL';
  const setFor = (purpose: NotificationPurpose): MessageTemplateSet => ({
    templateMode: mode,
    purpose,
    push: {
      channel: 'push',
      templateMode: mode,
      purpose,
      classificationMarker,
      title: requiredText(form, `${purpose}.push.title`),
      body: requiredText(form, `${purpose}.push.body`),
    },
    email: {
      channel: 'email',
      templateMode: mode,
      purpose,
      classificationMarker,
      subject: requiredText(form, `${purpose}.email.subject`),
      textBody: requiredText(form, `${purpose}.email.textBody`),
    },
    sms: {
      channel: 'sms',
      templateMode: mode,
      purpose,
      classificationMarker,
      body: requiredText(form, `${purpose}.sms.body`),
    },
  });
  return {
    activation: setFor('activation'),
    'all-clear': setFor('all-clear'),
    reactivation: setFor('reactivation'),
  };
}

function issuesForField(
  fieldIssues: readonly FieldIssue[],
  fieldId: string,
): readonly FieldIssue[] {
  return fieldIssues.filter((issue) => issue.fieldId === fieldId);
}

function describedBy(
  baseIds: string | readonly string[] | null,
  fieldIssues: readonly FieldIssue[],
  fieldId: string,
): string | undefined {
  const ids = [
    ...(baseIds === null
      ? []
      : typeof baseIds === 'string'
        ? [baseIds]
        : baseIds),
    ...(issuesForField(fieldIssues, fieldId).length > 0
      ? [`${fieldId}-error`]
      : []),
  ];
  return ids.length === 0 ? undefined : ids.join(' ');
}

function InlineFieldErrors({
  fieldId,
  fieldIssues,
}: Readonly<{
  fieldId: string;
  fieldIssues: readonly FieldIssue[];
}>) {
  const matching = issuesForField(fieldIssues, fieldId);
  return matching.length === 0 ? null : (
    <ul
      className="field-help"
      id={`${fieldId}-error`}
      style={{ color: '#7f1d1d', fontWeight: 700 }}
    >
      {matching.map((issue, index) => (
        <li key={`${issue.message}-${index}`}>Error: {issue.message}</li>
      ))}
    </ul>
  );
}

export function TemplateFields({
  templates,
  fieldIssues = [],
}: Readonly<{
  templates: MessageTemplateCatalog;
  fieldIssues?: readonly FieldIssue[];
}>) {
  return (
    <>
      {PURPOSES.map((purpose) => {
        const set = templates[purpose];
        const helpId = `${purpose}-token-help`;
        const smsHelpId = `${purpose}-sms-help`;
        return (
          <fieldset className="template-purpose" key={purpose}>
            <legend>{PURPOSE_LABELS[purpose]} messages</legend>
            <p className="field-help" id={helpId}>
              Allowed variables: {'{{site}}'}, {'{{eventType}}'},{' '}
              {'{{startTime}}'}, and {'{{initiator}}'}. PSD EOC adds the
              classification prefix; do not type [INCIDENT] or [DRILL].
            </p>
            <section
              className="channel-editor"
              aria-labelledby={`${purpose}-push`}
            >
              <h3 id={`${purpose}-push`}>Push notification</h3>
              <div className="field">
                <label htmlFor={`${purpose}-push-title`}>
                  Lock-screen title
                </label>
                <input
                  aria-describedby={describedBy(
                    helpId,
                    fieldIssues,
                    `${purpose}-push-title`,
                  )}
                  aria-invalid={
                    issuesForField(fieldIssues, `${purpose}-push-title`)
                      .length > 0
                  }
                  defaultValue={set.push.title}
                  id={`${purpose}-push-title`}
                  maxLength={105}
                  name={`${purpose}.push.title`}
                  required
                />
                <InlineFieldErrors
                  fieldId={`${purpose}-push-title`}
                  fieldIssues={fieldIssues}
                />
              </div>
              <div className="field">
                <label htmlFor={`${purpose}-push-body`}>Lock-screen body</label>
                <textarea
                  aria-describedby={describedBy(
                    helpId,
                    fieldIssues,
                    `${purpose}-push-body`,
                  )}
                  aria-invalid={
                    issuesForField(fieldIssues, `${purpose}-push-body`).length >
                    0
                  }
                  defaultValue={set.push.body}
                  id={`${purpose}-push-body`}
                  maxLength={485}
                  name={`${purpose}.push.body`}
                  required
                  rows={3}
                />
                <InlineFieldErrors
                  fieldId={`${purpose}-push-body`}
                  fieldIssues={fieldIssues}
                />
              </div>
            </section>
            <section
              className="channel-editor"
              aria-labelledby={`${purpose}-sms`}
            >
              <h3 id={`${purpose}-sms`}>SMS</h3>
              <div className="field">
                <label htmlFor={`${purpose}-sms-body`}>SMS body</label>
                <textarea
                  aria-describedby={describedBy(
                    [helpId, smsHelpId],
                    fieldIssues,
                    `${purpose}-sms-body`,
                  )}
                  aria-invalid={
                    issuesForField(fieldIssues, `${purpose}-sms-body`).length >
                    0
                  }
                  defaultValue={set.sms.body}
                  id={`${purpose}-sms-body`}
                  maxLength={980}
                  name={`${purpose}.sms.body`}
                  required
                  rows={3}
                />
                <InlineFieldErrors
                  fieldId={`${purpose}-sms-body`}
                  fieldIssues={fieldIssues}
                />
                <p className="field-help" id={smsHelpId}>
                  The renderer keeps the complete [INCIDENT] or [DRILL] prefix
                  and safely shortens only the editable tail so the entire
                  message fits in one SMS part.
                </p>
              </div>
            </section>
            <section
              className="channel-editor"
              aria-labelledby={`${purpose}-email`}
            >
              <h3 id={`${purpose}-email`}>Email</h3>
              <div className="field">
                <label htmlFor={`${purpose}-email-subject`}>
                  Email subject
                </label>
                <input
                  aria-describedby={describedBy(
                    helpId,
                    fieldIssues,
                    `${purpose}-email-subject`,
                  )}
                  aria-invalid={
                    issuesForField(fieldIssues, `${purpose}-email-subject`)
                      .length > 0
                  }
                  defaultValue={set.email.subject}
                  id={`${purpose}-email-subject`}
                  maxLength={185}
                  name={`${purpose}.email.subject`}
                  required
                />
                <InlineFieldErrors
                  fieldId={`${purpose}-email-subject`}
                  fieldIssues={fieldIssues}
                />
              </div>
              <div className="field">
                <label htmlFor={`${purpose}-email-body`}>
                  Plaintext email body
                </label>
                <textarea
                  aria-describedby={describedBy(
                    helpId,
                    fieldIssues,
                    `${purpose}-email-body`,
                  )}
                  aria-invalid={
                    issuesForField(fieldIssues, `${purpose}-email-body`)
                      .length > 0
                  }
                  defaultValue={set.email.textBody}
                  id={`${purpose}-email-body`}
                  maxLength={9_980}
                  name={`${purpose}.email.textBody`}
                  required
                  rows={7}
                />
                <InlineFieldErrors
                  fieldId={`${purpose}-email-body`}
                  fieldIssues={fieldIssues}
                />
              </div>
            </section>
          </fieldset>
        );
      })}
    </>
  );
}

export function PreviewCards({
  preview,
}: Readonly<{ preview: EventTypeRenderingPreview }>) {
  const push = preview.messages.find((message) => message.channel === 'push');
  const email = preview.messages.find((message) => message.channel === 'email');
  const sms = preview.messages.find((message) => message.channel === 'sms');
  if (
    push?.channel !== 'push' ||
    email?.channel !== 'email' ||
    sms?.channel !== 'sms'
  ) {
    return <p role="alert">The rendering preview is incomplete.</p>;
  }
  return (
    <section
      className="preview-section"
      aria-labelledby={`preview-${preview.purpose}`}
    >
      <h3 id={`preview-${preview.purpose}`}>
        {PURPOSE_LABELS[preview.purpose]} preview
      </h3>
      <p className={`mode-banner ${preview.templateMode}`}>
        {preview.templateMode === 'real'
          ? 'REAL INCIDENT MESSAGE'
          : 'DRILL — TRAINING ONLY'}
      </p>
      <div className="preview-grid">
        <article className="preview-card">
          <h4>Push lock screen</h4>
          <div className="lock-screen">
            <strong>{push.title}</strong>
            <span>{push.body}</span>
          </div>
        </article>
        <article className="preview-card">
          <h4>SMS</h4>
          <div className="lock-screen">
            <strong>PSD EOC</strong>
            <span>{sms.body}</span>
          </div>
        </article>
        <article className="preview-card">
          <h4>Email</h4>
          <p>
            <strong>Subject:</strong> {email.subject}
          </p>
          <pre>{email.textBody}</pre>
        </article>
      </div>
    </section>
  );
}

function uiError(
  heading: string,
  caught: unknown,
  fallbackMessage: string,
): UiError {
  return {
    heading,
    message: caught instanceof Error ? caught.message : fallbackMessage,
    fieldIssues:
      caught instanceof EventTypeRequestError ? caught.fieldIssues : [],
  };
}

function EventTypeEditor({
  item,
  csrfCookieName,
  editorId,
  sessionId,
}: Readonly<{
  item: EventTypeListItem | null;
  csrfCookieName: string;
  editorId: string;
  sessionId: string;
}>) {
  const router = useRouter();
  const [mode, setMode] = useState<TemplateMode>(
    item?.eventType.templateMode ?? 'real',
  );
  const [draft, setDraft] = useState<EventTypeVersionDraft | null>(null);
  const [draftRetained, setDraftRetained] = useState(false);
  const [previews, setPreviews] = useState<
    readonly EventTypeRenderingPreview[]
  >([]);
  const [previewReady, setPreviewReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [retainedCommand, setRetainedCommand] =
    useState<RetainedCommand | null>(null);
  const [published, setPublished] = useState(false);
  const [formEpoch, setFormEpoch] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<UiError | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error !== null) {
      errorRef.current?.focus();
    }
  }, [error]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let pendingRecord: RetainedCommand | null = null;
    let draftRecord: RetainedDraft | null = null;
    try {
      pendingRecord = readRetainedCommand(sessionId);
      draftRecord = readRetainedDraft(sessionId);
      if (pendingRecord?.editorId === editorId) {
        setRetainedCommand(pendingRecord);
        setStatus(
          'A previous change has an unresolved outcome. Use the explicit recovery button; PSD EOC will not replay it automatically.',
        );
      }
    } catch (caught) {
      setError(
        uiError(
          'Browser recovery unavailable',
          caught,
          'PSD EOC could not read browser recovery state. No change was sent.',
        ),
      );
      return () => controller.abort();
    }

    if (draftRecord?.editorId === editorId) {
      setPendingAction('restore');
      void (async () => {
        try {
          const parameters = new URLSearchParams({
            operation: 'draft',
            draftId: draftRecord.draftId,
          });
          const value = await requestJson(
            `/event-types/api?${parameters.toString()}`,
            controller.signal,
          );
          const parsed = EventTypeVersionDraftSchema.safeParse(value);
          if (
            !parsed.success ||
            parsed.data.id !== draftRecord.draftId ||
            parsed.data.eventTypeId !== draftRecord.eventTypeId
          ) {
            throw new EventTypeRequestError(
              'The retained draft response did not match its recovery record.',
              'definite',
            );
          }
          const restored = parsed.data;
          if (!active) {
            return;
          }
          setDraft(restored);
          setDraftRetained(true);
          setMode(restored.templateMode);
          setDirty(false);
          setPublished(false);
          setPreviews([]);
          setPreviewReady(false);
          setFormEpoch((value) => value + 1);
          const restoredPreviews = await requestPreviews(
            restored,
            controller.signal,
          );
          if (!active) {
            return;
          }
          setPreviews(restoredPreviews);
          setPreviewReady(true);
          setError(null);
          setStatus(
            pendingRecord?.editorId === editorId
              ? 'Unpublished draft restored and previewed. Resolve the previous retained change before continuing.'
              : 'Unpublished draft restored and previewed. Review every channel before publishing.',
          );
        } catch (caught) {
          if (controller.signal.aborted || !active) {
            return;
          }
          setPreviewReady(false);
          setPreviews([]);
          setError(
            uiError(
              'Draft recovery needs attention',
              caught,
              'PSD EOC could not restore the unpublished draft.',
            ),
          );
          setStatus('');
        } finally {
          if (active) {
            setPendingAction(null);
          }
        }
      })();
    }

    return () => {
      active = false;
      controller.abort();
    };
  }, [editorId, sessionId]);

  const initial =
    draft?.templates ?? item?.latestVersion.templates ?? defaultCatalog(mode);
  const editorName = draft?.name ?? item?.latestVersion.name ?? '';
  const editorDescription =
    draft?.description ?? item?.latestVersion.description ?? '';
  const fieldIssues = error?.fieldIssues ?? [];
  const commandRetainedForEditor = retainedCommand?.editorId === editorId;
  const formBlocked =
    pendingAction !== null || published || commandRetainedForEditor;
  const canPublish =
    draft !== null &&
    draftRetained &&
    !dirty &&
    previewReady &&
    previews.length === PURPOSES.length &&
    pendingAction === null &&
    !published &&
    !commandRetainedForEditor;

  function markDirty(): void {
    setDirty(true);
    setPreviewReady(false);
    setPreviews([]);
    setError(null);
    setStatus('Unsaved changes. Save and preview again before publishing.');
  }

  async function executeRetained(
    record: RetainedCommand,
  ): Promise<CommandSuccess> {
    try {
      const value = await sendCommand(
        csrfCookieName,
        record.bodyJson,
        record.idempotencyKey,
      );
      return parseCommandSuccess(record.command, value);
    } catch (caught) {
      if (
        caught instanceof EventTypeRequestError &&
        caught.commandWasDefinitivelyRejected
      ) {
        clearRetainedCommand(sessionId, record.idempotencyKey);
        setRetainedCommand(null);
      }
      throw caught;
    }
  }

  async function acceptDraftSuccess(
    record: RetainedCommand,
    savedDraft: EventTypeVersionDraft,
    recovered: boolean,
  ): Promise<void> {
    setDraft(savedDraft);
    setDraftRetained(false);
    setMode(savedDraft.templateMode);
    setPublished(false);
    setDirty(false);
    setPreviewReady(false);
    setPreviews([]);
    if (recovered) {
      setFormEpoch((value) => value + 1);
    }
    retainDraft(sessionId, editorId, savedDraft);
    setDraftRetained(true);
    clearRetainedCommand(sessionId, record.idempotencyKey);
    setRetainedCommand(null);
    try {
      const results = await requestPreviews(savedDraft);
      setPreviews(results);
      setPreviewReady(true);
      setError(null);
      setStatus(
        'Draft saved and retained for recovery. Review every renderer-produced channel below before publishing.',
      );
    } catch (caught) {
      setPreviewReady(false);
      setPreviews([]);
      setError(
        uiError(
          'Draft saved, but preview failed',
          caught,
          'The draft is saved, but it cannot be published until every preview succeeds.',
        ),
      );
      setStatus(
        'Draft saved and retained, but publication remains blocked until every renderer preview succeeds.',
      );
    }
  }

  function acceptVersionSuccess(
    record: RetainedCommand,
    version: EventTypeVersion,
  ): void {
    if (record.command.action !== 'publish-version') {
      throw new EventTypeRequestError(
        'The retained command response did not match the requested action.',
        'ambiguous',
      );
    }
    clearRetainedDraft(sessionId, record.command.input.draftId);
    clearRetainedCommand(sessionId, record.idempotencyKey);
    setRetainedCommand(null);
    setDraftRetained(false);
    setPreviewReady(false);
    setDirty(false);
    setPublished(true);
    setError(null);
    setStatus(
      `Version ${version.version} published. Historical events remain pinned to the versions they used.`,
    );
    router.refresh();
  }

  async function completeCommand(
    record: RetainedCommand,
    recovered: boolean,
  ): Promise<void> {
    const result = await executeRetained(record);
    if (result.kind === 'draft') {
      await acceptDraftSuccess(record, result.draft, recovered);
    } else {
      acceptVersionSuccess(record, result.version);
    }
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const selectedMode = item?.eventType.templateMode ?? mode;
    const name = requiredText(form, 'name');
    const rawDescription = requiredText(form, 'description');
    const templates = catalogFromForm(form, selectedMode);
    const command: EventTypeCommand =
      draft === null
        ? {
            action: 'create-draft',
            input: {
              target:
                item === null
                  ? {
                      kind: 'new-event-type',
                      key: requiredText(form, 'key'),
                      familyKey: requiredText(form, 'familyKey'),
                      templateMode: selectedMode,
                    }
                  : {
                      kind: 'existing-event-type',
                      eventTypeId: item.eventType.id,
                    },
              name,
              description: rawDescription.length === 0 ? null : rawDescription,
              templates,
            },
          }
        : {
            action: 'update-draft',
            input: {
              draftId: draft.id,
              name,
              description: rawDescription.length === 0 ? null : rawDescription,
              templates,
            },
          };
    setPendingAction('save');
    setError(null);
    setPreviewReady(false);
    setPreviews([]);
    setStatus(draft === null ? 'Saving draft…' : 'Updating draft…');
    try {
      const existingDraft = readRetainedDraft(sessionId);
      if (
        existingDraft !== null &&
        (draft === null ||
          existingDraft.editorId !== editorId ||
          existingDraft.draftId !== draft.id)
      ) {
        throw new BrowserRecoveryError(
          'Another unpublished draft is retained. Finish that draft before saving another.',
        );
      }
      const record = retainNewCommand(
        sessionId,
        editorId,
        validateCommand(command),
      );
      setRetainedCommand(record);
      await completeCommand(record, false);
    } catch (caught) {
      setError(
        uiError(
          draft === null ? 'Draft not saved' : 'Draft not updated',
          caught,
          'The event-type draft could not be saved.',
        ),
      );
      setStatus(
        caught instanceof EventTypeRequestError &&
          caught.outcome === 'ambiguous'
          ? 'The outcome is unresolved. Use the explicit recovery button; no automatic retry will occur.'
          : '',
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function publishDraft(): Promise<void> {
    if (!canPublish || draft === null) {
      setError({
        heading: 'Version not published',
        message:
          'Save the current wording and complete all three renderer previews before publishing.',
        fieldIssues: [],
      });
      return;
    }
    const command: EventTypeCommand = {
      action: 'publish-version',
      input: { draftId: draft.id },
    };
    setPendingAction('publish');
    setError(null);
    setStatus('Publishing a new immutable version…');
    try {
      const record = retainNewCommand(
        sessionId,
        editorId,
        validateCommand(command),
      );
      setRetainedCommand(record);
      await completeCommand(record, false);
    } catch (caught) {
      setError(
        uiError(
          'Version not published',
          caught,
          'The event-type version could not be published.',
        ),
      );
      setStatus(
        caught instanceof EventTypeRequestError &&
          caught.outcome === 'ambiguous'
          ? 'The publish outcome is unresolved. Use the explicit recovery button; no automatic retry will occur.'
          : '',
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function retryRetainedCommand(): Promise<void> {
    setPendingAction('retry');
    setError(null);
    setStatus('Retrying the exact retained change…');
    try {
      const persisted = readRetainedCommand(sessionId);
      if (
        persisted === null ||
        retainedCommand === null ||
        persisted.idempotencyKey !== retainedCommand.idempotencyKey ||
        persisted.editorId !== editorId
      ) {
        throw new BrowserRecoveryError(
          'The retained change no longer matches this editor. No change was sent.',
        );
      }
      if (persisted.command.action !== 'publish-version') {
        setPreviewReady(false);
        setPreviews([]);
      }
      await completeCommand(persisted, true);
    } catch (caught) {
      setError(
        uiError(
          'Previous change not recovered',
          caught,
          'PSD EOC could not recover the previous change.',
        ),
      );
      setStatus(
        caught instanceof EventTypeRequestError &&
          caught.outcome === 'ambiguous'
          ? 'The outcome remains unresolved. The exact command is still retained for an explicit retry.'
          : '',
      );
    } finally {
      setPendingAction(null);
    }
  }

  function stopRecoveringDraft(): void {
    if (
      draft === null ||
      !draftRetained ||
      retainedCommand !== null ||
      pendingAction !== null ||
      published
    ) {
      setError({
        heading: 'Draft recovery unchanged',
        message:
          'Resolve any retained change before stopping recovery for this draft.',
        fieldIssues: [],
      });
      return;
    }
    const confirmed = window.confirm(
      `Stop recovering draft ${draft.id} in this browser tab? This does not delete the server draft, but this admin page will no longer remember its ID and any unsaved edits will be discarded.`,
    );
    if (!confirmed) {
      return;
    }
    try {
      clearRetainedDraft(sessionId, draft.id);
      setDraft(null);
      setDraftRetained(false);
      setMode(item?.eventType.templateMode ?? 'real');
      setPreviews([]);
      setPreviewReady(false);
      setDirty(false);
      setPublished(false);
      setError(null);
      setFormEpoch((value) => value + 1);
      setStatus(
        `Local recovery stopped for draft ${draft.id}. The server draft was not deleted.`,
      );
    } catch (caught) {
      setError(
        uiError(
          'Draft recovery unchanged',
          caught,
          'PSD EOC could not clear the local draft recovery record.',
        ),
      );
    }
  }

  function focusField(fieldId: string): void {
    document.getElementById(fieldId)?.focus();
  }

  return (
    <section className="editor" aria-labelledby="editor-heading">
      <h2 id="editor-heading">
        {draft !== null && item === null
          ? `Continue unpublished ${draft.name}`
          : item === null
            ? 'Create event type'
            : `Edit ${item.latestVersion.name}`}
      </h2>
      <p className={`mode-banner ${mode}`}>
        {mode === 'real' ? 'REAL INCIDENT TYPE' : 'DRILL — TRAINING ONLY TYPE'}
      </p>
      <p className="classification-note">
        Real-versus-drill mode is immutable. The renderer—not this form—adds
        [INCIDENT] or [DRILL] to every visible channel field.
      </p>
      {item !== null ? (
        <dl className="version-facts">
          <dt>Current version</dt>
          <dd>{item.latestVersion.version}</dd>
          <dt>Stable key</dt>
          <dd>{item.eventType.key}</dd>
          <dt>Family</dt>
          <dd>{item.eventType.familyKey}</dd>
        </dl>
      ) : null}
      {commandRetainedForEditor ? (
        <div className="error-summary" role="alert">
          <h3>Previous change needs explicit recovery</h3>
          <p>
            PSD EOC retained the exact request and its idempotency key because
            the outcome was not confirmed. It will never replay automatically.
          </p>
          <button
            disabled={pendingAction !== null}
            onClick={() => void retryRetainedCommand()}
            type="button"
          >
            {retainedCommand.command.action === 'publish-version'
              ? 'Retry exact publication'
              : 'Retry exact draft save'}
          </button>
        </div>
      ) : null}
      {error !== null ? (
        <div
          className="error-summary"
          ref={errorRef}
          role="alert"
          tabIndex={-1}
        >
          <h3>{error.heading}</h3>
          <p>{error.message}</p>
          {error.fieldIssues.length > 0 ? (
            <ul>
              {error.fieldIssues.map((issue, index) => (
                <li key={`${issue.label}-${issue.message}-${index}`}>
                  {issue.fieldId === null ? (
                    `${issue.label}: ${issue.message}`
                  ) : (
                    <a
                      href={`#${issue.fieldId}`}
                      onClick={(event) => {
                        event.preventDefault();
                        focusField(issue.fieldId ?? '');
                      }}
                    >
                      {issue.label}: {issue.message}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <p aria-live="polite" className="status" role="status">
        {status}
      </p>
      <form
        aria-busy={pendingAction !== null}
        key={`${editorId}-${formEpoch}`}
        onChange={markDirty}
        onSubmit={(event) => void saveDraft(event)}
      >
        <fieldset
          disabled={formBlocked}
          style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
        >
          <legend
            style={{
              clip: 'rect(0 0 0 0)',
              clipPath: 'inset(50%)',
              height: 1,
              overflow: 'hidden',
              position: 'absolute',
              whiteSpace: 'nowrap',
              width: 1,
            }}
          >
            Event-type configuration fields
          </legend>
          {item === null && draft === null ? (
            <fieldset className="template-purpose">
              <legend>Immutable identity</legend>
              <div className="field">
                <label htmlFor="new-event-type-key">Stable key</label>
                <input
                  aria-describedby={describedBy(
                    'new-event-type-key-help',
                    fieldIssues,
                    'new-event-type-key',
                  )}
                  aria-invalid={
                    issuesForField(fieldIssues, 'new-event-type-key').length > 0
                  }
                  id="new-event-type-key"
                  maxLength={100}
                  name="key"
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  placeholder="secure"
                  required
                />
                <p className="field-help" id="new-event-type-key-help">
                  Lowercase words separated by hyphens.
                </p>
                <InlineFieldErrors
                  fieldId="new-event-type-key"
                  fieldIssues={fieldIssues}
                />
              </div>
              <div className="field">
                <label htmlFor="new-event-type-family">Family key</label>
                <input
                  aria-describedby={describedBy(
                    null,
                    fieldIssues,
                    'new-event-type-family',
                  )}
                  aria-invalid={
                    issuesForField(fieldIssues, 'new-event-type-family')
                      .length > 0
                  }
                  id="new-event-type-family"
                  maxLength={100}
                  name="familyKey"
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  placeholder="secure"
                  required
                />
                <InlineFieldErrors
                  fieldId="new-event-type-family"
                  fieldIssues={fieldIssues}
                />
              </div>
              <div className="field">
                <label htmlFor="new-event-type-mode">Message mode</label>
                <select
                  aria-describedby={describedBy(
                    null,
                    fieldIssues,
                    'new-event-type-mode',
                  )}
                  aria-invalid={
                    issuesForField(fieldIssues, 'new-event-type-mode').length >
                    0
                  }
                  id="new-event-type-mode"
                  name="templateMode"
                  onChange={(event) =>
                    setMode(event.target.value === 'drill' ? 'drill' : 'real')
                  }
                  value={mode}
                >
                  <option value="real">Real incident</option>
                  <option value="drill">Drill — training only</option>
                </select>
                <InlineFieldErrors
                  fieldId="new-event-type-mode"
                  fieldIssues={fieldIssues}
                />
              </div>
            </fieldset>
          ) : null}
          <div className="field">
            <label htmlFor="event-type-name">Display name</label>
            <input
              aria-describedby={describedBy(
                null,
                fieldIssues,
                'event-type-name',
              )}
              aria-invalid={
                issuesForField(fieldIssues, 'event-type-name').length > 0
              }
              defaultValue={editorName}
              id="event-type-name"
              maxLength={160}
              name="name"
              required
            />
            <InlineFieldErrors
              fieldId="event-type-name"
              fieldIssues={fieldIssues}
            />
          </div>
          <div className="field">
            <label htmlFor="event-type-description">Description</label>
            <textarea
              aria-describedby={describedBy(
                null,
                fieldIssues,
                'event-type-description',
              )}
              aria-invalid={
                issuesForField(fieldIssues, 'event-type-description').length > 0
              }
              defaultValue={editorDescription}
              id="event-type-description"
              maxLength={1_000}
              name="description"
              rows={3}
            />
            <InlineFieldErrors
              fieldId="event-type-description"
              fieldIssues={fieldIssues}
            />
          </div>
          <TemplateFields
            fieldIssues={fieldIssues}
            key={`${draft?.id ?? mode}-${formEpoch}`}
            templates={initial}
          />
        </fieldset>
        <div className="actions">
          <button
            disabled={formBlocked || (draft !== null && !dirty && previewReady)}
            type="submit"
          >
            {draft === null
              ? 'Save draft and preview'
              : 'Update draft and preview'}
          </button>
          <button
            className="secondary"
            disabled={!canPublish}
            onClick={() => void publishDraft()}
            type="button"
          >
            Publish new version
          </button>
          {draft !== null && draftRetained && !published ? (
            <button
              className="secondary"
              disabled={pendingAction !== null || retainedCommand !== null}
              onClick={stopRecoveringDraft}
              type="button"
            >
              Stop recovering this draft
            </button>
          ) : null}
        </div>
      </form>
      {previews.map((preview) => (
        <PreviewCards key={preview.purpose} preview={preview} />
      ))}
    </section>
  );
}

export function EventTypeAdmin({
  items,
  csrfCookieName,
  sessionId,
}: Readonly<{
  items: readonly EventTypeListItem[];
  csrfCookieName: string;
  sessionId: string;
}>) {
  const initialId = items[0]?.eventType.id ?? 'new';
  const [selectedId, setSelectedId] = useState(initialId);
  const [recoveryOutsideFilter, setRecoveryOutsideFilter] = useState(false);

  useEffect(() => {
    try {
      setRecoveryOutsideFilter(false);
      const retainedCommand = readRetainedCommand(sessionId);
      const retainedDraft = readRetainedDraft(sessionId);
      const preferredEditor =
        retainedCommand?.editorId ?? retainedDraft?.editorId ?? null;
      if (preferredEditor !== null) {
        if (
          preferredEditor === 'new' ||
          items.some((item) => item.eventType.id === preferredEditor)
        ) {
          setSelectedId(preferredEditor);
        } else {
          setRecoveryOutsideFilter(true);
        }
      }
    } catch {
      // The selected editor reports bounded storage failures and blocks writes.
    }
  }, [items, sessionId]);

  const selected =
    items.find((item) => item.eventType.id === selectedId) ?? null;
  return (
    <div className="admin-grid">
      <aside
        className="panel type-list"
        aria-labelledby="event-type-picker-heading"
      >
        <h2 id="event-type-picker-heading">Choose a configuration</h2>
        {recoveryOutsideFilter ? (
          <div className="error-summary" role="alert">
            <p>
              A retained change belongs to an event type hidden by the current
              filter. No new change can be sent until it is resolved.
            </p>
            <a href="/event-types/manage">
              Show all event types and open the retained change
            </a>
          </div>
        ) : null}
        <label htmlFor="event-type-picker">Event type</label>
        <select
          id="event-type-picker"
          onChange={(event) => setSelectedId(event.target.value)}
          value={selectedId}
        >
          {items.map((item) => (
            <option key={item.eventType.id} value={item.eventType.id}>
              {item.latestVersion.name} —{' '}
              {item.eventType.templateMode === 'real' ? 'REAL' : 'DRILL'} — v
              {item.latestVersion.version}
            </option>
          ))}
          <option value="new">Create a new event type</option>
        </select>
        <p className="field-help">
          Real and drill variants are separate immutable identities. Publishing
          never overwrites a version used by a historical event.
        </p>
      </aside>
      <EventTypeEditor
        csrfCookieName={csrfCookieName}
        editorId={selectedId}
        item={selectedId === 'new' ? null : selected}
        key={selectedId}
        sessionId={sessionId}
      />
    </div>
  );
}
