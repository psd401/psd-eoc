import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { PrimaryNav } from '../../nav/primary-nav';

export const metadata: Metadata = {
  title: 'Device sessions | PSD EOC',
  description: 'Review and revoke staff device sessions for PSD EOC.',
};

export default function DevicesRootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <PrimaryNav />
        {children}
      </body>
    </html>
  );
}
