// Companies House UK worker.
//
// Polls filing-history for each enabled row in ch_watchlist, upserts new
// filings into news_items with source_id='companies_house'. transaction_id is
// the stable external_id. Compliance: public filings API only, keyed auth via
// CH_API_KEY env var, no scraping, no brute-force over the register.
//
// CH fair-usage: ~600 requests per 5-minute window per key. Even with a
// watchlist of 50 companies polling every 10 minutes we stay two orders of
// magnitude below the ceiling.

import { db, closeDb } from '../lib/db';

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const PER_CALL_TIMEOUT_MS = 15_000;
const SOURCE_ID = 'companies_house';
const API_BASE = 'https://api.company-information.service.gov.uk';
const USER_AGENT = 'Safyr Capital Deal Terminal (compliance@safyr.capital)';

interface Watched {
  company_number: string;
  display_name: string;
}

export interface CHFiling {
  transaction_id: string;
  description: string;
  date: string;      // YYYY-MM-DD
  type: string;
  category?: string;
  links?: { self?: string };
}

interface CHResponse {
  items?: CHFiling[];
  total_count?: number;
}

export type CHFetcher = (companyNumber: string, apiKey: string) => Promise<CHResponse>;

// Basic auth: username = API key, empty password. base64("key:") is the norm.
export async function fetchFilingHistory(companyNumber: string, apiKey: string): Promise<CHResponse> {
  const url = `${API_BASE}/company/${encodeURIComponent(companyNumber)}/filing-history?items_per_page=25`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const basic = Buffer.from(`${apiKey}:`).toString('base64');
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${basic}`,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`CH ${companyNumber} responded ${res.status} ${res.statusText}`);
    return (await res.json()) as CHResponse;
  } finally {
    clearTimeout(timer);
  }
}

function filingTitle(displayName: string, filing: CHFiling): string {
  const desc = filing.description.replace(/-/g, ' ').replace(/_/g, ' ');
  return `[${displayName}] ${desc} (${filing.type})`;
}

function filingUrl(companyNumber: string, filing: CHFiling): string {
  return `https://find-and-update.company-information.service.gov.uk/company/${companyNumber}/filing-history/${filing.transaction_id}`;
}

async function enabledWatchlist(): Promise<Watched[]> {
  const { rows } = await db().query<Watched>(
    `SELECT company_number, display_name FROM ch_watchlist WHERE enabled = TRUE ORDER BY company_number`
  );
  return rows;
}

export interface CompanyResult {
  company_number: string;
  fetched: number;
  inserted: number;
  skipped: number;
  error?: string;
}

export async function pollCompany(
  watched: Watched,
  fetcher: CHFetcher,
  apiKey: string
): Promise<CompanyResult> {
  try {
    const resp = await fetcher(watched.company_number, apiKey);
    const filings = resp.items ?? [];
    let inserted = 0;
    let skipped = 0;
    for (const f of filings) {
      const publishedAt = new Date(`${f.date}T00:00:00Z`);
      if (Number.isNaN(publishedAt.getTime())) { skipped++; continue; }
      const result = await db().query(
        `INSERT INTO news_items
           (source_id, external_id, url, title, summary, published_at, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (source_id, external_id) DO NOTHING`,
        [
          SOURCE_ID,
          f.transaction_id,
          filingUrl(watched.company_number, f),
          filingTitle(watched.display_name, f),
          f.description,
          publishedAt.toISOString(),
          JSON.stringify({ company_number: watched.company_number, type: f.type, category: f.category }),
        ]
      );
      if (result.rowCount && result.rowCount > 0) inserted++;
      else skipped++;
    }
    const newestId = filings[0]?.transaction_id ?? null;
    await db().query(
      `UPDATE ch_watchlist SET last_polled_at = NOW(), last_cursor = $2 WHERE company_number = $1`,
      [watched.company_number, newestId]
    );
    return { company_number: watched.company_number, fetched: filings.length, inserted, skipped };
  } catch (error) {
    await db().query(
      `UPDATE ch_watchlist SET last_polled_at = NOW() WHERE company_number = $1`,
      [watched.company_number]
    );
    return {
      company_number: watched.company_number,
      fetched: 0, inserted: 0, skipped: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface PollResult {
  companies: number;
  results: CompanyResult[];
  totals: { fetched: number; inserted: number; skipped: number; errored: number };
}

export async function pollAll(
  fetcher: CHFetcher = fetchFilingHistory,
  apiKey: string | undefined = process.env.CH_API_KEY
): Promise<PollResult> {
  if (!apiKey) {
    throw new Error('CH_API_KEY is not set');
  }
  const watched = await enabledWatchlist();
  const results: CompanyResult[] = [];
  for (const w of watched) {
    results.push(await pollCompany(w, fetcher, apiKey));
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
  await db().query(`UPDATE sources SET last_polled_at = NOW() WHERE id = $1`, [SOURCE_ID]);
  return { companies: watched.length, results, totals };
}

async function runLoop() {
  console.log(`[ch] worker starting, interval=${POLL_INTERVAL_MS}ms`);
  while (true) {
    const started = Date.now();
    try {
      const r = await pollAll();
      console.log(
        `[ch] poll companies=${r.companies} fetched=${r.totals.fetched} ` +
        `inserted=${r.totals.inserted} skipped=${r.totals.skipped} errored=${r.totals.errored} ` +
        `elapsed=${Date.now() - started}ms`
      );
    } catch (err) {
      console.error('[ch] poll failed:', err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main() {
  const once = process.argv.includes('--once');
  if (once) {
    const r = await pollAll();
    console.log(
      `[ch] once companies=${r.companies} fetched=${r.totals.fetched} ` +
      `inserted=${r.totals.inserted} skipped=${r.totals.skipped} errored=${r.totals.errored}`
    );
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
