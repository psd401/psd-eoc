import { App } from 'aws-cdk-lib';

import {
  FAILURE_DRILL_RUN_ID_PATTERN,
  type DeploymentTarget,
} from '../src/stack/config';
import { PsdEocStack } from '../src/stack/psd-eoc-stack';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required for failure-drill synthesis.`);
  return value;
}

const account = requiredEnvironment('AWS_ACCOUNT_ID');
const accountAlias = requiredEnvironment('AWS_ACCOUNT_ALIAS');
const region = requiredEnvironment('AWS_REGION');
const runId = requiredEnvironment('FAILURE_DRILL_RUN_ID');

if (!/^\d{12}$/u.test(account)) {
  throw new Error('AWS_ACCOUNT_ID must be exactly 12 digits.');
}
if (!FAILURE_DRILL_RUN_ID_PATTERN.test(runId)) {
  throw new Error(
    'FAILURE_DRILL_RUN_ID must be 8 through 24 lowercase letters, digits, or hyphens.',
  );
}

const invalidDomain = 'example.invalid';
const applicationOrigin = `https://${runId}.${invalidDomain}`;
const deploymentTarget: DeploymentTarget = Object.freeze({
  account,
  accountAlias,
  monitoringRunbookBaseUrl: `https://operations.${invalidDomain}/failure-drills`,
  region,
  sesFromAddress: `alerts@${invalidDomain}`,
  sesIdentityDomain: invalidDomain,
});
const syntheticTenantContext: Readonly<Record<string, unknown>> = Object.freeze(
  {
    'psdEoc:applicationOrigin': applicationOrigin,
    'psdEoc:displayTimeZone': 'UTC',
    'psdEoc:facilities': [
      { code: 'SYNTHETIC', name: 'Synthetic Failure Drill Campus' },
    ],
    'psdEoc:hostedDomain': invalidDomain,
    'psdEoc:iosBundleId': 'invalid.example.failure-drill',
    'psdEoc:neighborhoods': [],
    'psdEoc:organizationName': 'Synthetic Failure Drill District',
    'psdEoc:syntheticGroups': [
      {
        displayName: 'Synthetic failure-drill staff',
        facilityCode: 'SYNTHETIC',
        members: [`operator@${invalidDomain}`],
      },
    ],
  },
);
const app = new App();

new PsdEocStack(app, 'FailureDrill', {
  failureDrillContext: {
    tryGetContext: (key) => syntheticTenantContext[key],
  },
  deploymentProfile: { kind: 'failure-drill', runId },
  deploymentTarget,
  description:
    'Disposable synthetic failure-recovery drill; mock providers and invalid recipient domain only.',
  env: { account, region },
  stackName: `PsdEocFailureDrill-${runId}`,
  terminationProtection: false,
});

app.synth();
