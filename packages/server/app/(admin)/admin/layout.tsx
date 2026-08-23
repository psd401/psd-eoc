import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../facilities/styles.css';
import { PrimaryNav } from '../../nav/primary-nav';

export const metadata: Metadata = {
  title: 'Deployment readiness | EOC',
  description: 'Review first-run configuration and recurring service liveness.',
};

export default function AdminReadinessLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <PrimaryNav currentPath="/admin" />
        {children}
      </body>
    </html>
  );
}
