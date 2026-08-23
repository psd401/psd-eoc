'use client';

import { usePathname } from 'next/navigation';

import {
  navigationDestinationIsCurrent,
  type NavDestination,
} from './primary-nav-model';

export function PrimaryNavLink({
  destination,
}: Readonly<{ destination: NavDestination }>) {
  const pathname = usePathname();
  return (
    <a
      aria-current={
        navigationDestinationIsCurrent(pathname, destination)
          ? 'page'
          : undefined
      }
      className="primary-nav__link"
      href={destination.href}
    >
      {destination.label}
    </a>
  );
}
