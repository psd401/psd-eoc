import {
  getEventClassificationPresentation,
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
const WHITESPACE_PATTERN = /\s/u;
const COMBINING_MARK_PATTERN = /\p{Mark}/u;
const SMS_CONTRACT_MAX_CODE_UNITS = 1_000;
const SINGLE_PART_GSM_MAX_SEPTETS = 160;
const SINGLE_PART_UCS2_MAX_CODE_UNITS = 70;
const TRUNCATION_MARKER = '...';
const SAFE_CONTEXT_FALLBACKS = Object.freeze({
  site: 'Recorded site',
  initiator: 'Recorded initiator',
});

/**
 * Unicode 17.0 TR39 MA sources whose mark-insensitive skeleton is a
 * substring of INCIDENT or DRILL. EMPTY is the one source whose mapped target
 * consists only of ignored marks. This closed renderer-local table is derived
 * from https://www.unicode.org/Public/17.0.0/security/confusables.txt; runtime
 * rendering never fetches it. Source SHA-256:
 * 091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a.
 */
const RESERVED_MARKER_CONFUSABLE_CODE_POINTS = Object.freeze({
  C: Object.freeze([
    0x00a2, 0x00c7, 0x00e7, 0x023c, 0x03f2, 0x03f9, 0x0421, 0x0441, 0x04aa,
    0x04ab, 0x1004, 0x105a, 0x13df, 0x1d04, 0x20a1, 0x2102, 0x212d, 0x216d,
    0x217d, 0x2ca4, 0x2ca5, 0xa4da, 0xabaf, 0xff23, 0xff43, 0x102a2, 0x10302,
    0x10415, 0x1043d, 0x1051c, 0x118e9, 0x118f2, 0x1ccd8, 0x1d402, 0x1d41c,
    0x1d436, 0x1d450, 0x1d46a, 0x1d484, 0x1d49e, 0x1d4b8, 0x1d4d2, 0x1d4ec,
    0x1d520, 0x1d554, 0x1d56e, 0x1d588, 0x1d5a2, 0x1d5bc, 0x1d5d6, 0x1d5f0,
    0x1d60a, 0x1d624, 0x1d63e, 0x1d658, 0x1d672, 0x1d68c, 0x1f16e, 0x1f74c,
  ]),
  D: Object.freeze([
    0x00d0, 0x0110, 0x0111, 0x0189, 0x018c, 0x0256, 0x0257, 0x0501, 0x13a0,
    0x13e7, 0x146f, 0x15de, 0x15ea, 0x20ab, 0x2145, 0x2146, 0x216e, 0x217e,
    0xa4d2, 0xa4d3, 0x1ccd9, 0x1d403, 0x1d41d, 0x1d437, 0x1d451, 0x1d46b,
    0x1d485, 0x1d49f, 0x1d4b9, 0x1d4d3, 0x1d4ed, 0x1d507, 0x1d521, 0x1d53b,
    0x1d555, 0x1d56f, 0x1d589, 0x1d5a3, 0x1d5bd, 0x1d5d7, 0x1d5f1, 0x1d60b,
    0x1d625, 0x1d63f, 0x1d659, 0x1d673, 0x1d68d,
  ]),
  E: Object.freeze([
    0x011a, 0x011b, 0x0246, 0x0247, 0x0395, 0x0415, 0x0435, 0x04bd, 0x04bf,
    0x13ac, 0x212e, 0x212f, 0x2130, 0x2147, 0x22ff, 0x2d39, 0xa4f0, 0xab32,
    0xff25, 0xff45, 0x10286, 0x118a6, 0x118ae, 0x1ccda, 0x1d404, 0x1d41e,
    0x1d438, 0x1d452, 0x1d46c, 0x1d486, 0x1d4d4, 0x1d4ee, 0x1d508, 0x1d522,
    0x1d53c, 0x1d556, 0x1d570, 0x1d58a, 0x1d5a4, 0x1d5be, 0x1d5d8, 0x1d5f2,
    0x1d60c, 0x1d626, 0x1d640, 0x1d65a, 0x1d674, 0x1d68e, 0x1d6ac, 0x1d6e6,
    0x1d720, 0x1d75a, 0x1d794,
  ]),
  EMPTY: Object.freeze([0x109e]),
  L: Object.freeze([
    0x0031, 0x0049, 0x007c, 0x0131, 0x0141, 0x0142, 0x0196, 0x0197, 0x019a,
    0x01c0, 0x01cf, 0x01d0, 0x0268, 0x0269, 0x026a, 0x026b, 0x026d, 0x02db,
    0x037a, 0x0399, 0x03b9, 0x0406, 0x0456, 0x04c0, 0x04cf, 0x0582, 0x05c0,
    0x05d5, 0x05df, 0x0625, 0x0627, 0x0661, 0x0673, 0x06f1, 0x07ca, 0x13a5,
    0x13de, 0x14aa, 0x16c1, 0x1d7b, 0x1d7c, 0x1fbe, 0x2110, 0x2111, 0x2112,
    0x2113, 0x2139, 0x2148, 0x2160, 0x216c, 0x2170, 0x217c, 0x2223, 0x2373,
    0x2378, 0x23fd, 0x24db, 0x2c92, 0x2c93, 0x2cd0, 0x2d4f, 0xa4e1, 0xa4f2,
    0xa647, 0xab75, 0xfd3c, 0xfd3d, 0xfe87, 0xfe88, 0xfe8d, 0xfe8e, 0xff29,
    0xff49, 0xff4c, 0xffe8, 0x1028a, 0x10309, 0x10320, 0x1041b, 0x10526,
    0x118a3, 0x118b2, 0x118c3, 0x11dda, 0x11de1, 0x16eaa, 0x16f16, 0x16f28,
    0x1ccde, 0x1cce1, 0x1ccf1, 0x1d22a, 0x1d408, 0x1d40b, 0x1d422, 0x1d425,
    0x1d43c, 0x1d43f, 0x1d456, 0x1d459, 0x1d470, 0x1d473, 0x1d48a, 0x1d48d,
    0x1d4be, 0x1d4c1, 0x1d4d8, 0x1d4db, 0x1d4f2, 0x1d4f5, 0x1d50f, 0x1d526,
    0x1d529, 0x1d540, 0x1d543, 0x1d55a, 0x1d55d, 0x1d574, 0x1d577, 0x1d58e,
    0x1d591, 0x1d5a8, 0x1d5ab, 0x1d5c2, 0x1d5c5, 0x1d5dc, 0x1d5df, 0x1d5f6,
    0x1d5f9, 0x1d610, 0x1d613, 0x1d62a, 0x1d62d, 0x1d644, 0x1d647, 0x1d65e,
    0x1d661, 0x1d678, 0x1d67b, 0x1d692, 0x1d695, 0x1d6a4, 0x1d6b0, 0x1d6ca,
    0x1d6ea, 0x1d704, 0x1d724, 0x1d73e, 0x1d75e, 0x1d778, 0x1d798, 0x1d7b2,
    0x1d7cf, 0x1d7d9, 0x1d7e3, 0x1d7ed, 0x1d7f7, 0x1e8c7, 0x1ee00, 0x1ee80,
    0x1fbf1,
  ]),
  LL: Object.freeze([0x01c1, 0x05f0, 0x2016, 0x2161, 0x2171, 0x2225, 0x10199]),
  LLL: Object.freeze([0x2162, 0x2172]),
  N: Object.freeze([
    0x014b, 0x019d, 0x019e, 0x0273, 0x039d, 0x03b7, 0x0572, 0x0578, 0x057c,
    0x1d70, 0x2115, 0x2c9a, 0xa4e0, 0xff2e, 0x1018e, 0x10513, 0x1cce3, 0x1d40d,
    0x1d427, 0x1d441, 0x1d45b, 0x1d475, 0x1d48f, 0x1d4a9, 0x1d4c3, 0x1d4dd,
    0x1d4f7, 0x1d511, 0x1d52b, 0x1d55f, 0x1d579, 0x1d593, 0x1d5ad, 0x1d5c7,
    0x1d5e1, 0x1d5fb, 0x1d615, 0x1d62f, 0x1d649, 0x1d663, 0x1d67d, 0x1d697,
    0x1d6b4, 0x1d6c8, 0x1d6ee, 0x1d702, 0x1d728, 0x1d73c, 0x1d762, 0x1d776,
    0x1d79c, 0x1d7b0,
  ]),
  R: Object.freeze([
    0x01a6, 0x024d, 0x027c, 0x027d, 0x0433, 0x0493, 0x13a1, 0x13d2, 0x1587,
    0x1d26, 0x1d72, 0x211b, 0x211c, 0x211d, 0x2c85, 0xa4e3, 0xab47, 0xab48,
    0xab81, 0x104b4, 0x16f35, 0x1cce7, 0x1d216, 0x1d411, 0x1d42b, 0x1d445,
    0x1d45f, 0x1d479, 0x1d493, 0x1d4c7, 0x1d4e1, 0x1d4fb, 0x1d52f, 0x1d563,
    0x1d57d, 0x1d597, 0x1d5b1, 0x1d5cb, 0x1d5e5, 0x1d5ff, 0x1d619, 0x1d633,
    0x1d64d, 0x1d667, 0x1d681, 0x1d69b,
  ]),
  T: Object.freeze([
    0x0166, 0x0167, 0x01ad, 0x01ae, 0x021a, 0x023e, 0x03a4, 0x0422, 0x04ac,
    0x13a2, 0x1d75, 0x20ae, 0x22a4, 0x2361, 0x27d9, 0x2ca6, 0xa4d4, 0xff34,
    0x10297, 0x102b1, 0x10315, 0x118bc, 0x16f0a, 0x1cce9, 0x1d413, 0x1d42d,
    0x1d447, 0x1d461, 0x1d47b, 0x1d495, 0x1d4af, 0x1d4c9, 0x1d4e3, 0x1d4fd,
    0x1d517, 0x1d531, 0x1d54b, 0x1d565, 0x1d57f, 0x1d599, 0x1d5b3, 0x1d5cd,
    0x1d5e7, 0x1d601, 0x1d61b, 0x1d635, 0x1d64f, 0x1d669, 0x1d683, 0x1d69d,
    0x1d6bb, 0x1d6f5, 0x1d72f, 0x1d769, 0x1d7a3, 0x1f768,
  ]),
});

const RESERVED_MARKER_SKELETONS = new Set(['LNCLDENT', 'DRLLL']);
const RESERVED_MARKER_SKELETON_PREFIXES = new Set(
  [...RESERVED_MARKER_SKELETONS].flatMap((skeleton) =>
    [...skeleton].map((_character, index) => skeleton.slice(0, index + 1)),
  ),
);

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
  label: string;
}>;

