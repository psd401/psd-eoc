import {
  EventKindSchema,
  RecordDeliveryEvidenceInputSchema,
  RecordEndpointStatusInputSchema,
  TemplateModeSchema,
  TimestampSchema,
  UuidSchema,
  type EventKind,
  type RecordDeliveryEvidenceInput,
  type RecordEndpointStatusInput,
  type TemplateMode,
} from '@psd-eoc/contracts';

const SES_PROVIDER = 'aws-ses-v2';
export const SES_CONFIGURATION_SET_NAME = 'psd-eoc-transactional' as const;
const MAX_SES_EVENT_BYTES = 256 * 1024;

const TAGS = Object.freeze({
  attemptId: 'psd-eoc-attempt-id',
  endpointId: 'psd-eoc-endpoint-id',
  rosterSnapshotId: 'psd-eoc-roster-snapshot-id',
  recipientId: 'psd-eoc-recipient-id',
  templateMode: 'psd-eoc-template-mode',
  eventKind: 'psd-eoc-event-kind',
  configurationSet: 'ses:configuration-set',
});

export type SesEventType =
  | 'Send'
  | 'Delivery'
  | 'Bounce'
  | 'Complaint'
  | 'Reject'
  | 'Rendering Failure'
  | 'DeliveryDelay';

export interface ParseSesEventOptions {
  readonly expectedConfigurationSetName: string;
  readonly expectedSendingAccountId: string;
  readonly snsMessageId: string;
}

export interface ParsedSesEvent {
  readonly attemptId: string;
  readonly endpointId: string;
  readonly rosterSnapshotId: string;
  readonly recipientId: string;
  readonly templateMode: TemplateMode;
  readonly eventKind: EventKind;
  readonly mailMessageId: string;
  readonly evidence: RecordDeliveryEvidenceInput | null;
  readonly endpointStatus: RecordEndpointStatusInput | null;
  readonly eventType: SesEventType;
}

export type SesEventErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNSUPPORTED_EVENT'
  | 'INVALID_CORRELATION';

export class SesEventError extends Error {
  public constructor(public readonly code: SesEventErrorCode) {
    super('The signed SES event could not be mapped safely.');
    this.name = 'SesEventError';
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, maximum = 500): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > maximum
  ) {
    return undefined;
  }
  return value;
}

function singleTag(
  tags: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = tags[name];
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    boundedString(value[0]) === undefined
  ) {
    throw new SesEventError('INVALID_CORRELATION');
  }
  return value[0] as string;
}

function eventObject(
  root: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = root[key];
  if (!isRecord(value)) {
    throw new SesEventError('INVALID_MESSAGE');
  }
  return value;
}

function eventTimestamp(value: unknown): string {
  const parsed = TimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw new SesEventError('INVALID_MESSAGE');
  }
  return parsed.data;
}

function evidence(
  attemptId: string,
  value: Omit<RecordDeliveryEvidenceInput, 'subject'>,
): RecordDeliveryEvidenceInput {
  const parsed = RecordDeliveryEvidenceInputSchema.safeParse({
    subject: { kind: 'attempt', attemptId },
    ...value,
  });
  if (!parsed.success) {
    throw new SesEventError('INVALID_CORRELATION');
  }
  return parsed.data;
}

function failedEvidence(
  attemptId: string,
  mailMessageId: string,
  reasonCode: string,
): RecordDeliveryEvidenceInput {
  return evidence(attemptId, {
    state: 'failed',
    provider: SES_PROVIDER,
    providerReference: mailMessageId,
    proof: null,
    reasonCode,
    diagnosticDigest: null,
  });
}

function endpointStatus(
  rosterSnapshotId: string,
  recipientId: string,
  endpointId: string,
  status: 'invalid' | 'disabled',
  reasonCode: string,
): RecordEndpointStatusInput {
  const parsed = RecordEndpointStatusInputSchema.safeParse({
    rosterSnapshotId,
    recipientId,
    endpointId,
    status,
    reasonCode,
  });
  if (!parsed.success) {
    throw new SesEventError('INVALID_CORRELATION');
  }
  return parsed.data;
}

function supportedEventType(value: unknown): SesEventType {
  switch (value) {
    case 'Send':
    case 'Delivery':
    case 'Bounce':
    case 'Complaint':
    case 'Reject':
    case 'Rendering Failure':
    case 'DeliveryDelay':
      return value;
    default:
      throw new SesEventError('UNSUPPORTED_EVENT');
  }
}

/**
 * Maps a signed configuration-set event without reading recipient addresses.
 * All persistence identifiers come from single-value SES message tags.
 */
