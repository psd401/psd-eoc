import type { ReactNode } from 'react';

import { PrimaryNav } from './primary-nav';

/** The shared document, skip target, navigation, and content order. */
export function OperatorShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <PrimaryNav />
        <div className="operator-shell__content">{children}</div>
      </body>
    </html>
  );
}
