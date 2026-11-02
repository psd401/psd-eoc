import type { ReactNode } from 'react';

import { PrimaryNav } from './primary-nav';
import { StoreLinksFooter } from './store-links-footer';

/** The shared document, skip target, navigation, content, and footer order. */
export function OperatorShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <PrimaryNav />
        <div className="operator-shell__content">{children}</div>
        <StoreLinksFooter />
      </body>
    </html>
  );
}
