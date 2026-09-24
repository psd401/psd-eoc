import { describe, expect, test } from 'bun:test';

import {
  readSyntheticGroupConfiguration,
  SyntheticGroupConfigurationError,
  describeSyntheticGroupOutcome,
} from './bootstrap-synthetic-groups';

function configuration(value: unknown): Record<string, string> {
  return { PSD_EOC_SYNTHETIC_GROUPS: JSON.stringify(value) };
}

describe('synthetic group configuration', () => {
  test('reads a configured group', () => {
    expect(
      readSyntheticGroupConfiguration(
        configuration([
          { facilityCode: 'ESC', members: ['canary@example.invalid'] },
        ]),
      ),
    ).toEqual([
      {
        facilityCode: 'ESC',
        displayName: 'Synthetic test recipients',
        members: ['canary@example.invalid'],
      },
    ]);
  });

  test('absent configuration is not an error', () => {
    expect(readSyntheticGroupConfiguration({})).toEqual([]);
    expect(
      readSyntheticGroupConfiguration({ PSD_EOC_SYNTHETIC_GROUPS: '  ' }),
    ).toEqual([]);
  });

  test('refuses a member at a domain that could resolve', () => {
    // The property that makes a synthetic activation safe by construction: a
    // real address cannot be configured as a synthetic recipient, so the
    // health check cannot be pointed at a person by editing configuration.
    for (const member of [
      'someone@anytownschools.org',
      'someone@gmail.com',
      'someone@example.invalid.co',
      'someone@notexample.com',
    ]) {
      expect(() =>
        readSyntheticGroupConfiguration(
          configuration([{ facilityCode: 'ESC', members: [member] }]),
        ),
      ).toThrow(SyntheticGroupConfigurationError);
    }
  });

  test('accepts every reserved domain RFC 2606 and 6761 set aside', () => {
    for (const member of [
      'canary@example.invalid',
      'canary@anything.example',
      'canary@host.test',
      'canary@box.localhost',
      'canary@example.com',
      'canary@example.net',
      'canary@example.org',
      'canary@sub.example.com',
    ]) {
      expect(
        readSyntheticGroupConfiguration(
          configuration([{ facilityCode: 'ESC', members: [member] }]),
        )[0]?.members,
      ).toEqual([member]);
    }
  });

  test('never repeats a rejected address back', () => {
    // A refused address is still an address, and a deploy log is not the place
    // for one. The message names the rule instead.
    let message = '';
    try {
      readSyntheticGroupConfiguration(
        configuration([
          { facilityCode: 'ESC', members: ['realperson@anytownschools.org'] },
        ]),
      );
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).not.toContain('realperson');
    expect(message).not.toContain('anytownschools.org');
    expect(message).toContain('reserved domain');
  });

  test('refuses two groups for the same facility', () => {
    expect(() =>
      readSyntheticGroupConfiguration(
        configuration([
          { facilityCode: 'ESC', members: ['a@example.invalid'] },
          { facilityCode: 'ESC', members: ['b@example.invalid'] },
        ]),
      ),
    ).toThrow(/same facility more than once/u);
  });

  test('refuses a group with no members', () => {
    // An empty synthetic group makes a test activation resolve to nobody,
    // which reads as a broken health check rather than missing configuration.
    expect(() =>
      readSyntheticGroupConfiguration(
        configuration([{ facilityCode: 'ESC', members: [] }]),
      ),
    ).toThrow(SyntheticGroupConfigurationError);
  });

  test('refuses malformed JSON and unknown keys', () => {
    expect(() =>
      readSyntheticGroupConfiguration({ PSD_EOC_SYNTHETIC_GROUPS: '{oops' }),
    ).toThrow(/must be a JSON array/u);
    expect(() =>
      readSyntheticGroupConfiguration(
        configuration([
          {
            facilityCode: 'ESC',
            members: ['a@example.invalid'],
            grantedRole: 'admin',
          },
        ]),
      ),
    ).toThrow(SyntheticGroupConfigurationError);
  });

  test('refuses a lower-case facility code', () => {
    expect(() =>
      readSyntheticGroupConfiguration(
        configuration([
          { facilityCode: 'esc', members: ['a@example.invalid'] },
        ]),
      ),
    ).toThrow(SyntheticGroupConfigurationError);
  });

  test('summarises without naming an address', () => {
    expect(
      describeSyntheticGroupOutcome({
        configured: 0,
        created: [],
        existing: [],
      }),
    ).toBe('No synthetic groups are configured; none were created.');
    expect(
      describeSyntheticGroupOutcome({
        configured: 2,
        created: ['ESC'],
        existing: ['synthetic-phs'],
      }),
    ).toBe('Created 1 of 2 configured synthetic groups: ESC.');
    expect(
      describeSyntheticGroupOutcome({
        configured: 2,
        created: [],
        existing: ['synthetic-esc', 'synthetic-phs'],
      }),
    ).toBe('All 2 configured synthetic groups already exist.');
  });
});
