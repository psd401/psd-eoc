export interface CanaryRuntimeDependencies {
  readonly fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly publishMetrics?: (
    namespace: string,
    success: boolean,
    latencyMilliseconds: number,
    timestamp: Date,
  ) => Promise<void>;
  readonly readSecret?: (
    secretArn: string,
  ) => Promise<{ readonly SecretString?: string }>;
  readonly reportFailure?: (stage: string) => void;
}

export function runCanary(
  event: unknown,
  dependencies?: CanaryRuntimeDependencies,
): Promise<void>;

export function handler(event: unknown): Promise<void>;
