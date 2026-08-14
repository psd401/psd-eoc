import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  EVENT_ROOM_PLAYWRIGHT_RUN_CONTEXT_ENV,
  claimEventRoomPlaywrightRunContext,
  cleanupInterruptedEventRoomPlaywrightCoordinator,
  cleanupEventRoomPlaywrightRunAfterChildExit,
  cleanupReportedEventRoomPlaywrightRun,
  detectPriorEventRoomPlaywrightResidue,
  eventRoomPlaywrightDatabaseMarker,
  finalizeEventRoomPlaywrightWebServer,
  hasEventRoomPlaywrightSupervisorStoppingMarker,
  inspectEventRoomPlaywrightPortLease,
  prepareEventRoomPlaywrightServerWorkspace,
  readEventRoomPlaywrightWebServerIdentity,
  releaseEventRoomPlaywrightPortLease,
  releaseEventRoomPlaywrightPortLeaseIfOwned,
  requireCurrentEventRoomPlaywrightGateHeartbeat,
  requireEventRoomPlaywrightDatabaseOwnership,
  requireEventRoomPlaywrightRunContext,
  requireSyntheticEventRoomTestDatabaseUrl,
  resolveEventRoomPlaywrightRunContext,
  terminateInterruptedEventRoomPlaywrightWebServer,
  writeEventRoomPlaywrightCoordinatorIdentity,
  writeEventRoomPlaywrightGateHeartbeat,
  writeEventRoomPlaywrightSupervisorStopping,
  writeEventRoomPlaywrightWebServerIdentity,
} from './test-database';

const BASE_DATABASE_URL = 'postgresql://test:test@localhost:5432/psd_eoc_test';

function createSyntheticSourceWorkspace(): {
  readonly root: string;
  readonly server: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'psd-eoc-source-workspace-'));
  const server = join(root, 'packages', 'server');
  mkdirSync(join(server, 'app'), { recursive: true });
  mkdirSync(join(server, '.next'), { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"private":true}');
  writeFileSync(join(root, 'bun.lock'), 'synthetic lock');
  writeFileSync(join(root, 'tsconfig.base.json'), '{}');
  writeFileSync(
    join(server, 'package.json'),
    '{"name":"@psd-eoc/server","private":true}',
  );
  writeFileSync(
    join(server, 'tsconfig.json'),
    '{"extends":"../../tsconfig.base.json"}',
  );
  writeFileSync(join(server, 'next-env.d.ts'), 'shared generated metadata');
  writeFileSync(join(server, 'server.tsbuildinfo'), 'shared build metadata');
  writeFileSync(join(server, '.next', 'shared-build'), 'shared build output');
  writeFileSync(
    join(server, 'app', 'page.tsx'),
    'export default function Page() {}',
  );
  return { root, server };
}

