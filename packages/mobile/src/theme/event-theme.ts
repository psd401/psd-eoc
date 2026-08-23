import {
  getEventClassificationPresentation,
  type EventKind,
  type TemplateMode,
} from '@psd-eoc/contracts';

/**
 * Visual tokens for the immutable real-versus-drill classification.
 *
 * The visible word and icon are deliberate safety signals in addition to
 * color, so classification never depends on color perception alone.
 */
export interface EventThemeTokens {
  readonly kind: EventKind;
  readonly mode: TemplateMode;
  readonly classificationWord: string;
  readonly explanation: string;
  readonly icon: {
    readonly name: string;
    readonly glyph: string;
  };
  readonly colors: {
    readonly pageBackground: string;
    readonly surface: string;
    readonly textPrimary: string;
    readonly textMuted: string;
    readonly bannerBackground: string;
    readonly onBanner: string;
    readonly border: string;
  };
}

/** Single source of truth for classification styling across mobile screens. */
function tokensFor(kind: EventKind, mode: TemplateMode): EventThemeTokens {
  const presentation = getEventClassificationPresentation({
    kind,
    templateMode: mode,
  });
  return Object.freeze({
    kind,
    mode,
    classificationWord: presentation.label,
    explanation: presentation.explanation,
    icon: presentation.icon,
    colors: presentation.colors,
  });
}

export const EVENT_THEME_TOKENS = Object.freeze({
  real: tokensFor('incident', 'real'),
  drill: tokensFor('drill', 'drill'),
}) satisfies Readonly<Record<TemplateMode, EventThemeTokens>>;

/** Returns the complete, canonical visual treatment for an event mode. */
export function getEventTheme(
  mode: TemplateMode,
  kind: EventKind = mode === 'real' ? 'incident' : 'drill',
): EventThemeTokens {
  const defaults = EVENT_THEME_TOKENS[mode];
  return defaults.kind === kind ? defaults : tokensFor(kind, mode);
}
