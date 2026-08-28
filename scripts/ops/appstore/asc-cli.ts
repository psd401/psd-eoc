import { syncTestFlight } from './asc-commands';
import {
  parseTesterCsv,
  parseTestInfoJson,
  readPrivateFile,
} from './asc-inputs';
import {
  type AscAppConfiguration,
  type CliOptions,
  PLAN_DIGEST_PATTERN,
  requireString,
  type Tester,
} from './asc-model';
import { AppStoreConnectClient } from './asc-resources';
const usage = `Usage:
  bun run scripts/ops/appstore/asc.ts sync [options]

Options:
  --internal-testers PATH   CSV/Google Group export for existing ASC users
  --test-info PATH          Beta test localization JSON (kept outside the repo)
  --build ID|latest         Processed build to distribute internally
  --apply                   Perform the previewed additive writes
  --confirm-apply VALUE     Must equal ASC_BUNDLE_ID when --apply is present
  --confirm-plan DIGEST     Must equal the prior preview's sha256 planDigest
  --help                    Show this help

Configuration (environment only): ASC_APP_NAME, ASC_APP_SKU, ASC_BUNDLE_ID,
ASC_INTERNAL_GROUP_NAME.
Credentials (environment only): ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH.
Without --apply the command performs authenticated reads and prints a plan.
This command distributes to the internal TestFlight group only. It never
creates an external group and never submits a build for Beta App Review.
Tester CSVs are complete approved rosters, not merely additions.`;
export const parseCli = (
  arguments_: readonly string[],
  app: AscAppConfiguration,
): CliOptions => {
  if (arguments_[0] !== 'sync') throw new Error(usage);
  let apply = false;
  let build: string | undefined;
  let confirmApply: string | undefined;
  let confirmPlanDigest: string | undefined;
  let internalTestersPath: string | undefined;
  let testInfoPath: string | undefined;
  const valueFlags = new Map<string, (value: string) => void>([
    ['--build', (value) => (build = value)],
    ['--confirm-apply', (value) => (confirmApply = value)],
    ['--confirm-plan', (value) => (confirmPlanDigest = value)],
    ['--internal-testers', (value) => (internalTestersPath = value)],
    ['--test-info', (value) => (testInfoPath = value)],
  ]);
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    const setValue =
      argument === undefined ? undefined : valueFlags.get(argument);
    if (setValue === undefined)
      throw new Error('Unknown command-line argument.');
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('A command-line option requires a value.');
    }
    setValue(value);
    index += 1;
  }
  if (apply && confirmApply !== app.bundleId) {
    throw new Error(`--apply requires --confirm-apply ${app.bundleId}.`);
  }
  if (apply && !PLAN_DIGEST_PATTERN.test(confirmPlanDigest ?? '')) {
    throw new Error(
      '--apply requires --confirm-plan sha256:<64 lowercase hex>.',
    );
  }
  if (!apply && confirmPlanDigest !== undefined) {
    throw new Error('--confirm-plan is only valid with --apply.');
  }
  return {
    app,
    apply,
    ...(build === undefined ? {} : { build }),
    ...(confirmApply === undefined ? {} : { confirmApply }),
    ...(confirmPlanDigest === undefined ? {} : { confirmPlanDigest }),
    ...(internalTestersPath === undefined ? {} : { internalTestersPath }),
    ...(testInfoPath === undefined ? {} : { testInfoPath }),
  };
};
const readTesters = async (
  path: string | undefined,
): Promise<readonly Tester[]> => {
  if (path === undefined) return [];
  return parseTesterCsv(await readPrivateFile(path, 5000000, 'Tester CSV'));
};
export const runAscCli = async (
  arguments_: readonly string[],
): Promise<void> => {
  if (arguments_.includes('--help')) {
    console.log(usage);
    return;
  }
  const app = Object.freeze({
    appName: requireString(Bun.env.ASC_APP_NAME, 'ASC_APP_NAME', 255),
    appSku: requireString(Bun.env.ASC_APP_SKU, 'ASC_APP_SKU', 255),
    bundleId: requireString(Bun.env.ASC_BUNDLE_ID, 'ASC_BUNDLE_ID', 255),
    internalGroupName: requireString(
      Bun.env.ASC_INTERNAL_GROUP_NAME,
      'ASC_INTERNAL_GROUP_NAME',
      255,
    ),
  });
  const cli = parseCli(arguments_, app);
  const keyId = requireString(Bun.env.ASC_KEY_ID, 'ASC_KEY_ID', 255);
  const issuerId = requireString(Bun.env.ASC_ISSUER_ID, 'ASC_ISSUER_ID', 255);
  const keyPath = requireString(Bun.env.ASC_KEY_PATH, 'ASC_KEY_PATH', 4096);
  const [privateKey, internalTesters, testInfo] = await Promise.all([
    readPrivateFile(keyPath, 64000, 'ASC private key'),
    readTesters(cli.internalTestersPath),
    cli.testInfoPath === undefined
      ? Promise.resolve(undefined)
      : readPrivateFile(cli.testInfoPath, 64000, 'Beta-test input').then(
          parseTestInfoJson,
        ),
  ]);
  const client = new AppStoreConnectClient({ issuerId, keyId, privateKey });
  const commonOptions = {
    app: cli.app,
    internalTesters,
    ...(cli.build === undefined ? {} : { build: cli.build }),
    ...(testInfo === undefined ? {} : { testInfo }),
  };
  const result = cli.apply
    ? await syncTestFlight(client, {
        ...commonOptions,
        apply: true,
        confirmPlanDigest: cli.confirmPlanDigest as string,
      })
    : await syncTestFlight(client, { ...commonOptions, apply: false });
  console.log(JSON.stringify(result, null, 2));
};
