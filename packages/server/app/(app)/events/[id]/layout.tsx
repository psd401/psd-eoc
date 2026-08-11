import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './styles.css';

export const metadata: Metadata = {
  title: 'Event room',
  description:
    'Follow an authorized PSD EOC event timeline and post operational updates.',
};

export default function EventRoomLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <>{children}</>;
}
