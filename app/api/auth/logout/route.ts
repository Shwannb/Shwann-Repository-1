import { NextResponse } from 'next/server';
import { buildClearCookie } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const secure = new URL(request.url).protocol === 'https:';
  return NextResponse.json(
    { ok: true },
    { headers: { 'Set-Cookie': buildClearCookie(secure) } }
  );
}
