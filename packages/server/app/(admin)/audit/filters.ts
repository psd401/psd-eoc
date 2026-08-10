import {
  RegisteredCapabilityIdSchema,
  SecurityAuditPrincipalFilterSchema,
  SecurityAuditPrincipalKindSchema,
  SecurityAuditQuerySchema,
  type SecurityAuditEntry,
  type SecurityAuditPage,
  type SecurityAuditPrincipalFilter,
  type SecurityAuditPrincipalKind,
  type SecurityAuditQuery,
} from '@psd-eoc/contracts';

export interface AuditFilterState {
  readonly actorKind: '' | SecurityAuditPrincipalKind;
  readonly actorReference: string;
  readonly action: string;
  readonly from: string;
  readonly through: string;
}

export interface AuditDisplayEntry {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly actorKind: SecurityAuditPrincipalKind;
  readonly actorReference: string;
  readonly action: string;
  readonly outcome: SecurityAuditEntry['outcome'];
  readonly facilityId: string | null;
  readonly reasonCode: string | null;
  readonly entryHash: string;
}

export interface AuditDisplayPage {
  readonly items: readonly AuditDisplayEntry[];
  readonly pageInfo: SecurityAuditPage['pageInfo'];
}

export interface AuditViewState {
  readonly filters: AuditFilterState;
  readonly page: AuditDisplayPage | null;
  readonly errorMessage: string | null;
  readonly forbidden: boolean;
}

export type ParsedAuditSubmission =
  | Readonly<{
      valid: true;
      filters: AuditFilterState;
      query: SecurityAuditQuery;
    }>
  | Readonly<{
      valid: false;
      filters: AuditFilterState;
      message: string;
    }>;

const UTC_LOCAL_TIME =
  /^(?<date>\d{4}-\d{2}-\d{2})T(?<time>\d{2}:\d{2})(?::(?<seconds>\d{2}))?$/u;

const AUDIT_FORM_FIELDS = new Set([
  'intent',
  'actorKind',
  'actorReference',
  'action',
  'from',
  'through',
  'cursor',
]);

export function emptyAuditFilterState(): AuditFilterState {
  return Object.freeze({
    actorKind: '',
    actorReference: '',
    action: '',
    from: '',
    through: '',
  });
}

export function createDefaultAuditQuery(): SecurityAuditQuery {
  return SecurityAuditQuerySchema.parse({
    actorKind: null,
    principal: null,
    category: null,
    outcome: null,
    action: null,
    facilityId: null,
    occurredFrom: null,
    occurredThrough: null,
    cursor: null,
    limit: 100,
  });
}

function auditPrincipalReference(entry: SecurityAuditEntry): string {
  switch (entry.principal.kind) {
    case 'human':
      return entry.principal.userId;
    case 'agent':
      return entry.principal.agentId;
    case 'system':
      return entry.principal.serviceId;
    case 'unauthenticated':
      return entry.principal.subjectDigest ?? 'Unavailable';
  }
}

/** Removes session, credential, request, target, and confirmation identifiers. */
export function toAuditDisplayPage(page: SecurityAuditPage): AuditDisplayPage {
  return Object.freeze({
    items: Object.freeze(
      page.items.map((entry) =>
        Object.freeze({
          sequence: entry.sequence,
          occurredAt: entry.occurredAt,
          actorKind: entry.principal.kind,
          actorReference: auditPrincipalReference(entry),
          action: entry.action,
          outcome: entry.outcome,
          facilityId: entry.facilityId,
          reasonCode: entry.reasonCode,
          entryHash: entry.entryHash,
        }),
      ),
    ),
    pageInfo: page.pageInfo,
  });
}

function assertKnownFields(formData: FormData): void {
  for (const name of formData.keys()) {
    if (!AUDIT_FORM_FIELDS.has(name) && !name.startsWith('$ACTION_')) {
      throw new TypeError(
        'The audit filter submission contains an unknown field.',
      );
    }
  }
}

function singleText(
  formData: FormData,
  name: string,
  maximumLength: number,
): string {
  const values = formData.getAll(name);
  if (values.length === 0) {
    return '';
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    typeof value !== 'string' ||
    value.length > maximumLength
  ) {
    throw new TypeError(
      'Audit filter fields must be single bounded text values.',
    );
  }
  return value;
}

