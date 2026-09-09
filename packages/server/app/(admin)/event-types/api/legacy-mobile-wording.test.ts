import { describe, expect, test } from 'bun:test';

import { defaultMessageTemplateCatalog } from '../../../../lib/notify/default-templates';
import { legacyMobileWording } from './legacy-mobile-wording';

describe('legacy mobile wording shim', () => {
  test('rewrites only the two lifecycle tokens, everywhere they appear', () => {
    const catalog = defaultMessageTemplateCatalog('drill');
    const rewritten = legacyMobileWording({
      latestVersion: { templates: catalog, name: 'Lockdown Drill' },
      count: 3,
      flags: [true, null],
    });
    const text = JSON.stringify(rewritten);
    expect(text).not.toContain('{{updatedBy}}');
    expect(text).not.toContain('{{updatedAt}}');
    expect(rewritten.latestVersion.templates['all-clear'].push.body).toBe(
      'Completed by {{initiator}} at {{startTime}}. Open PSD EOC for current information.',
    );
    // Activation wording never carried the tokens and is unchanged.
    expect(rewritten.latestVersion.templates.activation).toEqual(
      catalog.activation,
    );
    expect(rewritten.latestVersion.name).toBe('Lockdown Drill');
    expect(rewritten.count).toBe(3);
    expect(rewritten.flags).toEqual([true, null]);
  });

  test('is a no-op for wording that only uses the original five tokens', () => {
    const value = {
      body: 'Started by {{initiator}} at {{startTime}} at {{site}}.',
    };
    expect(legacyMobileWording(value)).toEqual(value);
  });
});
