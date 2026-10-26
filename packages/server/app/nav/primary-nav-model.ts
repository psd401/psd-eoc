import {
  partnerAllowlistPermits,
  type CapabilityScope,
  type RegisteredCapabilityId,
  type Role,
} from '@psd-eoc/contracts';

export interface NavDestination {
  readonly href: string;
  readonly label: string;
  readonly authorization: 'authenticated' | 'admin' | 'district-admin';
  readonly additionalActivePrefixes?: readonly string[];
  /**
   * The capability the destination's task runs. A partner session sees it
   * only when the partner allowlist admits that capability.
   */
  readonly capabilityId: RegisteredCapabilityId;
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
    capabilityId: 'list-active-events',
  },
  {
    href: '/start',
    label: 'Start event',
    authorization: 'authenticated',
    capabilityId: 'start-event',
  },
  {
    href: '/records',
    label: 'Records',
    authorization: 'authenticated',
    capabilityId: 'list-event-records',
  },
  {
    href: '/text-alerts',
    label: 'Text alerts',
    authorization: 'authenticated',
    capabilityId: 'read-my-sms-consent',
  },
  {
    href: '/admin',
    label: 'Readiness',
    authorization: 'district-admin',
    capabilityId: 'get-admin-readiness',
  },
  {
    href: '/facilities',
    label: 'Schools',
    authorization: 'district-admin',
    capabilityId: 'update-facility',
  },
  {
    href: '/event-types',
    label: 'Responses',
    authorization: 'district-admin',
    capabilityId: 'list-event-type-drafts',
  },
  {
    href: '/access',
    label: 'Access',
    authorization: 'district-admin',
    capabilityId: 'list-admitted-accounts',
  },
  {
    href: '/partner-alerts',
    label: 'Partner alerts',
    authorization: 'district-admin',
    capabilityId: 'get-partner-alert-settings',
  },
  {
    href: '/devices',
    label: 'Devices',
    authorization: 'admin',
    capabilityId: 'list-device-sessions',
  },
  {
    href: '/integrations',
    label: 'Notifications',
    authorization: 'district-admin',
    capabilityId: 'get-integration-health',
  },
  {
    href: '/audit',
    label: 'Audit',
    authorization: 'admin',
    capabilityId: 'query-security-audit',
  },
  {
    href: '/agents',
    label: 'Agents',
    authorization: 'district-admin',
    capabilityId: 'list-agent-api-keys',
  },
]);

export function navigationDestinationsFor(
  authorization: Readonly<{
    roles: readonly Role[];
    facilityScope: CapabilityScope['facilityScope'];
    partner?: CapabilityScope['partner'];
  }>,
): readonly NavDestination[] {
  const administrator = authorization.roles.includes('admin');
  const districtAdministrator =
    administrator && authorization.facilityScope.kind === 'district';
  return NAV_DESTINATIONS.filter(
    (destination) =>
      partnerAllowlistPermits(authorization, destination.capabilityId) &&
      (destination.authorization === 'authenticated' ||
        (destination.authorization === 'admin' && administrator) ||
        (destination.authorization === 'district-admin' &&
          districtAdministrator)),
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
