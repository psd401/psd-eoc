import type { TemplateMode } from '@psd-eoc/contracts';

/**
 * Visual tokens for the immutable real-versus-drill classification.
 *
 * The visible word and icon are deliberate safety signals in addition to
 * color, so classification never depends on color perception alone.
 */
export interface EventThemeTokens {
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
export const EVENT_THEME_TOKENS = {
  real: {
    mode: 'real',
    classificationWord: 'REAL INCIDENT',
    explanation: 'This visual state is reserved for a real incident.',
    icon: {
      name: 'warning',
      glyph: '!',
    },
    colors: {
      pageBackground: '#FFF7F7',
      surface: '#FFFFFF',
      textPrimary: '#2B0B0E',
      textMuted: '#6F3137',
      bannerBackground: '#7A1020',
      onBanner: '#FFFFFF',
      border: '#B42332',
    },
  },
  drill: {
    mode: 'drill',
    classificationWord: 'DRILL — PRACTICE',
    explanation: 'This visual state is for a drill or synthetic test only.',
    icon: {
      name: 'practice-pencil',
      glyph: '✎',
    },
    colors: {
      pageBackground: '#F0F9FF',
      surface: '#FFFFFF',
      textPrimary: '#082F49',
      textMuted: '#334E68',
      bannerBackground: '#075985',
      onBanner: '#FFFFFF',
      border: '#0369A1',
    },
  },
} as const satisfies Readonly<Record<TemplateMode, EventThemeTokens>>;

/** Returns the complete, canonical visual treatment for an event mode. */
export function getEventTheme(mode: TemplateMode): EventThemeTokens {
  return EVENT_THEME_TOKENS[mode];
}
