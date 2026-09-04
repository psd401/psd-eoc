import type { NextRequest } from 'next/server';

import { handleReadMySmsConsent, handleRecordSmsConsent } from './_lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return handleReadMySmsConsent(request);
}

export async function POST(request: NextRequest) {
  return handleRecordSmsConsent(request);
}
