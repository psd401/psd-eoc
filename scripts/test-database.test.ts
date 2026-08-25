import { describe, expect, test } from 'bun:test';

import {
  composeArguments,
  parseTestDatabaseCommand,
  testDatabaseProjectName,
} from './test-database';

describe('synthetic PostgreSQL helper', () => {
  test('starts only the repository-owned Compose service and waits for health', () => {
    expect(composeArguments('start', 'psd-eoc-fixture')).toEqual([
      'compose',
      '--project-name',
      'psd-eoc-fixture',
      '-f',
      'compose.test.yml',
      'up',
      '-d',
      '--wait',
    ]);
  });

  test('stops the repository-owned service and removes its synthetic data', () => {
    expect(composeArguments('stop', 'psd-eoc-fixture')).toEqual([
      'compose',
      '--project-name',
      'psd-eoc-fixture',
      '-f',
      'compose.test.yml',
      'down',
      '--volumes',
    ]);
  });

  test('rejects every unsupported operation', () => {
    expect(parseTestDatabaseCommand(['start'])).toBe('start');
    expect(() => parseTestDatabaseCommand(['restart'])).toThrow(/Usage/u);
    expect(() => parseTestDatabaseCommand([])).toThrow(/Usage/u);
  });

  test('isolates Compose resources by worktree parent', () => {
    expect(testDatabaseProjectName('/tmp/worktrees/c79c/psd-eoc')).toMatch(
      /^psd-eoc-c79c-[a-f0-9]{8}$/u,
    );
  });

  test('does not collide when two clones share a parent directory', () => {
    const first = testDatabaseProjectName('/tmp/repos/psd-eoc');
    const second = testDatabaseProjectName('/tmp/repos/psd-eoc-copy');
    expect(first).not.toBe(second);
    expect(testDatabaseProjectName('/tmp/repos/psd-eoc/')).toBe(first);
  });
});
