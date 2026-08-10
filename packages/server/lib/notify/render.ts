import {
  MessageTemplateSetSchema,
  RenderedMessageSchema,
  TimestampSchema,
  type EventKind,
  type MessageTemplateSet,
  type NotificationChannel,
  type NotificationPurpose,
  type RenderedMessage,
  type TemplateMode,
  type TemplateVariable,
} from '@psd-eoc/contracts';

const TEMPLATE_TOKEN_PATTERN = /\{\{(site|eventType|startTime|initiator)\}\}/gu;
const FORMAT_CHARACTER_PATTERN = /\p{Format}/u;
const DEFAULT_IGNORABLE_PATTERN = /\p{Default_Ignorable_Code_Point}/u;
const SMS_CONTRACT_MAX_CODE_UNITS = 1_000;
const SINGLE_PART_GSM_MAX_SEPTETS = 160;
const SINGLE_PART_UCS2_MAX_CODE_UNITS = 70;
const TRUNCATION_MARKER = '...';
const SAFE_CONTEXT_FALLBACKS = Object.freeze({
  site: 'Recorded site',
  initiator: 'Recorded initiator',
});

const RENDERED_FIELD_LIMITS = Object.freeze({
  pushTitle: 120,
  pushBody: 500,
  emailSubject: 200,
  emailBody: 10_000,
});

/** AWS End User Messaging SMS rejects payloads beyond these channel limits. */
export const SMS_GSM_MAX_SEPTETS = 1_530;
export const SMS_UCS2_MAX_CODE_UNITS = 630;

const GSM_BASIC_CHARACTERS = new Set([
  '@',
  '£',
  '$',
  '¥',
  'è',
  'é',
  'ù',
  'ì',
  'ò',
  'Ç',
  '\n',
  'Ø',
  'ø',
  '\r',
  'Å',
  'å',
  'Δ',
  '_',
  'Φ',
  'Γ',
  'Λ',
  'Ω',
  'Π',
  'Ψ',
  'Σ',
  'Θ',
  'Ξ',
  'Æ',
  'æ',
  'ß',
  'É',
  ' ',
  '!',
  '"',
  '#',
  '¤',
  '%',
  '&',
  "'",
  '(',
  ')',
  '*',
  '+',
  ',',
  '-',
  '.',
  '/',
  ':',
  ';',
  '<',
  '=',
  '>',
  '?',
  '¡',
  'Ä',
  'Ö',
  'Ñ',
  'Ü',
  '§',
  '¿',
  'ä',
  'ö',
  'ñ',
  'ü',
  'à',
  ...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
]);

const GSM_EXTENSION_CHARACTERS = new Set([
  '^',
  '{',
  '}',
  '\\',
  '[',
  ']',
  '~',
  '|',
  '€',
]);

const START_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

/** Structured values accepted by the closed contract token grammar. */
export type TemplateRenderVariables = Readonly<
  Record<TemplateVariable, string>
>;

export interface RenderTemplateSetInput {
  readonly eventKind: EventKind;
  readonly templates: MessageTemplateSet;
  readonly variables: TemplateRenderVariables;
}

export interface RenderMessageTemplateInput {
  readonly eventKind: EventKind;
  readonly template: MessageTemplateSet[NotificationChannel];
  readonly variables: TemplateRenderVariables;
}

export interface SmsLengthMeasurement {
  readonly encoding: 'gsm-7' | 'ucs-2';
  readonly units: number;
  readonly parts: number;
  readonly exceedsProviderLimit: boolean;
}

export type TemplateRenderErrorCode =
  | 'CLASSIFICATION_MISMATCH'
  | 'INVALID_VARIABLE'
  | 'RESERVED_MARKER'
  | 'RENDERED_MESSAGE_INVALID';

