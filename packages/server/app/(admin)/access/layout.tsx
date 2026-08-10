import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../facilities/styles.css';

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
        {children}
      </body>
    </html>
  );
}
