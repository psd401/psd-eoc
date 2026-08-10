import { ZodError } from 'zod';

export const MAX_EVENT_TYPE_REQUEST_BODY_BYTES = 100_000;

export type RequestFieldError = Readonly<{
  path: readonly (string | number)[];
  message: string;
}>;

export class RequestValidationError extends Error {
  public constructor(
    message: string,
    public readonly fieldErrors: readonly RequestFieldError[] = [],
  ) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export function parseRequestInput<Output>(
  parser: Readonly<{ parse(value: unknown): Output }>,
  value: unknown,
): Output {
  try {
    return parser.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new RequestValidationError(
        'Review the highlighted event-type fields and try again.',
        error.issues.slice(0, 100).map((issue) => ({
          path: issue.path.filter(
            (part): part is string | number =>
              typeof part === 'string' || typeof part === 'number',
          ),
          message: issue.message,
        })),
      );
    }
    throw error;
  }
}

/** Reads JSON incrementally so omitted or false Content-Length cannot bypass the cap. */
export async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (
    contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    throw new RequestValidationError(
      'The event-type request must use application/json.',
    );
  }
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > MAX_EVENT_TYPE_REQUEST_BODY_BYTES
    ) {
      throw new RequestValidationError('The event-type request is too large.');
    }
  }
  if (request.body === null) {
    throw new RequestValidationError('The event-type request body is empty.');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    total += result.value.byteLength;
    if (total > MAX_EVENT_TYPE_REQUEST_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RequestValidationError('The event-type request is too large.');
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RequestValidationError(
      'The event-type request must contain valid UTF-8 JSON.',
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestValidationError(
      'The event-type request contains malformed JSON.',
    );
  }
}
