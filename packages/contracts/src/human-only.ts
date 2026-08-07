import { z } from 'zod';

/**
 * Owns the immutable registry of critical production actions that only an
 * authenticated human in PSD EOC may perform. Agent, system, webhook,
 * scheduled, preview, and GET surfaces must never expose aliases for these
 * IDs. Additions require a safety-policy change, not a local capability fork.
 */
export const HUMAN_ONLY_ACTION_IDS = [
  'start-real-incident',
  'send-real-notification',
  'all-clear',
  'close-real-event',
] as const;

/**
 * Validates one canonical human-only action ID throughout capability
 * registration and execution. The registry is enforced server-side for every
 * invocation lifecycle.
 */
export const HumanOnlyActionIdSchema = z.enum(HUMAN_ONLY_ACTION_IDS);

/** Canonical human-only action ID inferred from the registry schema. */
export type HumanOnlyActionId = z.infer<typeof HumanOnlyActionIdSchema>;

/** Checks an untrusted capability ID against the canonical human-only set. */
export function isHumanOnlyActionId(
  value: unknown,
): value is HumanOnlyActionId {
  return HumanOnlyActionIdSchema.safeParse(value).success;
}
