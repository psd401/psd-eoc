import { describe, expect, test } from 'bun:test';

import {
  classifyDrift,
  evaluateCheck,
  parseDrift,
} from './check-expo-compatibility';

const PATCH_ONLY = `Some dependencies are incompatible with the installed expo version:
  expo@57.0.22 - expected version: ~57.0.23
  expo-image-picker@57.0.17 - expected version: ~57.0.18
  @expo/vector-icons@15.0.2 - expected version: ^15.0.3
Your project may not work correctly until you install the expected versions of the packages.`;

describe('Expo compatibility check', () => {
  test('passes when the raw check passes', () => {
    expect(evaluateCheck(0, 'Dependencies are up to date\n', '')).toEqual({
      ok: true,
      message: 'Expo dependencies are up to date.',
    });
  });

  test('parses scoped and unscoped drift lines with their ranges', () => {
    expect(parseDrift(PATCH_ONLY)).toEqual([
      {
        name: 'expo',
        installed: '57.0.22',
        expected: '~57.0.23',
        level: 'patch',
      },
      {
        name: 'expo-image-picker',
        installed: '57.0.17',
        expected: '~57.0.18',
        level: 'patch',
      },
      {
        name: '@expo/vector-icons',
        installed: '15.0.2',
        expected: '^15.0.3',
        level: 'patch',
      },
    ]);
  });

  test('classifies by the expected range minimum', () => {
    expect(classifyDrift('57.0.22', '~57.0.23')).toBe('patch');
    expect(classifyDrift('57.0.22', '57.0.30')).toBe('patch');
    expect(classifyDrift('57.0.22', '~57.1.0')).toBe('incompatible');
    expect(classifyDrift('57.0.22', '^58.0.0')).toBe('incompatible');
    expect(classifyDrift('0.81.4', '>=0.82.0')).toBe('incompatible');
  });

  test('warns without failing when every drift is a patch release', () => {
    const verdict = evaluateCheck(1, PATCH_ONLY, '');
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain('newer patch releases for 3 package(s)');
    expect(verdict.message).toContain(
      'expo@57.0.22 (expected ~57.0.23) [patch]',
    );
    expect(verdict.message).toContain('bunx expo install --fix');
  });

  test('fails when any package is behind the expected minor or major', () => {
    const verdict = evaluateCheck(
      1,
      `${PATCH_ONLY}\n  expo-router@57.0.21 - expected version: ~58.0.0\n`,
      '',
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('1 package(s) differ');
    expect(verdict.message).toContain(
      'expo-router@57.0.21 (expected ~58.0.0) [incompatible]',
    );
    expect(verdict.message).toContain('distribution-config.test.ts');
  });

  test('fails on a non-zero exit that reports no drift at all', () => {
    const verdict = evaluateCheck(2, '', 'Error: could not reach the registry');
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('exited with status 2');
    expect(verdict.message).toContain('could not reach the registry');
  });
});
