import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { OperatorShell } from '../nav/operator-shell';

export const metadata: Metadata = {
  title: {
    default: 'Emergency operations',
    template: '%s | Emergency operations',
  },
};

export default function OperationalLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  // The operator shell is deliberately not wrapped in Suspense. A boundary here
  // resolves after the shell, so its markup patches the document once the page
  // is already interactive. On the event room that remounts the media figure
  // and drops the IntersectionObserver registration its lazy read grant depends
  // on — a real defect for anyone on a slow connection, not only a test
  // artifact. Without a boundary the navigation is part of the initial HTML and
  // the document is not patched afterwards.
  return <OperatorShell>{children}</OperatorShell>;
}
