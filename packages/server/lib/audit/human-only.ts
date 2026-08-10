import {
  ActorSchema,
  CapabilityIdSchema,
  FacilityIdSchema,
  HumanOnlyActionIdSchema,
  InvocationSourceSchema,
  TimestampSchema,
  UuidSchema,
  type Actor,
  type CapabilityId,
  type FacilityId,
  type HumanOnlyActionId,
} from '@psd-eoc/contracts';
import { z } from 'zod';

import { parseSecurityAuditFact, type SecurityAuditFact } from './model';
import type { SecurityAuditWriter } from './writer';

const AgentActorSchema = ActorSchema.refine(
  (actor): actor is Extract<Actor, { readonly kind: 'agent' }> =>
    actor.kind === 'agent',
  { message: 'Human-only agent rejection requires an agent actor.' },
);

const AgentSourceSchema = InvocationSourceSchema.refine(
  (source): source is 'agent-rest' | 'mcp' =>
    source === 'agent-rest' || source === 'mcp',
  { message: 'Agent rejections require an agent invocation source.' },
);

const UniqueHumanOnlyActionsSchema = z
  .array(HumanOnlyActionIdSchema)
  .min(1)
  .max(4)
  .refine((actionIds) => new Set(actionIds).size === actionIds.length, {
    message: 'Human-only rejection action IDs must be unique.',
  })
  .readonly();

/** Trusted facts available when the canonical human-only gate rejects agent. */
export interface HumanOnlyAgentRejectionInput {
  readonly actor: Extract<Actor, { readonly kind: 'agent' }>;
  readonly source: 'agent-rest' | 'mcp';
  readonly capabilityId: CapabilityId;
  readonly actionIds: readonly HumanOnlyActionId[];
  readonly facilityId: FacilityId | null;
  readonly requestId: string;
  readonly occurredAt: string;
}

/** Client-safe shape emitted only after the rejection fact is appended. */
export interface HumanOnlyAgentForbidden {
  readonly code: 'FORBIDDEN';
  readonly status: 403;
  readonly requestId: string;
}

class HumanOnlyAgentForbiddenError
  extends Error
  implements HumanOnlyAgentForbidden
{
  public readonly code = 'FORBIDDEN' as const;
  public readonly status = 403 as const;

  public constructor(public readonly requestId: string) {
    super('This action requires an authenticated human in PSD EOC.');
    this.name = 'HumanOnlyAgentForbiddenError';
  }
}

/** Lets adapters map the helper-produced error without exposing a constructor. */
export function isHumanOnlyAgentForbiddenError(
  value: unknown,
): value is HumanOnlyAgentForbiddenError {
  return value instanceof HumanOnlyAgentForbiddenError;
}

/** Creates the sole minimized event shape for an agent human-only rejection. */
export function humanOnlyAgentRejectionFact(
  input: HumanOnlyAgentRejectionInput,
): SecurityAuditFact {
  const actor = AgentActorSchema.parse(input.actor);
  const source = AgentSourceSchema.parse(input.source);
  const capabilityId = CapabilityIdSchema.parse(input.capabilityId);
  const actionIds = UniqueHumanOnlyActionsSchema.parse(input.actionIds);
  const facilityId =
    input.facilityId === null ? null : FacilityIdSchema.parse(input.facilityId);
  const requestId = UuidSchema.parse(input.requestId);
  const occurredAt = TimestampSchema.parse(input.occurredAt);

  return parseSecurityAuditFact({
    category: 'human-only-rejection',
    action: capabilityId,
    actionIds,
    confirmationId: null,
    outcome: 'denied',
    principal: actor,
    source,
    facilityId,
    target: { kind: 'capability', id: capabilityId },
    requestId,
    reasonCode: 'HUMAN_ONLY_ACTION_REQUIRES_HUMAN',
    occurredAt,
  });
}

/** Appends the rejection before returning the 403 error to an API adapter. */
export async function rejectHumanOnlyAgentCapability(
  writer: SecurityAuditWriter,
  input: HumanOnlyAgentRejectionInput,
): Promise<never> {
  const fact = humanOnlyAgentRejectionFact(input);
  await writer.append(fact);
  throw new HumanOnlyAgentForbiddenError(fact.requestId);
}
