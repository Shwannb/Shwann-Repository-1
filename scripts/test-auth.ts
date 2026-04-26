// Auth gating test (offline, deterministic).
//
// Three states:
//   1. SAFYR_API_TOKEN unset       → middleware short-circuits, all open
//   2. SAFYR_API_TOKEN set, no auth → 401 / redirect
//   3. SAFYR_API_TOKEN set + Bearer → 200
//   4. Login flow round-trip via /api/auth/login + cookie

import {
  isAuthEnabled,
  isAuthorized,
  tokensEqual,
  buildSessionCookie,
  buildClearCookie,
  extractToken,
  SESSION_COOKIE_NAME,
} from '../lib/auth';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  // [1/6] Constant-time compare
  assert(tokensEqual('abc123', 'abc123'),  'equal tokens should match');
  assert(!tokensEqual('abc123', 'abc124'), 'differing tokens should not match');
  assert(!tokensEqual('abc123', 'abc'),    'different lengths should not match');
  console.log('[1/6] tokensEqual: OK');

  // [2/6] Open mode when env unset
  delete process.env.SAFYR_API_TOKEN;
  assert(!isAuthEnabled(), 'auth should be disabled when env unset');
  assert(isAuthorized(new Request('http://localhost/api/deals')), 'open mode should authorize');
  console.log('[2/6] open mode (env unset): OK');

  // [3/6] Closed mode rejects empty + wrong tokens
  process.env.SAFYR_API_TOKEN = 'super-secret-token';
  assert(isAuthEnabled(), 'auth should be enabled');
  assert(!isAuthorized(new Request('http://localhost/api/deals')), 'no header → reject');
  const wrong = new Request('http://localhost/api/deals', {
    headers: { Authorization: 'Bearer wrong-token-of-correct-length123' },
  });
  assert(!isAuthorized(wrong), 'wrong bearer → reject');
  console.log('[3/6] closed mode rejects empty + wrong: OK');

  // [4/6] Bearer header passes
  const goodHeader = new Request('http://localhost/api/deals', {
    headers: { Authorization: 'Bearer super-secret-token' },
  });
  assert(isAuthorized(goodHeader), 'correct bearer → accept');

  // Cookie also works (extractToken parses from a cookie header)
  const goodCookie = new Request('http://localhost/api/deals', {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=super-secret-token; other=foo` },
  });
  assert(isAuthorized(goodCookie), 'session cookie → accept');
  assert(extractToken(goodCookie) === 'super-secret-token', 'extractToken cookie value');
  console.log('[4/6] bearer + cookie auth path: OK');

  // [5/6] login route round-trip
  const { POST: loginPOST }  = await import('../app/api/auth/login/route');
  const { POST: logoutPOST } = await import('../app/api/auth/logout/route');

  // Wrong token -> 401, no Set-Cookie
  let res = await loginPOST(new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'nope' }),
  }));
  assert(res.status === 401, `wrong login should 401, got ${res.status}`);
  assert(!res.headers.get('set-cookie'), 'wrong login must not set cookie');

  // Right token -> 200 with httpOnly cookie
  res = await loginPOST(new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'super-secret-token' }),
  }));
  assert(res.status === 200, `correct login should 200, got ${res.status}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  assert(setCookie.includes(SESSION_COOKIE_NAME), 'cookie not set');
  assert(setCookie.toLowerCase().includes('httponly'), 'cookie should be HttpOnly');
  assert(setCookie.toLowerCase().includes('samesite=strict'), 'cookie should be SameSite=Strict');

  // Logout always clears
  res = await logoutPOST(new Request('http://localhost/api/auth/logout', { method: 'POST' }));
  const clearCookie = res.headers.get('set-cookie') ?? '';
  assert(clearCookie.includes('Max-Age=0'), 'logout should expire cookie');
  console.log('[5/6] login/logout round-trip: OK');

  // [6/6] Cookie format helpers — secure flag toggles correctly
  const insecure = buildSessionCookie('t', false);
  const secure   = buildSessionCookie('t', true);
  assert(!insecure.toLowerCase().includes('secure'), 'http should not set Secure');
  assert(secure.toLowerCase().includes('secure'),    'https should set Secure');
  assert(buildClearCookie(false).includes('Max-Age=0'), 'clear cookie sets Max-Age=0');
  console.log('[6/6] cookie format helpers: OK');

  delete process.env.SAFYR_API_TOKEN;
  console.log('\nAll auth checks passed.');
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exitCode = 1; });
