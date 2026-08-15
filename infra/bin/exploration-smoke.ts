import { App } from 'aws-cdk-lib';

import {
  EXPLORATION_SMOKE_ACCOUNT,
  EXPLORATION_SMOKE_REGION,
  EXPLORATION_SMOKE_STACK_NAME,
} from '../src/exploration-smoke/config';
import { ExplorationSmokeStack } from '../src/exploration-smoke/exploration-smoke-stack';

const app = new App();

new ExplorationSmokeStack(app, EXPLORATION_SMOKE_STACK_NAME, {
  description:
    'Isolated synthetic-only PSD EOC exploration web/mobile backend (GitHub issue #163)',
  env: {
    account: EXPLORATION_SMOKE_ACCOUNT,
    region: EXPLORATION_SMOKE_REGION,
  },
  stackName: EXPLORATION_SMOKE_STACK_NAME,
  terminationProtection: false,
});

app.synth();
