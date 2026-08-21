/**
 * Refuses a change that rewrites migration history.
 *
 * A migration file is a record of something that already happened. Drizzle
 * records a SHA-256 of each file in `drizzle.__drizzle_migrations` when it
 * applies it, and `PgDialect.migrate` decides what to run by comparing journal
 * timestamps — it writes that hash and never reads it again. So a file can be
 * edited after it has been applied and nothing in this repository, or in
 * drizzle, will say a word. The database and the file simply stop agreeing.
 *
 * That is not hypothetical. `4500da33` swept the words "exploration smoke" out
 * of the tree and caught `0019_retire_exploration_fixture.sql` on the way past,
 * rewriting one comment line of a migration that had been applied to production
 * ten hours earlier. The SQL was untouched and nothing broke, which is exactly
 * why it went unnoticed until someone compared the recorded hash by hand.
 *
 * Adding a migration is always allowed. Editing or deleting one that the base
 * branch already carries is not, and neither is altering a journal entry that
 * already exists — the journal may only grow.
 *
 * Usage: bun scripts/check-applied-migrations.ts <base-ref> <head-ref>
 */
import { spawnSync } from 'node:child_process';

const MIGRATIONS_PREFIX = 'packages/server/drizzle/migrations/';
const JOURNAL_PATH = `${MIGRATIONS_PREFIX}meta/_journal.json`;
const OVERRIDE_TRAILER = 'Migration-History-Override';

interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

function git(...args: readonly string[]): string {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.trim() || 'unknown error'}`,
    );
  }
  return result.stdout;
}

/**
 * The merge base, so a branch that is merely behind `main` is not blamed for
 * migrations it has not seen yet.
 */
function mergeBase(base: string, head: string): string {
  return git('merge-base', base, head).trim();
}

function readJournalAt(ref: string): readonly JournalEntry[] {
  const result = spawnSync('git', ['show', `${ref}:${JOURNAL_PATH}`], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  const parsed: unknown = JSON.parse(result.stdout);
  const entries = (parsed as { entries?: unknown }).entries;
  return Array.isArray(entries) ? (entries as readonly JournalEntry[]) : [];
}

function describeEntry(entry: JournalEntry): string {
  return JSON.stringify({
    idx: entry.idx,
    version: entry.version,
    when: entry.when,
    tag: entry.tag,
    breakpoints: entry.breakpoints,
  });
}

/** Returns the stated reason when a commit in the range claims the override. */
function readOverride(base: string, head: string): string | undefined {
  const log = git('log', '--format=%B', `${base}..${head}`);
  for (const line of log.split('\n')) {
    const match = new RegExp(`^${OVERRIDE_TRAILER}:\\s*(.+)$`, 'u').exec(
      line.trim(),
    );
    const reason = match?.[1]?.trim();
    if (reason !== undefined && reason.length > 0) return reason;
  }
  return undefined;
}

function checkMigrationFiles(base: string, head: string): string[] {
  // Rename detection off: a renamed migration is a delete plus an add, and both
  // halves are worth reporting by their real names.
  const output = git(
    'diff',
    '--no-renames',
    '--name-status',
    '--diff-filter=MD',
    base,
    head,
    '--',
    `${MIGRATIONS_PREFIX}*.sql`,
  );
  return output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [status, path] = line.split('\t');
      const verb = status === 'D' ? 'deleted' : 'modified';
      return `${path ?? line} was ${verb}`;
    });
}

function checkJournalEntries(base: string, head: string): string[] {
  const before = readJournalAt(base);
  const after = readJournalAt(head);
  const afterByIdx = new Map(after.map((entry) => [entry.idx, entry]));
  const problems: string[] = [];
  for (const entry of before) {
    const current = afterByIdx.get(entry.idx);
    if (current === undefined) {
      problems.push(`journal entry ${String(entry.idx)} (${entry.tag}) was removed`);
      continue;
    }
    if (describeEntry(current) !== describeEntry(entry)) {
      problems.push(
        `journal entry ${String(entry.idx)} changed from ${describeEntry(entry)} to ${describeEntry(current)}`,
      );
    }
  }
  return problems;
}

const [, , baseRef, headRef] = process.argv;
if (baseRef === undefined || headRef === undefined) {
  console.error(
    'Usage: bun scripts/check-applied-migrations.ts <base-ref> <head-ref>',
  );
  process.exit(2);
}

const base = mergeBase(baseRef, headRef);
const problems = [
  ...checkMigrationFiles(base, headRef),
  ...checkJournalEntries(base, headRef),
];

if (problems.length === 0) {
  console.info(
    'Applied migrations are untouched: this change only adds to the chain.',
  );
  process.exit(0);
}

// There is one honest reason to edit an applied migration: restoring it to the
// text that actually ran, which is what repairing 0019 required. That is rare
// enough to be stated on the commit rather than configured once and forgotten.
const override = readOverride(base, headRef);
if (override !== undefined) {
  console.warn('This change rewrites migration history:\n');
  for (const problem of problems) console.warn(`  - ${problem}`);
  console.warn(`\nAllowed by ${OVERRIDE_TRAILER}: ${override}`);
  process.exit(0);
}

console.error('This change rewrites migration history:\n');
for (const problem of problems) console.error(`  - ${problem}`);
console.error(
  [
    '',
    'A migration already on the base branch has been applied to a database that',
    'recorded its hash, and drizzle never re-runs it. Editing the file makes the',
    'repository stop describing what actually ran; it does not change any database.',
    '',
    'Add a new migration instead. If you are deliberately restoring a file to the',
    'text that was applied, put this trailer on the commit that does it:',
    '',
    `  ${OVERRIDE_TRAILER}: why this edit is the record, not a rewrite`,
  ].join('\n'),
);
process.exit(1);
