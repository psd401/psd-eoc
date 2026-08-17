import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const serviceArn =
  'arn:aws:apprunner:us-west-2:<aws-account-id>:service/psd-eoc-exploration-smoke/fd60545104344bd39ae9920feef7dd5c';
const domainName = 'eoc.psd401.net';
const dnsTarget = 'abcdefghij.us-west-2.awsapprunner.com';
const workflowUrl = new URL(
  '../../../.github/workflows/associate-exploration-custom-domain.yml',
  import.meta.url,
);

interface ValidationRecord {
  readonly Name: string;
  readonly Status: string;
  readonly Type: string;
  readonly Value: string;
}

interface CustomDomain {
  readonly CertificateValidationRecords: readonly ValidationRecord[];
  readonly DomainName: string;
  readonly EnableWWWSubdomain: boolean;
  readonly Status: string;
}

interface DescribeCustomDomainsResponse {
  readonly CustomDomains: readonly CustomDomain[];
  readonly DNSTarget: string;
  readonly ServiceArn: string;
}

interface ScenarioOptions {
  readonly acknowledge?: string;
  readonly associateResponse?: {
    readonly CustomDomain: CustomDomain;
    readonly DNSTarget: string;
    readonly ServiceArn: string;
  };
  readonly customDomainResponses: readonly DescribeCustomDomainsResponse[];
  readonly mode?: 'associate-if-absent' | 'inspect-only';
  readonly operationStatuses?: readonly string[];
  readonly serviceName?: string;
  readonly serviceStatus?: string;
}

