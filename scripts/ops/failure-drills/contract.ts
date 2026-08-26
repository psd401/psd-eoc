export const FAILURE_DRILL_SCENARIO_IDS = Object.freeze([
  'worker-termination-mid-fanout',
  'aurora-failover',
  'google-idp-outage',
  'dlq-redrive',
  'duplicate-provider-callback',
  'delayed-callback-after-all-clear',
  'device-revocation-mid-event',
  'roster-sync-failure-during-activation',
] as const);

export type FailureDrillScenarioId =
  (typeof FAILURE_DRILL_SCENARIO_IDS)[number];

export interface SideEffectReconciliation {
  readonly expected: readonly string[];
  readonly observed: readonly string[];
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly duplicates: readonly string[];
}

export const FAILURE_DRILL_INVARIANT_IDS = Object.freeze([
  'appendOnlyHistory',
  'authorization',
  'classification',
  'honestUnknown',
] as const);

export type FailureDrillInvariantId =
  (typeof FAILURE_DRILL_INVARIANT_IDS)[number];

export interface FailureDrillInvariantEvidence {
  readonly status: 'preserved' | 'not-applicable';
  readonly evidence: readonly string[];
}

export interface FailureDrillAlarmObservation {
  readonly alarmName: string;
  readonly state: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';
  readonly phase: 'before' | 'during' | 'after';
  readonly observedAt: string;
  readonly stateUpdatedAt: string;
}

export interface FailureDrillScenarioEvidence {
  readonly id: FailureDrillScenarioId;
  readonly status: 'passed' | 'failed';
  readonly observation: string;
  readonly alarmTransitions: readonly FailureDrillAlarmObservation[];
  readonly invariants: Readonly<
    Record<FailureDrillInvariantId, FailureDrillInvariantEvidence>
  >;
  readonly facts: Readonly<Record<string, string | number | boolean>>;
  readonly sideEffects: SideEffectReconciliation;
}

export interface FocusedFailureDrillResult {
  readonly scenarioId: FailureDrillScenarioId;
  readonly expectedSideEffects: readonly string[];
  readonly observedSideEffects: readonly string[];
  readonly facts: Readonly<Record<string, string | number | boolean>>;
}

export interface FailureDrillManifest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly revision: Readonly<{
    sourceSha: string;
    imageDigest: string;
    stackId: string;
  }>;
  readonly safety: Readonly<{
    deploymentClass: 'non-production';
    providerMode: 'mocked';
    rosterPopulation: 'synthetic';
    recipientDomain: 'example.invalid';
  }>;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly scenarios: readonly FailureDrillScenarioEvidence[];
  readonly cleanup: Readonly<{
    status: 'pending' | 'complete';
    stackName: string;
    remainingResources: readonly string[];
  }>;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

export function reconcileSideEffects(
  expected: readonly string[],
  observed: readonly string[],
): SideEffectReconciliation {
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  return Object.freeze({
    duplicates: Object.freeze(duplicates(observed)),
    expected: Object.freeze([...expected]),
    missing: Object.freeze(
      [...expectedSet].filter((value) => !observedSet.has(value)).sort(),
    ),
    observed: Object.freeze([...observed]),
    unexpected: Object.freeze(
      [...observedSet].filter((value) => !expectedSet.has(value)).sort(),
    ),
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseFocusedFailureDrillResult(
  output: string,
  scenarioId: FailureDrillScenarioId,
): FocusedFailureDrillResult {
  const results = output.split('\n').flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line.trim());
      return isRecord(value) &&
        value.kind === 'failure-drill-focused-result' &&
        value.scenarioId === scenarioId
        ? [value]
        : [];
    } catch {
      return [];
    }
  });
  const result = results[0];
  if (results.length !== 1 || result === undefined) {
    throw new Error(
      `Focused ${scenarioId} proof did not emit exactly one structured result.`,
    );
  }
  if (
    !Array.isArray(result.expectedSideEffects) ||
    !result.expectedSideEffects.every(
      (value) => typeof value === 'string' && value.length > 0,
    ) ||
    !Array.isArray(result.observedSideEffects) ||
    !result.observedSideEffects.every(
      (value) => typeof value === 'string' && value.length > 0,
    ) ||
    !isRecord(result.facts) ||
    Object.keys(result.facts).length === 0 ||
    !Object.values(result.facts).every(
      (value) =>
        (typeof value === 'string' && value.length > 0) ||
        typeof value === 'number' ||
        typeof value === 'boolean',
    )
  ) {
    throw new Error(`Focused ${scenarioId} proof emitted invalid evidence.`);
  }
  return result as unknown as FocusedFailureDrillResult;
}

