import { createDatabaseClient, readDatabaseConfig } from '../../db/client';
import { partnerMessageContext } from '../../lib/partners/messages';
import { resolvePartnerProviders } from '../../lib/partners/providers';
import { runPartnerAccessSweep } from '../../lib/partners/sweep';
import { describeFailure } from './failure-diagnostics';

/**
 * The daily partner-access run, started by its EventBridge schedule as a
 * one-off task. It expires admissions on their date, completes provider
 * changes that are still pending, sends the one notice 14 days ahead, and
 * once a quarter sends administrators the inactivity review. It never
 * disables anyone for inactivity. With partner access unconfigured it exits
 * having done nothing.
 */
export async function runFromCommandLine(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now: Date = new Date(),
): Promise<void> {
  const providers = resolvePartnerProviders(environment);
  if (providers === null) {
    console.info(
      JSON.stringify({
        event: 'partner-access-sweep-skipped',
        reason: 'unconfigured',
      }),
    );
    return;
  }
  const connection = createDatabaseClient(readDatabaseConfig(environment));
  try {
    const result = await runPartnerAccessSweep({
      database: connection.db,
      providers,
      messageContext: partnerMessageContext(environment),
      now,
    });
    console.info(
      JSON.stringify({ event: 'partner-access-sweep-complete', ...result }),
    );
    // A provider change or notice that could not complete is retried by the
    // next run; reporting it as a failure makes the task alarm visible.
    if (result.providerChangesPending > 0 || result.noticesFailed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await connection.close();
  }
}

export const PARTNER_SWEEP_FAILURE_PREFIX =
  'The partner access sweep did not complete.';

if (import.meta.main) {
  try {
    await runFromCommandLine();
  } catch (error) {
    console.error(describeFailure(PARTNER_SWEEP_FAILURE_PREFIX, error));
    process.exitCode = 1;
  }
}
