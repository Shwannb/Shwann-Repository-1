import { NextResponse } from 'next/server';
import { buildSessionCookie, getExpectedToken, tokensEqual } from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface LoginBody { token?: unknown }

export async function POST(request: Request) {
  const expected = getExpectedToken();
  // If auth is disabled, login is meaningless — refuse so callers don't think
  // they "logged in" and rely on a cookie that won't be checked.
  if (expected === null) {
    return NextResponse.json({ error: 'auth disabled on this deployment' }, { status: 400 });
  }

  let body: LoginBody;
  try { body = (await request.json()) as LoginBody; }
  catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  const candidate = typeof body.token === 'string' ? body.token : '';
  if (!candidate || !tokensEqual(expected, candidate)) {
    // Same response for empty and wrong token — don't help an attacker probe.
    return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  }

  const secure = new URL(request.url).protocol === 'https:';
  return NextResponse.json(
    { ok: true },
    { headers: { 'Set-Cookie': buildSessionCookie(candidate, secure) } }
  );
}
