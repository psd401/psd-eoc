import { App } from 'aws-cdk-lib';

import { AWS_ACCOUNT, AWS_REGION, STACK_NAME } from '../src/stack/config';
import { PsdEocStack } from '../src/stack/psd-eoc-stack';

const app = new App();

new PsdEocStack(app, STACK_NAME, {
  description: 'PSD EOC production web and mobile backend.',
  env: {
    account: AWS_ACCOUNT,
    region: AWS_REGION,
  },
  stackName: STACK_NAME,
  terminationProtection: false,
});

app.synth();
