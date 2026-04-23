// SEC EDGAR 8-K ingestion worker.
//
// SEC fair-access policy requires:
//   - A descriptive User-Agent that includes a contact email
//   - Traffic rate-limited to <= 10 req/sec
// See: https://www.sec.gov/os/accessing-edgar-data
//
// We poll the current-filings Atom feed (40 entries per page) every 10 minutes
// and upsert into news_items keyed on (source_id='edgar', external_id=accession).
// Classification runs in a separate step — this worker is ingest-only.

import { db, closeDb } from '../lib/db';
import { parseAtom, type AtomEntry } from '../lib/feed';

const EDGAR_URL =
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=40&output=atom';

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const SOURCE_ID = 'edgar';

export interface EdgarFiling {
  accessionNumber: string;
  url: string;
  title: string;
  summary?: string;
  publishedAt: Date;
}

// EDGAR's <id> looks like:
//   urn:tag:sec.gov,2008:accession-number=0001193125-24-123456
// Accession number is our stable dedupe key.
export function extractAccession(id: string): string | null {
  const m = id.match(/accession-number=([0-9-]+)/);
  return m ? m[1] : null;
}

export function toFiling(entry: AtomEntry): EdgarFiling | null {
  const accessionNumber = extractAccession(entry.id);
  if (!accessionNumber) return null;
  const when = entry.updated ?? entry.published;
  const publishedAt = when ? new Date(when) : new Date();
  if (Number.isNaN(publishedAt.getTime())) return null;
  return {
    accessionNumber,
    url: entry.link,
    title: entry.title,
    summary: entry.summary,
    publishedAt,
  };
}

export async function fetchEdgarAtom(signal?: AbortSignal): Promise<string> {
  const ua = process.env.EDGAR_USER_AGENT;
  if (!ua) {
    throw new Error(
      'EDGAR_USER_AGENT must be set (SEC requires a contact email in the User-Agent)'
    );
  }
  const res = await fetch(EDGAR_URL, {
    headers: {
      'User-Agent': ua,
      Accept: 'application/atom+xml, application/xml;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
      Host: 'www.sec.gov',
    },
    signal,
  });
  if (!res.ok) {
    throw new Error(`EDGAR responded ${res.status} ${res.statusText}`);
  }
  return res.text();
}

export interface PollResult {
  fetched: number;
  inserted: number;
  skipped: number;
}

export type AtomFetcher = () => Promise<string>;

// fetcher is injectable so tests can drive the pipeline without outbound HTTPS.
export async function pollOnce(fetcher: AtomFetcher = fetchEdgarAtom): Promise<PollResult> {
  const xml = await fetcher();
  const entries = parseAtom(xml);
  const filings = entries
    .map(toFiling)
    .filter((f): f is EdgarFiling => f !== null);

  const pool = db();
  let inserted = 0;
  let skipped = 0;
  for (const f of filings) {
    const result = await pool.query(
      `INSERT INTO news_items
         (source_id, external_id, url, title, summary, published_at, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (source_id, external_id) DO NOTHING`,
      [
        SOURCE_ID,
        f.accessionNumber,
        f.url,
        f.title,
        f.summary ?? null,
        f.publishedAt.toISOString(),
        JSON.stringify({ accessionNumber: f.accessionNumber }),
      ]
    );
    if (result.rowCount && result.rowCount > 0) inserted++;
    else skipped++;
  }
  await pool.query(
    'UPDATE sources SET last_polled_at = NOW() WHERE id = $1',
    [SOURCE_ID]
  );
  return { fetched: filings.length, inserted, skipped };
}

async function runLoop() {
  console.log(`[edgar] worker starting, interval=${POLL_INTERVAL_MS}ms`);
  // Run first poll immediately, then on an interval.
  while (true) {
    const started = Date.now();
    try {
      const r = await pollOnce();
      console.log(
        `[edgar] poll fetched=${r.fetched} inserted=${r.inserted} skipped=${r.skipped} elapsed=${Date.now() - started}ms`
      );
    } catch (err) {
      console.error('[edgar] poll failed:', err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main() {
  const once = process.argv.includes('--once');
  if (once) {
    const r = await pollOnce();
    console.log(`[edgar] once fetched=${r.fetched} inserted=${r.inserted} skipped=${r.skipped}`);
    await closeDb();
    return;
  }
  await runLoop();
}

// Only run when invoked directly (not when imported by tests).
const isDirectRun =
  typeof require !== 'undefined' && require.main === module ||
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
