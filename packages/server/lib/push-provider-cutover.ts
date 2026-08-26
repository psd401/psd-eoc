import {
  PushProviderCutoverSchema,
  type PushPlatform,
  type PushProvider,
  type PushProviderCutover,
} from '@psd-eoc/contracts';

/** Protected tenant cutover selecting exactly one push path per platform. */
export const PUSH_PROVIDER_CUTOVER_ENV =
  'PSD_EOC_PUSH_PROVIDER_CUTOVER' as const;

/** Missing, oversized, or malformed configuration denies push selection. */
export function parsePushProviderCutover(
  value: string | undefined,
): PushProviderCutover | null {
  if (value === undefined || value.length === 0 || value.length > 1_024) {
    return null;
  }
  try {
    const parsed = PushProviderCutoverSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Resolves `direct` to the only native provider valid for the platform. */
export function selectedPushProvider(
  cutover: PushProviderCutover,
  platform: PushPlatform,
): PushProvider {
  const selection = cutover[platform];
  if (selection === 'expo') return 'expo';
  return platform === 'ios' ? 'apns' : 'fcm';
}
