import { fileURLToPath } from 'node:url';

import { App } from 'aws-cdk-lib';

import {
  assertProtectedDeploymentTarget,
  readDeploymentIdentity,
  readDeploymentTarget,
  STACK_NAME,
} from '../src/stack/config';
import { PsdEocStack } from '../src/stack/psd-eoc-stack';
import { readSourceRevision } from '../src/source-revision';

const app = new App();
const deploymentTarget = readDeploymentTarget(app.node);
const enforceProtectedTarget =
  process.env.PSD_EOC_ENFORCE_DEPLOYMENT_TARGET === 'true';
assertProtectedDeploymentTarget(
  deploymentTarget,
  readDeploymentIdentity(app.node),
  {
    APP_PUBLIC_ORIGIN: process.env.APP_PUBLIC_ORIGIN,
    AWS_ACCOUNT_ID: process.env.AWS_ACCOUNT_ID,
    AWS_REGION: process.env.AWS_REGION,
    PSD_EOC_ENFORCE_DEPLOYMENT_TARGET:
      process.env.PSD_EOC_ENFORCE_DEPLOYMENT_TARGET,
  },
);

new PsdEocStack(app, STACK_NAME, {
  deploymentTarget,
  description: 'PSD EOC production web and mobile backend.',
  env: {
    account: deploymentTarget.account,
    region: deploymentTarget.region,
  },
  stackName: STACK_NAME,
  sourceSha: readSourceRevision({
    enforceClean: enforceProtectedTarget,
    repositoryRoot: fileURLToPath(new URL('../..', import.meta.url)),
  }),
  terminationProtection: false,
});

app.synth();
