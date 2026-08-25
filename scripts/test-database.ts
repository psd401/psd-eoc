import { basename, dirname } from 'node:path';

const REPOSITORY_ROOT = new URL('..', import.meta.url).pathname;

export type TestDatabaseCommand = 'start' | 'stop';

export function parseTestDatabaseCommand(
  arguments_: readonly string[],
): TestDatabaseCommand {
  const command = arguments_[0];
  if (arguments_.length !== 1 || (command !== 'start' && command !== 'stop')) {
    throw new Error('Usage: bun run test:db:start | bun run test:db:stop');
  }
  return command;
}

export function testDatabaseProjectName(
  repositoryRoot: string = REPOSITORY_ROOT,
): string {
  const worktree = basename(dirname(repositoryRoot))
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/gu, '-');
  return `psd-eoc-${worktree}`.slice(0, 63);
}

export function composeArguments(
  command: TestDatabaseCommand,
  projectName: string = testDatabaseProjectName(),
): string[] {
  const common = [
    'compose',
    '--project-name',
    projectName,
    '-f',
    'compose.test.yml',
  ];
  return command === 'start'
    ? [...common, 'up', '-d', '--wait']
    : [...common, 'down', '--volumes'];
}

export async function runTestDatabaseCommand(
  command: TestDatabaseCommand,
): Promise<number> {
  const projectName = testDatabaseProjectName();
  const child = Bun.spawn(
    ['docker', ...composeArguments(command, projectName)],
    {
      cwd: REPOSITORY_ROOT,
      stderr: 'inherit',
      stdout: 'inherit',
    },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0 || command === 'stop') return exitCode;

  const portProcess = Bun.spawn(
    [
      'docker',
      'compose',
      '--project-name',
      projectName,
      '-f',
      'compose.test.yml',
      'port',
      'postgres',
      '5432',
    ],
    { cwd: REPOSITORY_ROOT, stderr: 'pipe', stdout: 'pipe' },
  );
  const [portOutput, portError, portExitCode] = await Promise.all([
    new Response(portProcess.stdout).text(),
    new Response(portProcess.stderr).text(),
    portProcess.exited,
  ]);
  const match = /127\.0\.0\.1:(\d+)/u.exec(portOutput);
  if (portExitCode !== 0 || match?.[1] === undefined) {
    console.error(portError || 'Docker did not report the PostgreSQL port.');
    return 1;
  }
  const testDatabaseUrl = `postgresql://psd_eoc_test:synthetic_test_password@127.0.0.1:${match[1]}/psd_eoc_test`;
  console.info(
    `Synthetic PostgreSQL is ready.\nexport TEST_DATABASE_URL='${testDatabaseUrl}'\nexport DATABASE_URL="$TEST_DATABASE_URL"`,
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runTestDatabaseCommand(
    parseTestDatabaseCommand(Bun.argv.slice(2)),
  );
}