/** Bounded renderer failure that never echoes administrator or roster data. */
export class TemplateRenderError extends Error {
  public constructor(
    public readonly code: TemplateRenderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

type Classification = Readonly<{
  templateMode: TemplateMode;
  marker: 'INCIDENT' | 'DRILL';
}>;

type RendererFrame = Readonly<{
  prefix: string;
  suffix: string;
}>;

function classificationFor(eventKind: EventKind): Classification {
  return eventKind === 'incident'
    ? Object.freeze({ templateMode: 'real', marker: 'INCIDENT' })
    : Object.freeze({ templateMode: 'drill', marker: 'DRILL' });
}

function purposeLabel(purpose: NotificationPurpose): string {
  switch (purpose) {
    case 'activation':
      return 'ACTIVATION';
    case 'all-clear':
      return 'ALL CLEAR';
    case 'reactivation':
      return 'REACTIVATION';
  }
}

/**
 * Both boundaries are renderer-owned. Configurable text can say anything, but
 * it can neither remove nor impersonate the immutable mode and purpose frame.
 */
function rendererOwnedFrame(
  classification: Classification,
  purpose: NotificationPurpose,
): RendererFrame {
  const modeLabel =
    classification.templateMode === 'real' ? 'REAL INCIDENT' : 'TRAINING ONLY';
  return Object.freeze({
    prefix: `[${classification.marker}] ${modeLabel} - ${purposeLabel(purpose)}: `,
    suffix: ` [${classification.marker}]`,
  });
}

function containsUnsafeVisibleCodePoint(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      FORMAT_CHARACTER_PATTERN.test(character) ||
      DEFAULT_IGNORABLE_PATTERN.test(character) ||
      codePoint <= 0x09 ||
      (codePoint >= 0x0b && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    );
  });
}

/** Exact bracketed classification markers remain renderer-owned. */
function containsReservedRendererMarker(value: string): boolean {
  const compatible = value.normalize('NFKC');
  return /\[\s*(?:INCIDENT|DRILL)\s*\]/iu.test(compatible);
}

function validateConfiguredValue(
  name: Exclude<TemplateVariable, 'startTime'>,
  value: string,
  maxCodeUnits: number,
): string {
  if (
    value.length === 0 ||
    value.length > maxCodeUnits ||
    value !== value.trim() ||
    value !== value.normalize('NFC') ||
    value.includes('\n') ||
    value.includes('\r') ||
    containsUnsafeVisibleCodePoint(value)
  ) {
    throw new TemplateRenderError(
      'INVALID_VARIABLE',
      `The ${name} rendering variable is not safe visible text.`,
    );
  }
  if (containsReservedRendererMarker(value)) {
    throw new TemplateRenderError(
      'RESERVED_MARKER',
      'Classification markers [INCIDENT] and [DRILL] are owned by the renderer.',
    );
  }
  return value;
}

function assertEditableTextSafe(value: string): void {
  if (
    value.length === 0 ||
    value !== value.normalize('NFC') ||
    containsUnsafeVisibleCodePoint(value)
  ) {
    throw new TemplateRenderError(
      'RENDERED_MESSAGE_INVALID',
      'Editable template wording contains unsafe invisible or control text.',
    );
  }
  if (containsReservedRendererMarker(value)) {
    throw new TemplateRenderError(
      'RESERVED_MARKER',
      'Classification markers [INCIDENT] and [DRILL] are owned by the renderer.',
    );
  }
}

/** Formats an absolute event time consistently for district recipients. */
export function formatNotificationStartTime(value: string): string {
  const parsed = TimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw new TemplateRenderError(
      'INVALID_VARIABLE',
      'The startTime rendering variable must be an absolute timestamp.',
    );
  }
  return START_TIME_FORMATTER.format(new Date(parsed.data));
}

/**
 * Names are deliberately semantic-free here. The immutable frame, rather than
 * an incomplete natural-language filter, owns real-versus-drill meaning.
 */
export function assertApprovedEventTypeName(
  value: string,
  templateMode: TemplateMode,
): void {
  void templateMode;
  validateConfiguredValue('eventType', value, 160);
}

