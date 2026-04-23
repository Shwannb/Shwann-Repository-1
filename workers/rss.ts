// Generic RSS/Atom worker. Polls every enabled row in sources where
// kind = 'rss' on a 10-minute cadence and upserts into news_items keyed on
// (source_id, external_id).
//
// Each source is fetched and persisted independently so a single flaky feed
// can't block the rest of the bundle. We record last_polled_at per source
// regardless of outcome and last_cursor = external_id of the newest item seen
// (useful for debugging lag).

import { db, closeDb } from '../lib/db';
import { parseFeed, type FeedItem } from '../lib/feed';

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const PER_FEED_TIMEOUT_MS = 15_000;
const USER_AGENT = 'Safyr Capital Deal Terminal (compliance@safyr.capital)';

interface RssSource {
  id: string;
  url: string;
  display_name: string;
}

export type FeedFetcher = (url: string) => Promise<string>;

export async function fetchRss(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_FEED_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`${url} responded ${res.status} ${res.statusText}`);
    return res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function enabledRssSources(): Promise<RssSource[]> {
  const { rows } = await db().query<RssSource>(
    `SELECT id, url, display_name
       FROM sources
      WHERE kind = 'rss' AND enabled = TRUE AND url IS NOT NULL
      ORDER BY id`
  );
  return rows;
}

async function upsertItems(sourceId: string, items: FeedItem[]): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const item of items) {
    const result = await db().query(
      `INSERT INTO news_items
         (source_id, external_id, url, title, summary, published_at, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (source_id, external_id) DO NOTHING`,
      [
        sourceId,
        item.externalId,
        item.link,
        item.title,
        item.summary ?? null,
        item.publishedAt.toISOString(),
        JSON.stringify({}),
      ]
    );
    if (result.rowCount && result.rowCount > 0) inserted++;
    else skipped++;
  }
  return { inserted, skipped };
}

export interface SourceResult {
  source_id: string;
  fetched: number;
  inserted: number;
  skipped: number;
  error?: string;
}

export async function pollSource(source: RssSource, fetcher: FeedFetcher): Promise<SourceResult> {
  try {
    const xml = await fetcher(source.url);
    const items = parseFeed(xml);
    const { inserted, skipped } = await upsertItems(source.id, items);
    const newestId = items[0]?.externalId ?? null;
    await db().query(
      `UPDATE sources SET last_polled_at = NOW(), last_cursor = $2 WHERE id = $1`,
      [source.id, newestId]
    );
    return { source_id: source.id, fetched: items.length, inserted, skipped };
  } catch (error) {
    await db().query(`UPDATE sources SET last_polled_at = NOW() WHERE id = $1`, [source.id]);
    return {
      source_id: source.id,
      fetched: 0,
      inserted: 0,
      skipped: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface PollResult {
  sources: number;
  results: SourceResult[];
  totals: { fetched: number; inserted: number; skipped: number; errored: number };
}

export async function pollAll(fetcher: FeedFetcher = fetchRss): Promise<PollResult> {
  const sources = await enabledRssSources();
  const results: SourceResult[] = [];
  for (const src of sources) {
    results.push(await pollSource(src, fetcher));
  }
  const totals = results.reduce(
    (acc, r) => ({
      fetched:  acc.fetched  + r.fetched,
      inserted: acc.inserted + r.inserted,
      skipped:  acc.skipped  + r.skipped,
      errored:  acc.errored  + (r.error ? 1 : 0),
    }),
    { fetched: 0, inserted: 0, skipped: 0, errored: 0 }
  );
  return { sources: sources.length, results, totals };
}

async function runLoop() {
  console.log(`[rss] worker starting, interval=${POLL_INTERVAL_MS}ms`);
  while (true) {
    const started = Date.now();
    try {
      const r = await pollAll();
      console.log(
        `[rss] poll sources=${r.sources} fetched=${r.totals.fetched} inserted=${r.totals.inserted} ` +
        `skipped=${r.totals.skipped} errored=${r.totals.errored} elapsed=${Date.now() - started}ms`
      );
      for (const res of r.results) {
        if (res.error) {
          console.warn(`[rss] ${res.source_id}: ${res.error}`);
        }
      }
    } catch (err) {
      console.error('[rss] poll failed:', err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main() {
  const once = process.argv.includes('--once');
  if (once) {
    const r = await pollAll();
    console.log(
      `[rss] once sources=${r.sources} fetched=${r.totals.fetched} ` +
      `inserted=${r.totals.inserted} skipped=${r.totals.skipped} errored=${r.totals.errored}`
    );
    for (const res of r.results) {
      console.log(`  ${res.source_id}: fetched=${res.fetched} inserted=${res.inserted}` +
                  (res.error ? ` error=${res.error}` : ''));
    }
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
