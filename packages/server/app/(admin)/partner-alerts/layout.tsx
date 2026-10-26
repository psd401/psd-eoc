import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../facilities/styles.css';
import { OperatorShell } from '../../nav/operator-shell';

export const metadata: Metadata = {
  title: 'Partner alerts | Emergency operations',
  description: 'Choose which real events alert partner responders.',
};

export default function PartnerAlertsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <OperatorShell>{children}</OperatorShell>;
}
