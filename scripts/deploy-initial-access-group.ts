import { readInitialAccessGroupConfiguration } from '../packages/server/db/bootstrap-access';

const GROUP_ID = 'INITIAL_ACCESS_GROUP_ID';
const GROUP_EMAIL = 'INITIAL_ACCESS_GROUP_EMAIL';
const GROUP_NAME = 'INITIAL_ACCESS_GROUP_NAME';

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Validates the GitHub deployment inputs before any image build or CDK update.
 * Values are deliberately never included in diagnostics because the group
 * address is an Actions secret and deployment logs are retained.
 */
export function validateInitialAccessGroupConfiguration(
  environment: Environment,
): 'configured' | 'omitted' {
  const configuration = readInitialAccessGroupConfiguration(environment, {
    groupId: GROUP_ID,
    groupEmail: GROUP_EMAIL,
    groupName: GROUP_NAME,
  });
  return configuration === null ? 'omitted' : 'configured';
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
