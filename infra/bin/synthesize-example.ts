import { App } from 'aws-cdk-lib';

import { AWS_ACCOUNT, AWS_REGION } from '../src/stack/config';
import { PsdEocStack } from '../src/stack/psd-eoc-stack';

const app = new App({
  context: {
    'psdEoc:applicationOrigin': 'https://eoc.example.invalid',
    'psdEoc:facilities': [{ code: 'EXAMPLE', name: 'Example Campus' }],
    'psdEoc:hostedDomain': 'example.invalid',
    'psdEoc:iosBundleId': 'invalid.example.eoc',
    'psdEoc:neighborhoods': [],
    'psdEoc:organizationName': 'Example School District',
    'psdEoc:syntheticGroups': [
      {
        displayName: 'Example synthetic staff',
        facilityCode: 'EXAMPLE',
        members: ['staff@example.invalid'],
      },
    ],
  },
});

new PsdEocStack(app, 'ExampleDistrictVerification', {
  description: 'Synthetic second-district verification stack.',
  env: { account: AWS_ACCOUNT, region: AWS_REGION },
  stackName: 'example-district-eoc-verification',
  terminationProtection: false,
});

app.synth();