interface ScenarioResult {
  readonly artifactDirectory: string;
  readonly awsCalls: readonly string[];
  readonly describeCount: number;
  readonly directory: string;
  readonly exitCode: number;
  readonly result: unknown;
  readonly sleepCalls: readonly string[];
  readonly stderr: string;
  readonly summary: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function readWorkflow(): Promise<string> {
  return Bun.file(workflowUrl).text();
}

function customDomainScript(workflow: string): string {
  const script = workflow.match(
    / {6}- name: Inspect or associate the exact App Runner custom domain[\s\S]*? {8}run: \|\n([\s\S]*?)\n {6}- name: Upload exact and redacted provider readback/,
  )?.[1];
  if (script === undefined) {
    throw new Error('custom-domain workflow step is missing');
  }
  return script.replace(/^ {10}/gm, '');
}

function validationRecord(
  status: 'FAILED' | 'PENDING_VALIDATION' | 'SUCCESS' = 'PENDING_VALIDATION',
): ValidationRecord {
  return {
    Name: '_validation.eoc.psd401.net.',
    Status: status,
    Type: 'CNAME',
    Value: '_token.acm-validations.aws.',
  };
}

function customDomain(options?: {
  readonly domain?: string;
  readonly enableWWW?: boolean;
  readonly records?: readonly ValidationRecord[];
  readonly status?: string;
}): CustomDomain {
  return {
    CertificateValidationRecords: options?.records ?? [validationRecord()],
    DomainName: options?.domain ?? domainName,
    EnableWWWSubdomain: options?.enableWWW ?? false,
    Status: options?.status ?? 'PENDING_CERTIFICATE_DNS_VALIDATION',
  };
}

function response(
  domains: readonly CustomDomain[],
  options?: { readonly target?: string; readonly service?: string },
): DescribeCustomDomainsResponse {
  return {
    CustomDomains: domains,
    DNSTarget: options?.target ?? dnsTarget,
    ServiceArn: options?.service ?? serviceArn,
  };
}

async function runScenario(options: ScenarioOptions): Promise<ScenarioResult> {
  const directory = await mkdtemp(
    join(tmpdir(), 'psd-eoc-custom-domain-test-'),
  );
  temporaryDirectories.push(directory);
  const fakeBin = join(directory, 'bin');
  const artifactDirectory = join(directory, 'artifacts', 'custom-domain');
  const fixtureDirectory = join(directory, 'fixtures');
  await Promise.all([
    mkdir(fakeBin, { recursive: true }),
    mkdir(artifactDirectory, { recursive: true }),
    mkdir(fixtureDirectory, { recursive: true }),
  ]);

  const mode = options.mode ?? 'inspect-only';
  const acknowledge =
    options.acknowledge ??
    (mode === 'inspect-only'
      ? 'INSPECT EOC.PSD401.NET CUSTOM DOMAIN'
      : 'ASSOCIATE EOC.PSD401.NET WITHOUT WWW');
  const outerIdentity = {
    Account: '<aws-account-id>',
    Arn: 'arn:aws:sts::<aws-account-id>:assumed-role/psd-eoc-exploration-smoke-github-deploy/psd-eoc-domain-123',
    UserId: 'AROATEST:psd-eoc-domain-123',
  };
  await Bun.write(
    join(artifactDirectory, 'outer-identity-before.json'),
    JSON.stringify(outerIdentity),
  );
  await Promise.all(
    options.customDomainResponses.map((item, index) =>
      Bun.write(
        join(fixtureDirectory, `custom-domain-${index}.json`),
        JSON.stringify(item),
      ),
    ),
  );
  await Bun.write(
    join(fixtureDirectory, 'associate.json'),
    JSON.stringify(
      options.associateResponse ?? {
        CustomDomain: customDomain(),
        DNSTarget: dnsTarget,
        ServiceArn: serviceArn,
      },
    ),
  );
  await Bun.write(
    join(fixtureDirectory, 'operations.json'),
    JSON.stringify({
      OperationSummaryList: (options.operationStatuses ?? []).map(
        (status, index) => ({
          EndedAt: '2026-08-17T10:00:00Z',
          Id: `operation-${index}`,
          StartedAt: '2026-08-17T09:59:00Z',
          Status: status,
          Type: 'UPDATE_SERVICE',
        }),
      ),
    }),
  );
  await Bun.write(
    join(fixtureDirectory, 'service.json'),
    JSON.stringify({
      Service: {
        ServiceArn: serviceArn,
        ServiceName: options.serviceName ?? 'psd-eoc-exploration-smoke',
        Status: options.serviceStatus ?? 'RUNNING',
      },
    }),
  );

  const awsCallsFile = join(directory, 'aws-calls.txt');
  const describeCountFile = join(directory, 'describe-count.txt');
  const sleepCallsFile = join(directory, 'sleep-calls.txt');
  await Promise.all([
    Bun.write(awsCallsFile, ''),
    Bun.write(describeCountFile, '0\n'),
    Bun.write(sleepCallsFile, ''),
  ]);

  const awsPath = join(fakeBin, 'aws');
  await Bun.write(
    awsPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s:%s\t%s\t%s\n' "$1" "$2" "\${AWS_ACCESS_KEY_ID:-missing}" "$*" >> "$AWS_CALLS_FILE"

case "$1:$2" in
  sts:assume-role)
    test "\${AWS_ACCESS_KEY_ID:-}" = 'oidc-access'
    printf '%s\n' '{"AccessKeyId":"ASIAAAAAAAAAAAAAAAAA","Expiration":"2026-08-17T10:15:00Z","SecretAccessKey":"ssssssssssssssssssssssssssssssssssssssss","SessionToken":"tttttttttttttttttttttttttttttttt"}'
    ;;
  sts:get-caller-identity)
    if [[ "\${AWS_ACCESS_KEY_ID:-}" == 'ASIAAAAAAAAAAAAAAAAA' ]]; then
      printf '%s\n' '{"Account":"<aws-account-id>","Arn":"arn:aws:sts::<aws-account-id>:assumed-role/cdk-hnb659fds-deploy-role-<aws-account-id>-us-west-2/psd-eoc-domain-readback-123","UserId":"AROATEST:psd-eoc-domain-readback-123"}'
    else
      printf '%s\n' '{"Account":"<aws-account-id>","Arn":"arn:aws:sts::<aws-account-id>:assumed-role/psd-eoc-exploration-smoke-github-deploy/psd-eoc-domain-123","UserId":"AROATEST:psd-eoc-domain-123"}'
    fi
    ;;
  apprunner:describe-service)
    test "\${AWS_ACCESS_KEY_ID:-}" = 'ASIAAAAAAAAAAAAAAAAA'
    cat "$FIXTURE_DIRECTORY/service.json"
    ;;
  apprunner:list-operations)
    test "\${AWS_ACCESS_KEY_ID:-}" = 'ASIAAAAAAAAAAAAAAAAA'
    cat "$FIXTURE_DIRECTORY/operations.json"
    ;;
  apprunner:describe-custom-domains)
    test "\${AWS_ACCESS_KEY_ID:-}" = 'ASIAAAAAAAAAAAAAAAAA'
    count=$(cat "$DESCRIBE_COUNT_FILE")
    fixture="$FIXTURE_DIRECTORY/custom-domain-$count.json"
    if [[ ! -f "$fixture" ]]; then
      fixture="$FIXTURE_DIRECTORY/custom-domain-$((CUSTOM_DOMAIN_RESPONSE_COUNT - 1)).json"
    fi
    cat "$fixture"
    printf '%s\n' "$((count + 1))" > "$DESCRIBE_COUNT_FILE"
    ;;
  apprunner:associate-custom-domain)
    test "\${AWS_ACCESS_KEY_ID:-}" = 'ASIAAAAAAAAAAAAAAAAA'
    cat "$FIXTURE_DIRECTORY/associate.json"
    ;;
  *)
    echo "Unexpected AWS command: $*" >&2
    exit 97
    ;;
