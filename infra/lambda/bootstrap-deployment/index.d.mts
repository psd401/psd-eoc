interface BootstrapDependencies {
  readonly now?: () => number;
  readonly readStackStatus?: (stackId: string) => Promise<string>;
  readonly runTask?: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

interface BootstrapCheckDependencies {
  readonly describeTasks?: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  readonly now?: () => number;
  readonly stopTask?: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

interface RollbackValidationDependencies {
  readonly batchGetImage?: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  readonly fetchLayer?: (
    input: string,
    init: { readonly redirect: 'error' },
  ) => Promise<Response>;
  readonly getDownloadUrlForLayer?: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

interface RollbackQuiescenceDependencies {
  readonly describeServices?: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

interface BootstrapStartResult {
  readonly Data: Readonly<Record<string, unknown>>;
  readonly PhysicalResourceId: string;
}

export function startBootstrap(
  event: unknown,
  dependencies?: BootstrapDependencies,
): Promise<BootstrapStartResult>;

export function checkBootstrap(
  event: unknown,
  dependencies?: BootstrapCheckDependencies,
): Promise<{ readonly IsComplete: boolean }>;

export function onEvent(event: unknown): Promise<BootstrapStartResult>;
export function isComplete(
  event: unknown,
): Promise<{ readonly IsComplete: boolean }>;

export function validateRollbackImage(
  event: unknown,
  dependencies?: RollbackValidationDependencies,
): Promise<BootstrapStartResult>;

export function validateRollbackQuiescence(
  event: unknown,
  dependencies?: RollbackQuiescenceDependencies,
): Promise<BootstrapStartResult>;

export function resolveRollbackImage(
  event: unknown,
): Promise<BootstrapStartResult>;
