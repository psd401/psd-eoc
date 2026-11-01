import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  createSyntheticSimulatorAuthenticator,
  isSyntheticSimulatorAuthenticatorEnabled,
} from './synthetic-simulator-authenticator';

const developmentGlobal = globalThis as typeof globalThis & {
  __DEV__?: boolean;
};
const originalDevelopment = developmentGlobal.__DEV__;
const originalFixture = process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE;
const originalPushFixture =
  process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE;
const originalAuthFixture =
  process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE;
const originalApiBaseUrl = process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL;

beforeAll(() => {
  developmentGlobal.__DEV__ = true;
  process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE = 'issue-21';
  process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE = 'issue-32';
  process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE = 'issue-32';
});

afterAll(() => {
  if (originalDevelopment === undefined) delete developmentGlobal.__DEV__;
  else developmentGlobal.__DEV__ = originalDevelopment;
  for (const [name, value] of [
    ['EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE', originalFixture],
    ['EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE', originalPushFixture],
    ['EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE', originalAuthFixture],
    ['EXPO_PUBLIC_PSD_EOC_API_BASE_URL', originalApiBaseUrl],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('the synthetic simulator authenticator', () => {
  test('succeeds only while every exact development fixture remains enabled', async () => {
    expect(isSyntheticSimulatorAuthenticatorEnabled()).toBe(true);
    const authenticator = createSyntheticSimulatorAuthenticator();
    await expect(authenticator.authenticate()).resolves.toEqual({
      success: true,
    });
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE = 'unexpected';
    expect(isSyntheticSimulatorAuthenticatorEnabled()).toBe(false);
    await expect(authenticator.authenticate()).resolves.toMatchObject({
      success: false,
    });
    expect(() => createSyntheticSimulatorAuthenticator()).toThrow('disabled');
  });

  // Issue #598. The native partner journey has no in-process fixture, because
  // it drives the real client against a server on this machine. It is
  // identified instead by that server's origin, which a build anyone installs
  // can never have.
  test('stands in for the native partner journey, and only on loopback', () => {
    delete process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE;
    delete process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE;
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE = 'issue-598';

    process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL = 'http://127.0.0.1:34567';
    expect(isSyntheticSimulatorAuthenticatorEnabled()).toBe(true);

    // A deployment is where every installed build points, and it is refused.
    for (const origin of [
      'https://eoc.example.invalid',
      'http://eoc.example.invalid',
      'not-a-url',
    ]) {
      process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL = origin;
      expect(isSyntheticSimulatorAuthenticatorEnabled()).toBe(false);
    }
    delete process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL;
    expect(isSyntheticSimulatorAuthenticatorEnabled()).toBe(false);
  });

  test('never stands in for a release build', () => {
    process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL = 'http://127.0.0.1:34567';
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE = 'issue-598';
    delete process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE;
    delete process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE;
    expect(isSyntheticSimulatorAuthenticatorEnabled()).toBe(true);
    developmentGlobal.__DEV__ = false;
    expect(isSyntheticSimulatorAuthenticatorEnabled()).toBe(false);
    developmentGlobal.__DEV__ = true;
  });

  test('half of one journey never qualifies for the other', () => {
    process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL = 'http://127.0.0.1:34567';
    // The notification journey's app fixture without its push fixture.
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE = 'issue-32';
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE = 'issue-21';
    delete process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE;
    expect(isSyntheticSimulatorAuthenticatorEnabled()).toBe(false);
    // The partner journey's loopback origin with a push fixture it never sets.
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE = 'issue-598';
    delete process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE;
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE = 'issue-32';
    expect(isSyntheticSimulatorAuthenticatorEnabled()).toBe(false);
  });

  // Neither journey's flag value opens the other's arm, so a build left over
  // from one cannot stand in during the other.
  test('each journey names itself, and neither value opens the other arm', () => {
    process.env.EXPO_PUBLIC_PSD_EOC_API_BASE_URL = 'http://127.0.0.1:34567';
    // The native partner journey's world, labelled as the notification one.
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE = 'issue-32';
    delete process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE;
    delete process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE;
    expect(isSyntheticSimulatorAuthenticatorEnabled()).toBe(false);
    // The notification journey's world, labelled as the partner one.
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE = 'issue-598';
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE = 'issue-21';
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE = 'issue-32';
    expect(isSyntheticSimulatorAuthenticatorEnabled()).toBe(false);
    // An unknown label opens neither.
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE = 'issue-999';
    delete process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE;
    delete process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE;
    expect(isSyntheticSimulatorAuthenticatorEnabled()).toBe(false);
  });
});