esac
`,
  );
  const sleepPath = join(fakeBin, 'sleep');
  await Bun.write(
    sleepPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$SLEEP_CALLS_FILE"
`,
  );
  await Promise.all([chmod(awsPath, 0o755), chmod(sleepPath, 0o755)]);

  const workflow = await readWorkflow();
  const child = Bun.spawn(['bash', '-c', customDomainScript(workflow)], {
    cwd: directory,
    env: {
      ...processEnv(),
      ACKNOWLEDGE: acknowledge,
      APP_RUNNER_SERVICE_ARN: serviceArn,
      APP_RUNNER_SERVICE_NAME: 'psd-eoc-exploration-smoke',
      AWS_ACCESS_KEY_ID: 'oidc-access',
      AWS_ACCOUNT_ID: '<aws-account-id>',
      AWS_REGION: 'us-west-2',
      AWS_SECRET_ACCESS_KEY: 'oidc-secret',
      AWS_SESSION_TOKEN: 'oidc-token',
      AWS_CALLS_FILE: awsCallsFile,
      CDK_DEPLOY_ROLE_ARN:
        'arn:aws:iam::<aws-account-id>:role/cdk-hnb659fds-deploy-role-<aws-account-id>-us-west-2',
      CUSTOM_DOMAIN: domainName,
      CUSTOM_DOMAIN_RESPONSE_COUNT: String(
        options.customDomainResponses.length,
      ),
      DESCRIBE_COUNT_FILE: describeCountFile,
      FIXTURE_DIRECTORY: fixtureDirectory,
      GITHUB_RUN_ID: '123',
      GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
      MODE: mode,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      READBACK_ATTEMPTS: '6',
      READBACK_RETRY_SECONDS: '5',
      RUNNER_TEMP: join(directory, 'runner-temp'),
      SLEEP_CALLS_FILE: sleepCallsFile,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]).then(([code, standardError]) => [code, standardError] as const);

  return {
    artifactDirectory,
    awsCalls: (await Bun.file(awsCallsFile).text())
      .trim()
      .split('\n')
      .filter(Boolean),
    describeCount: Number((await Bun.file(describeCountFile).text()).trim()),
    directory,
    exitCode,
    result: await readOptionalJson(join(artifactDirectory, 'result.json')),
    sleepCalls: (await Bun.file(sleepCallsFile).text())
      .trim()
      .split('\n')
      .filter(Boolean),
    stderr,
    summary: await readOptionalText(join(directory, 'summary.md')),
  };
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function readOptionalJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.json() : undefined;
}

async function readOptionalText(path: string): Promise<string> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : '';
}

function commandCount(result: ScenarioResult, command: string): number {
  return result.awsCalls.filter((call) => call.startsWith(`${command}\t`))
    .length;
}

function expectNoForbiddenAwsWrites(result: ScenarioResult): void {
  expect(result.awsCalls.some((call) => call.startsWith('route53:'))).toBe(
    false,
  );
  expect(
    result.awsCalls.some((call) =>
      call.startsWith('apprunner:disassociate-custom-domain'),
    ),
  ).toBe(false);
}

