import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';

import type { FanoutStatus } from '@psd-eoc/contracts';

import {
  FanoutControlBanner,
  OperationalDocument,
  loadOperationalFanoutControlState,
} from './fanout-control-banner';
import { PrimaryNav } from '../nav/primary-nav';

export const metadata: Metadata = {
  title: {
    default: 'PSD EOC',
    template: '%s | PSD EOC',
  },
};

const FAIL_CLOSED_FALLBACK_STATE: FanoutStatus = Object.freeze({
  status: 'unavailable',
});

async function LoadedFanoutControlBanner() {
  const state = await loadOperationalFanoutControlState();
  return <FanoutControlBanner state={state} />;
}

export default function OperationalLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  // The navigation is deliberately not wrapped in Suspense. A boundary here
  // resolves after the shell, so its markup patches the document once the page
  // is already interactive. On the event room that remounts the media figure
  // and drops the IntersectionObserver registration its lazy read grant depends
  // on — a real defect for anyone on a slow connection, not only a test
  // artifact. Without a boundary the navigation is part of the initial HTML and
  // the document is not patched afterwards.
  //
  // The fan-out banner keeps its boundary: it renders a fail-closed fallback
  // immediately and swaps content in place, so it never delays the shell.
  return (
    <OperationalDocument
      banner={
        <Suspense
          fallback={<FanoutControlBanner state={FAIL_CLOSED_FALLBACK_STATE} />}
        >
          <LoadedFanoutControlBanner />
        </Suspense>
      }
      nav={<PrimaryNav />}
    >
      {children}
    </OperationalDocument>
  );
}