function utcLocalToIso(value: string): string | null {
  if (value.length === 0) {
    return null;
  }
  const match = UTC_LOCAL_TIME.exec(value);
  if (match?.groups === undefined) {
    throw new TypeError('Audit times must use the displayed UTC format.');
  }
  const candidate = `${match.groups.date}T${match.groups.time}:${
    match.groups.seconds ?? '00'
  }.000Z`;
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== candidate) {
    throw new TypeError('Audit time is not a valid UTC date and time.');
  }
  return candidate;
}

function parsePrincipal(
  actorKind: AuditFilterState['actorKind'],
  actorReference: string,
): SecurityAuditPrincipalFilter | null {
  if (actorReference.length === 0) {
    return null;
  }
  switch (actorKind) {
    case 'human':
      return SecurityAuditPrincipalFilterSchema.parse({
        kind: actorKind,
        userId: actorReference,
      });
    case 'agent':
      return SecurityAuditPrincipalFilterSchema.parse({
        kind: actorKind,
        agentId: actorReference,
      });
    case 'system':
      return SecurityAuditPrincipalFilterSchema.parse({
        kind: actorKind,
        serviceId: actorReference,
      });
    case 'unauthenticated':
      return SecurityAuditPrincipalFilterSchema.parse({
        kind: actorKind,
        subjectDigest: actorReference,
      });
    case '':
      throw new TypeError('An exact actor filter requires an actor type.');
  }
}

function principalReference(
  principal: SecurityAuditPrincipalFilter | null,
): string {
  if (principal === null) return '';
  switch (principal.kind) {
    case 'human':
      return principal.userId;
    case 'agent':
      return principal.agentId;
    case 'system':
      return principal.serviceId;
    case 'unauthenticated':
      return principal.subjectDigest;
  }
}

/**
 * Parses a POST body without reflecting unknown values. Exact actor identity
 * is intentionally accepted only here, never from URL search parameters.
 */
export function parseAuditSubmission(
  formData: FormData,
): ParsedAuditSubmission {
  let filters = emptyAuditFilterState();
  try {
    assertKnownFields(formData);
    const intent = singleText(formData, 'intent', 16) || 'filter';
    if (intent === 'clear') {
      return {
        valid: true,
        filters,
        query: createDefaultAuditQuery(),
      };
    }
    if (intent !== 'filter' && intent !== 'page') {
      throw new TypeError('The audit filter intent is invalid.');
    }

    const actorKindValue = singleText(formData, 'actorKind', 32);
    const actorReferenceValue = singleText(formData, 'actorReference', 255);
    const actionValue = singleText(formData, 'action', 120);
    const fromValue = singleText(formData, 'from', 32);
    const throughValue = singleText(formData, 'through', 32);
    const cursorValue = singleText(formData, 'cursor', 1_024);

    const actorKind =
      actorKindValue === ''
        ? ''
        : SecurityAuditPrincipalKindSchema.parse(actorKindValue);
    const action =
      actionValue === ''
        ? null
        : RegisteredCapabilityIdSchema.parse(actionValue);
    const principal = parsePrincipal(actorKind, actorReferenceValue);
    filters = {
      actorKind,
      actorReference: principalReference(principal),
      action: action ?? '',
      from: fromValue,
      through: throughValue,
    };

    if (intent === 'filter' && cursorValue.length > 0) {
      throw new TypeError('A new audit filter cannot retain an old cursor.');
    }
    if (intent === 'page' && cursorValue.length === 0) {
      throw new TypeError('Audit pagination requires an opaque cursor.');
    }

    const query = SecurityAuditQuerySchema.parse({
      actorKind: actorKind === '' ? null : actorKind,
      principal,
      category: null,
      outcome: null,
      action,
      facilityId: null,
      occurredFrom: utcLocalToIso(fromValue),
      occurredThrough: utcLocalToIso(throughValue),
      cursor: intent === 'page' ? cursorValue : null,
      limit: 100,
    });
    return { valid: true, filters, query };
  } catch {
    return {
      valid: false,
      filters,
      message:
        'One or more audit filters are invalid. Use one actor type, a matching opaque actor identifier, a kebab-case action, valid UTC times, and the current page cursor.',
    };
  }
}
