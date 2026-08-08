import {
  MessageTemplateSetSchema,
  RenderedMessageSchema,
  TimestampSchema,
  type EventKind,
  type MessageTemplateSet,
  type NotificationChannel,
  type RenderedMessage,
  type TemplateMode,
  type TemplateVariable,
} from '@psd-eoc/contracts';

const CLASSIFICATION_MARKER_PATTERN = /\[(?:INCIDENT|DRILL)\]/iu;
const TEMPLATE_TOKEN_PATTERN = /\{\{(site|eventType|startTime|initiator)\}\}/gu;
const SMS_CONTRACT_MAX_CODE_UNITS = 1_000;
const SINGLE_PART_GSM_MAX_SEPTETS = 160;
const SINGLE_PART_UCS2_MAX_CODE_UNITS = 70;

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

/** Structured, trusted values accepted by the closed contract token grammar. */
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

function classificationFor(eventKind: EventKind): Readonly<{
  templateMode: TemplateMode;
  marker: 'INCIDENT' | 'DRILL';
}> {
  return eventKind === 'incident'
    ? Object.freeze({ templateMode: 'real', marker: 'INCIDENT' })
    : Object.freeze({ templateMode: 'drill', marker: 'DRILL' });
}

function containsUnsafeVisibleCodePoint(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x09 ||
      (codePoint >= 0x0b && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      (codePoint >= 0x2060 && codePoint <= 0x206f) ||
      codePoint === 0xfeff
    );
  });
}

