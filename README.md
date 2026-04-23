# Safyr Deal Terminal

Live deal-sourcing terminal for Safyr Capital Partners Ltd.

**Stack:** Next.js 15 + TypeScript, Postgres (Supabase), Upstash Redis, Tailwind,
shadcn/ui. Dark Bloomberg-style aesthetic.

**Phase 1 status:** database schema + SEC EDGAR 8-K ingestion worker.
Further sources (Companies House, NewsAPI, GDELT, 10 RSS feeds), classification,
API routes, frontend, and WebSocket push are queued as follow-on increments.

See [`COMPLIANCE.md`](./COMPLIANCE.md) for data-scope and PII rules.

## Running locally

```bash
cp .env.example .env
# edit DATABASE_URL, EDGAR_USER_AGENT, ANTHROPIC_API_KEY

npm install
npm run db:migrate
npm run worker:edgar:once   # single poll
npm run worker:edgar        # 10-minute loop
```

## Testing

```bash
npm run test:edgar
```

The test drives the full parser → upsert → dedupe → cursor-update pipeline with
a fixture, then attempts a live EDGAR probe (skipped with a clear message when
outbound HTTPS is unavailable).
