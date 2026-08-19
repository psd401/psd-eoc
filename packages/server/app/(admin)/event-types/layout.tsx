import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './styles.css';
import { PrimaryNav } from '../../nav/primary-nav';

export const metadata: Metadata = {
  title: 'Event types | PSD EOC',
  description:
    'Administer versioned PSD EOC event types and notification wording.',
};

export default function EventTypesLayout({
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
