export const EXPECTED_BODY = '{"status":"ok"}';
export const MAX_RESPONSE_BYTES = 1_024;
export const REQUEST_TIMEOUT_MILLISECONDS = 20_000;

export function requiredEnvironment(environment, name, maximumLength = 2_048) {
  const value = environment[name];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error('Canary configuration is unavailable.');
  }
  return value;
}

export function assertCanaryUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/api/health' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !url.hostname.endsWith('.awsapprunner.com')
  ) {
    throw new Error('Canary URL is unavailable.');
  }
  return url;
}

export function parseCredential(secret) {
  const value = secret.SecretString;
  if (
    typeof value !== 'string' ||
    !/^psd_eoc_agent_v1_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/u.test(value)
  ) {
    throw new Error('Canary credential is unavailable.');
  }
  return value;
}

export function scheduledMetricTimestamp(event) {
  const value = event?.time;
  if (
    event?.source !== 'aws.events' ||
    event?.['detail-type'] !== 'Scheduled Event' ||
    typeof event?.id !== 'string' ||
    event.id.length === 0 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      event.id,
    ) ||
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
  ) {
    throw new Error('Canary schedule is unavailable.');
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error('Canary schedule is unavailable.');
  }
  timestamp.setUTCSeconds(0, 0);
  return timestamp;
}

export async function readBoundedBody(response) {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^[0-9]+$/u.test(contentLength) ||
      Number(contentLength) > MAX_RESPONSE_BYTES)
  ) {
    throw new Error('Canary response is unavailable.');
  }
  if (response.body === null) {
    throw new Error('Canary response is unavailable.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Canary response is unavailable.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Canary response is unavailable.');
  }
}
