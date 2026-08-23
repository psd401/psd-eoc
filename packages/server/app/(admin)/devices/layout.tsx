import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../facilities/styles.css';
import { OperatorShell } from '../../nav/operator-shell';

export const metadata: Metadata = {
  title: 'Device sessions | Emergency operations',
  description: 'Review and revoke staff device sessions.',
};

export default function DevicesRootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <OperatorShell>{children}</OperatorShell>;
}
