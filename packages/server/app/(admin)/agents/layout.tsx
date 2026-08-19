import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './styles.css';
import { PrimaryNav } from '../../nav/primary-nav';

export const metadata: Metadata = {
  title: 'Agent access | PSD EOC',
  description:
    'Issue scoped agent API keys, revoke access, and review agent call audits.',
};

export default function AgentsRootLayout({
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