describe('exploration custom-domain protected workflow', () => {
  it('is a standalone protected main-only OIDC workflow with one exact no-www write shape', async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).not.toContain('push:');
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain('name: exploration-smoke');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain(
      'role-to-assume: ${{ env.OUTER_OIDC_ROLE_ARN }}',
    );
    expect(workflow).toContain(serviceArn);
    expect(workflow).toContain(
      'arn:aws:iam::<aws-account-id>:role/cdk-hnb659fds-deploy-role-<aws-account-id>-us-west-2',
    );
    expect(
      workflow.match(/aws apprunner associate-custom-domain/g),
    ).toHaveLength(1);
    expect(workflow).toContain('--no-enable-www-subdomain');
    expect(workflow).not.toContain('aws route53');
    expect(workflow).not.toContain('aws apprunner disassociate-custom-domain');
    expect(workflow).not.toMatch(/AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY):\s*\S/);
    expect(workflow).toContain(
      '<internal-name-server> (10.0.70.76)',
    );
    expect(workflow).toContain(
      'vmnocdcpridns01.peninsula.wednet.edu (10.0.70.77)',
    );
  });

  it('keeps inspect-only absent state read-only and emits no handoff', async () => {
    const result = await runScenario({
      customDomainResponses: [response([])],
      mode: 'inspect-only',
    });

    expect(result.exitCode).toBe(0);
    expect(commandCount(result, 'apprunner:describe-custom-domains')).toBe(1);
    expect(commandCount(result, 'apprunner:associate-custom-domain')).toBe(0);
    expect(result.result).toMatchObject({
      dnsChanged: false,
      dnsHandoffAvailable: false,
      state: 'absent',
      tlsVerified: false,
    });
    expect(result.summary).toContain('performed no AWS write');
    expectNoForbiddenAwsWrites(result);
  });

  it('associates an absent exact domain once, with www disabled, then emits every CNAME', async () => {
    const pending = customDomain({
      records: [
        validationRecord(),
        {
          Name: '_second.eoc.psd401.net.',
          Status: 'PENDING_VALIDATION',
          Type: 'CNAME',
          Value: '_second.acm-validations.aws.',
        },
      ],
    });
    const result = await runScenario({
      associateResponse: {
        CustomDomain: customDomain({ records: [], status: 'CREATING' }),
        DNSTarget: dnsTarget,
        ServiceArn: serviceArn,
      },
      customDomainResponses: [response([]), response([pending])],
      mode: 'associate-if-absent',
    });

    expect(result.exitCode).toBe(0);
    expect(commandCount(result, 'apprunner:associate-custom-domain')).toBe(1);
    expect(commandCount(result, 'apprunner:describe-custom-domains')).toBe(2);
    const associateCall = result.awsCalls.find((call) =>
      call.startsWith('apprunner:associate-custom-domain'),
    );
    expect(associateCall).toContain(`--domain-name ${domainName}`);
    expect(associateCall).toContain('--no-enable-www-subdomain');
    expect(associateCall).not.toContain(' --enable-www-subdomain');
    expect(result.result).toMatchObject({
      dnsChanged: false,
      dnsHandoffAvailable: true,
      state: 'associated-now',
      tlsVerified: false,
      handoff: {
        enableWWWSubdomain: false,
        trafficCname: {
          name: domainName,
          type: 'CNAME',
          value: dnsTarget,
        },
      },
    });
    expect(
      (result.result as { handoff: { certificateValidationCnames: unknown[] } })
        .handoff.certificateValidationCnames,
    ).toHaveLength(2);
    expect(result.summary).toContain(
      'DNS is not changed and TLS is not yet verified',
    );
    expectNoForbiddenAwsWrites(result);
  });

  it('treats a complete pending association as idempotent', async () => {
    const result = await runScenario({
      customDomainResponses: [response([customDomain()])],
      mode: 'associate-if-absent',
    });

    expect(result.exitCode).toBe(0);
    expect(commandCount(result, 'apprunner:associate-custom-domain')).toBe(0);
    expect(result.describeCount).toBe(1);
    expect(result.result).toMatchObject({
      dnsHandoffAvailable: true,
      state: 'existing',
      handoff: {
        customDomainStatus: 'PENDING_CERTIFICATE_DNS_VALIDATION',
      },
    });
    expectNoForbiddenAwsWrites(result);
  });

  it('reads back an ACTIVE association without rewriting it or claiming TLS', async () => {
    const active = customDomain({
      records: [validationRecord('SUCCESS')],
      status: 'ACTIVE',
    });
    const result = await runScenario({
      customDomainResponses: [response([active])],
      mode: 'inspect-only',
    });

    expect(result.exitCode).toBe(0);
    expect(commandCount(result, 'apprunner:associate-custom-domain')).toBe(0);
    expect(result.result).toMatchObject({
      dnsChanged: false,
      tlsVerified: false,
      handoff: { customDomainStatus: 'ACTIVE' },
    });
    expectNoForbiddenAwsWrites(result);
  });

  it('retries only DescribeCustomDomains while validation records become complete', async () => {
    const partial = customDomain({ records: [] });
    const complete = customDomain({ records: [validationRecord()] });
    const result = await runScenario({
      customDomainResponses: [response([partial]), response([complete])],
      mode: 'inspect-only',
    });

    expect(result.exitCode).toBe(0);
    expect(result.describeCount).toBe(2);
    expect(result.sleepCalls).toEqual(['5']);
    expect(commandCount(result, 'apprunner:associate-custom-domain')).toBe(0);
    expectNoForbiddenAwsWrites(result);
  });

  it('fails closed on a foreign domain before any write', async () => {
    const result = await runScenario({
      customDomainResponses: [
        response([customDomain({ domain: 'foreign.psd401.net' })]),
      ],
      mode: 'associate-if-absent',
    });

    expect(result.exitCode).not.toBe(0);
    expect(commandCount(result, 'apprunner:associate-custom-domain')).toBe(0);
    expectNoForbiddenAwsWrites(result);
  });

  it('fails closed on an existing www-enabled mismatch', async () => {
    const result = await runScenario({
      customDomainResponses: [response([customDomain({ enableWWW: true })])],
      mode: 'associate-if-absent',
    });

    expect(result.exitCode).not.toBe(0);
    expect(commandCount(result, 'apprunner:associate-custom-domain')).toBe(0);
    expect(result.stderr).toContain(
      'Certificate validation records remained missing, partial, invalid, or failed.',
    );
    expectNoForbiddenAwsWrites(result);
  });

  it('fails closed when the association response names a different service', async () => {
    const result = await runScenario({
      associateResponse: {
        CustomDomain: customDomain({ status: 'CREATING' }),
        DNSTarget: dnsTarget,
        ServiceArn:
          'arn:aws:apprunner:us-west-2:<aws-account-id>:service/not-the-service/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      customDomainResponses: [response([])],
      mode: 'associate-if-absent',
    });

    expect(result.exitCode).not.toBe(0);
    expect(commandCount(result, 'apprunner:associate-custom-domain')).toBe(1);
    expect(result.describeCount).toBe(1);
    expect(result.result).toBeUndefined();
    expectNoForbiddenAwsWrites(result);
  });

  it('fails closed on an active App Runner operation before domain inspection or write', async () => {
    const result = await runScenario({
      customDomainResponses: [response([])],
      mode: 'associate-if-absent',
      operationStatuses: ['IN_PROGRESS'],
    });

    expect(result.exitCode).not.toBe(0);
    expect(commandCount(result, 'apprunner:describe-custom-domains')).toBe(0);
    expect(commandCount(result, 'apprunner:associate-custom-domain')).toBe(0);
    expectNoForbiddenAwsWrites(result);
  });

  it('fails closed when validation readback remains partial through the bounded retry', async () => {
    const result = await runScenario({
      customDomainResponses: [response([customDomain({ records: [] })])],
      mode: 'inspect-only',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.describeCount).toBe(6);
    expect(result.sleepCalls).toHaveLength(5);
    expect(commandCount(result, 'apprunner:associate-custom-domain')).toBe(0);
    expectNoForbiddenAwsWrites(result);
  });

  it('scopes App Runner calls to the deploy role and restores the outer OIDC identity', async () => {
    const result = await runScenario({
      customDomainResponses: [response([])],
      mode: 'inspect-only',
    });

    expect(result.exitCode).toBe(0);
    for (const call of result.awsCalls.filter((item) =>
      item.startsWith('apprunner:'),
    )) {
      expect(call).toContain('\tASIAAAAAAAAAAAAAAAAA\t');
    }
    const identityCalls = result.awsCalls.filter((call) =>
      call.startsWith('sts:get-caller-identity'),
    );
    expect(identityCalls[0]).toContain('\tASIAAAAAAAAAAAAAAAAA\t');
    expect(identityCalls.at(-1)).toContain('\toidc-access\t');
    expect(
      await Bun.file(
        join(result.artifactDirectory, 'outer-identity-after.json'),
      ).json(),
    ).toEqual(
      await Bun.file(
        join(result.artifactDirectory, 'outer-identity-before.json'),
      ).json(),
    );
    expectNoForbiddenAwsWrites(result);
  });
});
