export const EXPECTED_BODY: string;
export const MAX_RESPONSE_BYTES: number;
export const REQUEST_TIMEOUT_MILLISECONDS: number;

export function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  maximumLength?: number,
): string;

export function assertCanaryUrl(value: string): URL;

export function parseCredential(secret: {
  readonly SecretString?: string;
}): string;

export function scheduledMetricTimestamp(event: unknown): Date;

export function readBoundedBody(response: Response): Promise<string>;
