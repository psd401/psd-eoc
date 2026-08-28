#!/usr/bin/env bun
/**
 * Checks that the application's public name still points at the running service.
 *
 * The deployment owns this record, but a second copy can exist elsewhere — a
 * split-horizon resolver inside the district network, for example — and shadow
 * it. When that happens every service metric stays healthy and nobody can reach
 * the application, so this asks the question from wherever it is run.
 *
 * Read-only. It resolves a name and reads the service description; it changes
 * nothing.
 */
import {
  AppRunnerClient,
  DescribeCustomDomainsCommand,
  ListServicesCommand,
} from '@aws-sdk/client-apprunner';
import { Resolver } from 'node:dns/promises';

const SERVICE_NAME = 'psd-eoc';

interface Finding {
  readonly ok: boolean;
  readonly detail: string;
}

async function serviceDnsTarget(
  client: AppRunnerClient,
): Promise<Readonly<{ hostname: string; target: string }>> {
  const services = await client.send(new ListServicesCommand({}));
  const service = services.ServiceSummaryList?.find(
    (candidate) => candidate.ServiceName === SERVICE_NAME,
  );
  if (service?.ServiceArn === undefined) {
    throw new Error(`No App Runner service named ${SERVICE_NAME} exists.`);
  }
  const domains = await client.send(
    new DescribeCustomDomainsCommand({ ServiceArn: service.ServiceArn }),
  );
  const hostname = domains.CustomDomains?.[0]?.DomainName;
  const target = domains.DNSTarget;
  if (hostname === undefined || target === undefined) {
    throw new Error('The service has no associated custom domain.');
  }
  return Object.freeze({ hostname, target });
}

async function resolvedTarget(
  hostname: string,
  resolver: Resolver,
): Promise<string | null> {
  try {
    const records = await resolver.resolveCname(hostname);
    return records[0] ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const client = new AppRunnerClient({});
  const { hostname, target } = await serviceDnsTarget(client);
  const findings: Finding[] = [];

  const systemResolver = new Resolver();
  const observed = await resolvedTarget(hostname, systemResolver);
  if (observed === null) {
    findings.push({
      ok: false,
      detail: `${hostname} did not resolve. The service expects ${target}.`,
    });
  } else if (observed.replace(/\.$/u, '') !== target.replace(/\.$/u, '')) {
    findings.push({
      ok: false,
      detail: `${hostname} resolves to ${observed}, but the service is ${target}. A second record is shadowing the deployed one.`,
    });
  } else {
    findings.push({ ok: true, detail: `${hostname} points at ${target}.` });
  }

  // Reaching the service by its own hostname separates "the name is wrong"
  // from "the application is down". They need different responses.
  let serviceReachable = false;
  try {
    const response = await fetch(`https://${target}/api/health`, {
      signal: AbortSignal.timeout(15_000),
    });
    serviceReachable = response.status === 200;
  } catch {
    serviceReachable = false;
  }
  findings.push({
    ok: serviceReachable,
    detail: serviceReachable
      ? 'The service answers on its own address.'
      : 'The service did not answer on its own address.',
  });

  for (const finding of findings) {
    console.log(`${finding.ok ? 'ok  ' : 'FAIL'} ${finding.detail}`);
  }
  if (findings.some((finding) => !finding.ok)) {
    console.error(
      '\nThe public address does not match the running service. Correct the record that the deployment does not own; the deployed record is managed in the application hosted zone.',
    );
    process.exitCode = 1;
  }
}

await main();
