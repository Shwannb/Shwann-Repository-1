// GDELT worker — polls the DOC API for articles tagged with M&A themes and
// matching a broad deal query. No API key required. Provides strong global
// coverage especially for non-English / emerging-market deal news.
//
// See https://api.gdeltproject.org/api/v2/doc/doc for the query DSL. We use
// theme:ECON_M_ACQUIRER combined with a keyword filter to capture the deals
// the theme index misses.

import { createHash } from 'node:crypto';
import { db, closeDb } from '../lib/db';

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const PER_CALL_TIMEOUT_MS = 20_000;
const SOURCE_ID = 'gdelt';
const USER_AGENT = 'Safyr Capital Deal Terminal (compliance@safyr.capital)';

const QUERY =
  '(theme:ECON_M_AND_A OR theme:ECON_M_ACQUIRER OR ' +
  'acquisition OR merger OR IPO OR "private equity" OR "venture round") ' +
  'sourcelang:eng';

export interface GdeltArticle {
  url: string;
  title: string;
  seendate: string; // "YYYYMMDDThhmmssZ"
  domain?: string;
  language?: string;
  sourcecountry?: string;
}
interface GdeltResponse { articles?: GdeltArticle[] }

export type GdeltFetcher = (query: string) => Promise<GdeltResponse>;

export async function fetchGdelt(query: string): Promise<GdeltResponse> {
  const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  url.searchParams.set('query', query);
  url.searchParams.set('mode', 'ArtList');
  url.searchParams.set('format', 'json');
  url.searchParams.set('maxrecords', '250');
  url.searchParams.set('timespan', '15min');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`GDELT ${res.status} ${res.statusText}`);
    return (await res.json()) as GdeltResponse;
  } finally {
    clearTimeout(timer);
  }
}

// GDELT's seendate is a compact form like "20260422T140500Z".
export function parseSeendate(raw: string): Date | null {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function stableId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

export interface PollResult {
  fetched: number;
  inserted: number;
  skipped: number;
}

export async function pollOnce(fetcher: GdeltFetcher = fetchGdelt): Promise<PollResult> {
  const resp = await fetcher(QUERY);
  const articles = resp.articles ?? [];
  let inserted = 0;
  let skipped  = 0;
  for (const a of articles) {
    if (!a.url || !a.title) { skipped++; continue; }
    const publishedAt = parseSeendate(a.seendate);
    if (!publishedAt) { skipped++; continue; }
    const result = await db().query(
      `INSERT INTO news_items
         (source_id, external_id, url, title, summary, published_at, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (source_id, external_id) DO NOTHING`,
      [
        SOURCE_ID,
        stableId(a.url),
        a.url,
        a.title,
        null, // GDELT doesn't return summaries
        publishedAt.toISOString(),
        JSON.stringify({ domain: a.domain ?? null, language: a.language ?? null, country: a.sourcecountry ?? null }),
      ]
    );
    if (result.rowCount && result.rowCount > 0) inserted++;
    else skipped++;
  }
  await db().query(
    `UPDATE sources
        SET last_polled_at = NOW(),
            last_error     = NULL,
            last_error_at  = NULL
      WHERE id = $1`,
    [SOURCE_ID]
  );
  return { fetched: articles.length, inserted, skipped };
}

export async function recordGdeltError(message: string): Promise<void> {
  await db().query(
    `UPDATE sources
        SET last_polled_at = NOW(),
            last_error     = $2,
            last_error_at  = NOW()
      WHERE id = $1`,
    [SOURCE_ID, message.slice(0, 500)]
  );
}

async function runLoop() {
  console.log(`[gdelt] worker starting, interval=${POLL_INTERVAL_MS}ms`);
  while (true) {
    try {
      const r = await pollOnce();
      console.log(`[gdelt] poll fetched=${r.fetched} inserted=${r.inserted} skipped=${r.skipped}`);
    } catch (err) {
      console.error('[gdelt] poll failed:', err);
      const message = err instanceof Error ? err.message : String(err);
      await recordGdeltError(message).catch(() => void 0);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main() {
  const once = process.argv.includes('--once');
  if (once) {
    const r = await pollOnce();
    console.log(`[gdelt] once fetched=${r.fetched} inserted=${r.inserted} skipped=${r.skipped}`);
    await closeDb();
    return;
  }
  await runLoop();
}

const isDirectRun =
  typeof require !== 'undefined' && require.main === module ||
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