type RendererFrame = Readonly<{
  prefix: string;
  suffix: string;
}>;

function classificationFor(eventKind: EventKind): Classification {
  const templateMode = eventKind === 'incident' ? 'real' : 'drill';
  const presentation = getEventClassificationPresentation({
    kind: eventKind,
    templateMode,
  });
  return Object.freeze({
    templateMode,
    marker: eventKind === 'incident' ? 'INCIDENT' : 'DRILL',
    // ASCII keeps training/test SMS in the 160-septet GSM alphabet instead of
    // forcing the much shorter 70-character UCS-2 limit solely for an em dash.
    label: presentation.label.replaceAll(' — ', ' - '),
  });
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
  return Object.freeze({
    prefix: `[${classification.marker}] ${classification.label} - ${purposeLabel(purpose)}: `,
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

function buildReservedMarkerConfusableMap(
  groups: Readonly<Record<string, readonly number[]>>,
): ReadonlyMap<number, string> {
  const map = new Map<number, string>();
  for (const [skeleton, codePoints] of Object.entries(groups)) {
    for (const codePoint of codePoints) {
      map.set(codePoint, skeleton === 'EMPTY' ? '' : skeleton);
    }
  }
  return map;
}

const RESERVED_MARKER_CONFUSABLE_MAP = buildReservedMarkerConfusableMap(
  RESERVED_MARKER_CONFUSABLE_CODE_POINTS,
);

function canonicalAsciiMarkerLetters(value: string): string {
  return value
    .replace(/[a-z]/gu, (character) => character.toLocaleUpperCase('en-US'))
    .replace(/[IL]/gu, 'L');
}

function reservedMarkerContribution(character: string): string {
  const sourceCodePoint = character.codePointAt(0);
  const protectedValue =
    sourceCodePoint === undefined
      ? character
      : (RESERVED_MARKER_CONFUSABLE_MAP.get(sourceCodePoint) ?? character);
  let skeleton = '';
  for (const normalized of protectedValue.normalize('NFKD')) {
    if (
      WHITESPACE_PATTERN.test(normalized) ||
      COMBINING_MARK_PATTERN.test(normalized)
    ) {
      continue;
    }
    const normalizedCodePoint = normalized.codePointAt(0);
    const mapped =
      normalizedCodePoint === undefined
        ? normalized
        : (RESERVED_MARKER_CONFUSABLE_MAP.get(normalizedCodePoint) ??
          normalized);
    for (const mappedCharacter of mapped.normalize('NFKD')) {
      if (
        !WHITESPACE_PATTERN.test(mappedCharacter) &&
        !COMBINING_MARK_PATTERN.test(mappedCharacter)
      ) {
        skeleton += mappedCharacter;
      }
    }
  }
  return canonicalAsciiMarkerLetters(skeleton);
}

/** Exact or TR39-confusable bracketed classification markers stay owned. */
function containsReservedRendererMarker(value: string): boolean {
  let activeSkeletons: string[] = [];
  for (const character of value) {
    const compatible = character.normalize('NFKC');
    if (compatible === ']') {
      if (
        activeSkeletons.some((skeleton) =>
          RESERVED_MARKER_SKELETONS.has(skeleton),
        )
      ) {
        return true;
      }
      activeSkeletons = [];
      continue;
    }
    const contribution = reservedMarkerContribution(character);
    if (contribution.length > 0) {
      activeSkeletons = activeSkeletons
        .map((skeleton) => skeleton + contribution)
        .filter((skeleton) => RESERVED_MARKER_SKELETON_PREFIXES.has(skeleton));
    }
    if (compatible === '[') {
      activeSkeletons.push('');
    }
  }
  return false;
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
  templateMode: TemplateMode,
): string {
  const replaceTokens = (values: TemplateRenderVariables) =>
    value.replace(
      TEMPLATE_TOKEN_PATTERN,
      (_token, name: TemplateVariable) => values[name],
    );
  const rendered = replaceTokens(variables);
  if (containsUnsafeVisibleCodePoint(rendered)) {
    throw new TemplateRenderError(
      'RENDERED_MESSAGE_INVALID',
      'Rendered notification wording contains unsafe invisible or control text.',
    );
  }
  if (containsReservedRendererMarker(rendered)) {
    const recovered = replaceTokens({
      ...variables,
      site: SAFE_CONTEXT_FALLBACKS.site,
      eventType:
        templateMode === 'real'
          ? 'Configured response'
          : 'Configured drill response',
      initiator: SAFE_CONTEXT_FALLBACKS.initiator,
    });
    if (
      containsUnsafeVisibleCodePoint(recovered) ||
      containsReservedRendererMarker(recovered)
    ) {
      throw new TemplateRenderError(
        'RESERVED_MARKER',
        'Classification markers [INCIDENT] and [DRILL] are owned by the renderer.',
      );
    }
    return recovered;
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
    templateMode,
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
