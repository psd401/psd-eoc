import { EventTargetingSchema, type Endpoint } from '@psd-eoc/contracts';

import {
  resolveAudience,
  type ResolveAudienceInput,
  type ResolvedAudience,
} from '../../../lib/roster/resolve';

/**
 * Test mode is server-owned. Callers cannot substitute a staff population,
 * real rendering, or a drill that could legitimately target staff.
 */
export const TEST_MODE_TARGETING = EventTargetingSchema.parse({
  kind: 'test',
  templateMode: 'drill',
  rosterPopulation: 'synthetic',
});

export type TestModeAudienceResolutionErrorCode =
  | 'TEST_MODE_REQUIRES_SYNTHETIC_ROSTER'
  | 'TEST_MODE_RESOLVED_UNSAFE_ENDPOINT'
  | 'TEST_MODE_RESOLVED_WRONG_POPULATION';

const ERROR_MESSAGES = Object.freeze({
  TEST_MODE_REQUIRES_SYNTHETIC_ROSTER:
    'Test mode requires the server-owned synthetic roster population.',
  TEST_MODE_RESOLVED_UNSAFE_ENDPOINT:
    'Test-mode resolution produced an endpoint outside reserved synthetic ranges.',
  TEST_MODE_RESOLVED_WRONG_POPULATION:
    'Test-mode resolution did not preserve the synthetic roster population.',
} as const satisfies Readonly<
  Record<TestModeAudienceResolutionErrorCode, string>
>);

/** Safe failure that never reflects a recipient or endpoint destination. */
export class TestModeAudienceResolutionError extends Error {
  public readonly code: TestModeAudienceResolutionErrorCode;

  public constructor(code: TestModeAudienceResolutionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'TestModeAudienceResolutionError';
    this.code = code;
  }
}

function testModeRosterPopulation(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TestModeAudienceResolutionError(
      'TEST_MODE_REQUIRES_SYNTHETIC_ROSTER',
    );
  }
  return Reflect.get(value, 'population');
}

function isProvablyUnroutable(endpoint: Endpoint): boolean {
  switch (endpoint.channel) {
    case 'email':
      return endpoint.email.toLowerCase().endsWith('.invalid');
    case 'sms':
      return /^\+120255501\d{2}$/u.test(endpoint.phoneNumber);
    case 'push':
      return endpoint.token.startsWith('synthetic-unroutable:');
  }
}

/**
 * Resolves the admin test-mode audience through the shared immutable resolver.
 *
 * The runtime snapshot container is checked before its population is read, and
 * the population check happens before the resolver can inspect or return an
 * endpoint. The shared resolver then reparses the complete snapshot, which
 * rejects a well-shaped forged synthetic snapshot containing any routable
 * destination. The postcondition keeps this route fail-closed if the shared
 * implementation changes later. This function has no provider or network
 * dependency.
 */
export function resolveTestModeAudience(
  input: ResolveAudienceInput,
): ResolvedAudience {
  const targeting = EventTargetingSchema.safeParse({
    ...TEST_MODE_TARGETING,
    rosterPopulation: testModeRosterPopulation(input.rosterSnapshot),
  });
  if (!targeting.success) {
    throw new TestModeAudienceResolutionError(
      'TEST_MODE_REQUIRES_SYNTHETIC_ROSTER',
    );
  }

  const resolved = resolveAudience(input);
  if (resolved.rosterSnapshot.population !== 'synthetic') {
    throw new TestModeAudienceResolutionError(
      'TEST_MODE_RESOLVED_WRONG_POPULATION',
    );
  }
  if (
    resolved.recipients.some((recipient) =>
      recipient.endpoints.some((endpoint) => !isProvablyUnroutable(endpoint)),
    )
  ) {
    throw new TestModeAudienceResolutionError(
      'TEST_MODE_RESOLVED_UNSAFE_ENDPOINT',
    );
  }

  return resolved;
}
