import type { CapabilityScope, Role } from '@psd-eoc/contracts';

export interface NavDestination {
  readonly href: string;
  readonly label: string;
  readonly authorization: 'authenticated' | 'admin' | 'district-admin';
  readonly additionalActivePrefixes?: readonly string[];
}

/**
 * The single task-based navigation definition for every authenticated page.
 *
 * Authorization mirrors the corresponding server capability boundaries:
 * operational reads are available to an authenticated staff session within
 * its scope, while configuration surfaces require both the admin role and
 * district scope.
 */
export const NAV_DESTINATIONS: readonly NavDestination[] = Object.freeze([
  {
    href: '/',
    label: 'Events',
    authorization: 'authenticated',
    additionalActivePrefixes: Object.freeze(['/events']),
  },
  { href: '/start', label: 'Start event', authorization: 'authenticated' },
  { href: '/records', label: 'Records', authorization: 'authenticated' },
  {
    href: '/text-alerts',
    label: 'Text alerts',
    authorization: 'authenticated',
  },
  {
    href: '/delivery-tests',
    label: 'Delivery tests',
    authorization: 'authenticated',
  },
  { href: '/admin', label: 'Readiness', authorization: 'district-admin' },
  { href: '/facilities', label: 'Schools', authorization: 'district-admin' },
  {
    href: '/event-types',
    label: 'Responses',
    authorization: 'district-admin',
  },
  { href: '/access', label: 'Access', authorization: 'district-admin' },
  { href: '/devices', label: 'Devices', authorization: 'admin' },
  {
    href: '/integrations',
    label: 'Notifications',
    authorization: 'district-admin',
  },
  { href: '/audit', label: 'Audit', authorization: 'admin' },
  { href: '/agents', label: 'Agents', authorization: 'district-admin' },
]);

export function navigationDestinationsFor(
  authorization: Readonly<{
    roles: readonly Role[];
    facilityScope: CapabilityScope['facilityScope'];
  }>,
): readonly NavDestination[] {
  const administrator = authorization.roles.includes('admin');
  const districtAdministrator =
    administrator && authorization.facilityScope.kind === 'district';
  return NAV_DESTINATIONS.filter(
    (destination) =>
      destination.authorization === 'authenticated' ||
      (destination.authorization === 'admin' && administrator) ||
      (destination.authorization === 'district-admin' && districtAdministrator),
  );
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function navigationDestinationIsCurrent(
  pathname: string,
  destination: NavDestination,
): boolean {
  if (destination.href === '/') {
    return (
      pathname === '/' ||
      (destination.additionalActivePrefixes ?? []).some((prefix) =>
        pathMatchesPrefix(pathname, prefix),
      )
    );
  }
  return pathMatchesPrefix(pathname, destination.href);
}
