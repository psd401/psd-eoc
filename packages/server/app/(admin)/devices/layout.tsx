import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Device sessions | PSD EOC',
  description: 'Review and revoke staff device sessions for PSD EOC.',
};

export default function DevicesRootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
