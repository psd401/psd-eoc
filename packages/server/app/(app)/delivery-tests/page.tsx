import { randomUUID } from 'node:crypto';

import {
  ListDeliveryTestReportsInputSchema,
  MonthlyDeliveryTestReportPageSchema,
} from '@psd-eoc/contracts';
import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import {
  WEB_CSRF_COOKIE_NAME,
  WEB_SESSION_COOKIE_NAME,
  type AuthenticatedSession,
} from '../../../lib/auth/sessions';
import { eventTypesForMode, loadOperationalViewData } from '../start/_lib/data';
import {
  DELIVERY_TEST_PRODUCT_OWNER_USER_ID_ENV,
  executeListDeliveryTestReports,
} from './capabilities';
import { DeliveryTestConsole } from './delivery-test-console';
import { DeliveryTestReportList } from './report-list';
import '../start/styles.css';
import './styles.css';
import { authenticateWebSession } from '../../../lib/auth/request-session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = {
  title: { absolute: 'Monthly delivery tests | PSD EOC' },
  description:
    'Protected live-canary DRILL console and destination-free delivery evidence.',
};

async function requireDeliveryTestSession(): Promise<{
  readonly authenticated: AuthenticatedSession;
  readonly hasCsrfCookie: boolean;
}> {
  const cookieStore = await cookies();
  const token = cookieStore.get(WEB_SESSION_COOKIE_NAME)?.value;
  if (token === undefined) {
    redirect('/login?reason=session-required&returnTo=%2Fdelivery-tests');
  }
  let authenticated: AuthenticatedSession;
  try {
    authenticated = await authenticateWebSession(token);
  } catch {
    redirect('/login?reason=session-expired&returnTo=%2Fdelivery-tests');
  }
  return {
    authenticated,
    hasCsrfCookie: cookieStore.has(WEB_CSRF_COOKIE_NAME),
  };
}

export default async function DeliveryTestsPage() {
  const { authenticated, hasCsrfCookie } = await requireDeliveryTestSession();
  if (!hasCsrfCookie) {
    redirect('/login?reason=session-required&returnTo=%2Fdelivery-tests');
  }

  const [operational, reportPageValue] = await Promise.all([
    loadOperationalViewData(authenticated),
    executeListDeliveryTestReports({
      authenticated,
      command: ListDeliveryTestReportsInputSchema.parse({
        facilityId: null,
        status: null,
        generatedFrom: null,
        generatedThrough: null,
        cursor: null,
        limit: 100,
      }),
      metadata: { requestId: randomUUID(), now: new Date() },
    }),
  ]);
  const reports = MonthlyDeliveryTestReportPageSchema.parse(reportPageValue);
  const showTargetConfiguration =
    authenticated.roles.includes('admin') &&
    process.env[DELIVERY_TEST_PRODUCT_OWNER_USER_ID_ENV] ===
      authenticated.actor.userId;

  return (
    <main
      className="page-shell delivery-tests-page"
      id="main-content"
      tabIndex={-1}
    >
      <header className="page-heading">
        <div>
          <p className="eyebrow">Reliability operations</p>
          <h1>Monthly live delivery test</h1>
          <p className="lede">
            A protected provider-path DRILL for explicitly opted-in controlled
            canary endpoints. The monthly schedule only reminds the team; it
            cannot start this run.
          </p>
        </div>
        <a className="button button--secondary" href="/">
          Return to dashboard
        </a>
      </header>

      <aside className="delivery-test-safety" aria-labelledby="safety-heading">
        <h2 id="safety-heading">Human-only live-send boundary</h2>
        <p>
          Creating configuration and loading a preview never sends. A live
          canary requires an exact unexpired consequence preview, live-verified
          providers and credentials, and a fresh explicit authenticated-human
          confirmation through canonical start-event. It is always a DRILL.
        </p>
      </aside>

      <DeliveryTestConsole
        csrfCookieName={WEB_CSRF_COOKIE_NAME}
        drillEventTypes={eventTypesForMode(operational.eventTypes, 'drill')}
        facilities={operational.facilities.map((facility) => ({
          id: facility.id,
          code: facility.code,
          name: facility.name,
        }))}
        showTargetConfiguration={showTargetConfiguration}
      />

      <DeliveryTestReportList reports={reports.items} />
      {reports.pageInfo.hasMore ? (
        <p className="supporting-text">
          Showing the 100 newest append-only report snapshots. Additional
          history remains available through the canonical report API.
        </p>
      ) : null}
    </main>
  );
}
