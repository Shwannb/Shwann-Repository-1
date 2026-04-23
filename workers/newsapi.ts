// NewsAPI worker — polls /v2/everything with a deal-focused query every 10
// minutes. External ID is a SHA-256 of the article URL since NewsAPI does
// not provide a stable per-article identifier.
//
// Compliance: standard NewsAPI commercial terms, no scraping, keyed auth.
// API key via NEWSAPI_KEY env var.

import { createHash } from 'node:crypto';
import { db, closeDb } from '../lib/db';

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const PER_CALL_TIMEOUT_MS = 20_000;
const SOURCE_ID = 'newsapi';
const USER_AGENT = 'Safyr Capital Deal Terminal (compliance@safyr.capital)';

// Broad deal-related query. The classifier is our real filter — we cast a
// wide net here and rely on Claude to tag relevance.
const QUERY = [
  'acquisition', 'merger', 'IPO', 'Series A', 'Series B', 'Series C',
  '"funding round"', '"private equity"', '"venture capital"',
].join(' OR ');

export interface NewsApiArticle {
  title: string;
  description: string | null;
  url: string;
  publishedAt: string;
  source: { name?: string | null };
}
interface NewsApiResponse {
  status: string;
  articles?: NewsApiArticle[];
  code?: string;
  message?: string;
}

export type NewsApiFetcher = (query: string, apiKey: string) => Promise<NewsApiResponse>;

export async function fetchNewsApi(query: string, apiKey: string): Promise<NewsApiResponse> {
  const url = new URL('https://newsapi.org/v2/everything');
  url.searchParams.set('q', query);
  url.searchParams.set('language', 'en');
  url.searchParams.set('sortBy', 'publishedAt');
  url.searchParams.set('pageSize', '100');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      headers: {
        'X-Api-Key': apiKey,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`NewsAPI ${res.status} ${res.statusText}`);
    return (await res.json()) as NewsApiResponse;
  } finally {
    clearTimeout(timer);
  }
}

function stableId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

export interface PollResult {
  fetched: number;
  inserted: number;
  skipped: number;
}

export async function pollOnce(
  fetcher: NewsApiFetcher = fetchNewsApi,
  apiKey: string | undefined = process.env.NEWSAPI_KEY
): Promise<PollResult> {
  if (!apiKey) throw new Error('NEWSAPI_KEY is not set');
  const resp = await fetcher(QUERY, apiKey);
  if (resp.status !== 'ok') {
    throw new Error(`NewsAPI responded status=${resp.status} code=${resp.code ?? ''} msg=${resp.message ?? ''}`);
  }
  const articles = resp.articles ?? [];
  let inserted = 0;
  let skipped  = 0;
  for (const a of articles) {
    if (!a.url || !a.title) { skipped++; continue; }
    const publishedAt = new Date(a.publishedAt);
    if (Number.isNaN(publishedAt.getTime())) { skipped++; continue; }
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
        a.description,
        publishedAt.toISOString(),
        JSON.stringify({ outlet: a.source?.name ?? null }),
      ]
    );
    if (result.rowCount && result.rowCount > 0) inserted++;
    else skipped++;
  }
  await db().query(`UPDATE sources SET last_polled_at = NOW() WHERE id = $1`, [SOURCE_ID]);
  return { fetched: articles.length, inserted, skipped };
}

async function runLoop() {
  console.log(`[newsapi] worker starting, interval=${POLL_INTERVAL_MS}ms`);
  while (true) {
    try {
      const r = await pollOnce();
      console.log(`[newsapi] poll fetched=${r.fetched} inserted=${r.inserted} skipped=${r.skipped}`);
    } catch (err) {
      console.error('[newsapi] poll failed:', err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main() {
  const once = process.argv.includes('--once');
  if (once) {
    const r = await pollOnce();
    console.log(`[newsapi] once fetched=${r.fetched} inserted=${r.inserted} skipped=${r.skipped}`);
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
