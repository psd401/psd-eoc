import { z } from 'zod';

import { ThreatKeySchema } from './threat';
import { TimestampSchema, UuidSchema } from './shared';

/**
 * Which events alert partners — responders from outside the district.
 *
 * An administrator chooses the responses that alert partners, by event-type
 * family (`lockdown` covers the real Lockdown and its drill identity), and
 * the threats whose events never alert partners, by threat key. Both are
 * keyed on stable keys, never display names, so renaming a response or a
 * threat changes nothing here.
 *
 * Channels are not a setting: a partner is emailed at their admitted address
 * and reached by push or text only after they sign in and enroll a device or
 * consent, exactly like staff. Drills never alert partners, so there is no
 * drill setting either.
 *
 * Settings are append-only versions. Each save is a new version naming the
 * administrator who made it and the version it replaced; nothing is edited.
 */

/** An event-type family, the response a partner alert setting names. */
export const PartnerAlertResponseFamilyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

/**
 * The responses that alert partners until an administrator saves settings:
 * Lockdown and Modified Lockdown (product owner, 2026-10-23). A district
 * without one of these families simply has fewer defaults that match.
 */
export const DEFAULT_PARTNER_ALERT_RESPONSE_FAMILY_KEYS = Object.freeze([
  'lockdown',
  'modified-lockdown',
] as const);

/** Response families bounded well above any district's response list. */
export const PARTNER_ALERT_RESPONSE_FAMILY_LIMIT = 100;

/** Threat exclusions bounded at the threat list's own page size. */
export const PARTNER_ALERT_EXCLUDED_THREAT_LIMIT = 200;

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

const partnerAlertSettingsShape = {
  /** Responses whose real events alert partners. Empty turns alerts off. */
  responseFamilyKeys: z
    .array(PartnerAlertResponseFamilyKeySchema)
    .max(PARTNER_ALERT_RESPONSE_FAMILY_LIMIT)
    .readonly(),
  /** Threats whose events never alert partners, whatever the response. */
  excludedThreatKeys: z
    .array(ThreatKeySchema)
    .max(PARTNER_ALERT_EXCLUDED_THREAT_LIMIT)
    .readonly(),
};

function refineUniqueKeys(
  settings: Readonly<{
    responseFamilyKeys: readonly string[];
    excludedThreatKeys: readonly string[];
  }>,
  context: z.RefinementCtx,
): void {
  if (hasDuplicates(settings.responseFamilyKeys)) {
    context.addIssue({
      code: 'custom',
      message: 'A response is named more than once.',
      path: ['responseFamilyKeys'],
    });
  }
  if (hasDuplicates(settings.excludedThreatKeys)) {
    context.addIssue({
      code: 'custom',
      message: 'A threat is named more than once.',
      path: ['excludedThreatKeys'],
    });
  }
}

/** The settings themselves, without version provenance. */
export const PartnerAlertSettingsSchema = z
  .object(partnerAlertSettingsShape)
  .strict()
  .superRefine(refineUniqueKeys)
  .readonly();

export type PartnerAlertSettings = z.infer<typeof PartnerAlertSettingsSchema>;

/** The settings that apply before any administrator has saved a version. */
export const DEFAULT_PARTNER_ALERT_SETTINGS: PartnerAlertSettings =
  PartnerAlertSettingsSchema.parse({
    responseFamilyKeys: DEFAULT_PARTNER_ALERT_RESPONSE_FAMILY_KEYS,
    excludedThreatKeys: [],
  });

/** One saved, immutable version of the settings. */
export const PartnerAlertSettingsVersionSchema = z
  .object({
    ...partnerAlertSettingsShape,
    id: UuidSchema,
    version: z.number().int().positive(),
    /** The version this one replaced; null only for the first. */
    supersedesVersionId: UuidSchema.nullable(),
    /** The administrator who saved it. */
    createdByUserId: UuidSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((version, context) => {
    refineUniqueKeys(version, context);
    if ((version.version === 1) !== (version.supersedesVersionId === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only the first version replaces nothing.',
        path: ['supersedesVersionId'],
      });
    }
    if (version.supersedesVersionId === version.id) {
      context.addIssue({
        code: 'custom',
        message: 'A version cannot replace itself.',
        path: ['supersedesVersionId'],
      });
    }
  })
  .readonly();

export type PartnerAlertSettingsVersion = z.infer<
  typeof PartnerAlertSettingsVersionSchema
>;

/** A response an administrator can choose, named as operators see it. */
export const PartnerAlertResponseOptionSchema = z
  .object({
    familyKey: PartnerAlertResponseFamilyKeySchema,
    name: z.string().trim().min(1).max(160),
  })
  .strict()
  .readonly();

/** A threat an administrator can exclude, named as operators see it. */
export const PartnerAlertThreatOptionSchema = z
  .object({
    key: ThreatKeySchema,
    name: z.string().trim().min(1).max(160),
    active: z.boolean(),
  })
  .strict()
  .readonly();

export const GetPartnerAlertSettingsInputSchema = z
  .object({})
  .strict()
  .readonly();

export type GetPartnerAlertSettingsInput = z.infer<
  typeof GetPartnerAlertSettingsInputSchema
>;

/**
 * What the settings page shows: the current version (null until the first
 * save), the settings in effect (the current version's, or the defaults),
 * and the responses and threats there are to choose from.
 */
export const PartnerAlertSettingsStateSchema = z
  .object({
    current: PartnerAlertSettingsVersionSchema.nullable(),
    effective: PartnerAlertSettingsSchema,
    responseOptions: z
      .array(PartnerAlertResponseOptionSchema)
      .max(PARTNER_ALERT_RESPONSE_FAMILY_LIMIT)
      .readonly(),
    threatOptions: z
      .array(PartnerAlertThreatOptionSchema)
      .max(PARTNER_ALERT_EXCLUDED_THREAT_LIMIT)
      .readonly(),
  })
  .strict()
  .superRefine((state, context) => {
    if (
      state.current !== null &&
      (state.current.responseFamilyKeys.join('\n') !==
        state.effective.responseFamilyKeys.join('\n') ||
        state.current.excludedThreatKeys.join('\n') !==
          state.effective.excludedThreatKeys.join('\n'))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The settings in effect are the current version.',
        path: ['effective'],
      });
    }
  })
  .readonly();

export type PartnerAlertSettingsState = z.infer<
  typeof PartnerAlertSettingsStateSchema
>;

/**
 * Saves a new version. `baseVersionId` is the version the administrator was
 * looking at (null when none had been saved); a save based on anything but
 * the current version is refused, so two administrators cannot silently
 * overwrite each other.
 */
export const SetPartnerAlertSettingsInputSchema = z
  .object({
    ...partnerAlertSettingsShape,
    baseVersionId: UuidSchema.nullable(),
  })
  .strict()
  .superRefine(refineUniqueKeys)
  .readonly();

export type SetPartnerAlertSettingsInput = z.infer<
  typeof SetPartnerAlertSettingsInputSchema
>;
