# Safyr Deal Terminal — Phase 1

Live deal-sourcing terminal for Safyr Capital Partners Ltd (Mauritius-based
impact investment bank). Phase 1 is a dark, Bloomberg-style terminal that
ingests public filings and news from five source kinds, classifies each item
with Claude Opus 4.7, and pushes new deals to the browser in real time.

See [`COMPLIANCE.md`](./COMPLIANCE.md) for data-scope and PII rules. Contact
data (emails, direct-dials, LinkedIn) is **not** ingested by Phase 1 and must
only be sourced via a licensed provider in Phase 2.

---

## Architecture

```
     ┌─ EDGAR ──────┐
     ├─ RSS × 10 ───┤       ┌────────────────┐
     ├─ Companies   │──────▶│   news_items   │
     │  House       │       └────────┬───────┘
     ├─ NewsAPI ────┤                │
     └─ GDELT ──────┘        (classifier worker:
                              Opus 4.7 + adaptive
                              thinking, structured
                              output, prompt cache)
                                      │
                                      ▼
                              ┌───────────────┐
                              │     deals     │◀── pg_notify('deals_new')
                              └───────┬───────┘        │
                                      │                ▼
                                      ▼           ┌──────┐
                                /api/deals   ◀────│  ws  │──▶ browser
                                /api/news                       (terminal UI)
```

Five ingestion workers poll on a 10-minute cadence; the classifier promotes
concrete-`deal_type` news_items into the `deals` table in the same
transaction as classification; a Postgres trigger fires `NOTIFY deals_new`
which the WS server relays to connected browser clients.

---

## Stack

- **Next.js 15** (app router) + **TypeScript** + **React 19**
- **Tailwind v4** with a Bloomberg-style dark theme (hand-rolled, shadcn-compatible class structure)
- **Postgres 16** (Supabase-compatible connection string)
- **Anthropic SDK** — `claude-opus-4-7` with adaptive thinking and structured outputs
- **`ws`** package + Postgres LISTEN/NOTIFY for live push
- **Upstash Redis** reserved for multi-instance deployments (Phase 1.5)

---

## Quick start (Docker)

```bash
cp .env.example .env
# Edit .env and set at least ANTHROPIC_API_KEY (classifier requires it).
# Optional: CH_API_KEY, NEWSAPI_KEY. The gdelt and 10 RSS sources need no key.

docker compose up --build
```

Open **http://localhost:3000** once the web container logs `Ready on 0.0.0.0:3000`.

Services in the compose file:

| Service     | Role                                               | Port |
|-------------|----------------------------------------------------|------|
| `postgres`  | Postgres 16 with a named volume                    | 5432 |
| `migrate`   | Applies `db/migrations/*.sql` forward, then exits  | —    |
| `web`       | Next.js frontend + `/api/deals` + `/api/news`      | 3000 |
| `ws`        | WebSocket push server (`/ws/deals`)                | 3030 |
| `classifier`| Claude-backed classification + deal promotion      | —    |
| `edgar`     | SEC 8-K polling                                    | —    |
| `rss`       | 10 public RSS/Atom feeds                           | —    |
| `ch`        | Companies House UK (idle until `CH_API_KEY` set)   | —    |
| `newsapi`   | NewsAPI (idle until `NEWSAPI_KEY` set)             | —    |
| `gdelt`     | GDELT DOC API (no key required)                    | —    |

---

## Local development (no Docker)

```bash
npm install
cp .env.example .env   # set DATABASE_URL, ANTHROPIC_API_KEY, EDGAR_USER_AGENT

npm run db:migrate
npm run dev                  # Next.js on :3000
npm run worker:ws            # live push on :3030
npm run worker:classifier    # needs ANTHROPIC_API_KEY
npm run worker:edgar         # 10-min poll loop
npm run worker:rss           # 10-min poll loop across 10 feeds
npm run worker:gdelt         # 10-min poll loop

# Optional (require API keys)
npm run worker:ch
npm run worker:newsapi
```

Each worker also has a `--once` variant for ad-hoc runs:

```bash
npm run worker:edgar:once
npm run worker:rss:once
npm run worker:classifier:once
```

### Adding UK companies to the Companies House watchlist

```sql
INSERT INTO ch_watchlist (company_number, display_name) VALUES
  ('00445790', 'Tesco PLC'),
  ('00914577', 'BP p.l.c.');
```

### Disabling an RSS feed

```sql
UPDATE sources SET enabled = FALSE WHERE id = 'rss:dealstreetasia';
```

---

## API

Both endpoints accept the same filter set so the terminal's **News** tab
auto-filters to the same sector as the **Deals** filter.

`GET /api/deals` — returns `{ deals: Deal[], total, limit, offset }`
`GET /api/news`  — returns `{ news:  NewsItem[], total, limit, offset }`

Query parameters (all optional):

| Param       | Type                         | Notes                          |
|-------------|------------------------------|--------------------------------|
| `sector`    | enum (see `lib/taxonomy.ts`) | e.g. `fintech`, `healthcare`   |
| `geography` | enum                         | e.g. `sub_saharan_africa`      |
| `deal_type` | enum                         | e.g. `m_and_a`, `vc_round`     |
| `min_size`  | number (USD)                 | inclusive                      |
| `max_size`  | number (USD)                 | inclusive                      |
| `from`      | ISO 8601 date                | inclusive                      |
| `to`        | ISO 8601 date                | inclusive                      |
| `limit`     | 1..200                       | default 50                     |
| `offset`    | ≥ 0                          | default 0                      |

Invalid filters return `400` with `{ error: "<field>: <reason>" }`.

`GET ws://host:3030/ws/deals` — open a WebSocket to receive
`{ type: 'new_deal', deal: {...} }` frames on every `INSERT deals`.

---

## Testing

Eight test suites; each exercises a full vertical slice with injected
dependencies so they run offline. Live probes hit the real endpoints when
available and skip cleanly when egress is blocked.

```bash
npm run test:edgar       # SEC EDGAR parser, upsert, dedupe, cursor
npm run test:classifier  # taxonomy, drain pipeline, invalid-output guard
npm run test:api         # promotion, filter parser, both routes
npm run test:rss         # Atom/RSS auto-detect, pollAll, error isolation
npm run test:ch          # watchlist, per-company polling, dedupe
npm run test:newsapi     # upsert, dedupe, error surfacing
npm run test:gdelt       # seendate parse, upsert, dedupe
npm run test:ws          # real end-to-end LISTEN/NOTIFY → WebSocket → client
npm run test:all         # all of the above in order
```

---

## Phase 1 / Phase 2 scope

**In Phase 1**: public filings and published news only. No contact data, no
PII, no scraping. See [COMPLIANCE.md](./COMPLIANCE.md).

**Phase 2**: contact enrichment via Apollo.io (licensed provider, under their
data-use terms). The `APOLLO_API_KEY` placeholder in `.env.example` is not
wired into any Phase 1 code.

---

## Layout

```
app/                Next.js app router — layout, page, terminal, /api/*
db/migrations/      Forward-only SQL migrations applied by scripts/migrate.ts
lib/                db pool, feed parser, classifier, repository, filters, taxonomy
workers/            One file per long-running process
scripts/            Migration runner + test drivers
```
