import { describe, expect, test } from 'bun:test';

import { readThreatContext } from '../src/stack/config';

function context(value: unknown): { tryGetContext(key: string): unknown } {
  return {
    tryGetContext(key: string): unknown {
      return key === 'psdEoc:threats' ? value : undefined;
    },
  };
}

const VALID = Object.freeze({
  key: 'gun-firearm',
  name: 'Gun / Firearm',
  requiresDetail: false,
  active: true,
});

describe('psdEoc:threats context', () => {
  test('passes a district list the deploy-time bootstrap will also accept', () => {
    expect(readThreatContext(context([VALID]))).toBe(JSON.stringify([VALID]));
    expect(readThreatContext(context(undefined))).toBe('');
    expect(
      readThreatContext(context([{ key: 'other', name: 'Other' }])),
    ).toContain('"key":"other"');
  });

  test('refuses at synth exactly what the bootstrap would refuse at deploy', () => {
    // Each of these reaches the bootstrap's own Zod schema and fails there.
    // Catching them during `cdk synth` turns a failed deployment into a
    // failed build.
    for (const entry of [
      { ...VALID, key: 'Not Kebab' },
      { ...VALID, key: `${'a'.repeat(101)}` },
      { ...VALID, name: '   ' },
      { ...VALID, name: 'a'.repeat(161) },
      { ...VALID, requiresDetail: 'yes' },
      { ...VALID, active: 'true' },
    ]) {
      expect(() => readThreatContext(context([entry]))).toThrow();
    }
    expect(() => readThreatContext(context({ key: 'other' }))).toThrow();
  });
});
