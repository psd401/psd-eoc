import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './styles.css';
import { OperatorShell } from '../../nav/operator-shell';

export const metadata: Metadata = {
  title: 'Agent access | Emergency operations',
  description:
    'Issue scoped agent API keys, revoke access, and review agent call audits.',
};

export default function AgentsRootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <OperatorShell>{children}</OperatorShell>;
}
