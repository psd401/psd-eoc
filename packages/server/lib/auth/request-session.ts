import { cache } from 'react';

import {
  getDefaultSessionService,
  type AuthenticatedSession,
} from './sessions';

/**
 * Authenticates one web session token, at most once per request.
 *
 * Every authenticated page renders inside a layout that renders the primary
 * navigation, and both need the same viewer: the navigation to decide which
 * destinations to offer and whose identity to show, the page to authorize what
 * it is about to do. Calling the session service from each of them means two
 * identical database round trips per page view, on the hot path, scaling with
 * traffic rather than with anything the viewer did.
 *
 * React's `cache` is keyed on the arguments and scoped to a single request, so
 * the layout and the page share one lookup and nothing is shared between
 * viewers. A rejection is memoized alongside a success, which is correct here:
 * the same token in the same request cannot be both expired and valid, and
 * every caller should see the same answer.
 *
 * Use this from server components. Route handlers authenticate their own
 * request and have no second reader to share with.
 */
export const authenticateWebSession = cache(
  async (sessionToken: string): Promise<AuthenticatedSession> =>
    getDefaultSessionService().authenticate(sessionToken, 'web'),
);
