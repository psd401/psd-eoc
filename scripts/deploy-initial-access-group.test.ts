import { describe, expect, test } from 'bun:test';

import { validateInitialAccessGroupConfiguration } from './deploy-initial-access-group';

const WORKFLOW = new URL('../.github/workflows/deploy.yml', import.meta.url);
const PREFLIGHT = new URL('./deploy-initial-access-group.ts', import.meta.url);

describe('initial access group deployment preflight', () => {
  test('accepts either a complete required pair or no configuration', () => {
    expect(validateInitialAccessGroupConfiguration({})).toBe('omitted');
    expect(
      validateInitialAccessGroupConfiguration({
        INITIAL_ACCESS_GROUP_ID: '  ',
        INITIAL_ACCESS_GROUP_EMAIL: '',
        INITIAL_ACCESS_GROUP_NAME: '\t',
      }),
    ).toBe('omitted');
    expect(
      validateInitialAccessGroupConfiguration({
        INITIAL_ACCESS_GROUP_ID: 'groups/synthetic-administrators',
        INITIAL_ACCESS_GROUP_EMAIL: 'administrators@example.invalid',
      }),
    ).toBe('configured');
    expect(
      validateInitialAccessGroupConfiguration({
        INITIAL_ACCESS_GROUP_ID: 'groups/synthetic-administrators',
        INITIAL_ACCESS_GROUP_EMAIL: 'administrators@example.invalid',
        INITIAL_ACCESS_GROUP_NAME: 'System administrators',
      }),
    ).toBe('configured');
  });

  test('names a missing email without exposing the configured id', () => {
    const configuredId = 'groups/do-not-repeat-this-identifier';
    expect(() =>
      validateInitialAccessGroupConfiguration({
        INITIAL_ACCESS_GROUP_ID: configuredId,
      }),
    ).toThrow('INITIAL_ACCESS_GROUP_EMAIL is missing');

    try {
      validateInitialAccessGroupConfiguration({
        INITIAL_ACCESS_GROUP_ID: configuredId,
      });
    } catch (error) {
      expect(String(error)).not.toContain(configuredId);
    }
  });

  test('names a missing id without exposing the configured email', () => {
    const configuredEmail = 'do-not-print@example.invalid';
    expect(() =>
      validateInitialAccessGroupConfiguration({
        INITIAL_ACCESS_GROUP_EMAIL: configuredEmail,
      }),
    ).toThrow('INITIAL_ACCESS_GROUP_ID is missing');

    try {
      validateInitialAccessGroupConfiguration({
        INITIAL_ACCESS_GROUP_EMAIL: configuredEmail,
      });
    } catch (error) {
      expect(String(error)).not.toContain(configuredEmail);
    }
  });

  test('refuses a display name without the required pair', () => {
    expect(() =>
      validateInitialAccessGroupConfiguration({
        INITIAL_ACCESS_GROUP_NAME: 'System administrators',
      }),
    ).toThrow(
      'INITIAL_ACCESS_GROUP_ID and INITIAL_ACCESS_GROUP_EMAIL are missing',
    );
  });

  test('refuses every partial pair without reflecting configured values', () => {
    for (const environment of [
      {
        INITIAL_ACCESS_GROUP_ID: 'groups/private-id',
        INITIAL_ACCESS_GROUP_NAME: 'Private name',
      },
      {
        INITIAL_ACCESS_GROUP_EMAIL: 'private@example.invalid',
        INITIAL_ACCESS_GROUP_NAME: 'Private name',
      },
    ]) {
      let message = '';
      try {
        validateInitialAccessGroupConfiguration(environment);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain('is missing');
      for (const value of Object.values(environment)) {
        expect(message).not.toContain(value);
      }
    }
  });

  test('refuses malformed complete values without reflecting them', () => {
    for (const environment of [
      {
        INITIAL_ACCESS_GROUP_ID: 'groups/invalid nested id',
        INITIAL_ACCESS_GROUP_EMAIL: 'administrators@example.invalid',
      },
      {
        INITIAL_ACCESS_GROUP_ID: 'groups/synthetic-administrators',
        INITIAL_ACCESS_GROUP_EMAIL: 'not-an-email',
      },
      {
        INITIAL_ACCESS_GROUP_ID: 'groups/synthetic-administrators',
        INITIAL_ACCESS_GROUP_EMAIL: 'administrators@example.invalid',
        INITIAL_ACCESS_GROUP_NAME: 'Administrators\nspoofed output',
      },
    ]) {
      let message = '';
      try {
        validateInitialAccessGroupConfiguration(environment);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain('INITIAL_ACCESS_GROUP_');
      for (const value of Object.values(environment)) {
        expect(message).not.toContain(value);
      }
    }
  });

  test('CLI exits before deployment and never prints configured values', () => {
    const email = 'private-cli@example.invalid';
    const successful = Bun.spawnSync({
      cmd: [process.execPath, PREFLIGHT.pathname],
      env: {
        INITIAL_ACCESS_GROUP_ID: 'groups/private-cli-id',
        INITIAL_ACCESS_GROUP_EMAIL: email,
      },
    });
    const failed = Bun.spawnSync({
      cmd: [process.execPath, PREFLIGHT.pathname],
      env: { INITIAL_ACCESS_GROUP_EMAIL: email },
    });

    expect(successful.exitCode).toBe(0);
    expect(successful.stdout.toString()).toContain('configured');
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr.toString()).toContain(
      'INITIAL_ACCESS_GROUP_ID is missing',
    );
    for (const output of [
      successful.stdout,
      successful.stderr,
      failed.stdout,
      failed.stderr,
    ]) {
      expect(output.toString()).not.toContain(email);
      expect(output.toString()).not.toContain('private-cli-id');
    }
  });
});

describe('supported deployment workflow', () => {
  test('fails closed on absent or padded SMS carrier configuration', async () => {
    const workflow = await Bun.file(WORKFLOW).text();

    for (const secret of [
      'SMS_ORIGINATION_IDENTITY_ARN',
      'SMS_HELP_MESSAGE',
      'SMS_STOP_MESSAGE',
    ]) {
      expect(workflow).toContain(
        `${secret}: \${{ secrets.${secret} || 'UNCONFIGURED' }}`,
      );
    }
    expect(workflow).toContain('-z "$SMS_HELP_MESSAGE"');
    expect(workflow).toContain('-z "$SMS_STOP_MESSAGE"');
    expect(workflow).toContain('${#SMS_HELP_MESSAGE} -gt 160');
    expect(workflow).toContain('${#SMS_STOP_MESSAGE} -gt 160');
    expect(workflow).toContain('"$SMS_HELP_MESSAGE" =~ ^[[:space:]]');
    expect(workflow).toContain('"$SMS_STOP_MESSAGE" =~ [[:space:]]$');
  });

  test('preserves every active SMS setting while staging migrations', async () => {
    const workflow = await Bun.file(WORKFLOW).text();
    const stage = workflow.slice(
      workflow.indexOf(
        '- name: Stage the bootstrap task without changing the live service',
      ),
      workflow.indexOf('- name: Run database migrations'),
    );

    expect(stage).toContain(
      '$STACK_NAME:EnableAwsEumSmsWorker=$PREVIOUS_SMS_ENABLED',
    );
    expect(stage).toContain(
      '$STACK_NAME:ProvisionAwsEumSmsResources=$PREVIOUS_SMS_PROVISIONED',
    );
    expect(stage).toContain('--previous-parameters true');
    for (const parameter of [
      'SmsRegistrationVerificationReference',
      'SmsOriginationIdentityArn',
      'SmsDestinationCountryCode',
      'SmsHelpMessage',
      'SmsStopMessage',
    ]) {
      expect(stage).not.toContain(`$STACK_NAME:${parameter}=`);
      expect(
        workflow.match(new RegExp(`\\$STACK_NAME:${parameter}=`, 'gu')),
      ).toHaveLength(1);
    }
  });

  test('preflights before build and forwards every parameter in both CDK phases', async () => {
    const workflow = await Bun.file(WORKFLOW).text();
    const preflight = workflow.indexOf(
      'bun scripts/deploy-initial-access-group.ts',
    );
    const build = workflow.indexOf('- name: Build and push the image');
    const firstDeploy = workflow.indexOf('bunx --bun cdk');

    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(build);
    expect(build).toBeLessThan(firstDeploy);
    expect(
      workflow.match(
        /\$STACK_NAME:InitialAccessGroupId=\$INITIAL_ACCESS_GROUP_ID/gu,
      ),
    ).toHaveLength(2);
    expect(
      workflow.match(
        /\$STACK_NAME:InitialAccessGroupEmail=\$INITIAL_ACCESS_GROUP_EMAIL/gu,
      ),
    ).toHaveLength(2);
    expect(
      workflow.match(
        /\$STACK_NAME:InitialAccessGroupName=\$INITIAL_ACCESS_GROUP_NAME/gu,
      ),
    ).toHaveLength(2);
    expect(workflow).toContain(
      'INITIAL_ACCESS_GROUP_ID: ${{ vars.INITIAL_ACCESS_GROUP_ID }}',
    );
    expect(workflow).toContain(
      'INITIAL_ACCESS_GROUP_EMAIL: ${{ secrets.INITIAL_ACCESS_GROUP_EMAIL }}',
    );
    expect(workflow).toContain(
      'INITIAL_ACCESS_GROUP_NAME: ${{ vars.INITIAL_ACCESS_GROUP_NAME }}',
    );
    expect(
      workflow.match(
        /INITIAL_ACCESS_GROUP_EMAIL: \$\{\{ secrets\.INITIAL_ACCESS_GROUP_EMAIL \}\}/gu,
      ),
    ).toHaveLength(3);
    expect(workflow).not.toContain('echo "$INITIAL_ACCESS_GROUP_EMAIL"');
  });

  test('turns the bounded task result into a deployment summary', async () => {
    const workflow = await Bun.file(WORKFLOW).text();
    expect(workflow).toContain('BootstrapLogGroupName');
    expect(workflow).toContain('aws logs get-log-events');
    expect(workflow).toContain("jq -er '.accessBootstrap'");
    expect(workflow).toContain('Initial access group');
  });

  test('uses current bootstrap code when deploying an older application image', async () => {
    const workflow = await Bun.file(WORKFLOW).text();
    expect(workflow).toContain('--image-ids "imageTag=$GITHUB_SHA"');
    expect(
      workflow.match(/\$STACK_NAME:BootstrapImageDigest=\$BOOTSTRAP_DIGEST/gu),
    ).toHaveLength(2);
    expect(
      workflow.match(
        /\$STACK_NAME:BootstrapSourceSha=\$BOOTSTRAP_SOURCE_SHA/gu,
      ),
    ).toHaveLength(2);
    expect(workflow).toContain(
      '--parameters "$STACK_NAME:SourceSha=$TARGET_SOURCE_SHA"',
    );
    expect(workflow).toContain('source_sha=$source_sha');
    expect(workflow).toContain('bootstrap_digest=$bootstrap_digest');
    expect(workflow).toContain(
      'if ! bootstrap_digest=$(aws ecr describe-images',
    );
    expect(workflow).toContain(
      '::error::The current commit does not have a bootstrap image in the repository',
    );
  });
});
