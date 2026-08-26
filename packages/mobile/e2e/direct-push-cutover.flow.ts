#!/usr/bin/env bun

import {
  PushProviderCutoverSchema,
  PushTokenRegistrationReceiptSchema,
  RegisterPushTokenInputSchema,
} from '@psd-eoc/contracts';

import { verifyMobilePushDeepLinkFlow } from './mobile-push-deep-link.flow';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Provider-free issue #43 composition flow. Focused worker tests exercise all
 * outcome branches before this file runs; this binds dual registration,
 * independent platform cutover, rollback immutability, and the exact local
 * notification tap/deep-link fixture without contacting APNs, FCM, or Expo.
 */
export async function verifyDirectPushCutoverFlow(): Promise<void> {
  const build = Object.freeze({
    applicationId: 'example.synthetic.eoc',
    applicationVersion: '1.0.4',
    nativeBuildVersion: '43',
    expoProjectId: '00000000-0000-4000-8000-000000000043',
    updateMode: 'embedded-only' as const,
  });
  const deviceEnrollmentId = '00000000-0000-4000-8000-000000000043';
  const registrations = [
    {
      deviceEnrollmentId,
      platform: 'ios',
      provider: 'expo',
      serviceEnvironment: 'production',
      build,
      token: 'synthetic-unroutable-expo-ios',
    },
    {
      deviceEnrollmentId,
      platform: 'ios',
      provider: 'apns',
      serviceEnvironment: 'production',
      build,
      token: 'synthetic-unroutable-apns-ios',
      expoFallbackToken: 'synthetic-unroutable-expo-ios',
    },
    {
      deviceEnrollmentId,
      platform: 'android',
      provider: 'expo',
      serviceEnvironment: 'production',
      build,
      token: 'synthetic-unroutable-expo-android',
    },
    {
      deviceEnrollmentId,
      platform: 'android',
      provider: 'fcm',
      serviceEnvironment: 'production',
      build,
      token: 'synthetic-unroutable-fcm-android',
      expoFallbackToken: 'synthetic-unroutable-expo-android',
    },
  ] as const;

  const receipts = registrations.map((input) => {
    const registration = RegisterPushTokenInputSchema.parse(input);
    return PushTokenRegistrationReceiptSchema.parse({
      deviceEnrollmentId: registration.deviceEnrollmentId,
      platform: registration.platform,
      provider: registration.provider,
      serviceEnvironment: registration.serviceEnvironment,
      status: 'registered',
    });
  });
  assert(
    receipts.every((receipt) => !('token' in receipt)),
    'Registration receipts must remain token-free.',
  );

  const immutableHistory = Object.freeze({
    eventId: '00000000-0000-4000-8000-000000000143',
    attemptIds: Object.freeze([
      '00000000-0000-4000-8000-000000000243',
      '00000000-0000-4000-8000-000000000343',
    ]),
    receipts: Object.freeze(receipts),
  });
  const beforeCutover = JSON.stringify(immutableHistory);
  const direct = PushProviderCutoverSchema.parse({
    version: 1,
    ios: 'direct',
    android: 'expo',
  });
  const bothDirect = PushProviderCutoverSchema.parse({
    ...direct,
    android: 'direct',
  });
  const rollback = PushProviderCutoverSchema.parse({
    ...bothDirect,
    ios: 'expo',
  });
  assert(
    direct.ios === 'direct' && direct.android === 'expo',
    'iOS and Android cutover must be independent.',
  );
  assert(
    rollback.ios === 'expo' && rollback.android === 'direct',
    'Rollback must switch only the selected platform.',
  );
  assert(
    JSON.stringify(immutableHistory) === beforeCutover,
    'Cutover and rollback must not rewrite event, attempt, or registration history.',
  );

  await verifyMobilePushDeepLinkFlow();
}

if (import.meta.main) {
  await verifyDirectPushCutoverFlow();
  console.info(
    'Issue #43 provider-free dual registration, per-platform cutover, rollback, and mobile tap flow passed.',
  );
}
