import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../facilities/styles.css';
import { PrimaryNav } from '../../nav/primary-nav';

export const metadata: Metadata = {
  title: 'Integration health | PSD EOC',
  description: 'Review PSD EOC integration, roster, and test-mode health.',
};

export default function IntegrationsLayout({
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
