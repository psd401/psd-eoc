const GROUP_ID = 'INITIAL_ACCESS_GROUP_ID';
const GROUP_EMAIL = 'INITIAL_ACCESS_GROUP_EMAIL';
const GROUP_NAME = 'INITIAL_ACCESS_GROUP_NAME';

type Environment = Readonly<Record<string, string | undefined>>;

function isConfigured(environment: Environment, name: string): boolean {
  return (environment[name]?.trim().length ?? 0) > 0;
}

/**
 * Validates the GitHub deployment inputs before any image build or CDK update.
 * Values are deliberately never included in diagnostics because the group
 * address is an Actions secret and deployment logs are retained.
 */
export function validateInitialAccessGroupConfiguration(
  environment: Environment,
): 'configured' | 'omitted' {
  const hasId = isConfigured(environment, GROUP_ID);
  const hasEmail = isConfigured(environment, GROUP_EMAIL);
  const hasName = isConfigured(environment, GROUP_NAME);

  if (!hasId && !hasEmail && !hasName) return 'omitted';
  if (!hasId && !hasEmail) {
    throw new Error(`${GROUP_ID} and ${GROUP_EMAIL} are missing.`);
  }
  if (!hasId) {
    throw new Error(
      `${GROUP_ID} is missing; set it together with ${GROUP_EMAIL}.`,
    );
  }
  if (!hasEmail) {
    throw new Error(
      `${GROUP_EMAIL} is missing; set it together with ${GROUP_ID}.`,
    );
  }
  return 'configured';
}

if (import.meta.main) {
  try {
    const status = validateInitialAccessGroupConfiguration(process.env);
    console.info(`Initial access group configuration: ${status}.`);
  } catch (error) {
    console.error(
      `Initial access group configuration is invalid: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    process.exitCode = 1;
  }
}