function validateDisplayVariable(
  name: Exclude<TemplateVariable, 'startTime'>,
  value: string,
): string {
  if (
    value.length === 0 ||
    value.length > 500 ||
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
  if (CLASSIFICATION_MARKER_PATTERN.test(value.normalize('NFKC'))) {
    throw new TemplateRenderError(
      'RESERVED_MARKER',
      'Classification markers are owned by the renderer.',
    );
  }
  return value;
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

function validatedVariables(
  variables: TemplateRenderVariables,
): TemplateRenderVariables {
  return Object.freeze({
    site: validateDisplayVariable('site', variables.site),
    eventType: validateDisplayVariable('eventType', variables.eventType),
    startTime: formatNotificationStartTime(variables.startTime),
    initiator: validateDisplayVariable('initiator', variables.initiator),
  });
}

function assertRendererOwnsMarkers(value: string): void {
  if (containsUnsafeVisibleCodePoint(value)) {
    throw new TemplateRenderError(
      'RENDERED_MESSAGE_INVALID',
      'Editable template wording contains unsafe invisible or control text.',
    );
  }
  if (CLASSIFICATION_MARKER_PATTERN.test(value.normalize('NFKC'))) {
    throw new TemplateRenderError(
      'RESERVED_MARKER',
      'Editable template wording cannot contain a reserved classification marker.',
    );
  }
}

function assertClassificationLanguage(
  value: string,
  templateMode: TemplateMode,
): void {
  const normalized = value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\bisn(?:['’])?t\b/gu, 'is not');
  if (templateMode === 'real') {
    const withoutReinforcingNegation = normalized.replace(
      /\b(?:(?:not|never)\s+(?:a\s+|an\s+)?|no\s+)(?:drill|test|training(?:\s+(?:exercise|message))?|practice|exercise|simulation|rehearsal|mock(?:\s+(?:incident|message))?|fake(?:\s+(?:incident|alert))?)\b/gu,
      '',
    );
    if (
      /\b(?:drill|test|training|practice|exercise|simulat\w*|rehearsal|mock|fake|(?:not|never)\s+(?:a\s+|an\s+)?(?:(?:real|actual|live)\s+)?(?:incident|emergency|alert))\b/u.test(
        withoutReinforcingNegation,
      )
    ) {
      throw new TemplateRenderError(
        'CLASSIFICATION_MISMATCH',
        'Real-incident wording cannot contradict its real classification.',
      );
    }
  }
  if (templateMode === 'drill') {
    const withoutExplicitNegation = normalized
      .replace(
        /\b(?:not|never)\s+(?:a\s+|an\s+)?(?:(?:real|actual|live)\s+)?(?:incident|emergency|alert)(?:\s+(?:alert|all-clear))?\b/gu,
        '',
      )
      .replace(/\bemergency\s+assistance\b/gu, '');
    if (
      /\b(?:(?:(?:not|never)\s+(?:a\s+|an\s+)?|no\s+)(?:drill|test|training|practice|exercise|simulation|rehearsal)|(?:real|actual|live|genuine)\s+(?:incident|emergency|alert|event)|(?:this|message|alert|event)\s+is\s+(?:a\s+|an\s+)?(?:(?:real|actual|live|genuine)\s+)?(?:incident|emergency|alert)|this\s+is\s+(?:real|actual|live)|emergency\s+(?:alert|incident|message))\b/u.test(
        withoutExplicitNegation,
      )
    ) {
      throw new TemplateRenderError(
        'CLASSIFICATION_MISMATCH',
        'Drill wording cannot claim to be a real incident.',
      );
    }
  }
}

function assertEventTypeNameClassification(
  value: string,
  templateMode: TemplateMode,
): void {
  const normalized = value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\b(?:isn't|isn’t|isnt)\b/gu, 'is not');
  const visiblyDrillNamed =
    /\b(?:drill|test|training|practice|exercise|simulat\w*|mock|rehearsal)\b/u.test(
      normalized,
    );
  const deniesDrillClassification =
    /\b(?:(?:not|never)\s+(?:a\s+|an\s+)?|no\s+)(?:drill|test|training|practice|exercise|simulat\w*|mock|rehearsal)\b/u.test(
      normalized,
    );
  if (
    (templateMode === 'real' && visiblyDrillNamed) ||
    (templateMode === 'drill' &&
      (!visiblyDrillNamed || deniesDrillClassification))
  ) {
    throw new TemplateRenderError(
      'CLASSIFICATION_MISMATCH',
      'The event-type name must visibly match its immutable real-or-drill mode.',
    );
  }
}

function stripEditableClassificationLead(
  value: string,
  templateMode: TemplateMode,
): string {
  return templateMode === 'real'
    ? value.replace(
        /^REAL\s+INCIDENT(?:\s*[-:—]\s*|\s+(?=(?:ACTIVATION|ALL-CLEAR|REACTIVATION)\b))/iu,
        '',
      )
    : value.replace(
        /^(?:DRILL\s*[-—]\s*)?TRAINING\s+ONLY(?:\s*[-.:—]\s*|\s+(?=(?:ACTIVATION|ALL-CLEAR|REACTIVATION)\b))/iu,
        '',
      );
}

function interpolate(
  value: string,
  variables: TemplateRenderVariables,
): string {
  assertRendererOwnsMarkers(value);
  const rendered = value.replace(
    TEMPLATE_TOKEN_PATTERN,
    (_token, name: TemplateVariable) => variables[name],
  );
  assertRendererOwnsMarkers(rendered);
  return rendered;
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

function truncateVisibleField(
  prefix: string,
  editable: string,
  maxCodeUnits: number,
): string {
  const complete = `${prefix}${editable}`;
  if (complete.length <= maxCodeUnits) {
    return complete;
  }
  const suffix = '...';
  const budget = maxCodeUnits - prefix.length - suffix.length;
  if (budget < 1) {
    throw new TemplateRenderError(
      'RENDERED_MESSAGE_INVALID',
      'The renderer-owned classification prefix exceeds channel limits.',
    );
  }
  let retained = '';
  for (const segment of new Intl.Segmenter('en', {
    granularity: 'grapheme',
  }).segment(editable)) {
    if (retained.length + segment.segment.length > budget) {
      break;
    }
    retained += segment.segment;
  }
  retained = retained.trimEnd();
  const finalWhitespace = Math.max(
    retained.lastIndexOf(' '),
    retained.lastIndexOf('\n'),
  );
  if (finalWhitespace >= Math.floor(retained.length * 0.7)) {
    retained = retained.slice(0, finalWhitespace).trimEnd();
  }
  return `${prefix}${retained}${suffix}`;
}

/** Keeps the renderer-owned classification visible in one complete SMS part. */
function truncateSmsBody(prefix: string, editableBody: string): string {
  const complete = `${prefix}${editableBody}`;
  if (smsFitsOnePart(complete)) {
    return complete;
  }

  const suffix = '...';
  const segments = [
    ...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(
      editableBody,
    ),
  ].map((segment) => segment.segment);
  let retained = '';
  for (const segment of segments) {
    const candidate = `${prefix}${retained}${segment}${suffix}`;
    if (!smsFitsOnePart(candidate)) {
      break;
    }
    retained += segment;
  }

  retained = retained.trimEnd();
  const finalWhitespace = retained.lastIndexOf(' ');
  if (finalWhitespace >= Math.floor(retained.length * 0.7)) {
    retained = retained.slice(0, finalWhitespace).trimEnd();
  }
  const truncated = `${prefix}${retained}${suffix}`;
  if (!smsFitsOnePart(truncated)) {
    throw new TemplateRenderError(
      'RENDERED_MESSAGE_INVALID',
      'The renderer-owned SMS classification prefix exceeds channel limits.',
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
 * Renders one channel while deriving, prefixing, and validating classification
 * outside all administrator-editable wording.
 */
export function renderMessageTemplate(
  input: RenderMessageTemplateInput,
): RenderedMessage {
  const variables = validatedVariables(input.variables);
  const classification = classificationFor(input.eventKind);
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

  const prefix =
    classification.templateMode === 'real'
      ? '[INCIDENT] REAL INCIDENT: '
      : '[DRILL] TRAINING ONLY: ';
  const common = {
    eventKind: input.eventKind,
    templateMode: classification.templateMode,
    purpose: template.purpose,
    classificationMarker: classification.marker,
  } as const;
  assertEventTypeNameClassification(
    variables.eventType,
    classification.templateMode,
  );

  switch (template.channel) {
    case 'push': {
      assertClassificationLanguage(template.title, classification.templateMode);
      assertClassificationLanguage(template.body, classification.templateMode);
      const title = interpolate(
        stripEditableClassificationLead(
          template.title,
          classification.templateMode,
        ),
        variables,
      );
      const body = interpolate(
        stripEditableClassificationLead(
          template.body,
          classification.templateMode,
        ),
        variables,
      );
      return parseRenderedMessage({
        ...common,
        channel: 'push',
        title: truncateVisibleField(
          prefix,
          title,
          RENDERED_FIELD_LIMITS.pushTitle,
        ),
        body: truncateVisibleField(
          prefix,
          body,
          RENDERED_FIELD_LIMITS.pushBody,
        ),
      });
    }
    case 'email': {
      assertClassificationLanguage(
        template.subject,
        classification.templateMode,
      );
      assertClassificationLanguage(
        template.textBody,
        classification.templateMode,
      );
      const subject = interpolate(
        stripEditableClassificationLead(
          template.subject,
          classification.templateMode,
        ),
        variables,
      );
      const textBody = interpolate(
        stripEditableClassificationLead(
          template.textBody,
          classification.templateMode,
        ),
        variables,
      );
      return parseRenderedMessage({
        ...common,
        channel: 'email',
        subject: truncateVisibleField(
          prefix,
          subject,
          RENDERED_FIELD_LIMITS.emailSubject,
        ),
        textBody: truncateVisibleField(
          prefix,
          textBody,
          RENDERED_FIELD_LIMITS.emailBody,
        ),
      });
    }
    case 'sms': {
      assertClassificationLanguage(template.body, classification.templateMode);
      const editableBody = interpolate(
        stripEditableClassificationLead(
          template.body,
          classification.templateMode,
        ),
        variables,
      );
      return parseRenderedMessage({
        ...common,
        channel: 'sms',
        body: truncateSmsBody(prefix, editableBody),
      });
    }
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
