import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { Suspense, type ReactNode } from 'react';

import type { FanoutControlEffectiveState } from '@psd-eoc/contracts';

import {
  WEB_SESSION_COOKIE_NAME,
  getDefaultSessionService,
  type AuthenticatedSession,
} from '../../lib/auth/sessions';
import {
  FanoutControlBanner,
  executeGetWebFanoutControl,
  loadFanoutControlBannerState,
} from './fanout-control-banner';

export const metadata: Metadata = {
  title: {
    default: 'PSD EOC',
    template: '%s | PSD EOC',
  },
};

const FAIL_CLOSED_FALLBACK_STATE: FanoutControlEffectiveState = Object.freeze({
  kind: 'unavailable',
  effectiveMode: 'emergency-disabled',
  currentEpochId: null,
  currentRecord: null,
  reasonCode: 'CONTROL_STATE_UNREADABLE',
});

function OperationalDocument({
  banner,
  children,
}: Readonly<{
  banner: ReactNode;
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {banner}
        {children}
      </body>
    </html>
  );
}

export function OperationalLayoutFrame({
  children,
  fanoutControlState,
}: Readonly<{
  children: ReactNode;
  fanoutControlState: FanoutControlEffectiveState;
}>) {
  return (
    <OperationalDocument
      banner={<FanoutControlBanner state={fanoutControlState} />}
    >
      {children}
    </OperationalDocument>
  );
}

export interface OperationalFanoutControlDependencies {
  readSessionToken(): Promise<string | undefined>;
  authenticate(sessionToken: string): Promise<AuthenticatedSession>;
  execute(authenticated: AuthenticatedSession): Promise<unknown>;
}

const DEFAULT_FANOUT_CONTROL_DEPENDENCIES: OperationalFanoutControlDependencies =
  Object.freeze({
    async readSessionToken() {
      return (await cookies()).get(WEB_SESSION_COOKIE_NAME)?.value;
    },
    authenticate(sessionToken: string) {
      return getDefaultSessionService().authenticate(sessionToken, 'web');
    },
    execute: executeGetWebFanoutControl,
  });

/** Authenticates first, then performs only the canonical human web query. */
export function loadOperationalFanoutControlState(
  dependencies: OperationalFanoutControlDependencies = DEFAULT_FANOUT_CONTROL_DEPENDENCIES,
): Promise<FanoutControlEffectiveState> {
  return loadFanoutControlBannerState(async () => {
    const sessionToken = await dependencies.readSessionToken();
    if (sessionToken === undefined) {
      throw new TypeError('An authenticated web session is required.');
    }
    const authenticated = await dependencies.authenticate(sessionToken);
    if (
      authenticated.actor.kind !== 'human' ||
      authenticated.source !== 'web'
    ) {
      throw new TypeError('Authenticated human web provenance is required.');
    }
    return dependencies.execute(authenticated);
  });
}

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
    >
      {children}
    </OperationalDocument>
  );
}
