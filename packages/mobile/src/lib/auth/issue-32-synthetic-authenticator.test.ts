import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  createIssue32SyntheticAuthenticator,
  isIssue32SyntheticAuthenticatorEnabled,
} from './issue-32-synthetic-authenticator';

const developmentGlobal = globalThis as typeof globalThis & {
  __DEV__?: boolean;
};
const originalDevelopment = developmentGlobal.__DEV__;
const originalFixture = process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_FIXTURE;
const originalPushFixture =
  process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_PUSH_FIXTURE;
const originalAuthFixture =
  process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE;

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
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('issue-32 synthetic simulator authenticator', () => {
  test('succeeds only while every exact development fixture remains enabled', async () => {
    expect(isIssue32SyntheticAuthenticatorEnabled()).toBe(true);
    const authenticator = createIssue32SyntheticAuthenticator();
    await expect(authenticator.authenticate()).resolves.toEqual({
      success: true,
    });
    process.env.EXPO_PUBLIC_PSD_EOC_SYNTHETIC_AUTH_FIXTURE = 'unexpected';
    expect(isIssue32SyntheticAuthenticatorEnabled()).toBe(false);
    await expect(authenticator.authenticate()).resolves.toMatchObject({
      success: false,
    });
    expect(() => createIssue32SyntheticAuthenticator()).toThrow('disabled');
  });
});
