import type { ReactNode } from 'react';

import './styles.css';

export default function StartFlowLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return children;
}
