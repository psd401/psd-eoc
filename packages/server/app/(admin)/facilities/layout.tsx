import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './styles.css';
import { OperatorShell } from '../../nav/operator-shell';

export const metadata: Metadata = {
  title: 'Facilities administration | Emergency operations',
  description: 'Configure facilities, groups, and audiences.',
};

export default function FacilitiesLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <OperatorShell>{children}</OperatorShell>;
}
