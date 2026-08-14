import type { NextRequest } from 'next/server';

import { handleGetMobileFanoutControl } from './runtime';

export function GET(request: NextRequest) {
  return handleGetMobileFanoutControl(request);
}