function rendererOwnedEventTypeName(
  value: string,
  templateMode: TemplateMode,
): string {
  try {
    assertApprovedEventTypeName(value, templateMode);
    return value;
  } catch (error) {
    if (error instanceof TemplateRenderError) {
      return templateMode === 'real'
        ? 'Configured response'
        : 'Configured drill response';
    }
    throw error;
  }
}

function safeContextVariable(
  name: 'initiator' | 'site',
  value: string,
): string {
  try {
    return validateConfiguredValue(name, value, 500);
  } catch (error) {
    if (error instanceof TemplateRenderError) {
      return SAFE_CONTEXT_FALLBACKS[name];
    }
    throw error;
  }
}

function validatedVariables(
  variables: TemplateRenderVariables,
  templateMode: TemplateMode,
): TemplateRenderVariables {
  return Object.freeze({
    site: safeContextVariable('site', variables.site),
    eventType: rendererOwnedEventTypeName(variables.eventType, templateMode),
    startTime: formatNotificationStartTime(variables.startTime),
    initiator: safeContextVariable('initiator', variables.initiator),
  });
}

function stripEditableClassificationLead(
  value: string,
  templateMode: TemplateMode,
): string {
  return templateMode === 'real'
    ? value.replace(
        /^REAL\s+INCIDENT(?:\s*[-:—]\s*|\s+(?=(?:ACTIVATION|ALL-CLEAR|ALL CLEAR|REACTIVATION)\b))/iu,
        '',
      )
    : value.replace(
        /^(?:DRILL\s*[-—]\s*)?TRAINING\s+ONLY(?:\s*[-.:—]\s*|\s+(?=(?:ACTIVATION|ALL-CLEAR|ALL CLEAR|REACTIVATION)\b))/iu,
        '',
      );
}

function stripEditablePurposeLead(
  value: string,
  purpose: NotificationPurpose,
): string {
  const pattern =
    purpose === 'activation'
      ? /^ACTIVATION(?:\s*[-:—]\s*)/iu
      : purpose === 'all-clear'
        ? /^ALL[- ]CLEAR(?:\s*[-:—]\s*)/iu
        : /^REACTIVATION(?:\s*[-:—]\s*)/iu;
  return value.replace(pattern, '');
}

function stripMatchingLegacyLeads(
  value: string,
  templateMode: TemplateMode,
  purpose: NotificationPurpose,
): string {
  const stripped = stripEditablePurposeLead(
    stripEditableClassificationLead(value, templateMode),
    purpose,
  );
  return stripped.length === 0 ? value : stripped;
}

function interpolate(
  value: string,
  variables: TemplateRenderVariables,
): string {
  const rendered = value.replace(
    TEMPLATE_TOKEN_PATTERN,
    (_token, name: TemplateVariable) => variables[name],
  );
  if (containsUnsafeVisibleCodePoint(rendered)) {
    throw new TemplateRenderError(
      'RENDERED_MESSAGE_INVALID',
      'Rendered notification wording contains unsafe invisible or control text.',
    );
  }
  if (containsReservedRendererMarker(rendered)) {
    throw new TemplateRenderError(
      'RESERVED_MARKER',
      'Classification markers [INCIDENT] and [DRILL] are owned by the renderer.',
    );
  }
  return rendered;
}

function renderEditableInterior(
  value: string,
  variables: TemplateRenderVariables,
  templateMode: TemplateMode,
  purpose: NotificationPurpose,
): string {
  assertEditableTextSafe(value);
  return interpolate(
    stripMatchingLegacyLeads(value, templateMode, purpose),
    variables,
  );
}