const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ATTEMPT_ENDPOINT_IDENTITY_PATTERN = new RegExp(
  `^attempt:${UUID_PATTERN}:endpoint:${UUID_PATTERN}$`,
  'u',
);
const CALLBACK_IDENTITY_PATTERN = new RegExp(
  `^callback:[A-Za-z0-9._:-]{1,200}:attempt:${UUID_PATTERN}:endpoint:${UUID_PATTERN}$`,
  'u',
);

function assertEvidenceDerivedIdentities(
  scenario: FailureDrillScenarioEvidence,
): void {
  const pattern =
    scenario.id === 'worker-termination-mid-fanout' ||
    scenario.id === 'dlq-redrive'
      ? ATTEMPT_ENDPOINT_IDENTITY_PATTERN
      : scenario.id === 'duplicate-provider-callback'
        ? CALLBACK_IDENTITY_PATTERN
        : scenario.id === 'delayed-callback-after-all-clear'
          ? ATTEMPT_ENDPOINT_IDENTITY_PATTERN
          : undefined;
  if (pattern === undefined) return;
  const identities = [
    ...scenario.sideEffects.expected,
    ...scenario.sideEffects.observed,
  ];
  if (identities.length < 2 || !identities.every((id) => pattern.test(id))) {
    throw new Error(
      `Failure-drill ${scenario.id} requires evidence-derived immutable attempt and endpoint identities.`,
    );
  }
  if (
    scenario.id === 'worker-termination-mid-fanout' &&
    (scenario.sideEffects.expected.length < 2 ||
      scenario.sideEffects.observed.length < 2 ||
      new Set(
        scenario.sideEffects.expected.map((identity) =>
          identity.slice(identity.lastIndexOf(':endpoint:') + 10),
        ),
      ).size < 2)
  ) {
    throw new Error(
      'Worker termination requires a multi-endpoint immutable fan-out set.',
    );
  }
  if (
    scenario.id === 'worker-termination-mid-fanout' &&
    (scenario.facts.fanoutEndpointCount !==
      scenario.sideEffects.expected.length ||
      scenario.facts.logicalSideEffectCount !==
        scenario.sideEffects.observed.length)
  ) {
    throw new Error(
      'Worker termination facts must reconcile the complete fan-out set.',
    );
  }
  if (scenario.id === 'dlq-redrive') {
    const attemptId = scenario.facts.attemptId;
    const endpointId = scenario.facts.endpointId;
    const eventId = scenario.facts.eventId;
    const evidenceId = scenario.facts.evidenceId;
    if (
      typeof attemptId !== 'string' ||
      typeof endpointId !== 'string' ||
      typeof eventId !== 'string' ||
      typeof evidenceId !== 'string' ||
      !new RegExp(`^${UUID_PATTERN}$`, 'u').test(attemptId) ||
      !new RegExp(`^${UUID_PATTERN}$`, 'u').test(endpointId) ||
      !new RegExp(`^${UUID_PATTERN}$`, 'u').test(eventId) ||
      !new RegExp(`^${UUID_PATTERN}$`, 'u').test(evidenceId) ||
      scenario.facts.evidenceState !== 'attempted' ||
      scenario.sideEffects.expected[0] !==
        `attempt:${attemptId}:endpoint:${endpointId}`
    ) {
      throw new Error(
        'DLQ redrive requires a persisted attempt, endpoint, event, and attempted evidence identity.',
      );
    }
  }
  if (scenario.id === 'duplicate-provider-callback') {
    const callbackId = scenario.facts.callbackId;
    const attemptId = scenario.facts.attemptId;
    const endpointId = scenario.facts.endpointId;
    if (
      typeof callbackId !== 'string' ||
      typeof attemptId !== 'string' ||
      typeof endpointId !== 'string' ||
      !new RegExp(`^${UUID_PATTERN}$`, 'u').test(callbackId) ||
      !new RegExp(`^${UUID_PATTERN}$`, 'u').test(attemptId) ||
      !new RegExp(`^${UUID_PATTERN}$`, 'u').test(endpointId) ||
      typeof scenario.facts.callbackClaimId !== 'string' ||
      !new RegExp(`^${UUID_PATTERN}$`, 'u').test(
        scenario.facts.callbackClaimId,
      ) ||
      typeof scenario.facts.capabilityEvidenceId !== 'string' ||
      !new RegExp(`^${UUID_PATTERN}$`, 'u').test(
        scenario.facts.capabilityEvidenceId,
      ) ||
      scenario.facts.capabilityEvidenceSequence !== 2 ||
      scenario.facts.firstStatus !== 204 ||
      scenario.facts.replayStatus !== 204 ||
      scenario.sideEffects.expected[0] !==
        `callback:${callbackId}:attempt:${attemptId}:endpoint:${endpointId}`
    ) {
      throw new Error(
        'Duplicate callback requires independently expected fixture identity and persisted callback evidence.',
      );
    }
  }
}

