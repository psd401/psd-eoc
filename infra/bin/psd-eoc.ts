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
import {
  LOCAL_TENANT_CONTEXT_FILE,
  readLocalTenantContext,
} from '../src/tenant-context';

// cdk.local.json supplies the tenant keys kept out of the repository. CDK
// applies cdk.json and -c context over these defaults, so refuse to continue
// when either overrides a local key: the operator scripts read the local
// file directly and would otherwise disagree with the deployed stack.
const localContext = readLocalTenantContext();
const app = new App({ context: { ...localContext } });
for (const [key, value] of Object.entries(localContext)) {
  if (JSON.stringify(app.node.tryGetContext(key)) !== JSON.stringify(value)) {
    throw new Error(
      `CDK context ${key} from cdk.json or -c overrides ${LOCAL_TENANT_CONTEXT_FILE}; keep the key in exactly one place.`,
    );
  }
}
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
