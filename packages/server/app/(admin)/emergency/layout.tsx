import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../facilities/styles.css';
import { PrimaryNav } from '../../nav/primary-nav';

export const metadata: Metadata = {
  title: 'Emergency notification control | PSD EOC',
  description:
    'Review or emergency-disable the district notification fan-out path.',
};

export default function EmergencyControlLayout({
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
