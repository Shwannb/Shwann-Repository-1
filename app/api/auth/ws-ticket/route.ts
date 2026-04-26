import { NextResponse } from 'next/server';
import { getExpectedToken } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// The browser fetches this just-in-time before opening a WebSocket. The
// terminal page is gated by middleware, so the only way to reach this
// endpoint is with a valid session cookie or Authorization header. We then
// echo back the token the client should pass as ?token= on the WS upgrade.
//
// Security note: this briefly puts the token in browser-accessible memory
// (vs. the cookie-only path). Acceptable for an internal Phase 1.5 tool;
// when this is deployed against a multi-user identity provider we'll mint
// a short-lived signed ticket distinct from the API token.
export async function GET() {
  const expected = getExpectedToken();
  // When auth is disabled, return an empty ticket — the WS server doesn't
  // require one, and the client can connect without ?token=.
  return NextResponse.json({ ticket: expected ?? '' });
}
