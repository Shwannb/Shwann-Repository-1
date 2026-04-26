// Retention worker — daily cleanup of stale news_items.
//
// Without this, news_items grows unbounded as ingestion runs. A 10-source
// terminal can easily ingest tens of thousands of items per day; over months
// this kills the unindexed sector/geography filters.
//
// Policy: delete news_items that are
//   (a) older than RETENTION_DAYS (default 90), AND
//   (b) not linked to a deal via deal_news_items.
//
// Linked items are preserved indefinitely so the deal detail drawer can keep
// showing source articles for as long as the deal itself is around.
//
// Run cadence: every 24 hours. Single-pod is fine for Phase 1.

import { db, closeDb } from '../lib/db';

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 90);
const BATCH_SIZE = 1000;

export interface RetentionResult {
  deleted: number;
  kept_linked: number;
  kept_recent: number;
}

// Returns counts so the worker log can show what changed without a follow-up
// query. The "kept" numbers are bounded inspection counts, not full table
// totals — querying COUNT(*) on the whole table after a large run is wasteful.
export async function runRetention(retentionDays: number = RETENTION_DAYS): Promise<RetentionResult> {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    throw new Error(`RETENTION_DAYS must be >= 1, got ${retentionDays}`);
  }

  // Delete in bounded batches to keep individual transactions short. Postgres
  // takes row locks on the deletes; bounded batches let other workers (the
  // classifier, the ingestion workers) keep making progress between batches.
  let deleted = 0;
  while (true) {
    const { rowCount } = await db().query(
      `DELETE FROM news_items
        WHERE id IN (
          SELECT n.id
            FROM news_items n
           WHERE n.ingested_at < NOW() - ($1 || ' days')::interval
             AND NOT EXISTS (
               SELECT 1 FROM deal_news_items d WHERE d.news_item_id = n.id
             )
           LIMIT $2
        )`,
      [String(retentionDays), BATCH_SIZE]
    );
    const n = rowCount ?? 0;
    deleted += n;
    if (n < BATCH_SIZE) break;
  }

  // Sanity counts so the log line is self-explanatory. These bound at 10000
  // each — anything beyond that is "lots, doesn't matter for a log message."
  const { rows: [linkedRow] } = await db().query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM (
       SELECT 1 FROM news_items n
       WHERE EXISTS (SELECT 1 FROM deal_news_items d WHERE d.news_item_id = n.id)
       LIMIT 10000
     ) s`
  );
  const { rows: [recentRow] } = await db().query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM (
       SELECT 1 FROM news_items n
       WHERE n.ingested_at >= NOW() - ($1 || ' days')::interval
       LIMIT 10000
     ) s`,
    [String(retentionDays)]
  );
  return {
    deleted,
    kept_linked: Number(linkedRow.c),
    kept_recent: Number(recentRow.c),
  };
}

async function runLoop() {
  console.log(`[retention] worker starting, interval=${POLL_INTERVAL_MS}ms days=${RETENTION_DAYS}`);
  while (true) {
    const started = Date.now();
    try {
      const r = await runRetention();
      console.log(
        `[retention] sweep deleted=${r.deleted} kept_linked=${r.kept_linked} ` +
        `kept_recent=${r.kept_recent} elapsed=${Date.now() - started}ms`
      );
    } catch (err) {
      console.error('[retention] sweep failed:', err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main() {
  const once = process.argv.includes('--once');
  if (once) {
    const r = await runRetention();
    console.log(`[retention] once deleted=${r.deleted} kept_linked=${r.kept_linked} kept_recent=${r.kept_recent}`);
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
