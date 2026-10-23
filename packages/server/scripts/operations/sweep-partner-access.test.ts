import { describe, expect, test } from 'bun:test';

import { runFromCommandLine } from './sweep-partner-access';

describe('the partner-access sweep task', () => {
  test('does nothing, and opens no database, when partner access is unconfigured', async () => {
    const logged: string[] = [];
    const original = console.info;
    console.info = (line: string) => {
      logged.push(line);
    };
    try {
      // No database variables at all: a database open would throw.
      await runFromCommandLine({
        PSD_EOC_PARTNER_USER_POOL_ID: 'UNCONFIGURED',
      });
    } finally {
      console.info = original;
    }
    expect(logged.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: 'partner-access-sweep-skipped', reason: 'unconfigured' },
    ]);
  });
});