/** Measures AWS SMS encoding units and multipart behavior without sending. */
export function measureSmsLength(value: string): SmsLengthMeasurement {
  let septets = 0;
  let gsm = true;
  for (const character of value) {
    if (GSM_BASIC_CHARACTERS.has(character)) {
      septets += 1;
    } else if (GSM_EXTENSION_CHARACTERS.has(character)) {
      septets += 2;
    } else {
      gsm = false;
      break;
    }
  }
  if (gsm) {
    return Object.freeze({
      encoding: 'gsm-7' as const,
      units: septets,
      parts: septets <= 160 ? 1 : Math.ceil(septets / 153),
      exceedsProviderLimit:
        septets > SMS_GSM_MAX_SEPTETS ||
        value.length > SMS_CONTRACT_MAX_CODE_UNITS,
    });
  }
  const codeUnits = value.length;
  return Object.freeze({
    encoding: 'ucs-2' as const,
    units: codeUnits,
    parts: codeUnits <= 70 ? 1 : Math.ceil(codeUnits / 67),
    exceedsProviderLimit:
      codeUnits > SMS_UCS2_MAX_CODE_UNITS ||
      codeUnits > SMS_CONTRACT_MAX_CODE_UNITS,
  });
}

function smsFitsOnePart(value: string): boolean {
  const measurement = measureSmsLength(value);
  return (
    !measurement.exceedsProviderLimit &&
    (measurement.encoding === 'gsm-7'
      ? measurement.units <= SINGLE_PART_GSM_MAX_SEPTETS
      : measurement.units <= SINGLE_PART_UCS2_MAX_CODE_UNITS)
  );
}

function retainGraphemePrefix(
  editable: string,
  candidateFits: (retained: string) => boolean,
): string {
  let retained = '';
  for (const segment of new Intl.Segmenter('en', {
    granularity: 'grapheme',
  }).segment(editable)) {
    const candidate = `${retained}${segment.segment}`;
    if (!candidateFits(candidate)) {
      break;
    }
    retained = candidate;
  }

  retained = retained.trimEnd();
  const finalWhitespace = Math.max(
    retained.lastIndexOf(' '),
    retained.lastIndexOf('\n'),
  );
  if (finalWhitespace >= Math.floor(retained.length * 0.7)) {
    retained = retained.slice(0, finalWhitespace).trimEnd();
  }
  return retained;
}

/** Truncation can remove only configurable interior, never either frame edge. */
function frameVisibleField(
  frame: RendererFrame,
  editable: string,
  maxCodeUnits: number,
): string {
  const complete = `${frame.prefix}${editable}${frame.suffix}`;
  if (complete.length <= maxCodeUnits) {
    return complete;
  }
  const fixedLength =
    frame.prefix.length + frame.suffix.length + TRUNCATION_MARKER.length;
  if (fixedLength > maxCodeUnits) {
    throw new TemplateRenderError(
      'RENDERED_MESSAGE_INVALID',
      'The renderer-owned notification frame exceeds channel limits.',
    );
  }
  const retained = retainGraphemePrefix(
    editable,
    (candidate) => fixedLength + candidate.length <= maxCodeUnits,
  );
  return `${frame.prefix}${retained}${TRUNCATION_MARKER}${frame.suffix}`;
}

/** Keeps both renderer-owned frame edges visible in one complete SMS part. */
function frameSmsBody(frame: RendererFrame, editableBody: string): string {
  const complete = `${frame.prefix}${editableBody}${frame.suffix}`;
  if (smsFitsOnePart(complete)) {
    return complete;
  }

  const retained = retainGraphemePrefix(editableBody, (candidate) =>
    smsFitsOnePart(
      `${frame.prefix}${candidate}${TRUNCATION_MARKER}${frame.suffix}`,
    ),
  );
  const truncated = `${frame.prefix}${retained}${TRUNCATION_MARKER}${frame.suffix}`;
  if (!smsFitsOnePart(truncated)) {
    throw new TemplateRenderError(
      'RENDERED_MESSAGE_INVALID',
      'The renderer-owned SMS notification frame exceeds one-part limits.',
    );
  }
  return truncated;
}

