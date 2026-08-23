import { describe, expect, test } from 'bun:test';

import { AdminReadinessSchema, type AdminReadiness } from '@psd-eoc/contracts';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  AdminReadinessView,
  ForbiddenAdminReadiness,
} from './admin-readiness-view';

const OBSERVED_AT = '2026-08-22T18:00:00.000Z';
const FRESH_AT = '2026-08-22T17:00:00.000Z';
const GROUP_ID = '00000000-0000-4000-8000-000000002890';

function readiness(overrides: Partial<AdminReadiness> = {}): AdminReadiness {
  return AdminReadinessSchema.parse({
    observedAt: OBSERVED_AT,
    overallStatus: 'ready',
    accessMembership: {
      status: 'ready',
      freshnessWindowSeconds: 86_400,
      groups: [
        {
          id: GROUP_ID,
          displayName: 'District administrators',
          grantedRole: 'admin',
          membersCapturedAt: FRESH_AT,
          status: 'fresh',
        },
      ],
    },
    facilityConfiguration: {
      status: 'ready',
      activeFacilityCount: 2,
      facilitiesWithoutNeighborhoodCount: 0,
      facilitiesWithoutBuildingGroupCount: 0,
    },
    roster: {
      status: 'ready',
      freshnessWindowSeconds: 86_400,
      latestAttemptCompletedAt: FRESH_AT,
      latestAttemptOutcome: 'complete',
      latestCompleteSnapshotCapturedAt: FRESH_AT,
    },
    alarmTopics: [
      {
        kind: 'operations',
        status: 'ready',
        confirmedSubscriberCount: 2,
      },
      {
        kind: 'critical',
        status: 'ready',
        confirmedSubscriberCount: 2,
      },
    ],
    ...overrides,
  });
}

function render(value: AdminReadiness): string {
  return renderToStaticMarkup(<AdminReadinessView readiness={value} />);
}

describe('administrator readiness view', () => {
  test('renders an accessible ready summary with timestamps and destinations', () => {
    const markup = render(readiness());

    expect(markup).toContain(
      '<main aria-labelledby="admin-readiness-heading" id="main-content" tabindex="-1">',
    );
    expect(markup).toContain('Ready for a first drill');
    expect(markup).toContain(`dateTime="${FRESH_AT}"`);
    expect(markup).toContain('Access membership read evidence');
    expect(markup).toContain(
      '<caption>Active access groups and their last membership read</caption>',
    );
    expect(markup).not.toContain('<nav');
    expect(markup).toContain('does not send a notification');
    expect(markup).not.toContain('/emergency');
  });

  test('visibly distinguishes never read, stale, zero subscribers, and unavailable', () => {
    const staleAt = '2026-08-20T17:00:00.000Z';
    const markup = render(
      readiness({
        overallStatus: 'action-required',
        accessMembership: {
          status: 'action-required',
          freshnessWindowSeconds: 86_400,
          groups: [
            {
              id: GROUP_ID,
              displayName: 'District administrators',
              grantedRole: 'admin',
              membersCapturedAt: staleAt,
              status: 'stale',
            },
            {
              id: '00000000-0000-4000-8000-000000002899',
              displayName: 'District staff',
              grantedRole: 'staff',
              membersCapturedAt: null,
              status: 'never-read',
            },
          ],
        },
        alarmTopics: [
          {
            kind: 'operations',
            status: 'action-required',
            confirmedSubscriberCount: 0,
          },
          {
            kind: 'critical',
            status: 'unavailable',
            confirmedSubscriberCount: null,
          },
        ],
      }),
    );

    expect(markup).toContain('Stale');
    expect(markup).toContain('Never read');
    expect(markup).toContain('0 confirmed subscribers.');
    expect(markup).toContain('Provider status could not be read.');
    expect(markup).toContain('Unable to verify');
    expect(markup).toContain(
      'verify the alarm-topic ARN settings, the App Runner role’s subscription-list permission, and AWS connectivity',
    );
  });

  test('forbidden view contains no readiness evidence', () => {
    const markup = renderToStaticMarkup(<ForbiddenAdminReadiness />);

    expect(markup).toContain('Administrator access required');
    expect(markup).toContain(
      'No configuration, membership, roster, or alarm data was displayed.',
    );
    expect(markup).not.toContain('District administrators');
    expect(markup).not.toContain(FRESH_AT);
  });
});
