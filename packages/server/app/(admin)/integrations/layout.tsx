import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../facilities/styles.css';
import { OperatorShell } from '../../nav/operator-shell';

export const metadata: Metadata = {
  title: 'Integration health | Emergency operations',
  description: 'Review PSD EOC integration, roster, and test-mode health.',
};

export default function IntegrationsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <OperatorShell>{children}</OperatorShell>;
}