function parseRenderedMessage(value: unknown): RenderedMessage {
  const parsed = RenderedMessageSchema.safeParse(value);
  if (!parsed.success) {
    throw new TemplateRenderError(
      'RENDERED_MESSAGE_INVALID',
      'Rendered notification wording does not satisfy the channel contract.',
    );
  }
  return parsed.data;
}

/**
 * Renders one channel while deriving both immutable frame boundaries outside
 * all administrator-configurable wording.
 */
export function renderMessageTemplate(
  input: RenderMessageTemplateInput,
): RenderedMessage {
  const classification = classificationFor(input.eventKind);
  const variables = validatedVariables(
    input.variables,
    classification.templateMode,
  );
  const templateSet = MessageTemplateSetSchema.parse({
    templateMode: input.template.templateMode,
    purpose: input.template.purpose,
    push:
      input.template.channel === 'push'
        ? input.template
        : {
            channel: 'push',
            templateMode: input.template.templateMode,
            purpose: input.template.purpose,
            classificationMarker: input.template.classificationMarker,
            title: 'validation-only',
            body: 'validation-only',
          },
    email:
      input.template.channel === 'email'
        ? input.template
        : {
            channel: 'email',
            templateMode: input.template.templateMode,
            purpose: input.template.purpose,
            classificationMarker: input.template.classificationMarker,
            subject: 'validation-only',
            textBody: 'validation-only',
          },
    sms:
      input.template.channel === 'sms'
        ? input.template
        : {
            channel: 'sms',
            templateMode: input.template.templateMode,
            purpose: input.template.purpose,
            classificationMarker: input.template.classificationMarker,
            body: 'validation-only',
          },
  });
  const template = templateSet[input.template.channel];
  if (
    template.templateMode !== classification.templateMode ||
    template.classificationMarker !== classification.marker
  ) {
    throw new TemplateRenderError(
      'CLASSIFICATION_MISMATCH',
      'Event kind, template mode, and classification marker must agree.',
    );
  }

  const frame = rendererOwnedFrame(classification, template.purpose);
  const common = {
    eventKind: input.eventKind,
    templateMode: classification.templateMode,
    purpose: template.purpose,
    classificationMarker: classification.marker,
  } as const;
  const renderInterior = (value: string) =>
    renderEditableInterior(
      value,
      variables,
      classification.templateMode,
      template.purpose,
    );

  switch (template.channel) {
    case 'push':
      return parseRenderedMessage({
        ...common,
        channel: 'push',
        title: frameVisibleField(
          frame,
          renderInterior(template.title),
          RENDERED_FIELD_LIMITS.pushTitle,
        ),
        body: frameVisibleField(
          frame,
          renderInterior(template.body),
          RENDERED_FIELD_LIMITS.pushBody,
        ),
      });
    case 'email':
      return parseRenderedMessage({
        ...common,
        channel: 'email',
        subject: frameVisibleField(
          frame,
          renderInterior(template.subject),
          RENDERED_FIELD_LIMITS.emailSubject,
        ),
        textBody: frameVisibleField(
          frame,
          renderInterior(template.textBody),
          RENDERED_FIELD_LIMITS.emailBody,
        ),
      });
    case 'sms':
      return parseRenderedMessage({
        ...common,
        channel: 'sms',
        body: frameSmsBody(frame, renderInterior(template.body)),
      });
  }
}

/** Renders exactly one push, email, and SMS payload in stable channel order. */
export function renderTemplateSet(
  input: RenderTemplateSetInput,
): readonly [RenderedMessage, RenderedMessage, RenderedMessage] {
  const templates = MessageTemplateSetSchema.parse(input.templates);
  return Object.freeze([
    renderMessageTemplate({
      eventKind: input.eventKind,
      template: templates.push,
      variables: input.variables,
    }),
    renderMessageTemplate({
      eventKind: input.eventKind,
      template: templates.email,
      variables: input.variables,
    }),
    renderMessageTemplate({
      eventKind: input.eventKind,
      template: templates.sms,
      variables: input.variables,
    }),
  ]);
}
