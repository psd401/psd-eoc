import { Buffer } from 'node:buffer';
import { MAX_RESPONSE_BYTES } from './asc-model';
export const cancelResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // The static size-limit error remains authoritative.
  }
};
export const readBoundedResponseJson = async (
  response: Response,
): Promise<unknown> => {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await cancelResponseBody(response);
    throw new Error('Apple response exceeded its size limit.');
  }
  if (response.body === null)
    throw new Error('Apple returned an empty JSON response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  let sizeExceeded = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > MAX_RESPONSE_BYTES) {
        sizeExceeded = true;
        try {
          await reader.cancel();
        } catch {
          // The static size-limit error remains authoritative.
        }
        throw new Error('Apple response exceeded its size limit.');
      }
      chunks.push(value);
    }
  } catch {
    if (sizeExceeded) {
      throw new Error('Apple response exceeded its size limit.');
    }
    try {
      await reader.cancel();
    } catch {
      // The static read error remains authoritative.
    }
    throw new Error('Apple response body could not be read.');
  } finally {
    reader.releaseLock();
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks, byteCount),
    );
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Apple returned invalid JSON.');
  }
};
