// Classifier worker — drains news_items rows where classified_at IS NULL and
// writes sector / geography / deal_type / deal_size_usd back into the row.
//
// Runs with a small concurrency cap (default 3) so we don't fan out hundreds
// of simultaneous Anthropic requests when a new worker brings in a backlog.

import { db, closeDb } from '../lib/db';
import { claudeClassifier, CLASSIFIER_MODEL, type Classifier } from '../lib/classifier';
import { DEAL_TYPES } from '../lib/taxonomy';

// deal_type values we promote into the deals table. 'unknown'/'other' stay in
// news_items only — not every classified item is a trackable transaction.
const PROMOTABLE_DEAL_TYPES = DEAL_TYPES.filter((t) => t !== 'unknown' && t !== 'other');

const POLL_INTERVAL_MS = 30 * 1000;        // 30s — we want to catch up quickly
const BATCH_SIZE       = 50;
const CONCURRENCY      = 3;

interface UnclassifiedRow {
  id: string;
  title: string;
  summary: string | null;
  source_kind: string;
}

async function fetchUnclassified(limit: number): Promise<UnclassifiedRow[]> {
  const { rows } = await db().query<UnclassifiedRow>(
    `SELECT n.id, n.title, n.summary, s.kind AS source_kind
       FROM news_items n
       JOIN sources    s ON s.id = n.source_id
      WHERE n.classified_at IS NULL
      ORDER BY n.ingested_at ASC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function classifyAndStore(row: UnclassifiedRow, classify: Classifier): Promise<void> {
  const result = await classify({
    title: row.title,
    summary: row.summary,
    sourceKind: row.source_kind,
  });

  // Classification write + (conditional) promotion run in a single transaction
  // so a crash mid-promotion never leaves a classified news_item without its
  // deal row.
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE news_items
          SET sector           = $2,
              geography        = $3,
              deal_type        = $4,
              deal_size_usd    = $5,
              classified_at    = NOW(),
              classifier_model = $6
        WHERE id = $1`,
      [row.id, result.sector, result.geography, result.deal_type, result.deal_size_usd, CLASSIFIER_MODEL]
    );
    if ((PROMOTABLE_DEAL_TYPES as readonly string[]).includes(result.deal_type)) {
      // Idempotency: if this news_item is already linked to a deal, skip.
      // In practice drainOnce only sees unclassified rows, but an explicit
      // re-classification (model upgrade) would otherwise duplicate.
      const { rows: existing } = await client.query(
        `SELECT 1 FROM deal_news_items WHERE news_item_id = $1 LIMIT 1`,
        [row.id]
      );
      if (existing.length === 0) {
        const { rows: dealRows } = await client.query<{ id: string }>(
          `INSERT INTO deals
             (headline, sector, geography, deal_type, deal_size_usd,
              announced_at, primary_source_id, primary_url)
           SELECT title, $2, $3, $4, $5, published_at, source_id, url
             FROM news_items WHERE id = $1
           RETURNING id`,
          [row.id, result.sector, result.geography, result.deal_type, result.deal_size_usd]
        );
        await client.query(
          `INSERT INTO deal_news_items (deal_id, news_item_id) VALUES ($1, $2)
            ON CONFLICT DO NOTHING`,
          [dealRows[0].id, row.id]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Simple bounded-concurrency runner. No external dep.
async function runBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i]) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export interface DrainResult {
  processed: number;
  failed: number;
}

export async function drainOnce(
  classify: Classifier,
  batchSize: number = BATCH_SIZE,
  concurrency: number = CONCURRENCY
): Promise<DrainResult> {
  const rows = await fetchUnclassified(batchSize);
  if (rows.length === 0) return { processed: 0, failed: 0 };

  const outcomes = await runBounded(rows, concurrency, (row) =>
    classifyAndStore(row, classify)
  );

  const failed = outcomes.filter((o) => !o.ok).length;
  const processed = outcomes.length - failed;
  const firstError = outcomes.find((o) => !o.ok);
  if (firstError && !firstError.ok) {
    console.error('[classifier] sample error:', firstError.error);
  }
  return { processed, failed };
}

async function runLoop() {
  const classify = claudeClassifier();
  console.log(`[classifier] worker starting, interval=${POLL_INTERVAL_MS}ms model=${CLASSIFIER_MODEL}`);
  while (true) {
    const started = Date.now();
    try {
      const r = await drainOnce(classify);
      if (r.processed + r.failed > 0) {
        console.log(`[classifier] drain processed=${r.processed} failed=${r.failed} elapsed=${Date.now() - started}ms`);
      }
    } catch (err) {
      console.error('[classifier] drain failed:', err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main() {
  const once = process.argv.includes('--once');
  if (once) {
    const r = await drainOnce(claudeClassifier());
    console.log(`[classifier] once processed=${r.processed} failed=${r.failed}`);
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
