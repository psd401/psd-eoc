const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export const EVENT_ROOM_PLAYWRIGHT_STORAGE_STATE_PATH =
  '/tmp/psd-eoc-issue16-storage-state.json';
export const EVENT_ROOM_PLAYWRIGHT_FIXTURE_PATH =
  '/tmp/psd-eoc-issue16-fixture.json';
export const EVENT_ROOM_PLAYWRIGHT_CHANNEL_STATE_PATH =
  '/tmp/psd-eoc-issue16-channel-state.json';

/**
 * Fails closed before issue #16 tests can migrate, seed, or mutate a database.
 * Remote test services require an explicit opt-in and every database name must
 * end in `_test` or `-test` so an ordinary production URL cannot be reused.
 */
export function requireSyntheticEventRoomTestDatabaseUrl(
  value: string | undefined,
  allowRemote = process.env.PSD_EOC_ALLOW_REMOTE_TEST_DATABASE === 'true',
): string {
  if (value === undefined || value.length === 0) {
    throw new Error('TEST_DATABASE_URL is required for event-room tests.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error('TEST_DATABASE_URL must name a synthetic test database.');
  }
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    parsed.hostname.length === 0 ||
    !/^[A-Za-z0-9_-]+[-_]test$/u.test(databaseName) ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    (!LOOPBACK_HOSTS.has(parsed.hostname) && !allowRemote)
  ) {
    throw new Error(
      'TEST_DATABASE_URL must target a loopback PostgreSQL database whose name ends in _test; remote test databases require explicit opt-in.',
    );
  }
  return value;
}
