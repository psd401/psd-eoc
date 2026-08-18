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
  return (
    <OperationalDocument
      banner={
        <Suspense
          fallback={<FanoutControlBanner state={FAIL_CLOSED_FALLBACK_STATE} />}
        >
          <LoadedFanoutControlBanner />
        </Suspense>
      }
      nav={
        <Suspense fallback={null}>
          <PrimaryNav />
        </Suspense>
      }
    >
      {children}
    </OperationalDocument>
  );
}