function assertAlarmEvidence(scenario: FailureDrillScenarioEvidence): void {
  if (scenario.id === 'aurora-failover') {
    const suffixes = ['-aurora-acu', '-apprunner-5xx'] as const;
    if (
      scenario.alarmTransitions.length !== 4 ||
      !suffixes.every((suffix) => {
        const observations = scenario.alarmTransitions.filter(({ alarmName }) =>
          alarmName.endsWith(suffix),
        );
        return (
          observations.length === 2 &&
          observations.some(({ phase }) => phase === 'before') &&
          observations.some(({ phase }) => phase === 'after')
        );
      })
    ) {
      throw new Error(
        'Aurora recovery requires exact before-and-after Aurora and App Runner alarm observations.',
      );
    }
  }
  if (scenario.id === 'dlq-redrive') {
    if (
      scenario.alarmTransitions.length !== 3 ||
      !scenario.alarmTransitions.every(({ alarmName }) =>
        alarmName.endsWith('-dlq-2'),
      ) ||
      !scenario.alarmTransitions.some(
        ({ phase, state }) => phase === 'before' && state === 'OK',
      ) ||
      !scenario.alarmTransitions.some(
        ({ phase, state }) => phase === 'during' && state === 'ALARM',
      ) ||
      !scenario.alarmTransitions.some(
        ({ phase, state }) => phase === 'after' && state === 'OK',
      )
    ) {
      throw new Error(
        'DLQ redrive requires exact CloudWatch OK, ALARM, and recovered OK observations.',
      );
    }
  }
}

