'use client';

// Minimal token-entry form. Bloomberg-monochrome to match the rest of the
// terminal. On success the API sets a session cookie and we redirect to
// the original destination (?next=...) or the home page.

import { useState, type FormEvent } from 'react';

export default function LoginPage() {
  const [token, setToken] = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const url = new URL(window.location.href);
      const next = url.searchParams.get('next') ?? '/';
      // Use a same-origin replace so back-button doesn't return to /login.
      window.location.replace(next.startsWith('/') ? next : '/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center text-[12px]">
      <form
        onSubmit={onSubmit}
        className="bg-surface border border-grid-strong p-5 min-w-[340px]"
        data-testid="login-form"
      >
        <div className="flex items-baseline gap-2 mb-4">
          <span className="text-amber font-bold tracking-wider">SAFYR</span>
          <span className="text-fg-dim">DEAL TERMINAL · LOGIN</span>
        </div>
        <label className="block text-fg-mute mb-1">API TOKEN</label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
          autoComplete="current-password"
          className="w-full border border-grid bg-bg px-2 py-1 text-fg focus:outline-none focus:border-amber"
        />
        {error && <div className="mt-3 text-neg">{error}</div>}
        <div className="flex justify-end mt-4">
          <button
            type="submit"
            disabled={busy || token.length === 0}
            className="px-3 py-1 border border-grid text-fg-dim hover:text-amber hover:border-amber disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {busy ? 'SUBMIT…' : 'SIGN IN'}
          </button>
        </div>
        <p className="text-fg-mute mt-4 text-[10px]">
          Public data only — see COMPLIANCE.md. Contact data is gated behind
          Phase 2 and requires a separate licensed-provider login.
        </p>
      </form>
    </main>
  );
}
