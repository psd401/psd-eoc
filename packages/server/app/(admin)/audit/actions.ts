'use server';

import { randomUUID } from 'node:crypto';

import type { SecurityAuditQuery } from '@psd-eoc/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  WEB_SESSION_COOKIE_NAME,
  type AuthenticatedSession,
} from '../../../lib/auth/sessions';
import {
  executeQuerySecurityAuditCapability,
  getDefaultSecurityAuditService,
  isSecurityAuditForbiddenError,
} from '../../../lib/audit';
import {
  createDefaultAuditQuery,
  emptyAuditFilterState,
  parseAuditSubmission,
  toAuditDisplayPage,
  type AuditFilterState,
  type AuditViewState,
} from './filters';
import { authenticateWebSession } from '../../../lib/auth/request-session';

async function authenticateAuditSession(): Promise<AuthenticatedSession> {
  const cookieStore = await cookies();
  const token = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (token === undefined) {
    redirect('/login?reason=session-required');
  }

  try {
    return await authenticateWebSession(token);
  } catch {
    redirect('/login?reason=session-expired');
  }
}

async function executeAuditQuery(
  authenticated: AuthenticatedSession,
  filters: AuditFilterState,
  query: SecurityAuditQuery,
): Promise<AuditViewState> {
  try {
    const page = await executeQuerySecurityAuditCapability({
      service: getDefaultSecurityAuditService(),
      access: {
        actor: authenticated.actor,
        source: authenticated.source,
        facilityScope: authenticated.scope.facilityScope,
        roles: authenticated.roles,
        capabilityGrants: [],
      },
      query,
      requestId: randomUUID(),
    });
    return {
      filters,
      page: toAuditDisplayPage(page),
      errorMessage: null,
      forbidden: false,
    };
  } catch (error) {
    if (isSecurityAuditForbiddenError(error)) {
      return {
        filters,
        page: null,
        errorMessage: null,
        forbidden: true,
      };
    }
    return {
      filters,
      page: null,
      errorMessage:
        'Security audit records are unavailable. No records were displayed.',
      forbidden: false,
    };
  }
}

/** Initial server render uses the same authenticated, self-auditing query. */
export async function loadInitialAuditViewState(): Promise<AuditViewState> {
  const authenticated = await authenticateAuditSession();
  return executeAuditQuery(
    authenticated,
    emptyAuditFilterState(),
    createDefaultAuditQuery(),
  );
}

/**
 * POST-backed filter and pagination action. Its previous UI state is never an
 * authorization input; actor, roles, and facility scope are resolved anew.
 */
export async function queryAuditAction(
  previousState: AuditViewState,
  formData: FormData,
): Promise<AuditViewState> {
  void previousState;
  const authenticated = await authenticateAuditSession();
  if (!authenticated.roles.includes('admin')) {
    return executeAuditQuery(
      authenticated,
      emptyAuditFilterState(),
      createDefaultAuditQuery(),
    );
  }
  const parsed = parseAuditSubmission(formData);
  if (!parsed.valid) {
    return {
      filters: parsed.filters,
      page: null,
      errorMessage: parsed.message,
      forbidden: false,
    };
  }
  return executeAuditQuery(authenticated, parsed.filters, parsed.query);
}
