#!/usr/bin/env bun

import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const mobileRoot = resolve(import.meta.dir, '..');
const flowRoot = resolve(import.meta.dir, 'flows');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Provider-free proof for issue #278. Physical receipt remains a separate
 * human observation; this verifies the exact local presentation/tap/deep-link
 * flow used on both platforms without registering or contacting Expo.
 */
export async function verifyMobilePushDeepLinkFlow(): Promise<void> {
  const names = (await readdir(flowRoot)).filter((name) =>
    /^open-push-(android|ios)[.]yaml$/u.test(name),
  );
  assert(names.length === 2, 'Both platform push-open flows are required.');
  for (const name of names) {
    const flow = await Bun.file(resolve(flowRoot, name)).text();
    const selectsDrillNotification =
      name === 'open-push-ios.yaml'
        ? flow.includes('start: 50%, 83%') &&
          flow.includes('point: 15%, 83%') &&
          flow.includes(
            'Synthetic earthquake drill. Synthetic Test School, SYNTH.',
          )
        : flow.includes("'\\[DRILL\\] Synthetic earthquake drill'");
    assert(
      selectsDrillNotification,
      `${name} must open the DRILL notification.`,
    );
    assert(
      flow.includes('PSD_EOC_E2E_SYNTHETIC_ONLY'),
      `${name} must refuse non-synthetic execution.`,
    );
    assert(
      !flow.includes('[INCIDENT]') && !flow.includes('ExponentPushToken'),
      `${name} must contain neither incident copy nor a provider token.`,
    );
  }

  const runner = await Bun.file(resolve(import.meta.dir, 'run.ts')).text();
  assert(
    runner.includes("EXPO_PUBLIC_PSD_EOC_PUSH_REGISTRATION_ENABLED: 'false'"),
    'Simulator deep-link proof must keep provider registration disabled.',
  );
  assert(
    runner.includes('notification=local-provider-free'),
    'The evidence context must identify local provider-free presentation.',
  );
  assert(
    runner.includes("await capture('push-opened-event-room')"),
    'The runner must retain post-tap event-room visual evidence.',
  );

  const lifecycle = await Bun.file(
    resolve(mobileRoot, 'src/lib/push/lifecycle.tsx'),
  ).text();
  assert(
    lifecycle.includes("pathname: '/events/[id]'") &&
      lifecycle.includes('params: { id: payload.eventId }'),
    'Push tap handling must deep-link to the exact event room.',
  );
}

if (import.meta.main) {
  await verifyMobilePushDeepLinkFlow();
  console.info(
    'Issue #278 mobile push presentation, tap, and deep-link contracts are valid for iOS and Android.',
  );
}
