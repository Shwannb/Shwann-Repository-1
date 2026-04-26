// Authentication for the Safyr terminal.
//
// Single-token model: a deployment shares one SAFYR_API_TOKEN across the team.
// API clients send `Authorization: Bearer <token>`; browser clients exchange
// the token at /login for a same-origin httpOnly cookie. Sufficient for an
// internal tool behind a corporate VPN; multi-user / SSO is Phase 1.5+.
//
// When SAFYR_API_TOKEN is unset the system is "open" — middleware short-
// circuits to allow all traffic. This keeps `npm run dev` and the test
// suite usable without standing up auth infrastructure.

const COOKIE_NAME = 'safyr_session';
// Sessions last 12 hours by default. The cookie itself is httpOnly + sameSite
// strict; a stolen token is the only credential exposure path, so we lean on
// rotation rather than short TTL.
const SESSION_TTL_SECONDS = 12 * 60 * 60;

export function getExpectedToken(): string | null {
  const tok = process.env.SAFYR_API_TOKEN;
  return tok && tok.length > 0 ? tok : null;
}

export function isAuthEnabled(): boolean {
  return getExpectedToken() !== null;
}

// Constant-time compare so an attacker can't time the prefix match.
export function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Pull the candidate token from either an Authorization: Bearer header or
// from the safyr_session cookie. Returns null if neither is present.
export function extractToken(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      if (k === COOKIE_NAME) return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function isAuthorized(request: Request): boolean {
  const expected = getExpectedToken();
  if (expected === null) return true; // open mode
  const got = extractToken(request);
  return got !== null && tokensEqual(expected, got);
}

// Returned to the browser by /api/auth/login. Properties chosen to be safe
// defaults: httpOnly (no JS read), sameSite=strict (no cross-site request),
// secure when serving over https.
export function buildSessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearCookie(secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=`,
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
