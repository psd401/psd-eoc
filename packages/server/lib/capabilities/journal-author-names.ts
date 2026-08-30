import { ActorSchema } from '@psd-eoc/contracts';
import { eq, inArray } from 'drizzle-orm';

import type { DatabaseQuery, PostgresDatabase } from '../../db/client';
import { agents, users } from '../../db/schema';
import type { journalEntries } from '../../db/schema';

type JournalRow = typeof journalEntries.$inferSelect;

/**
 * Resolves the display name for each entry's author, one query per actor kind
 * rather than one per entry.
 *
 * Read-time resolution is deliberate. A name copied into the entry when it was
 * written would keep showing a person's former name in a record the district
 * has to be able to read back years later; resolving here means the timeline
 * always shows the current name for the account that acted.
 *
 * A disabled account still resolves. The entry is history, and who wrote it
 * does not stop being true when their access ends.
 */
export async function resolveAuthorDisplayNames(
  database: DatabaseQuery | PostgresDatabase,
  rows: readonly JournalRow[],
): Promise<ReadonlyMap<string, string>> {
  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const row of rows) {
    const author = ActorSchema.safeParse(row.author);
    if (!author.success) continue;
    if (author.data.kind === 'human') userIds.add(author.data.userId);
    if (author.data.kind === 'agent') agentIds.add(author.data.agentId);
  }
  const resolved = new Map<string, string>();
  if (userIds.size > 0) {
    const found = await database
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    for (const row of found) resolved.set(row.id, row.displayName);
  }
  if (agentIds.size > 0) {
    const found = await database
      .select({ id: agents.id, displayName: agents.displayName })
      .from(agents)
      .where(inArray(agents.id, [...agentIds]));
    for (const row of found) resolved.set(row.id, row.displayName);
  }
  return resolved;
}

/** The name to show for one entry's author, or null when there is none. */
export function authorDisplayNameForRow(
  row: JournalRow,
  resolved: ReadonlyMap<string, string>,
): string | null {
  const author = ActorSchema.safeParse(row.author);
  if (!author.success) return null;
  switch (author.data.kind) {
    case 'human':
      return resolved.get(author.data.userId) ?? null;
    case 'agent':
      return resolved.get(author.data.agentId) ?? null;
    case 'system':
      return null;
  }
}

/**
 * The display name for one actor, for the entry a mutation returns.
 *
 * A posted entry comes back from the write and is rendered before any read
 * refreshes it, so without this the person who just posted an update sees the
 * fallback label on their own entry until the page reloads -- the one place
 * the name matters most.
 */
export async function resolveActorDisplayName(
  database: DatabaseQuery | PostgresDatabase,
  actorValue: unknown,
): Promise<string | null> {
  const actor = ActorSchema.safeParse(actorValue);
  if (!actor.success) return null;
  switch (actor.data.kind) {
    case 'human': {
      const [row] = await database
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, actor.data.userId))
        .limit(1);
      return row?.displayName ?? null;
    }
    case 'agent': {
      const [row] = await database
        .select({ displayName: agents.displayName })
        .from(agents)
        .where(eq(agents.id, actor.data.agentId))
        .limit(1);
      return row?.displayName ?? null;
    }
    case 'system':
      return null;
  }
}
