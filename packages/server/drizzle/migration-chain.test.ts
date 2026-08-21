import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { migrationsFolder } from './migrate';

/**
 * Structural guards on the migration folder.
 *
 * Every rule here is one that has already been broken once, silently. None of
 * them need a database: they are properties of the files, and they are checked
 * here so a migration that cannot work is rejected before it is merged rather
 * than after it has been deployed.
 */

const SNAPSHOT_PATTERN = /^(\d{4})_snapshot\.json$/u;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

interface Snapshot {
  readonly file: string;
  readonly idx: number;
  readonly id: string;
  readonly prevId: string;
  readonly version: string;
  readonly dialect: string;
}

function readJournal(): readonly JournalEntry[] {
  const parsed: unknown = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  );
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('The migration journal has no entries.');
  }
  return entries as readonly JournalEntry[];
}

/** Sorted the way drizzle-kit sorts them: lexically by file name. */
function readSnapshots(): readonly Snapshot[] {
  const metaFolder = join(migrationsFolder, 'meta');
  return readdirSync(metaFolder)
    .filter((name) => SNAPSHOT_PATTERN.test(name))
    .sort()
    .map((file) => {
      const parsed: unknown = JSON.parse(
        readFileSync(join(metaFolder, file), 'utf8'),
      );
      const record = parsed as Omit<Snapshot, 'file' | 'idx'>;
      return {
        file,
        idx: Number(SNAPSHOT_PATTERN.exec(file)?.[1]),
        id: record.id,
        prevId: record.prevId,
        version: record.version,
        dialect: record.dialect,
      };
    });
}

const journal = readJournal();
const snapshots = readSnapshots();
const sqlFiles = readdirSync(migrationsFolder)
  .filter((name) => name.endsWith('.sql'))
  .sort();

describe('the migration journal', () => {
  test('numbers its entries contiguously from zero', () => {
    expect(journal.map((entry) => entry.idx)).toEqual(
      journal.map((_, index) => index),
    );
  });

  test('gives every entry a timestamp greater than the one before it', () => {
    // This is the rule that decides whether a migration ever runs.
    // `PgDialect.migrate` reads the single highest `created_at` from
    // `drizzle.__drizzle_migrations` and applies a migration only when its
    // journal `when` exceeds that value. An entry stamped at or below the
    // highest already-applied timestamp is skipped on every database that is
    // up to date, forever, without an error.
    //
    // It is not hypothetical. Entries 0015-0023 carry timestamps a day apart
    // ending in 2026-08-23, so `db:generate`, which stamps the real current
    // time, produced entries that would never have run until real time passed
    // that date. 0024, 0025 and 0026 were each corrected by hand.
    const offenders = journal
      .slice(1)
      .map((entry, index) => ({ previous: journal[index], entry }))
      .filter(({ previous, entry }) => entry.when <= (previous?.when ?? 0))
      .map(
        ({ previous, entry }) =>
          `${entry.tag} (${String(entry.when)}) does not exceed ${previous?.tag ?? '?'} (${String(previous?.when)})`,
      );
    expect(offenders).toEqual([]);
  });

  test('has exactly one SQL file per entry and no others', () => {
    expect(sqlFiles).toEqual(journal.map((entry) => `${entry.tag}.sql`));
  });
});

describe('the snapshot chain', () => {
  test('has a snapshot for the newest journal entry', () => {
    // drizzle-kit does not consult the journal to find its diff baseline.
    // `prepareOutFolder` lists `meta/`, sorts the names, and
    // `preparePrevSnapshot` takes the last one. If the newest entry has no
    // snapshot, `db:generate` silently diffs `db/schema.ts` against whatever
    // older snapshot happens to sort last and emits a migration that recreates
    // everything dropped since.
    //
    // That is what happened between 0014 and 0023: nine hand-written
    // migrations landed with no snapshot beside them, and the next generated
    // migration would have recreated the fan-out tables and the
    // access-membership children that 0021 and 0023 had removed.
    const newest = journal.at(-1);
    const expected = `${String(newest?.idx).padStart(4, '0')}_snapshot.json`;
    expect(snapshots.at(-1)?.file).toBe(expected);
  });

  test('has no snapshot beyond the newest journal entry', () => {
    // A snapshot numbered past the journal sorts last and becomes the diff
    // baseline while nothing applies it — the same failure from the other
    // direction.
    const newestIdx = journal.at(-1)?.idx ?? -1;
    expect(snapshots.filter((snapshot) => snapshot.idx > newestIdx)).toEqual(
      [],
    );
  });

  test('names every snapshot after a journal entry', () => {
    const known = new Set(journal.map((entry) => entry.idx));
    expect(
      snapshots
        .filter((snapshot) => !known.has(snapshot.idx))
        .map((s) => s.file),
    ).toEqual([]);
  });

  test('links each snapshot to the one before it', () => {
    // Intermediate snapshots may be absent — 0002 and 0015-0022 are, because
    // those migrations were hand-written, and nothing reads an intermediate
    // snapshot. What must hold is that the ones present form a single chain in
    // sorted order, because that is the order drizzle-kit walks and a break
    // means a snapshot describes a schema no other snapshot leads to.
    const links = snapshots.map((snapshot, index) => ({
      file: snapshot.file,
      prevId: snapshot.prevId,
      expected: index === 0 ? ZERO_UUID : snapshots[index - 1]?.id,
    }));
    expect(
      links
        .filter((link) => link.prevId !== link.expected)
        .map((link) => link.file),
    ).toEqual([]);
  });

  test('gives every snapshot a distinct parent', () => {
    // drizzle-kit's own `check` refuses to run when two snapshots claim the
    // same parent, because it cannot tell which one continues the chain.
    const parents = snapshots.map((snapshot) => snapshot.prevId);
    expect(parents.length).toBe(new Set(parents).size);
  });

  test('keeps every snapshot on the dialect and version drizzle-kit expects', () => {
    expect(
      snapshots
        .filter(
          (snapshot) =>
            snapshot.version !== '7' || snapshot.dialect !== 'postgresql',
        )
        .map((snapshot) => snapshot.file),
    ).toEqual([]);
  });
});
