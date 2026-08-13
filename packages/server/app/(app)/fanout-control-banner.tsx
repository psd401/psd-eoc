import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';

import {
  FanoutStatusSchema,
  type CapabilityInput,
  type FanoutStatus,
} from '@psd-eoc/contracts';
import type { CSSProperties, ReactNode } from 'react';

import {
  createDrizzleAdminCapabilityStore,
  executeAdminQueryCapability,
  getDefaultAdminDatabase,
  type AdminCapabilityStore,
  type AdminCapabilityTransaction,
} from '../(admin)/facilities/admin-core';
import {
  WEB_SESSION_COOKIE_NAME,
  getDefaultSessionService,
  type AuthenticatedSession,
} from '../../lib/auth/sessions';
import type {
  CapabilityHandlerContext,
  ServerCapabilityRegistration,
} from '../../lib/capabilities/engine';
import { readFanoutStatus } from '../../lib/notify/fanout-control';

const BANNER_STYLE: CSSProperties = Object.freeze({
  backgroundColor: '#7f1d1d',
  border: '4px solid #450a0a',
  color: '#ffffff',
  margin: 0,
  padding: '1rem',
});

const HEADING_STYLE: CSSProperties = Object.freeze({
  color: 'inherit',
  fontSize: '1.25rem',
  fontWeight: 800,
  margin: '0 0 0.5rem',
});

const PARAGRAPH_STYLE: CSSProperties = Object.freeze({
  color: 'inherit',
  margin: '0.25rem 0',
});

const UNAVAILABLE_STATE = FanoutStatusSchema.parse({ status: 'unavailable' });

export type FanoutControlStateReader = () => Promise<unknown>;

export interface OperationalFanoutControlDependencies {
  readSessionToken(): Promise<string | undefined>;
  authenticate(sessionToken: string): Promise<AuthenticatedSession>;
  execute(authenticated: AuthenticatedSession): Promise<unknown>;
}

const getWebFanoutControlRegistration: ServerCapabilityRegistration<
  'get-fanout-status',
  AdminCapabilityTransaction
> = Object.freeze({
  id: 'get-fanout-status',
  resolveFacilityId(
    _input: CapabilityInput<'get-fanout-status'>,
    context: CapabilityHandlerContext<AdminCapabilityTransaction>,
  ) {
    const actor = context.invocation.actor;
    if (
      actor.kind !== 'human' ||
      context.invocation.source !== 'web' ||
      context.invocation.mutation !== null
    ) {
      throw new TypeError(
        'Web fan-out status requires an authenticated human web query.',
      );
    }
    return null;
  },
  handler(
    _input: CapabilityInput<'get-fanout-status'>,
    context: CapabilityHandlerContext<AdminCapabilityTransaction>,
  ) {
    return readFanoutStatus(context.transaction.database);
  },
});

/**
 * Executes the authenticated web status read through the canonical capability
 * engine. The global status has no facility side door and accepts no mutation
 * or confirmation metadata.
 */
export function executeGetWebFanoutControl(
  authenticated: AuthenticatedSession,
  metadata: Readonly<{ requestId?: string; now?: Date }> = {},
  injectedStore?: AdminCapabilityStore,
) {
  const store =
    injectedStore ??
    createDrizzleAdminCapabilityStore(getDefaultAdminDatabase(), authenticated);
  return executeAdminQueryCapability(
    getWebFanoutControlRegistration,
    {},
    authenticated,
    store,
    {
      requestId: metadata.requestId ?? randomUUID(),
      now: metadata.now ?? new Date(),
    },
  );
}

/**
 * Reads and revalidates global fan-out truth for the authenticated web shell.
 * Configuration failures, read failures, and malformed results all collapse
 * to one safe unavailable state; error text is never reflected to a user.
 */
export async function loadFanoutControlBannerState(
  readState: FanoutControlStateReader,
): Promise<FanoutStatus> {
  try {
    return FanoutStatusSchema.parse(await readState());
  } catch {
    return UNAVAILABLE_STATE;
  }
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
): Promise<FanoutStatus> {
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

/** Prominent status shared by every authenticated operational route. */
export function FanoutControlBanner({
  state,
}: Readonly<{ state: FanoutStatus }>) {
  if (state.status === 'enabled') return null;

  const unavailable = state.status === 'unavailable';
  const heading = unavailable
    ? 'Notification status unavailable — sending is blocked'
    : 'Emergency notification sending is disabled';
  const status = unavailable
    ? 'PSD EOC cannot prove the current notification fan-out state, so it remains fail-closed and will refuse notification handoff.'
    : 'PSD EOC is emergency-disabled and will refuse new notification previews and notification handoff.';

  return (
    <aside
      aria-describedby="fanout-control-banner-status fanout-control-banner-classification"
      aria-labelledby="fanout-control-banner-heading"
      data-fanout-control-state={unavailable ? 'unavailable' : 'disabled'}
      role="alert"
      style={BANNER_STYLE}
    >
      <h2 id="fanout-control-banner-heading" style={HEADING_STYLE}>
        {heading}
      </h2>
      <p id="fanout-control-banner-status" style={PARAGRAPH_STYLE}>
        {status} This status banner did not send a notification.
      </p>
      <p id="fanout-control-banner-classification" style={PARAGRAPH_STYLE}>
        Real incidents remain real and drills remain drills; this control never
        changes their classification.
      </p>
    </aside>
  );
}

export function OperationalDocument({
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
  fanoutControlState: FanoutStatus;
}>) {
  return (
    <OperationalDocument
      banner={<FanoutControlBanner state={fanoutControlState} />}
    >
      {children}
    </OperationalDocument>
  );
}
