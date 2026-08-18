import { cookies } from 'next/headers';

import {
  WEB_SESSION_COOKIE_NAME,
  getDefaultSessionService,
} from '../../lib/auth/sessions';
import { SignOutButton } from './sign-out-button';

import './primary-nav.css';

interface NavDestination {
  readonly href: string;
  readonly label: string;
  readonly adminOnly: boolean;
}

/**
 * Every authenticated destination in the web application.
 *
 * Admin destinations are filtered out server-side for non-admins rather than
 * hidden with styling, so the navigation never advertises a page the viewer
 * would be refused.
 */
const DESTINATIONS: readonly NavDestination[] = Object.freeze([
  { href: '/start', label: 'Start', adminOnly: false },
  { href: '/records', label: 'Records', adminOnly: false },
  { href: '/facilities', label: 'Schools', adminOnly: true },
  { href: '/event-types', label: 'Event types', adminOnly: true },
  { href: '/access', label: 'Access', adminOnly: true },
  { href: '/devices', label: 'Devices', adminOnly: true },
  { href: '/integrations', label: 'Integrations', adminOnly: true },
  { href: '/emergency', label: 'Notifications', adminOnly: true },
  { href: '/audit', label: 'Audit', adminOnly: true },
]);

/**
 * Primary navigation and account controls.
 *
 * Rendered by each section layout. Returns nothing when the viewer is not
 * authenticated so the login and error surfaces stay unchanged; the pages
 * themselves remain responsible for requiring a session.
 */
export async function PrimaryNav({
  currentPath,
}: Readonly<{ currentPath?: string }>): Promise<React.JSX.Element | null> {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (sessionToken === undefined) return null;

  let email: string;
  let roles: readonly string[];
  let sessionId: string;
  try {
    const authenticated = await getDefaultSessionService().authenticate(
      sessionToken,
      'web',
    );
    email = authenticated.result.user.email;
    roles = authenticated.roles;
    sessionId = authenticated.actor.sessionId;
  } catch {
    // An unusable session is the page's problem, not the navigation's. Render
    // nothing rather than a signed-in-looking bar the viewer cannot act on.
    return null;
  }

  const isAdmin = roles.includes('admin');
  const visible = DESTINATIONS.filter(
    (destination) => !destination.adminOnly || isAdmin,
  );

  return (
    <nav aria-label="Primary" className="primary-nav">
      <a className="primary-nav__brand" href="/start">
        PSD EOC
      </a>
      <ul className="primary-nav__links">
        {visible.map((destination) => (
          <li key={destination.href}>
            <a
              aria-current={
                currentPath === destination.href ? 'page' : undefined
              }
              className="primary-nav__link"
              href={destination.href}
            >
              {destination.label}
            </a>
          </li>
        ))}
      </ul>
      <div className="primary-nav__account">
        <span className="primary-nav__identity">
          <span className="primary-nav__identity-email">{email}</span>
          <span className="primary-nav__identity-roles">
            {roles.length > 0 ? roles.join(' · ') : 'no roles'}
          </span>
        </span>
        <SignOutButton sessionId={sessionId} />
      </div>
    </nav>
  );
}