describe('event-room synthetic database guard', () => {
  test('accepts IPv4, bracketed IPv6, and localhost loopback test databases', () => {
    for (const value of [
      'postgresql://test:test@127.0.0.1:5432/psd_eoc_test',
      'postgresql://test:test@[::1]:5432/psd_eoc_test',
      'postgresql://test:test@localhost:5432/psd-eoc-test',
    ]) {
      expect(requireSyntheticEventRoomTestDatabaseUrl(value, false)).toBe(
        value,
      );
    }
  });

  test('rejects remote IPv6, non-test names, and URL options by default', () => {
    for (const value of [
      'postgresql://test:test@[2001:db8::1]:5432/psd_eoc_test',
      'postgresql://test:test@localhost:5432/psd_eoc',
      'postgresql://test:test@localhost:5432/psd_eoc_test?sslmode=require',
    ]) {
      expect(() =>
        requireSyntheticEventRoomTestDatabaseUrl(value, false),
      ).toThrow();
    }
  });

  test('derives isolated database, files, and port from immutable run metadata', () => {
    const runId = randomUUID();
    const context = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      runId,
    );
    try {
      expect(context.databaseName).toBe(
        `psd_eoc_event_room_${runId.replaceAll('-', '')}_test`,
      );
      expect(new URL(context.databaseUrl).pathname).toBe(
        `/${context.databaseName}`,
      );
      expect(context.fixturePath.startsWith(`${context.runDirectory}/`)).toBe(
        true,
      );
      expect(
        context.storageStatePath.startsWith(`${context.runDirectory}/`),
      ).toBe(true);
      for (const path of [
        context.workspaceDirectory,
        context.serverDirectory,
        context.serverBuildDirectory,
        context.serverTsconfigPath,
        context.serverNextEnvPath,
        context.serverWorkspaceReadyPath,
        context.serverStoppedPath,
      ]) {
        expect(path.startsWith(`${context.runDirectory}${sep}`)).toBe(true);
      }
      for (const path of [
        context.gateHeartbeatPath,
        context.coordinatorIdentityPath,
        context.coordinatorChildExitPath,
        context.webServerIdentityPath,
        context.supervisorReadyPath,
        context.supervisorStoppingPath,
      ]) {
        expect(path.startsWith(`${context.supervisionDirectory}${sep}`)).toBe(
          true,
        );
      }
      expect(context.supervisionDirectory).not.toBe(context.runDirectory);
      expect(context.appPort).toBeGreaterThanOrEqual(20_000);
      expect(context.appPort).toBeLessThan(50_000);
      expect(requireEventRoomPlaywrightRunContext(context)).toEqual(context);
      expect(() =>
        requireEventRoomPlaywrightRunContext({
          ...context,
          databaseName: 'main',
        }),
      ).toThrow('altered');
    } finally {
      releaseEventRoomPlaywrightPortLease(context);
    }
  });

  test('binds disposable database ownership to the exact immutable run', () => {
    const context = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    try {
      const marker = eventRoomPlaywrightDatabaseMarker(context);
      expect(() =>
        requireEventRoomPlaywrightDatabaseOwnership(context, marker),
      ).not.toThrow();
      expect(() =>
        requireEventRoomPlaywrightDatabaseOwnership(context, null),
      ).toThrow('ownership marker');
      expect(() =>
        requireEventRoomPlaywrightDatabaseOwnership(
          context,
          marker.replace(context.runId, randomUUID()),
        ),
      ).toThrow('ownership marker');
    } finally {
      releaseEventRoomPlaywrightPortLease(context);
    }
  });

  test('separates current gate liveness from immutable coordinator identity', () => {
    const nonce = 'a'.repeat(64);
    const current = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const missing = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    try {
      const now = Date.now();
      writeEventRoomPlaywrightGateHeartbeat(current, process.pid, nonce, now);
      expect(
        requireCurrentEventRoomPlaywrightGateHeartbeat(
          current,
          process.pid,
          nonce,
          now,
        ),
      ).toBe(now);
      expect(() =>
        requireCurrentEventRoomPlaywrightGateHeartbeat(
          current,
          process.pid,
          'b'.repeat(64),
          now,
        ),
      ).toThrow('altered');
      expect(() =>
        requireCurrentEventRoomPlaywrightGateHeartbeat(
          current,
          process.pid,
          nonce,
          now + 2_001,
        ),
      ).toThrow('stale');
      expect(() =>
        requireCurrentEventRoomPlaywrightGateHeartbeat(
          missing,
          process.pid,
          nonce,
          now,
        ),
      ).toThrow('missing');
      writeEventRoomPlaywrightSupervisorStopping(current, process.pid, nonce);
      expect(
        hasEventRoomPlaywrightSupervisorStoppingMarker(
          current,
          process.pid,
          nonce,
        ),
      ).toBe(true);
      expect(() =>
        hasEventRoomPlaywrightSupervisorStoppingMarker(
          current,
          process.pid,
          'b'.repeat(64),
        ),
      ).toThrow('altered or replaced');
    } finally {
      rmSync(current.runDirectory, { force: true, recursive: true });
      rmSync(current.supervisionDirectory, { force: true, recursive: true });
      releaseEventRoomPlaywrightPortLeaseIfOwned(current);
      releaseEventRoomPlaywrightPortLeaseIfOwned(missing);
    }
  });

  test('a later run detects current and legacy marked residue without adopting name-only cleanup authority', () => {
    const nonce = 'a'.repeat(64);
    const current = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const stale = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const active = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const stopping = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const unmarked = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const legacy = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const leaseOnly = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const pendingHeartbeat = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const alteredLegacy = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    try {
      const now = Date.now();
      writeEventRoomPlaywrightGateHeartbeat(
        stale,
        process.pid,
        nonce,
        now - 2_001,
      );
      writeEventRoomPlaywrightGateHeartbeat(active, process.pid, nonce, now);
      mkdirSync(active.runDirectory, { recursive: true });
      writeFileSync(
        join(active.runDirectory, 'process-supervisor.json'),
        JSON.stringify({
          kind: 'psd-eoc-event-room-playwright-supervisor',
          version: 1,
          runId: active.runId,
          contextSha256: 'c'.repeat(64),
          ownerPid: process.pid,
          coordinatorNonce: randomUUID(),
        }),
      );
      writeEventRoomPlaywrightGateHeartbeat(
        stopping,
        process.pid,
        nonce,
        now - 2_001,
      );
      writeEventRoomPlaywrightSupervisorStopping(
        stopping,
        process.pid,
        nonce,
        now,
      );
      mkdirSync(unmarked.supervisionDirectory, { recursive: true });
      releaseEventRoomPlaywrightPortLease(unmarked);

      mkdirSync(legacy.runDirectory, { recursive: true });
      writeFileSync(
        join(legacy.runDirectory, 'process-supervisor.json'),
        JSON.stringify({
          kind: 'psd-eoc-event-room-playwright-supervisor',
          version: 1,
          runId: legacy.runId,
          contextSha256: 'd'.repeat(64),
          ownerPid: process.pid,
          coordinatorNonce: randomUUID(),
        }),
      );
      releaseEventRoomPlaywrightPortLease(legacy);

      const staleLeaseTime = new Date(now - 2_001);
      utimesSync(leaseOnly.portLeasePath, staleLeaseTime, staleLeaseTime);

      mkdirSync(alteredLegacy.runDirectory, { recursive: true });
      writeFileSync(
        join(alteredLegacy.runDirectory, 'process-supervisor.json'),
        JSON.stringify({
          kind: 'psd-eoc-event-room-playwright-supervisor',
          version: 1,
          runId: randomUUID(),
          contextSha256: 'e'.repeat(64),
          ownerPid: process.pid,
          coordinatorNonce: randomUUID(),
        }),
      );
      releaseEventRoomPlaywrightPortLease(alteredLegacy);

      expect(
        detectPriorEventRoomPlaywrightResidue(current, () => now),
      ).toContainEqual({ runId: stale.runId, reason: 'stale-heartbeat' });
      expect(
        detectPriorEventRoomPlaywrightResidue(current, () => now),
      ).not.toContainEqual({ runId: active.runId, reason: 'stale-heartbeat' });
      expect(
        detectPriorEventRoomPlaywrightResidue(current, () => now).some(
          ({ runId }) => runId === active.runId,
        ),
      ).toBe(false);
      expect(
        detectPriorEventRoomPlaywrightResidue(current, () => now).some(
          ({ runId }) => runId === unmarked.runId,
        ),
      ).toBe(false);
      expect(
        detectPriorEventRoomPlaywrightResidue(current, () => now).some(
          ({ runId }) => runId === stopping.runId,
        ),
      ).toBe(false);
      expect(
        detectPriorEventRoomPlaywrightResidue(current, () => now),
      ).toContainEqual({ runId: legacy.runId, reason: 'legacy-run-marker' });
      expect(
        detectPriorEventRoomPlaywrightResidue(current, () => now),
      ).toContainEqual({
        runId: leaseOnly.runId,
        reason: 'orphaned-port-lease',
      });
      expect(
        detectPriorEventRoomPlaywrightResidue(current, () => now).some(
          ({ runId }) => runId === alteredLegacy.runId,
        ),
      ).toBe(false);
      expect(
        detectPriorEventRoomPlaywrightResidue(current, () => now).some(
          ({ runId }) => runId === pendingHeartbeat.runId,
        ),
      ).toBe(false);
      expect(
        detectPriorEventRoomPlaywrightResidue(current, () => now + 35_001),
      ).toContainEqual({ runId: stopping.runId, reason: 'stale-heartbeat' });
      expect(existsSync(stale.gateHeartbeatPath)).toBe(true);
      expect(inspectEventRoomPlaywrightPortLease(stale)).toBe('owned');
      expect(
        existsSync(join(legacy.runDirectory, 'process-supervisor.json')),
      ).toBe(true);
      expect(inspectEventRoomPlaywrightPortLease(leaseOnly)).toBe('owned');
    } finally {
      for (const context of [
        current,
        stale,
        active,
        stopping,
        unmarked,
        legacy,
        leaseOnly,
        pendingHeartbeat,
        alteredLegacy,
      ]) {
        rmSync(context.runDirectory, { force: true, recursive: true });
        rmSync(context.supervisionDirectory, { force: true, recursive: true });
        releaseEventRoomPlaywrightPortLeaseIfOwned(context);
      }
    }
  });

  test('residue freshness uses time read after advancing heartbeat and lease evidence', () => {
    const nonce = 'b'.repeat(64);
    const current = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const heartbeatAdvanced = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const leaseAdvanced = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    try {
      const scanStartedAt = Date.now();
      const evidenceAdvancedAt = scanStartedAt + 1_000;
      writeEventRoomPlaywrightGateHeartbeat(
        heartbeatAdvanced,
        process.pid,
        nonce,
        evidenceAdvancedAt,
      );
      const advancedLeaseTime = new Date(evidenceAdvancedAt);
      utimesSync(
        leaseAdvanced.portLeasePath,
        advancedLeaseTime,
        advancedLeaseTime,
      );

      let clockReads = 0;
      const residue = detectPriorEventRoomPlaywrightResidue(current, () => {
        clockReads += 1;
        return clockReads === 1 ? scanStartedAt : evidenceAdvancedAt;
      });

      expect(clockReads).toBeGreaterThan(1);
      expect(
        residue.some(({ runId }) => runId === heartbeatAdvanced.runId),
      ).toBe(false);
      expect(residue.some(({ runId }) => runId === leaseAdvanced.runId)).toBe(
        false,
      );
    } finally {
      for (const context of [current, heartbeatAdvanced, leaseAdvanced]) {
        rmSync(context.runDirectory, { force: true, recursive: true });
        rmSync(context.supervisionDirectory, {
          force: true,
          recursive: true,
        });
        releaseEventRoomPlaywrightPortLeaseIfOwned(context);
      }
    }
  });

  test('wrong, missing, or stale coordinator identity never authorizes cleanup', async () => {
    const nonce = 'c'.repeat(64);
    const coordinatorPid = 424_242;
    const command = `${process.execPath} playwright.web-server.ts --coordinate ${nonce}`;
    const identity = {
      coordinatorPid,
      processGroupId: coordinatorPid,
      processStartedAt: 'Thu Aug 13 17:00:00 2026',
      commandHash: createHash('sha256').update(command).digest('hex'),
    } as const;
    const missing = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const wrong = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const stale = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    let authorized = false;
    const operations = {
      async inspectProcess() {
        return {
          processGroupId: coordinatorPid,
          startedAt: 'Thu Aug 13 16:59:59 2026',
          command,
        };
      },
      signalProcessGroup() {
        authorized = true;
      },
      signalProcess() {
        authorized = true;
      },
      async processGroupMembers() {
        authorized = true;
        return [];
      },
      async proveWebServerRunIdentity() {
        authorized = true;
        return false;
      },
      async waitForPortClose() {
        authorized = true;
      },
      async dropOwnedDatabase() {
        authorized = true;
      },
    };
    try {
      await expect(
        cleanupInterruptedEventRoomPlaywrightCoordinator(
          missing,
          {
            kind: 'psd-eoc-event-room-playwright-coordinator',
            version: 1,
            runId: missing.runId,
            leaseOwnerPid: missing.leaseOwnerPid,
            ...identity,
            supervisorNonceHash: createHash('sha256')
              .update(nonce)
              .digest('hex'),
          },
          nonce,
          operations,
        ),
      ).rejects.toThrow('identity is missing');
      expect(authorized).toBe(false);

      mkdirSync(wrong.runDirectory, { recursive: true });
      const wrongIdentity = writeEventRoomPlaywrightCoordinatorIdentity(
        wrong,
        identity,
        nonce,
      );
      writeFileSync(wrong.coordinatorIdentityPath, 'altered marker');
      await expect(
        cleanupInterruptedEventRoomPlaywrightCoordinator(
          wrong,
          wrongIdentity,
          nonce,
          operations,
        ),
      ).rejects.toThrow('altered or replaced');
      expect(authorized).toBe(false);

      mkdirSync(stale.runDirectory, { recursive: true });
      const staleIdentity = writeEventRoomPlaywrightCoordinatorIdentity(
        stale,
        identity,
        nonce,
      );
      await expect(
        cleanupInterruptedEventRoomPlaywrightCoordinator(
          stale,
          staleIdentity,
          nonce,
          operations,
        ),
      ).rejects.toThrow('ambiguous or reused');
      expect(authorized).toBe(false);
    } finally {
      for (const context of [missing, wrong, stale]) {
        rmSync(context.runDirectory, { force: true, recursive: true });
        rmSync(context.supervisionDirectory, {
          force: true,
          recursive: true,
        });
        releaseEventRoomPlaywrightPortLeaseIfOwned(context);
      }
    }
  });

  test('web-server cleanup requires exact process identity and a live run challenge', async () => {
    const context = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const nonce = 'd'.repeat(64);
    const webServerPid = 434_343;
    const command = `${process.execPath} app/(app)/events/[id]/playwright.web-server.ts`;
    let authorized = false;
    let challengeProven = false;
    let observedStart = 'Thu Aug 13 17:29:59 2026';
    let challengeAttempts = 0;
    try {
      const identity = writeEventRoomPlaywrightWebServerIdentity(
        context,
        {
          webServerPid,
          processGroupId: webServerPid,
          processStartedAt: 'Thu Aug 13 17:30:00 2026',
          commandHash: createHash('sha256').update(command).digest('hex'),
          challengePort: 43_434,
        },
        nonce,
      );
      expect(readEventRoomPlaywrightWebServerIdentity(context, nonce)).toEqual(
        identity,
      );
      expect(() =>
        readEventRoomPlaywrightWebServerIdentity(context, 'e'.repeat(64)),
      ).toThrow('altered or replaced');
      await expect(
        terminateInterruptedEventRoomPlaywrightWebServer(
          context,
          identity,
          nonce,
          {
            async inspectProcess() {
              return {
                processGroupId: webServerPid,
                startedAt: observedStart,
                command,
              };
            },
            signalProcessGroup() {
              authorized = true;
            },
            signalProcess() {
              authorized = true;
            },
            async processGroupMembers() {
              authorized = true;
              return [];
            },
            async proveWebServerRunIdentity() {
              challengeAttempts += 1;
              return challengeProven;
            },
            async waitForPortClose() {
              authorized = true;
            },
            async dropOwnedDatabase() {
              authorized = true;
            },
          },
        ),
      ).rejects.toThrow('ambiguous or reused before termination');
      expect(authorized).toBe(false);
      expect(challengeAttempts).toBe(0);

      // A PID/PGID reused within ps(1)'s one-second start-time precision can
      // retain the same wrapper command. Only the nonce-bound live challenge
      // distinguishes that replacement from this exact run.
      observedStart = 'Thu Aug 13 17:30:00 2026';
      await expect(
        terminateInterruptedEventRoomPlaywrightWebServer(
          context,
          identity,
          nonce,
          {
            async inspectProcess() {
              return {
                processGroupId: webServerPid,
                startedAt: observedStart,
                command,
              };
            },
            signalProcessGroup() {
              authorized = true;
            },
            signalProcess() {
              authorized = true;
            },
            async processGroupMembers() {
              authorized = true;
              return [];
            },
            async proveWebServerRunIdentity() {
              challengeAttempts += 1;
              return challengeProven;
            },
            async waitForPortClose() {
              authorized = true;
            },
            async dropOwnedDatabase() {
              authorized = true;
            },
          },
        ),
      ).rejects.toThrow('run challenge failed before termination');
      expect(authorized).toBe(false);
      expect(challengeAttempts).toBe(1);

      challengeProven = true;
      await terminateInterruptedEventRoomPlaywrightWebServer(
        context,
        identity,
        nonce,
        {
          async inspectProcess() {
            return {
              processGroupId: webServerPid,
              startedAt: observedStart,
              command,
            };
          },
          signalProcessGroup() {
            authorized = true;
          },
          signalProcess() {
            authorized = true;
          },
          async processGroupMembers() {
            return [];
          },
          async proveWebServerRunIdentity() {
            challengeAttempts += 1;
            return challengeProven;
          },
          async waitForPortClose() {
            authorized = true;
          },
          async dropOwnedDatabase() {
            authorized = true;
          },
        },
      );
      expect(authorized).toBe(true);
      expect(challengeAttempts).toBe(2);
    } finally {
      rmSync(context.supervisionDirectory, { force: true, recursive: true });
      releaseEventRoomPlaywrightPortLeaseIfOwned(context);
    }
  });

  test('atomically probes past a concurrent run holding the preferred port', () => {
    const first = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    let second: ReturnType<typeof claimEventRoomPlaywrightRunContext> | null =
      null;
    try {
      second = claimEventRoomPlaywrightRunContext(
        BASE_DATABASE_URL,
        randomUUID(),
        first.appPort,
      );
      expect(second.appPort).not.toBe(first.appPort);
      expect(second.appPort).toBeGreaterThanOrEqual(20_000);
      expect(second.appPort).toBeLessThan(50_000);
      expect(first.portLeasePath).not.toBe(second.portLeasePath);
      expect(first.workspaceDirectory).not.toBe(second.workspaceDirectory);
      expect(first.serverBuildDirectory).not.toBe(second.serverBuildDirectory);
      expect(first.serverTsconfigPath).not.toBe(second.serverTsconfigPath);
      expect(first.serverNextEnvPath).not.toBe(second.serverNextEnvPath);
    } finally {
      if (second !== null) releaseEventRoomPlaywrightPortLease(second);
      releaseEventRoomPlaywrightPortLease(first);
    }
  });

  test('publishes one run-scoped server copy and reuses it without overwriting a live overlay', () => {
    const source = createSyntheticSourceWorkspace();
    const context = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    try {
      prepareEventRoomPlaywrightServerWorkspace(context, source.server);

      expect(readFileSync(context.serverTsconfigPath, 'utf8')).toContain(
        '../../tsconfig.base.json',
      );
      expect(
        readFileSync(join(context.serverDirectory, 'app', 'page.tsx'), 'utf8'),
      ).toContain('function Page');
      expect(
        lstatSync(
          join(context.workspaceDirectory, 'node_modules'),
        ).isSymbolicLink(),
      ).toBe(true);
      expect(existsSync(context.serverBuildDirectory)).toBe(false);
      expect(existsSync(context.serverNextEnvPath)).toBe(false);
      expect(
        existsSync(join(context.serverDirectory, 'server.tsbuildinfo')),
      ).toBe(false);

      writeFileSync(context.serverTsconfigPath, 'live worker metadata');
      writeFileSync(
        join(source.server, 'tsconfig.json'),
        'changed shared source',
      );
      prepareEventRoomPlaywrightServerWorkspace(context, source.server);
      expect(readFileSync(context.serverTsconfigPath, 'utf8')).toBe(
        'live worker metadata',
      );
      expect(existsSync(context.serverWorkspacePreparationLeasePath)).toBe(
        false,
      );
    } finally {
      rmSync(context.runDirectory, { force: true, recursive: true });
      rmSync(context.supervisionDirectory, { force: true, recursive: true });
      releaseEventRoomPlaywrightPortLease(context);
      rmSync(source.root, { force: true, recursive: true });
    }
  });

  test('retains the run directory and lease until the server exits and its port closes', async () => {
    const context = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    mkdirSync(context.runDirectory, { recursive: true });
    let resolveServerExit: (exitCode: number) => void = () => undefined;
    const serverExit = new Promise<number>((resolveExit) => {
      resolveServerExit = resolveExit;
    });
    let announcePortWait: () => void = () => undefined;
    const portWaitStarted = new Promise<void>((resolveStarted) => {
      announcePortWait = resolveStarted;
    });
    let resolvePortClosed: () => void = () => undefined;
    const portClosed = new Promise<void>((resolveClosed) => {
      resolvePortClosed = resolveClosed;
    });
    let announceDatabaseCleanup: () => void = () => undefined;
    const databaseCleanupStarted = new Promise<void>((resolveStarted) => {
      announceDatabaseCleanup = resolveStarted;
    });
    let resolveDatabaseCleanup: () => void = () => undefined;
    const databaseCleanup = new Promise<void>((resolveCleanup) => {
      resolveDatabaseCleanup = resolveCleanup;
    });
    let replacement: ReturnType<
      typeof claimEventRoomPlaywrightRunContext
    > | null = null;

    try {
      const finalizing = finalizeEventRoomPlaywrightWebServer(
        context,
        () => serverExit,
        async (appPort) => {
          expect(appPort).toBe(context.appPort);
          announcePortWait();
          await portClosed;
        },
        async () => {
          announceDatabaseCleanup();
          await databaseCleanup;
        },
      );
      expect(existsSync(context.runDirectory)).toBe(true);
      expect(existsSync(context.portLeasePath)).toBe(true);
      expect(() => cleanupReportedEventRoomPlaywrightRun(context)).toThrow(
        'no stopped evidence',
      );

      resolveServerExit(0);
      await portWaitStarted;
      expect(existsSync(context.runDirectory)).toBe(true);
      expect(existsSync(context.portLeasePath)).toBe(true);

      resolvePortClosed();
      await databaseCleanupStarted;
      expect(existsSync(context.runDirectory)).toBe(true);
      expect(existsSync(context.portLeasePath)).toBe(true);
      expect(existsSync(context.serverStoppedPath)).toBe(false);
      resolveDatabaseCleanup();
      expect(await finalizing).toBe(0);
      expect(existsSync(context.runDirectory)).toBe(true);
      expect(existsSync(context.portLeasePath)).toBe(false);
      expect(existsSync(context.serverStoppedPath)).toBe(true);

      replacement = claimEventRoomPlaywrightRunContext(
        BASE_DATABASE_URL,
        randomUUID(),
        context.appPort,
      );
      expect(replacement.appPort).toBe(context.appPort);
      expect(inspectEventRoomPlaywrightPortLease(context)).toBe('replacement');
      expect(releaseEventRoomPlaywrightPortLeaseIfOwned(context)).toBe(false);
      await cleanupEventRoomPlaywrightRunAfterChildExit(context, async () => {
        throw new Error('replacement port must not be awaited');
      });
      expect(existsSync(context.runDirectory)).toBe(false);
      expect(existsSync(replacement.portLeasePath)).toBe(true);
      expect(inspectEventRoomPlaywrightPortLease(replacement)).toBe('owned');
    } finally {
      rmSync(context.runDirectory, { force: true, recursive: true });
      rmSync(context.supervisionDirectory, { force: true, recursive: true });
      if (replacement !== null) {
        releaseEventRoomPlaywrightPortLease(replacement);
      } else {
        releaseEventRoomPlaywrightPortLeaseIfOwned(context);
      }
    }
  });

  test('database cleanup failure retains the run, lease, and missing stopped evidence', async () => {
    const context = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    mkdirSync(context.runDirectory, { recursive: true });
    try {
      await expect(
        finalizeEventRoomPlaywrightWebServer(
          context,
          async () => 0,
          async () => undefined,
          async () => {
            throw new Error('synthetic database cleanup failure');
          },
        ),
      ).rejects.toThrow('synthetic database cleanup failure');
      expect(existsSync(context.runDirectory)).toBe(true);
      expect(existsSync(context.portLeasePath)).toBe(true);
      expect(existsSync(context.serverStoppedPath)).toBe(false);
      expect(() => cleanupReportedEventRoomPlaywrightRun(context)).toThrow(
        'no stopped evidence',
      );
    } finally {
      rmSync(context.runDirectory, { force: true, recursive: true });
      rmSync(context.supervisionDirectory, { force: true, recursive: true });
      releaseEventRoomPlaywrightPortLeaseIfOwned(context);
    }
  });

  test('orders database removal inside graceful server shutdown and outside setup hooks', () => {
    const config = readFileSync(
      new URL('./playwright.config.ts', import.meta.url),
      'utf8',
    );
    const setup = readFileSync(
      new URL('./playwright.global-setup.ts', import.meta.url),
      'utf8',
    );
    const wrapper = readFileSync(
      new URL('./playwright.web-server.ts', import.meta.url),
      'utf8',
    );
    const cleanupReporter = readFileSync(
      new URL('./playwright.cleanup-reporter.ts', import.meta.url),
      'utf8',
    );
    expect(config).toContain('playwright.web-server.ts');
    expect(config).toContain('playwright.cleanup-reporter.ts');
    expect(config).toContain('gracefulShutdown');
    expect(config).not.toContain('globalTeardown');
    expect(cleanupReporter).toContain('onExit()');
    expect(cleanupReporter).toContain('cleanupReportedEventRoomPlaywrightRun');
    expect(setup).toContain('createOwnedEventRoomPlaywrightDatabase');
    expect(setup).not.toContain('dropOwnedEventRoomPlaywrightDatabase');
    expect(wrapper).toContain('dropOwnedEventRoomPlaywrightDatabase');
    expect(wrapper).toContain('finalizeEventRoomPlaywrightWebServer');
    const gate = readFileSync(
      new URL('./event-room.playwright-gate.test.ts', import.meta.url),
      'utf8',
    );
    expect(gate).toContain('dropOwnedEventRoomPlaywrightDatabase');
    expect(gate).toContain("child.kill('SIGTERM')");
    expect(gate).toContain("child.kill('SIGKILL')");
    expect(gate).toContain('await completion');
    expect(gate).toContain('cleanupEventRoomPlaywrightRunAfterChildExit');
    expect(gate).not.toContain('waitForEventRoomPlaywrightPortToClose');
    const cleanupBody = gate.slice(
      gate.indexOf('async function cleanExactGateRun'),
      gate.indexOf("describe('event-room Playwright gate'"),
    );
    expect(
      cleanupBody.indexOf('await operations.stopServerAndRemoveRun(context)'),
    ).toBeLessThan(
      cleanupBody.indexOf('await operations.dropDatabase(context)'),
    );
    expect(gate).toContain('BROWSER_GATE_TIMEOUT_MS');
    const lifecycle = readFileSync(
      new URL('./test-database.ts', import.meta.url),
      'utf8',
    );
    const finalizerBody = lifecycle.slice(
      lifecycle.indexOf(
        'export async function finalizeEventRoomPlaywrightWebServer',
      ),
    );
    expect(
      finalizerBody.indexOf('await waitForPortClose(context.appPort)'),
    ).toBeLessThan(
      finalizerBody.indexOf('await cleanupOwnedDatabaseAfterPortClose()'),
    );
    expect(
      finalizerBody.indexOf('await cleanupOwnedDatabaseAfterPortClose()'),
    ).toBeLessThan(
      finalizerBody.indexOf('recordStoppedEventRoomPlaywrightServer(context)'),
    );
    expect(setup).not.toContain('releaseEventRoomPlaywrightPortLease');
    expect(setup).not.toContain('rm(context.runDirectory');
  });

  test('outer cleanup fails closed until an unmarked run independently proves its port closed', async () => {
    const context = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    mkdirSync(context.runDirectory, { recursive: true });
    try {
      await expect(
        cleanupEventRoomPlaywrightRunAfterChildExit(
          context,
          async (appPort) => {
            expect(appPort).toBe(context.appPort);
            throw new Error('synthetic port remains open');
          },
        ),
      ).rejects.toThrow('synthetic port remains open');
      expect(existsSync(context.runDirectory)).toBe(true);
      expect(inspectEventRoomPlaywrightPortLease(context)).toBe('owned');

      await cleanupEventRoomPlaywrightRunAfterChildExit(
        context,
        async () => undefined,
      );
      expect(existsSync(context.runDirectory)).toBe(false);
      expect(inspectEventRoomPlaywrightPortLease(context)).toBe('absent');
    } finally {
      rmSync(context.runDirectory, { force: true, recursive: true });
      rmSync(context.supervisionDirectory, { force: true, recursive: true });
      releaseEventRoomPlaywrightPortLeaseIfOwned(context);
    }
  });

  test('outer cleanup preserves published process identity for exact supervisor cleanup', async () => {
    const context = claimEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      randomUUID(),
    );
    const nonce = 'f'.repeat(64);
    mkdirSync(context.runDirectory, { recursive: true });
    try {
      writeEventRoomPlaywrightCoordinatorIdentity(
        context,
        {
          coordinatorPid: 454_545,
          processGroupId: 454_545,
          processStartedAt: 'Thu Aug 13 18:00:00 2026',
          commandHash: createHash('sha256')
            .update(`playwright coordinator ${nonce}`)
            .digest('hex'),
        },
        nonce,
      );
      await expect(
        cleanupEventRoomPlaywrightRunAfterChildExit(
          context,
          async () => undefined,
        ),
      ).rejects.toThrow('exact supervisor cleanup is required');
      expect(existsSync(context.runDirectory)).toBe(true);
      expect(existsSync(context.coordinatorIdentityPath)).toBe(true);
      expect(inspectEventRoomPlaywrightPortLease(context)).toBe('owned');
    } finally {
      rmSync(context.runDirectory, { force: true, recursive: true });
      rmSync(context.supervisionDirectory, { force: true, recursive: true });
      releaseEventRoomPlaywrightPortLeaseIfOwned(context);
    }
  });

  test('reuses the coordinator run context when workers evaluate config', () => {
    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    const runId = randomUUID();
    const coordinator = resolveEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      environment,
      () => runId,
    );
    try {
      const worker = resolveEventRoomPlaywrightRunContext(
        BASE_DATABASE_URL,
        environment,
        () => {
          throw new Error('a worker must not claim another run');
        },
      );
      expect(worker).toEqual(coordinator);
      expect(environment[EVENT_ROOM_PLAYWRIGHT_RUN_CONTEXT_ENV]).toBe(
        JSON.stringify(coordinator),
      );
    } finally {
      releaseEventRoomPlaywrightPortLease(coordinator);
    }
  });

  test('fails closed on malformed or cross-database inherited metadata', () => {
    expect(() =>
      resolveEventRoomPlaywrightRunContext(BASE_DATABASE_URL, {
        NODE_ENV: 'test',
        [EVENT_ROOM_PLAYWRIGHT_RUN_CONTEXT_ENV]: '{',
      }),
    ).toThrow('invalid JSON');

    const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    const coordinator = resolveEventRoomPlaywrightRunContext(
      BASE_DATABASE_URL,
      environment,
    );
    try {
      expect(() =>
        resolveEventRoomPlaywrightRunContext(
          'postgresql://test:test@localhost:5432/another_test',
          environment,
        ),
      ).toThrow('different base database');
    } finally {
      releaseEventRoomPlaywrightPortLease(coordinator);
    }
  });
});
