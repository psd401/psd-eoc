import { describe, expect, test } from 'bun:test';

import {
  NAV_DESTINATIONS,
  navigationDestinationIsCurrent,
  navigationDestinationsFor,
} from './primary-nav-model';

describe('shared operator navigation model', () => {
  test('matches authenticated, admin, and district-admin server authorization tiers', () => {
    const staff = navigationDestinationsFor({
      roles: ['staff'],
      facilityScope: {
        kind: 'facilities',
        facilityIds: ['10000000-0000-4000-8000-000000000001'],
      },
    });
    const districtAdministrator = navigationDestinationsFor({
      roles: ['admin'],
      facilityScope: { kind: 'district' },
    });

    expect(staff.map(({ label }) => label)).toEqual([
      'Events',
      'Start event',
      'Records',
      'Delivery tests',
    ]);
    expect(districtAdministrator.map(({ label }) => label)).toEqual([
      'Events',
      'Start event',
      'Records',
      'Delivery tests',
      'Readiness',
      'Schools',
      'Event types',
      'Access',
      'Devices',
      'Notifications',
      'Audit',
      'Agents',
    ]);
    const facilityAdministrator = navigationDestinationsFor({
      roles: ['admin'],
      facilityScope: {
        kind: 'facilities',
        facilityIds: ['10000000-0000-4000-8000-000000000001'],
      },
    });
    expect(facilityAdministrator.map(({ label }) => label)).toEqual([
      'Events',
      'Start event',
      'Records',
      'Delivery tests',
      'Devices',
      'Audit',
    ]);
  });

  test('contains only unique, shipped destinations and no dead emergency route', () => {
    const hrefs = NAV_DESTINATIONS.map(({ href }) => href);

    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs).not.toContain('/emergency');
    expect(hrefs).toEqual([
      '/',
      '/start',
      '/records',
      '/delivery-tests',
      '/admin',
      '/facilities',
      '/event-types',
      '/access',
      '/devices',
      '/integrations',
      '/audit',
      '/agents',
    ]);
  });

  test('marks nested task routes active without marking unrelated prefixes', () => {
    const destination = (href: string) => {
      const match = NAV_DESTINATIONS.find(
        (candidate) => candidate.href === href,
      );
      if (match === undefined) throw new Error(`Missing ${href} destination.`);
      return match;
    };

    expect(
      navigationDestinationIsCurrent('/events/synthetic-id', destination('/')),
    ).toBe(true);
    expect(
      navigationDestinationIsCurrent('/start/confirm', destination('/start')),
    ).toBe(true);
    expect(
      navigationDestinationIsCurrent(
        '/event-types/manage',
        destination('/event-types'),
      ),
    ).toBe(true);
    expect(
      navigationDestinationIsCurrent('/delivery-tests', destination('/')),
    ).toBe(false);
  });
});
