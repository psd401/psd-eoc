import { describe, expect, test } from 'bun:test';
import {
  ChannelConfigurationSchema,
  IntegrationHealthSchema,
  IntegrationStatusSchema,
  StaleRosterReportSchema,
} from '@psd-eoc/contracts';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  IntegrationsAdminView,
  TEST_MODE_BANNER,
  type IntegrationsAdminViewProps,
} from './integrations-admin-view';

const AT = '2026-08-10T12:00:00.000Z';
const USER_ID = '00000000-0000-4000-8000-000000002650';
const SNAPSHOT_ID = '00000000-0000-4000-8000-000000002651';
const RECIPIENT_ID = '00000000-0000-4000-8000-000000002652';
const GROUP_ID = '00000000-0000-4000-8000-000000002653';
const FACILITY_ID = '00000000-0000-4000-8000-000000002654';

const STATUSES = [
  IntegrationStatusSchema.parse({
    integrationId: 'expo-push',
    label: 'mocked',
    verifiedAt: null,
    verifiedByUserId: null,
    authorizationReference: null,
    reasonCode: null,
    observedAt: AT,
  }),
  IntegrationStatusSchema.parse({
    integrationId: 'ses-email',
    label: 'configured-unverified',
    verifiedAt: null,
    verifiedByUserId: null,
    authorizationReference: null,
    reasonCode: null,
    observedAt: AT,
  }),
  IntegrationStatusSchema.parse({
    integrationId: 'google-groups',
    label: 'live-verified',
    verifiedAt: AT,
    verifiedByUserId: USER_ID,
    authorizationReference: 'approved-integration-verification',
    reasonCode: null,
    observedAt: AT,
  }),
  IntegrationStatusSchema.parse({
    integrationId: 'aws-eum-sms',
    label: 'blocked',
    verifiedAt: null,
    verifiedByUserId: null,
    authorizationReference: null,
    reasonCode: 'CARRIER_REGISTRATION_PENDING',
    observedAt: AT,
  }),
];

const PROPS = Object.freeze({
  integrationHealth: IntegrationHealthSchema.parse({
    statuses: STATUSES,
    observedAt: AT,
  }),
  channelConfigurations: [
    ChannelConfigurationSchema.parse({
      integrationId: 'expo-push',
      enabled: true,
      status: STATUSES[0],
      changedAt: AT,
    }),
    ChannelConfigurationSchema.parse({
      integrationId: 'aws-eum-sms',
      enabled: false,
      status: STATUSES[3],
      changedAt: AT,
    }),
    ChannelConfigurationSchema.parse({
      integrationId: 'google-groups',
      enabled: false,
      status: STATUSES[2],
      changedAt: AT,
    }),
  ],
  lastRosterSync: {
    population: 'synthetic' as const,
    outcome: 'partial-rejected' as const,
    completedAt: AT,
  },
  staleEndpointReport: StaleRosterReportSchema.parse({
    generatedAt: AT,
    status: 'stale',
    latestCompleteSnapshotId: SNAPSHOT_ID,
    latestCompleteCapturedAt: AT,
    latestCompleteAgeSeconds: 600,
    failedGroups: [
      {
        groupSourceRef: {
          id: GROUP_ID,
          kind: 'synthetic',
          purpose: 'building',
          facilityId: FACILITY_ID,
        },
        errorCode: 'SYNTHETIC_FIXTURE_UNAVAILABLE',
        attemptedAt: AT,
      },
    ],
    staleRecipients: [
      { recipientId: RECIPIENT_ID, reason: 'no-active-endpoint' },
    ],
  }),
}) satisfies IntegrationsAdminViewProps;

function render(props: IntegrationsAdminViewProps = PROPS): string {
  return renderToStaticMarkup(
    <IntegrationsAdminView csrfToken="synthetic-csrf-token" {...props} />,
  );
}

describe('integrations admin view', () => {
  test('renders an immutable literal TEST boundary with semantic landmarks', () => {
    const markup = render();

    expect(markup).toContain(
      `<main aria-labelledby="integrations-admin-heading" id="main-content" tabindex="-1">`,
    );
    expect(markup).toContain(
      '<aside aria-labelledby="test-mode-heading" class="test-boundary">',
    );
    expect(markup).toContain(TEST_MODE_BANNER);
    expect(markup).toContain('<dt>Event kind</dt><dd>TEST</dd>');
    expect(markup).toContain('<dt>Template mode</dt><dd>DRILL</dd>');
    expect(markup).toContain('<dt>Roster population</dt><dd>SYNTHETIC</dd>');
    expect(markup.match(/SYNTHETIC RECIPIENTS ONLY/gu)).toHaveLength(1);
    expect(markup).not.toContain('contenteditable');
    expect(markup).toContain('aria-label="Administration"');
  });

  test('shows every truth label, channel state, and safe health evidence as text', () => {
    const markup = render();

    for (const label of [
      'mocked',
      'configured-unverified',
      'live-verified',
      'blocked',
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('Enabled');
    expect(markup).toContain('Disabled');
    expect(markup).toContain('CARRIER_REGISTRATION_PENDING');
    expect(markup).toContain('partial-rejected');
    expect(markup).toContain('Recipients shown without a usable endpoint');
    expect(markup).toContain(
      'This is a bounded page of endpoint evidence, not a district-wide total.',
    );
    expect(markup).toContain('<dd>1</dd>');
    expect(markup).toContain(`<time dateTime="${AT}">${AT}</time>`);
    expect(markup).toContain(
      '<caption>Current external integration truth</caption>',
    );
    expect(markup).toContain(
      '<caption>Administrative channel enablement and truth</caption>',
    );
    expect(markup).toContain('<th scope="col">Truth label</th>');
    expect(markup).toContain('<th scope="row">expo-push</th>');
    expect(markup).toMatch(
      /<form action="\/integrations\/api" method="post">/u,
    );
    expect(markup).toMatch(
      /<input[^>]*name="csrfToken"[^>]*value="synthetic-csrf-token"/u,
    );
    expect(markup).toMatch(
      /<input[^>]*name="idempotencyKey"[^>]*value="[0-9a-f-]{36}"/u,
    );
    expect(markup).toContain(
      'Paste only the non-secret, change-specific JSON artifact issued for this integration and requested state.',
    );
    expect(markup).toMatch(
      /<textarea[^>]*name="authorization"[^>]*required=""[^>]*><\/textarea>/u,
    );
    expect(markup).not.toContain('productOwnerApprovalReference');
    expect(markup).toMatch(
      /name="integrationId" value="aws-eum-sms"[\s\S]*?<option disabled="" value="true">Enabled<\/option>/u,
    );
  });

  test('renders explicit empty and unknown states', () => {
    const markup = render({
      integrationHealth: IntegrationHealthSchema.parse({
        statuses: [],
        observedAt: AT,
      }),
      channelConfigurations: [],
      lastRosterSync: null,
      staleEndpointReport: StaleRosterReportSchema.parse({
        generatedAt: AT,
        status: 'unknown',
        latestCompleteSnapshotId: null,
        latestCompleteCapturedAt: null,
        latestCompleteAgeSeconds: null,
        failedGroups: [],
        staleRecipients: [],
      }),
    });

    expect(markup).toContain('No integration observations are available.');
    expect(markup).toContain('No notification channels are configured.');
    expect(markup).toContain('No roster synchronization result is available.');
    expect(markup).toContain('<dd>unknown</dd>');
    expect(markup).toContain('<dd>None recorded</dd>');
  });
});
