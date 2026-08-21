import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

/**
 * Proofs for the guard that refuses a change rewriting migration history.
 *
 * The guard exists because nothing else notices when an applied migration is
 * edited. That argument applies to the guard itself: a changed pathspec, a
 * tweaked trailer pattern, or an off-by-one in the journal comparison would
 * disarm it silently, and the failure would only surface the next time somebody
 * rewrote history and nobody was told.
 *
 * Each case builds its own throwaway repository rather than reaching into this
 * one's history, so the proofs keep working after the commits that inspired
 * them have scrolled away.
 */

const SCRIPT = join(import.meta.dir, 'check-applied-migrations.ts');
const MIGRATIONS = 'packages/server/drizzle/migrations';

interface RunResult {
  readonly status: number;
  readonly output: string;
}

let repository: string;

function git(...args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function journal(entries: readonly { idx: number; tag: string; when: number }[]): string {
  return `${JSON.stringify(
    {
      version: '7',
      dialect: 'postgresql',
      entries: entries.map((entry) => ({
        idx: entry.idx,
        version: '7',
        when: entry.when,
        tag: entry.tag,
        breakpoints: true,
      })),
    },
    null,
    2,
  )}\n`;
}

function write(relativePath: string, contents: string): void {
  const absolute = join(repository, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, contents, 'utf8');
}

function commit(message: string): void {
  git('add', '-A');
  git('commit', '-q', '-m', message);
}

function run(base: string, head: string): RunResult {
  const result = spawnSync('bun', [SCRIPT, base, head], {
    cwd: repository,
    encoding: 'utf8',
  });
  return {
    status: result.status ?? -1,
    output: `${result.stdout}${result.stderr}`,
  };
}

beforeEach(() => {
  repository = mkdtempSync(join(tmpdir(), 'psd-eoc-applied-migrations-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Migration Guard Test');
  git('config', 'commit.gpgsign', 'false');
  write(`${MIGRATIONS}/0000_first.sql`, '-- first\nselect 1;\n');
  write(`${MIGRATIONS}/0001_second.sql`, '-- second\nselect 2;\n');
  write(
    `${MIGRATIONS}/meta/_journal.json`,
    journal([
      { idx: 0, tag: '0000_first', when: 1_000 },
      { idx: 1, tag: '0001_second', when: 2_000 },
    ]),
  );
  commit('base: two applied migrations');
});

afterEach(() => {
  rmSync(repository, { force: true, recursive: true });
});

describe('a change that only grows the chain', () => {
  test('passes when a migration is added', () => {
    write(`${MIGRATIONS}/0002_third.sql`, '-- third\nselect 3;\n');
    write(
      `${MIGRATIONS}/meta/_journal.json`,
      journal([
        { idx: 0, tag: '0000_first', when: 1_000 },
        { idx: 1, tag: '0001_second', when: 2_000 },
        { idx: 2, tag: '0002_third', when: 3_000 },
      ]),
    );
    commit('add a migration');

    const result = run('main~1', 'main');
    expect(result.status).toBe(0);
    expect(result.output).toContain('only adds to the chain');
  });

  test('passes when nothing changed at all', () => {
    expect(run('main', 'main').status).toBe(0);
  });

  test('passes when the branch is merely behind the base', () => {
    // The merge base, not the base tip. Without it a branch that simply has not
    // caught up reads as having deleted every migration added since, and the
    // check would fail constantly and be turned off.
    write(`${MIGRATIONS}/0002_third.sql`, '-- third\nselect 3;\n');
    commit('base moves ahead');
    const result = run('main', 'main~1');
    expect(result.status).toBe(0);
  });
});

describe('a change that rewrites history', () => {
  test('refuses a modified migration and names it', () => {
    write(`${MIGRATIONS}/0001_second.sql`, '-- second, reworded\nselect 2;\n');
    commit('reword an applied migration');

    const result = run('main~1', 'main');
    expect(result.status).toBe(1);
    expect(result.output).toContain('0001_second.sql was modified');
  });

  test('refuses a deleted migration', () => {
    git('rm', '-q', `${MIGRATIONS}/0001_second.sql`);
    commit('delete an applied migration');

    const result = run('main~1', 'main');
    expect(result.status).toBe(1);
    expect(result.output).toContain('0001_second.sql was deleted');
  });

  test('refuses an altered journal entry', () => {
    write(
      `${MIGRATIONS}/meta/_journal.json`,
      journal([
        { idx: 0, tag: '0000_first', when: 1_000 },
        { idx: 1, tag: '0001_second', when: 2_001 },
      ]),
    );
    commit('restamp an applied journal entry');

    const result = run('main~1', 'main');
    expect(result.status).toBe(1);
    expect(result.output).toContain('journal entry 1 changed');
  });

  test('refuses a removed journal entry', () => {
    write(
      `${MIGRATIONS}/meta/_journal.json`,
      journal([{ idx: 0, tag: '0000_first', when: 1_000 }]),
    );
    commit('drop an applied journal entry');

    const result = run('main~1', 'main');
    expect(result.status).toBe(1);
    expect(result.output).toContain('journal entry 1');
    expect(result.output).toContain('was removed');
  });

  test('reports a rename as both a deletion and the file it names', () => {
    git('mv', `${MIGRATIONS}/0001_second.sql`, `${MIGRATIONS}/0001_renamed.sql`);
    commit('rename an applied migration');

    const result = run('main~1', 'main');
    expect(result.status).toBe(1);
    expect(result.output).toContain('0001_second.sql was deleted');
  });
});

describe('the override trailer', () => {
  test('allows the edit when a commit states its reason', () => {
    write(`${MIGRATIONS}/0001_second.sql`, '-- second, as applied\nselect 2;\n');
    commit(
      'restore 0001 to the applied text\n\nMigration-History-Override: restoring the bytes production recorded',
    );

    const result = run('main~1', 'main');
    expect(result.status).toBe(0);
    // Allowed, but still said out loud: the point is a record, not silence.
    expect(result.output).toContain('0001_second.sql was modified');
    expect(result.output).toContain(
      'Allowed by Migration-History-Override: restoring the bytes production recorded',
    );
  });

  test('ignores a trailer with no stated reason', () => {
    write(`${MIGRATIONS}/0001_second.sql`, '-- second, reworded\nselect 2;\n');
    commit('reword it\n\nMigration-History-Override:');

    expect(run('main~1', 'main').status).toBe(1);
  });

  test('ignores a trailer that predates the range', () => {
    // A reason given for an earlier, already-merged repair must not license a
    // later rewrite that nobody justified.
    write(`${MIGRATIONS}/0001_second.sql`, '-- second, as applied\nselect 2;\n');
    commit(
      'restore 0001\n\nMigration-History-Override: restoring the bytes production recorded',
    );
    write(`${MIGRATIONS}/0001_second.sql`, '-- second, reworded again\nselect 2;\n');
    commit('reword it again with no reason');

    expect(run('main~1', 'main').status).toBe(1);
  });
});

describe('invocation', () => {
  test('explains itself when the refs are missing', () => {
    const result = spawnSync('bun', [SCRIPT], {
      cwd: repository,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain('Usage:');
  });
});
