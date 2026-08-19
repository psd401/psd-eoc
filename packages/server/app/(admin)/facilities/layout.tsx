import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './styles.css';
import { PrimaryNav } from '../../nav/primary-nav';

export const metadata: Metadata = {
  title: 'Facilities administration | PSD EOC',
  description: 'Configure PSD EOC facilities, groups, and audiences.',
};

export default function FacilitiesLayout({
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