export function parseSesEvent(
  messageString: string,
  options: ParseSesEventOptions,
): ParsedSesEvent {
  if (
    typeof messageString !== 'string' ||
    messageString.length === 0 ||
    Buffer.byteLength(messageString, 'utf8') > MAX_SES_EVENT_BYTES ||
    !UuidSchema.safeParse(options.snsMessageId).success ||
    !/^[0-9]{12}$/u.test(options.expectedSendingAccountId) ||
    options.expectedConfigurationSetName !== SES_CONFIGURATION_SET_NAME
  ) {
    throw new SesEventError('INVALID_MESSAGE');
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(messageString) as unknown;
  } catch {
    throw new SesEventError('INVALID_MESSAGE');
  }
  if (!isRecord(parsedJson) || !isRecord(parsedJson.mail)) {
    throw new SesEventError('INVALID_MESSAGE');
  }

  const eventType = supportedEventType(parsedJson.eventType);
  const mail = parsedJson.mail;
  const mailMessageId = boundedString(mail.messageId);
  if (
    mailMessageId === undefined ||
    mail.sendingAccountId !== options.expectedSendingAccountId ||
    !TimestampSchema.safeParse(mail.timestamp).success ||
    !isRecord(mail.tags)
  ) {
    throw new SesEventError('INVALID_CORRELATION');
  }

  const configurationSet = singleTag(mail.tags, TAGS.configurationSet);
  const attemptId = singleTag(mail.tags, TAGS.attemptId);
  const endpointId = singleTag(mail.tags, TAGS.endpointId);
  const rosterSnapshotId = singleTag(mail.tags, TAGS.rosterSnapshotId);
  const recipientId = singleTag(mail.tags, TAGS.recipientId);
  const templateModeResult = TemplateModeSchema.safeParse(
    singleTag(mail.tags, TAGS.templateMode),
  );
  const eventKindResult = EventKindSchema.safeParse(
    singleTag(mail.tags, TAGS.eventKind),
  );
  if (
    configurationSet !== options.expectedConfigurationSetName ||
    !UuidSchema.safeParse(attemptId).success ||
    !UuidSchema.safeParse(endpointId).success ||
    !UuidSchema.safeParse(rosterSnapshotId).success ||
    !UuidSchema.safeParse(recipientId).success ||
    !templateModeResult.success ||
    !eventKindResult.success
  ) {
    throw new SesEventError('INVALID_CORRELATION');
  }

  let mappedEvidence: RecordDeliveryEvidenceInput | null;
  let mappedEndpointStatus: RecordEndpointStatusInput | null = null;
  switch (eventType) {
    case 'Send': {
      eventObject(parsedJson, 'send');
      mappedEvidence = evidence(attemptId, {
        state: 'provider-accepted',
        provider: SES_PROVIDER,
        providerReference: mailMessageId,
        proof: null,
        reasonCode: null,
        diagnosticDigest: null,
      });
      break;
    }
    case 'Delivery': {
      const delivery = eventObject(parsedJson, 'delivery');
      const deliveredAt = eventTimestamp(delivery.timestamp);
      mappedEvidence = evidence(attemptId, {
        state: 'delivered',
        provider: SES_PROVIDER,
        providerReference: mailMessageId,
        proof: {
          kind: 'provider-delivery-receipt',
          provider: SES_PROVIDER,
          receiptId: options.snsMessageId,
          deliveredAt,
        },
        reasonCode: null,
        diagnosticDigest: null,
      });
      break;
    }
    case 'Bounce': {
      const bounce = eventObject(parsedJson, 'bounce');
      eventTimestamp(bounce.timestamp);
      let reasonCode: string;
      switch (bounce.bounceType) {
        case 'Permanent':
          reasonCode = 'SES_PERMANENT_BOUNCE';
          mappedEndpointStatus = endpointStatus(
            rosterSnapshotId,
            recipientId,
            endpointId,
            'invalid',
            reasonCode,
          );
          break;
        case 'Transient':
          reasonCode = 'SES_TRANSIENT_BOUNCE';
          break;
        case 'Undetermined':
          reasonCode = 'SES_UNDETERMINED_BOUNCE';
          break;
        default:
          throw new SesEventError('INVALID_MESSAGE');
      }
      mappedEvidence = failedEvidence(attemptId, mailMessageId, reasonCode);
      break;
    }
    case 'Complaint': {
      const complaint = eventObject(parsedJson, 'complaint');
      eventTimestamp(complaint.timestamp);
      // A complaint must suppress future sends, but must not regress or invent
      // the existing delivery truth for the attempt.
      mappedEvidence = null;
      mappedEndpointStatus = endpointStatus(
        rosterSnapshotId,
        recipientId,
        endpointId,
        'disabled',
        'SES_COMPLAINT',
      );
      break;
    }
    case 'Reject':
      eventObject(parsedJson, 'reject');
      mappedEvidence = failedEvidence(attemptId, mailMessageId, 'SES_REJECTED');
      break;
    case 'Rendering Failure':
      eventObject(parsedJson, 'failure');
      mappedEvidence = failedEvidence(
        attemptId,
        mailMessageId,
        'SES_RENDERING_FAILURE',
      );
      break;
    case 'DeliveryDelay': {
      const deliveryDelay = eventObject(parsedJson, 'deliveryDelay');
      eventTimestamp(deliveryDelay.timestamp);
      // Delay is nonterminal. Keep provider-accepted truth until SES emits a
      // terminal callback or the ordinary reconciliation deadline expires.
      mappedEvidence = null;
      break;
    }
  }

  return Object.freeze({
    attemptId,
    endpointId,
    rosterSnapshotId,
    recipientId,
    templateMode: templateModeResult.data,
    eventKind: eventKindResult.data,
    mailMessageId,
    evidence: mappedEvidence,
    endpointStatus: mappedEndpointStatus,
    eventType,
  });
}
