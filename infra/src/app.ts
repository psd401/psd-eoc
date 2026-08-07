import { App } from 'aws-cdk-lib';

import { DEPLOYMENT_ACCOUNT, DEPLOYMENT_REGION, STACK_NAME } from './config';
import { PsdEocStack } from './psd-eoc-stack';

const app = new App();

new PsdEocStack(app, STACK_NAME, {
  description:
    'PSD EOC high-availability infrastructure baseline (GitHub issue #4)',
  env: {
    account: DEPLOYMENT_ACCOUNT,
    region: DEPLOYMENT_REGION,
  },
  stackName: STACK_NAME,
  terminationProtection: true,
});

app.synth();
