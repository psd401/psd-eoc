import type { RegisteredCapabilityId } from './capability-catalog';

/**
 * Owns the exact set of capabilities a partner-agency session may run.
 *
 * This is a written allowlist, not a derivation, in the same shape as the
 * agent-key allowlist. A partner may see live events (with the facility,
 * threat, and published event-type reads that render them), open an event
 * room, join an event, read and post to its timeline, attach media to it, and
 * manage their own session, devices, push registration, and text-message
 * consent. Everything else is refused by the capability engine for every
 * transport: starting, ending, correcting, or reopening an event, roster and
 * notification work, Records and exports, configuration, audit, and agent
 * keys.
 *
 * The engine reads it whenever the server-resolved capability scope carries
 * `partner: true`, which only a partner-admission session's scope does.
 */
export const PARTNER_CAPABILITY_IDS = Object.freeze([
  'list-active-events',
  'get-event',
  'list-facilities',
  'get-facility',
  'list-threats',
  'list-event-types',
  'get-event-type-version',
  'sync-event-room',
  'join-event',
  'list-journal-entries',
  'append-journal-entry',
  'create-media-upload-intent',
  'complete-media-upload',
  'get-media-read-grant',
  'get-current-session',
  'revoke-session',
  'list-my-devices',
  'register-push-token',
  'unregister-push-token',
  'record-sms-consent',
  'withdraw-sms-consent',
  'read-my-sms-consent',
] as const satisfies readonly RegisteredCapabilityId[]);

/** Capability ID a partner session may run, inferred from the allowlist. */
export type PartnerCapabilityId = (typeof PARTNER_CAPABILITY_IDS)[number];

const partnerCapabilityIdSet = new Set<string>(PARTNER_CAPABILITY_IDS);

/** Returns true only for IDs on the partner allowlist. */
export function isPartnerCapabilityId(
  value: unknown,
): value is PartnerCapabilityId {
  return typeof value === 'string' && partnerCapabilityIdSet.has(value);
}

/**
 * Returns true when a session with this scope may run the capability as far
 * as the partner allowlist is concerned: every non-partner scope, and a
 * partner scope only for allowlisted IDs.
 *
 * Interfaces use it to hide controls the engine would refuse. It never
 * authorizes anything: role, facility, and source checks stay in the engine.
 */
export function partnerAllowlistPermits(
  scope: Readonly<{ partner?: true | undefined }>,
  capabilityId: RegisteredCapabilityId,
): boolean {
  return scope.partner !== true || isPartnerCapabilityId(capabilityId);
}
