import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './styles.css';
import { OperatorShell } from '../../nav/operator-shell';

export const metadata: Metadata = {
  title: 'Responses | Emergency operations',
  description: 'Administer versioned responses and notification wording.',
};

export default function EventTypesLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <OperatorShell>{children}</OperatorShell>;
}
