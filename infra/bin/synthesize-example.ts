import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import productionConfiguration from '../cdk.json';
import { assertDatabaseArn } from '../lambda/failover-metric/index.mjs';
import { readDeploymentTarget } from '../src/stack/config';
import { PsdEocStack } from '../src/stack/psd-eoc-stack';

const productionContext = productionConfiguration.context as Readonly<
  Record<string, unknown>
>;
const productionDeploymentTarget = readDeploymentTarget({
  tryGetContext: (key) => productionContext[key],
});

function alternative(
  current: string,
  preferred: string,
  fallback: string,
): string {
  return current === preferred ? fallback : preferred;
}

const productionHostedDomain = String(
  productionContext['psdEoc:hostedDomain'] ?? '',
);
const exampleHostedDomain = alternative(
  productionHostedDomain,
  'example.invalid',
  'example.test',
);
const exampleConfiguration = Object.freeze({
  account: alternative(
    productionDeploymentTarget.account,
    '000000000000',
    '111111111111',
  ),
  accountAlias: alternative(
    productionDeploymentTarget.accountAlias,
    'example-district',
    'sample-district',
  ),
  applicationOrigin: `https://eoc.${exampleHostedDomain}`,
  displayTimeZone: 'America/New_York',
  facilities: [{ code: 'EXAMPLE', name: 'Example Campus' }],
  hostedDomain: exampleHostedDomain,
  iosBundleId: alternative(
    String(productionContext['psdEoc:iosBundleId'] ?? ''),
    'invalid.example.eoc',
    'test.example.eoc',
  ),
  monitoringRunbookBaseUrl: `https://operations.${exampleHostedDomain}/runbooks`,
  neighborhoods: [],
  organizationName: alternative(
    String(productionContext['psdEoc:organizationName'] ?? ''),
    'Example School District',
    'Sample School District',
  ),
  privacyContactUrl: `https://www.${exampleHostedDomain}/contact`,
  region: alternative(
    productionDeploymentTarget.region,
    'us-east-1',
    'us-west-1',
  ),
  sesFromAddress: `eoc-alerts@${exampleHostedDomain}`,
  sesIdentityDomain: exampleHostedDomain,
  sourceRepositoryUrl: `https://code.${exampleHostedDomain}/example/eoc`,
  syntheticGroups: [
    {
      displayName: 'Example synthetic staff',
      facilityCode: 'EXAMPLE',
      members: [`staff@${exampleHostedDomain}`],
    },
  ],
});

const app = new App({
  context: {
    'psdEoc:applicationOrigin': exampleConfiguration.applicationOrigin,
    'psdEoc:awsAccount': exampleConfiguration.account,
    'psdEoc:awsAccountAlias': exampleConfiguration.accountAlias,
    'psdEoc:awsRegion': exampleConfiguration.region,
    'psdEoc:facilities': exampleConfiguration.facilities,
    'psdEoc:displayTimeZone': exampleConfiguration.displayTimeZone,
    'psdEoc:hostedDomain': exampleConfiguration.hostedDomain,
    // A placeholder zone: the example synthesis never reaches Route 53.
    'psdEoc:hostedZoneId': 'Z0EXAMPLEZONEID',
    'psdEoc:iosBundleId': exampleConfiguration.iosBundleId,
    'psdEoc:monitoringRunbookBaseUrl':
      exampleConfiguration.monitoringRunbookBaseUrl,
    'psdEoc:neighborhoods': exampleConfiguration.neighborhoods,
    'psdEoc:organizationName': exampleConfiguration.organizationName,
    'psdEoc:privacyContactUrl': exampleConfiguration.privacyContactUrl,
    'psdEoc:sesFromAddress': exampleConfiguration.sesFromAddress,
    'psdEoc:sesIdentityDomain': exampleConfiguration.sesIdentityDomain,
    'psdEoc:sourceRepositoryUrl': exampleConfiguration.sourceRepositoryUrl,
    'psdEoc:syntheticGroups': exampleConfiguration.syntheticGroups,
  },
});
const exampleDeploymentTarget = readDeploymentTarget(app.node);
const stack = new PsdEocStack(app, 'ExampleDistrictVerification', {
  deploymentTarget: exampleDeploymentTarget,
  description: 'Synthetic second-district verification stack.',
  env: {
    account: exampleDeploymentTarget.account,
    region: exampleDeploymentTarget.region,
  },
  stackName: 'example-district-eoc-verification',
  sourceSha: 'a'.repeat(40),
  terminationProtection: false,
});
const template = Template.fromStack(stack);

for (const [output, value] of Object.entries({
  DeploymentAccount: exampleConfiguration.account,
  DeploymentRegion: exampleConfiguration.region,
  ExpectedAwsAccountAlias: exampleConfiguration.accountAlias,
  SesFromAddress: exampleConfiguration.sesFromAddress,
  SesIdentityDomain: exampleConfiguration.sesIdentityDomain,
})) {
  template.hasOutput(output, { Value: value });
}

template.hasResourceProperties('AWS::AppRunner::Service', {
  SourceConfiguration: Match.objectLike({
    ImageRepository: Match.objectLike({
      ImageConfiguration: Match.objectLike({
        RuntimeEnvironmentVariables: Match.arrayWith([
          {
            Name: 'GOOGLE_OIDC_APPLICATION_ORIGIN',
            Value: exampleConfiguration.applicationOrigin,
          },
          {
            Name: 'GOOGLE_OIDC_HOSTED_DOMAIN',
            Value: exampleConfiguration.hostedDomain,
          },
          {
            Name: 'PSD_EOC_IOS_BUNDLE_ID',
            Value: exampleConfiguration.iosBundleId,
          },
          {
            Name: 'PSD_EOC_ORGANIZATION_NAME',
            Value: exampleConfiguration.organizationName,
          },
          {
            Name: 'PSD_EOC_PRIVACY_CONTACT_URL',
            Value: exampleConfiguration.privacyContactUrl,
          },
          {
            Name: 'PSD_EOC_DISPLAY_TIME_ZONE',
            Value: exampleConfiguration.displayTimeZone,
          },
        ]),
      }),
    }),
  }),
});

template.hasResourceProperties('AWS::ECS::TaskDefinition', {
  ContainerDefinitions: Match.arrayWith([
    Match.objectLike({
      Environment: Match.arrayWith([
        {
          Name: 'PSD_EOC_FACILITIES',
          Value: JSON.stringify(exampleConfiguration.facilities),
        },
        {
          Name: 'PSD_EOC_SYNTHETIC_GROUPS',
          Value: JSON.stringify(exampleConfiguration.syntheticGroups),
        },
      ]),
      Name: 'native-bootstrap',
    }),
  ]),
});

template.hasResourceProperties('AWS::CloudWatch::Alarm', {
  AlarmDescription: Match.stringLikeRegexp(
    exampleConfiguration.monitoringRunbookBaseUrl.replace(
      /[.*+?^${}()|[\]\\]/gu,
      '\\$&',
    ),
  ),
});
assertDatabaseArn(
  `arn:aws:rds:${exampleConfiguration.region}:${exampleConfiguration.account}:cluster:synthetic-example`,
  exampleConfiguration.region,
);

console.info(
  'Synthetic infrastructure consumes only the example cloud, tenant, and provider identity.',
);
