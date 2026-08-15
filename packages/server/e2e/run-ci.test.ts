import { readFile } from 'node:fs/promises';

import { expect, test } from 'bun:test';

test('uses the supervised Bun event-room browser gate', async () => {
  const source = await readFile(new URL('run-ci.ts', import.meta.url), 'utf8');
  const eventRoomCommandStart = source.indexOf(
    "label: 'late join, text, location, photo, and lifecycle journeys'",
  );
  const followingCommandStart = source.indexOf(
    "label: 'event-type configuration happy path and axe proof'",
  );

  expect(eventRoomCommandStart).toBeGreaterThan(-1);
  expect(followingCommandStart).toBeGreaterThan(eventRoomCommandStart);
  const eventRoomCommand = source.slice(
    eventRoomCommandStart,
    followingCommandStart,
  );
  expect(eventRoomCommand).toContain(
    "'packages/server/app/(app)/events/[id]/event-room.playwright-gate.test.ts'",
  );
  expect(eventRoomCommand).toContain(
    "'runs the owned browser suite when the synthetic database is configured'",
  );
  expect(eventRoomCommand).toContain('timeoutMs: EVENT_ROOM_GATE_TIMEOUT_MS');
  expect(eventRoomCommand).not.toContain('playwright.config.ts');
});
