// Gates the terminal when SAFYR_API_TOKEN is set.
//
// Public paths (always open):
//   /api/health            — used by docker-compose healthchecks
//   /api/auth/login        — the login form posts here
//   /api/auth/logout       — clears the cookie
//   /login                 — the login form HTML
//   _next/* and /favicon.* — Next.js asset paths
//
// Everything else returns 401 (API) or redirects to /login (HTML) when no
// valid Authorization header / session cookie is present.
//
// When SAFYR_API_TOKEN is unset the middleware short-circuits to next() so
// dev/test runs without any auth setup.

import { NextResponse, type NextRequest } from 'next/server';
import { isAuthEnabled, isAuthorized } from './lib/auth';

const PUBLIC_PATHS: ReadonlyArray<string> = [
  '/api/health',
  '/api/auth/login',
  '/api/auth/logout',
  '/login',
];

function isPublic(pathname: string): boolean {
  if (pathname === '/' && false) return false; // root is gated when auth is on
  if (PUBLIC_PATHS.includes(pathname)) return true;
  if (pathname.startsWith('/_next/'))  return true;
  if (pathname.startsWith('/favicon')) return true;
  return false;
}

export function middleware(request: NextRequest) {
  if (!isAuthEnabled()) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  if (isAuthorized(request)) return NextResponse.next();

  // API requests get a 401 with a JSON body so curl / fetch see it cleanly.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'unauthorized' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="safyr"' } }
    );
  }
  // Everything else is HTML — bounce to /login with a return-path.
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.searchParams.set('next', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Apply to everything except static assets (Next.js handles those via the
  // matcher; we still skip them in isPublic for double safety).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
