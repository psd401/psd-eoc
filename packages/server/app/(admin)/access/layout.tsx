import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../facilities/styles.css';
import { PrimaryNav } from '../../nav/primary-nav';

export const metadata: Metadata = {
  title: 'Access administration | PSD EOC',
  description: 'Configure PSD EOC access groups and administrator roles.',
};

export default function AccessLayout({
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
