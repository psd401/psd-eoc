import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { IdempotencyKeySchema } from '@psd-eoc/contracts';

import {
  MAX_EVENT_TYPE_REQUEST_BODY_BYTES,
  RequestValidationError,
  parseRequestInput,
  readBoundedJson,
} from './request';

function jsonRequest(
  body: BodyInit,
  headers: Readonly<Record<string, string>> = {},
): Request {
  return new Request('https://eoc.example.test/event-types/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

describe('bounded event-type request parsing', () => {
  test('accepts bounded UTF-8 JSON without trusting Content-Length', async () => {
    const request = jsonRequest(JSON.stringify({ action: 'preview' }));
    expect(request.headers.get('content-length')).toBeNull();
    await expect(readBoundedJson(request)).resolves.toEqual({
      action: 'preview',
    });
  });

  test('rejects an omitted or false small Content-Length when streamed bytes exceed the cap', async () => {
    const oversized = JSON.stringify({
      body: 'x'.repeat(MAX_EVENT_TYPE_REQUEST_BODY_BYTES),
    });
    const omitted = jsonRequest(oversized);
    await expect(readBoundedJson(omitted)).rejects.toMatchObject({
      name: 'RequestValidationError',
      message: 'The event-type request is too large.',
    });

    const falseSmall = jsonRequest(oversized, { 'Content-Length': '1' });
    await expect(readBoundedJson(falseSmall)).rejects.toMatchObject({
      name: 'RequestValidationError',
      message: 'The event-type request is too large.',
    });
  });

  test('rejects malformed JSON, invalid UTF-8, and non-JSON content', async () => {
    await expect(readBoundedJson(jsonRequest('{'))).rejects.toMatchObject({
      message: 'The event-type request contains malformed JSON.',
    });
    await expect(
      readBoundedJson(jsonRequest(new Uint8Array([0xc3, 0x28]))),
    ).rejects.toMatchObject({
      message: 'The event-type request must contain valid UTF-8 JSON.',
    });
    await expect(
      readBoundedJson(
        new Request('https://eoc.example.test/event-types/api', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: '{}',
        }),
      ),
    ).rejects.toMatchObject({
      message: 'The event-type request must use application/json.',
    });
    await expect(
      readBoundedJson(
        new Request('https://eoc.example.test/event-types/api', {
          method: 'POST',
          headers: { 'Content-Type': 'application/jsonp' },
          body: '{}',
        }),
      ),
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  test('turns only request-schema failures into bounded field errors', () => {
    const schema = z.object({ name: z.string().min(3) }).strict();
    try {
      parseRequestInput(schema, { name: 'x' });
      throw new Error('Expected request validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(RequestValidationError);
      expect(error).toMatchObject({
        message: 'Review the highlighted event-type fields and try again.',
        fieldErrors: [{ path: ['name'] }],
      });
    }

    const internal = new Error('internal parser failure');
    expect(() =>
      parseRequestInput(
        {
          parse: () => {
            throw internal;
          },
        },
        {},
      ),
    ).toThrow(internal);
    expect(() => parseRequestInput(IdempotencyKeySchema, '')).toThrow(
      RequestValidationError,
    );
  });
});
