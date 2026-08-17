import { describe, expect, test } from 'bun:test';

import { TemplateModeSchema } from '@psd-eoc/contracts';

import { EVENT_THEME_TOKENS, getEventTheme } from './event-theme';

function relativeLuminance(color: string): number {
  if (!/^#[0-9a-f]{6}$/iu.test(color)) {
    throw new Error(`Expected a six-digit hex color, received ${color}`);
  }

  const channels = [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('event theme tokens', () => {
  test('covers every canonical template mode', () => {
    expect(Object.keys(EVENT_THEME_TOKENS).sort()).toEqual(
      [...TemplateModeSchema.options].sort(),
    );

    for (const mode of TemplateModeSchema.options) {
      expect(getEventTheme(mode).mode).toBe(mode);
    }
  });

  test('distinguishes real and drill with color, visible wording, and icon', () => {
    const real = getEventTheme('real');
    const drill = getEventTheme('drill');

    expect(real.colors.bannerBackground).not.toBe(
      drill.colors.bannerBackground,
    );
    expect(real.colors.pageBackground).not.toBe(drill.colors.pageBackground);
    expect(real.classificationWord).toBe('REAL INCIDENT');
    expect(drill.classificationWord).toBe('DRILL — PRACTICE');
    expect(drill.explanation).toBe(
      'This visual state is for a drill or synthetic test only.',
    );
    expect(real.icon.name).not.toBe(drill.icon.name);
    expect(real.icon.glyph).not.toBe(drill.icon.glyph);
  });

  test('keeps classification banners at WCAG AA text contrast', () => {
    for (const mode of TemplateModeSchema.options) {
      const { colors } = getEventTheme(mode);
      expect(
        contrastRatio(colors.bannerBackground, colors.onBanner),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(colors.surface, colors.textPrimary),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(colors.surface, colors.textMuted),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
