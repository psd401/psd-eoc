import { AGENT_REST_OPENAPI_DOCUMENT } from '../../../../../lib/agents/openapi';

const OPENAPI_RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  Vary: 'Authorization',
  'X-Content-Type-Options': 'nosniff',
});

/** Serves the contract-generated description without caching credential context. */
export function GET(): Response {
  return Response.json(AGENT_REST_OPENAPI_DOCUMENT, {
    headers: OPENAPI_RESPONSE_HEADERS,
  });
}