function requireString(record: Readonly<Record<string, unknown>>, key: string) {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Failure-drill manifest requires ${key}.`);
  }
  return value;
}

export function parseFailureDrillManifest(
  value: unknown,
): FailureDrillManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Failure-drill evidence must use schemaVersion 1.');
  }
  const runId = requireString(value, 'runId');
  if (!/^[a-z0-9][a-z0-9-]{7,23}$/u.test(runId)) {
    throw new Error('Failure-drill evidence has an invalid runId.');
  }
  if (!isRecord(value.revision)) {
    throw new Error('Failure-drill evidence requires one immutable revision.');
  }
  const sourceSha = requireString(value.revision, 'sourceSha');
  const imageDigest = requireString(value.revision, 'imageDigest');
  const stackId = requireString(value.revision, 'stackId');
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new Error('Failure-drill sourceSha must be an exact Git commit.');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(imageDigest)) {
    throw new Error('Failure-drill imageDigest must be exact.');
  }
  if (!stackId.includes(`:stack/PsdEocFailureDrill-${runId}/`)) {
    throw new Error('Failure-drill stackId must identify the exact drill run.');
  }
  if (!isRecord(value.safety)) {
    throw new Error('Failure-drill evidence requires the safety boundary.');
  }
  if (
    value.safety.deploymentClass !== 'non-production' ||
    value.safety.providerMode !== 'mocked' ||
    value.safety.rosterPopulation !== 'synthetic' ||
    value.safety.recipientDomain !== 'example.invalid'
  ) {
    throw new Error('Failure-drill safety boundary is not synthetic-only.');
  }
  if (!Array.isArray(value.scenarios)) {
    throw new Error('Failure-drill evidence requires scenario results.');
  }
  const scenarioRecords = value.scenarios.map((scenario) => {
    if (!isRecord(scenario)) {
      throw new Error('Failure-drill scenario evidence must be an object.');
    }
    return scenario;
  });
  const ids = scenarioRecords.map((scenario) => requireString(scenario, 'id'));
  if (
    ids.length !== FAILURE_DRILL_SCENARIO_IDS.length ||
    new Set(ids).size !== ids.length ||
    FAILURE_DRILL_SCENARIO_IDS.some((id) => !ids.includes(id))
  ) {
    throw new Error(
      'Failure-drill evidence must contain all eight drills once.',
    );
  }
  for (const scenario of scenarioRecords) {
    if (scenario.status !== 'passed' && scenario.status !== 'failed') {
      throw new Error('Failure-drill scenario status is invalid.');
    }
    requireString(scenario, 'observation');
    if (!Array.isArray(scenario.alarmTransitions)) {
      throw new Error('Failure-drill scenario alarm transitions are invalid.');
    }
    for (const observation of scenario.alarmTransitions) {
      if (
        !isRecord(observation) ||
        typeof observation.alarmName !== 'string' ||
        observation.alarmName.length === 0 ||
        !['OK', 'ALARM', 'INSUFFICIENT_DATA'].includes(
          String(observation.state),
        ) ||
        !['before', 'during', 'after'].includes(String(observation.phase)) ||
        typeof observation.observedAt !== 'string' ||
        new Date(observation.observedAt).toISOString() !==
          observation.observedAt ||
        typeof observation.stateUpdatedAt !== 'string' ||
        new Date(observation.stateUpdatedAt).toISOString() !==
          observation.stateUpdatedAt
      ) {
        throw new Error(
          'Failure-drill scenario alarm transitions are invalid.',
        );
      }
    }
    if (!isRecord(scenario.invariants)) {
      throw new Error('Failure-drill scenario omitted invariant evidence.');
    }
    for (const invariant of FAILURE_DRILL_INVARIANT_IDS) {
      const assessment = scenario.invariants[invariant];
      if (
        !isRecord(assessment) ||
        (assessment.status !== 'preserved' &&
          assessment.status !== 'not-applicable') ||
        !Array.isArray(assessment.evidence) ||
        assessment.evidence.length === 0 ||
        !assessment.evidence.every(
          (entry) => typeof entry === 'string' && entry.length > 0,
        )
      ) {
        throw new Error(
          `Failure-drill scenario omitted evidence for ${invariant}.`,
        );
      }
    }
    if (!isRecord(scenario.facts) || Object.keys(scenario.facts).length === 0) {
      throw new Error('Failure-drill scenario requires observed facts.');
    }
    for (const fact of Object.values(scenario.facts)) {
      if (
        (typeof fact !== 'string' || fact.length === 0) &&
        typeof fact !== 'number' &&
        typeof fact !== 'boolean'
      ) {
        throw new Error('Failure-drill scenario fact is invalid.');
      }
    }
    if (!isRecord(scenario.sideEffects)) {
      throw new Error(
        'Failure-drill scenario requires side-effect reconciliation.',
      );
    }
    for (const field of [
      'expected',
      'observed',
      'missing',
      'unexpected',
      'duplicates',
    ]) {
      if (
        !Array.isArray(scenario.sideEffects[field]) ||
        !scenario.sideEffects[field].every(
          (entry) => typeof entry === 'string' && entry.length > 0,
        )
      ) {
        throw new Error(`Failure-drill sideEffects.${field} is invalid.`);
      }
    }
    const expectedReconciliation = reconcileSideEffects(
      scenario.sideEffects.expected as readonly string[],
      scenario.sideEffects.observed as readonly string[],
    );
    if (
      JSON.stringify(expectedReconciliation) !==
      JSON.stringify(scenario.sideEffects)
    ) {
      throw new Error(
        'Failure-drill side-effect reconciliation does not match its immutable identity sets.',
      );
    }
    const typedScenario = scenario as unknown as FailureDrillScenarioEvidence;
    assertEvidenceDerivedIdentities(typedScenario);
    assertAlarmEvidence(typedScenario);
  }
  if (!isRecord(value.cleanup)) {
    throw new Error('Failure-drill evidence requires cleanup truth.');
  }
  if (
    value.cleanup.status !== 'pending' &&
    value.cleanup.status !== 'complete'
  ) {
    throw new Error('Failure-drill cleanup status is invalid.');
  }
  if (
    requireString(value.cleanup, 'stackName') !== `PsdEocFailureDrill-${runId}`
  ) {
    throw new Error('Failure-drill cleanup must target the exact drill stack.');
  }
  if (
    !Array.isArray(value.cleanup.remainingResources) ||
    !value.cleanup.remainingResources.every(
      (resource) => typeof resource === 'string' && resource.length > 0,
    )
  ) {
    throw new Error('Failure-drill cleanup resource list is invalid.');
  }
  const startedAt = requireString(value, 'startedAt');
  const completedAt = requireString(value, 'completedAt');
  if (
    new Date(startedAt).toISOString() !== startedAt ||
    new Date(completedAt).toISOString() !== completedAt ||
    completedAt < startedAt
  ) {
    throw new Error('Failure-drill timestamps must be ordered ISO instants.');
  }
  return value as unknown as FailureDrillManifest;
}

export function assertSuccessfulFailureDrillManifest(value: unknown): void {
  const manifest = parseFailureDrillManifest(value);
  const invariantRequired = new Set<FailureDrillScenarioId>([
    'aurora-failover',
    'google-idp-outage',
    'duplicate-provider-callback',
    'delayed-callback-after-all-clear',
    'device-revocation-mid-event',
    'roster-sync-failure-during-activation',
  ]);
  const failures = manifest.scenarios.flatMap((scenario) => {
    const preserved = invariantRequired.has(scenario.id)
      ? FAILURE_DRILL_INVARIANT_IDS.every(
          (id) => scenario.invariants[id].status === 'preserved',
        )
      : true;
    const divergent =
      scenario.sideEffects.missing.length > 0 ||
      scenario.sideEffects.unexpected.length > 0 ||
      scenario.sideEffects.duplicates.length > 0;
    return scenario.status === 'passed' && preserved && !divergent
      ? []
      : [scenario.id];
  });
  if (failures.length > 0) {
    throw new Error(`Failure-drill divergences: ${failures.join(', ')}`);
  }
}

export function assertCompletedFailureDrillManifest(value: unknown): void {
  assertSuccessfulFailureDrillManifest(value);
  const manifest = parseFailureDrillManifest(value);
  if (
    manifest.cleanup.status !== 'complete' ||
    manifest.cleanup.remainingResources.length > 0
  ) {
    throw new Error('Failure-drill cleanup is not complete.');
  }
}
