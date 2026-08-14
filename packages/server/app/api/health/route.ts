import { handleHealthGet, handleHealthPost } from './runtime';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/** Side-effect-free, unauthenticated deep health read. */
export function GET(): Promise<Response> {
  return handleHealthGet();
}

/** Authenticated TEST/drill/synthetic lifecycle, deliberately rolled back. */
export function POST(request: Request): Promise<Response> {
  return handleHealthPost(request);
}
