import { timingSafeEqual } from 'node:crypto';

function equal(value: string, expected: string): boolean {
  const first = Buffer.from(value, 'utf8');
  const second = Buffer.from(expected, 'utf8');
  return first.length === second.length && timingSafeEqual(first, second);
}

export function authorizeSyntheticSessionRequest(request: Request): string {
  const runId = process.env.PSD_EOC_FAILURE_DRILL_RUN_ID;
  const applicationOrigin = process.env.GOOGLE_OIDC_APPLICATION_ORIGIN;
  const suppliedOrigin = request.headers.get('origin');
  if (
    process.env.PSD_EOC_FAILURE_DRILL_DEPLOYMENT_CLASS !== 'non-production' ||
    process.env.PSD_EOC_FAILURE_DRILL_PROVIDER_MODE !== 'mocked' ||
    process.env.PSD_EOC_FAILURE_DRILL_ROSTER_POPULATION !== 'synthetic' ||
    process.env.GOOGLE_OIDC_HOSTED_DOMAIN !== 'example.invalid' ||
    runId === undefined ||
    !/^[a-z0-9][a-z0-9-]{7,23}$/u.test(runId) ||
    applicationOrigin === undefined ||
    !/^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.[a-z0-9-]+\.awsapprunner\.com$/u.test(
      applicationOrigin,
    ) ||
    suppliedOrigin !== applicationOrigin
  ) {
    throw new Error('The synthetic drill boundary is unavailable.');
  }
  const expected = process.env.PSD_EOC_FAILURE_DRILL_OPERATOR_TOKEN;
  const supplied = request.headers.get('authorization');
  if (
    expected === undefined ||
    supplied === null ||
    !supplied.startsWith('Bearer ') ||
    !equal(supplied.slice('Bearer '.length), expected)
  ) {
    throw new Error('The synthetic drill operator credential was refused.');
  }
  return applicationOrigin;
}
