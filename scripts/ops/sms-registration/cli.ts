import {
  defaultToken,
  parseStatusOptions,
  parseSubmitOptions,
  runStatus,
  runSubmit,
  terminalSafeText,
  type RegistrationKind,
  type Runtime,
} from './core';

export function defaultRuntime(): Runtime {
  return {
    createApi: async () => {
      const { createAwsApi } = await import('./aws-adapter');
      return createAwsApi();
    },
    env: process.env,
    isInteractive:
      process.stdin.isTTY === true && process.stdout.isTTY === true,
    randomToken: defaultToken,
    stderr: (message) => console.error(message),
    stdout: (message) => console.log(message),
  };
}

function errorMessage(error: unknown): string {
  return terminalSafeText(
    error instanceof Error ? error.message : String(error),
  );
}

export async function submitMain(
  kind: RegistrationKind,
  args: readonly string[],
  baseDirectory: string,
  runtime: Runtime = defaultRuntime(),
): Promise<number> {
  try {
    await runSubmit(kind, parseSubmitOptions(args, baseDirectory), runtime);
    return 0;
  } catch (error) {
    runtime.stderr(`ERROR: ${errorMessage(error)}`);
    return 1;
  }
}

export async function statusMain(
  args: readonly string[],
  baseDirectory: string,
  runtime: Runtime = defaultRuntime(),
): Promise<number> {
  try {
    await runStatus(parseStatusOptions(args, baseDirectory), runtime);
    return 0;
  } catch (error) {
    runtime.stderr(`ERROR: ${errorMessage(error)}`);
    return 1;
  }
}
