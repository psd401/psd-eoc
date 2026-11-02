import { connection } from 'next/server';

import {
  mobileStoreListings,
  type MobileStoreListings,
} from '../../lib/config/store-listings';

import './store-links-footer.css';

/**
 * The page footer linking to the mobile app's store listings, so anyone on the
 * web can always find the app. Renders nothing when the deployment has
 * configured neither store.
 */
export async function StoreLinksFooter(): Promise<React.JSX.Element | null> {
  // The listings are deployment configuration read at request time; a page
  // prerendered at build would otherwise bake in the build's empty values.
  await connection();
  return <StoreLinksFooterContent listings={mobileStoreListings()} />;
}

export function StoreLinksFooterContent({
  listings,
}: Readonly<{ listings: MobileStoreListings }>): React.JSX.Element | null {
  const links = [
    { label: 'App Store', href: listings.appStore },
    { label: 'Google Play', href: listings.googlePlay },
  ].filter(
    (link): link is { label: string; href: string } => link.href !== null,
  );
  if (links.length === 0) return null;
  return (
    <footer className="store-links-footer">
      <span>Get the mobile app:</span>
      <ul>
        {links.map((link) => (
          <li key={link.label}>
            <a href={link.href} rel="noopener noreferrer" target="_blank">
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </footer>
  );
}
