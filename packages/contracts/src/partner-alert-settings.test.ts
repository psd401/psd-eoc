import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_PARTNER_ALERT_SETTINGS,
  getCapabilityInvocationPolicy,
  isPartnerCapabilityId,
  PartnerAlertSettingsStateSchema,
  PartnerAlertSettingsVersionSchema,
  SetPartnerAlertSettingsInputSchema,
} from './index';

const VERSION_ONE = '00000000-0000-4000-8000-000000005971';
const VERSION_TWO = '00000000-0000-4000-8000-000000005972';
const ADMIN = '00000000-0000-4000-8000-000000005973';
const AT = '2026-10-26T12:00:00.000Z';

describe('partner alert settings contract', () => {
  test('defaults to Lockdown and Modified Lockdown with no threat excluded', () => {
    expect(DEFAULT_PARTNER_ALERT_SETTINGS).toEqual({
      responseFamilyKeys: ['lockdown', 'modified-lockdown'],
      excludedThreatKeys: [],
    });
  });

  test('a save names keys, never display names, each at most once', () => {
    const valid = {
      responseFamilyKeys: ['lockdown'],
      excludedThreatKeys: ['synthetic-wildlife'],
      baseVersionId: null,
    };
    expect(SetPartnerAlertSettingsInputSchema.safeParse(valid).success).toBe(
      true,
    );
    for (const invalid of [
      { ...valid, responseFamilyKeys: ['Lockdown'] },
      { ...valid, responseFamilyKeys: ['lockdown', 'lockdown'] },
      { ...valid, excludedThreatKeys: ['Synthetic wildlife'] },
      {
        ...valid,
        excludedThreatKeys: ['synthetic-wildlife', 'synthetic-wildlife'],
      },
      { ...valid, channels: ['email'] },
      { responseFamilyKeys: [], excludedThreatKeys: [] },
    ]) {
      expect(
        SetPartnerAlertSettingsInputSchema.safeParse(invalid).success,
      ).toBe(false);
    }
  });

  test('no responses at all is a valid save: it turns partner alerts off', () => {
    expect(
      SetPartnerAlertSettingsInputSchema.safeParse({
        responseFamilyKeys: [],
        excludedThreatKeys: [],
        baseVersionId: VERSION_ONE,
      }).success,
    ).toBe(true);
  });

  test('only the first version replaces nothing, and none replaces itself', () => {
    const first = {
      id: VERSION_ONE,
      version: 1,
      responseFamilyKeys: ['lockdown'],
      excludedThreatKeys: [],
      supersedesVersionId: null,
      createdByUserId: ADMIN,
      createdAt: AT,
    };
    expect(PartnerAlertSettingsVersionSchema.safeParse(first).success).toBe(
      true,
    );
    expect(
      PartnerAlertSettingsVersionSchema.safeParse({
        ...first,
        id: VERSION_TWO,
        version: 2,
        supersedesVersionId: VERSION_ONE,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...first, supersedesVersionId: VERSION_TWO },
      { ...first, version: 2 },
      { ...first, version: 2, supersedesVersionId: VERSION_ONE },
      { ...first, version: 0 },
    ]) {
      expect(PartnerAlertSettingsVersionSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  test('the settings in effect are the current version once one exists', () => {
    const current = {
      id: VERSION_ONE,
      version: 1,
      responseFamilyKeys: ['lockdown'],
      excludedThreatKeys: [],
      supersedesVersionId: null,
      createdByUserId: ADMIN,
      createdAt: AT,
    };
    const state = {
      current,
      effective: { responseFamilyKeys: ['lockdown'], excludedThreatKeys: [] },
      responseOptions: [{ familyKey: 'lockdown', name: 'Lockdown' }],
      threatOptions: [],
    };
    expect(PartnerAlertSettingsStateSchema.safeParse(state).success).toBe(true);
    expect(
      PartnerAlertSettingsStateSchema.safeParse({
        ...state,
        effective: DEFAULT_PARTNER_ALERT_SETTINGS,
      }).success,
    ).toBe(false);
  });

  test('both capabilities are web-only administration and never a partner’s', () => {
    for (const id of [
      'get-partner-alert-settings',
      'set-partner-alert-settings',
    ] as const) {
      const policy = getCapabilityInvocationPolicy(id);
      expect(policy.principalKinds).toEqual(['human']);
      expect(policy.sources).toEqual(['web']);
      expect(isPartnerCapabilityId(id)).toBe(false);
    }
  });
});
