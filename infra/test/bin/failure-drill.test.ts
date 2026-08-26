import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type JsonObject = Readonly<Record<string, unknown>>;

const infraDirectory = fileURLToPath(new URL('../..', import.meta.url));
const cdkConfiguration = JSON.parse(
  await readFile(new URL('../../cdk.json', import.meta.url), 'utf8'),
) as Readonly<{ context: JsonObject }>;
const synthesizedTemplate = new URL(
  '../../../node_modules/.cache/psd-eoc-failure-drill-cdk.out/FailureDrill.template.json',
  import.meta.url,
);

test('the actual failure-drill CLI synth cannot inherit production tenant context', async () => {
  const runId = 'issue31cli';
  const productionContext = cdkConfiguration.context;
  const process = Bun.spawn(['bun', 'run', 'synth:failure-drill'], {
    cwd: infraDirectory,
    env: {
      ...globalThis.process.env,
      AWS_ACCOUNT_ALIAS: String(productionContext['psdEoc:awsAccountAlias']),
      AWS_ACCOUNT_ID: String(productionContext['psdEoc:awsAccount']),
      AWS_REGION: String(productionContext['psdEoc:awsRegion']),
      FAILURE_DRILL_RUN_ID: runId,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Failure-drill CLI synth failed:\n${stdout}\n${stderr}`);
  }

  const serialized = await readFile(synthesizedTemplate, 'utf8');
  const template = JSON.parse(serialized) as Readonly<{
    Parameters?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  }>;
  expect(
    template.Parameters?.FailureDrillApplicationOrigin?.AllowedPattern,
  ).toBe(
    `^https://(?:${runId}\\.example\\.invalid|[a-z0-9][a-z0-9-]{0,62}\\.us-west-2\\.awsapprunner\\.com)$`,
  );
  expect(serialized).toContain('FailureDrillApplicationOrigin');
  expect(serialized).toContain('Synthetic Failure Drill District');
  expect(serialized).toContain('Synthetic Failure Drill Campus');

  for (const key of [
    'psdEoc:applicationOrigin',
    'psdEoc:awsAccountAlias',
    'psdEoc:hostedDomain',
    'psdEoc:iosBundleId',
    'psdEoc:organizationName',
    'psdEoc:displayTimeZone',
  ]) {
    const value = productionContext[key];
    if (typeof value === 'string') expect(serialized).not.toContain(value);
  }
  const facilities = productionContext['psdEoc:facilities'];
  if (!Array.isArray(facilities)) {
    throw new Error('The production CDK context must declare facilities.');
  }
  for (const facility of facilities) {
    if (typeof facility !== 'object' || facility === null) continue;
    const name = Reflect.get(facility, 'name');
    if (typeof name === 'string') expect(serialized).not.toContain(name);
  }
});
