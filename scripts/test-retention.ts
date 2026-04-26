// Retention worker test (offline-deterministic).
//
// Seeds three known states and asserts the policy:
//   1. Orphan + old → DELETED
//   2. Orphan + recent → KEPT
//   3. Old + linked to a deal → KEPT (deal_news_items preserves it)

import { db, closeDb } from '../lib/db';
import { runRetention } from '../workers/retention';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function cleanup() {
  await db().query(
    `DELETE FROM deal_news_items WHERE news_item_id IN (
      SELECT id FROM news_items WHERE external_id LIKE 'ret-test-%'
    )`
  );
  await db().query(`DELETE FROM deals WHERE primary_url LIKE 'https://example.test/ret-%'`);
  await db().query(`DELETE FROM news_items WHERE external_id LIKE 'ret-test-%'`);
}

async function seed() {
  await cleanup();

  // Orphan + old (200 days back, ingested 200 days back) — should be deleted.
  await db().query(
    `INSERT INTO news_items (source_id, external_id, url, title, summary, published_at, ingested_at)
     VALUES ('edgar', 'ret-test-orphan-old',  'https://example.test/ret-orphan-old',
             'Old orphan', null,
             NOW() - INTERVAL '200 days', NOW() - INTERVAL '200 days')`
  );

  // Orphan + recent (1 day back) — should be kept.
  await db().query(
    `INSERT INTO news_items (source_id, external_id, url, title, summary, published_at, ingested_at)
     VALUES ('edgar', 'ret-test-orphan-recent', 'https://example.test/ret-orphan-recent',
             'Recent orphan', null,
             NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')`
  );

  // Old + linked — should be kept because deal_news_items references it.
  const { rows: [niRow] } = await db().query<{ id: string }>(
    `INSERT INTO news_items (source_id, external_id, url, title, summary, published_at, ingested_at)
     VALUES ('edgar', 'ret-test-linked-old', 'https://example.test/ret-linked-old',
             'Old but linked', null,
             NOW() - INTERVAL '300 days', NOW() - INTERVAL '300 days')
     RETURNING id`
  );
  const { rows: [dealRow] } = await db().query<{ id: string }>(
    `INSERT INTO deals (headline, sector, geography, deal_type, deal_size_usd,
                        announced_at, primary_source_id, primary_url)
     VALUES ('[ret-test] historic deal', 'energy', 'global', 'm_and_a', 100000000,
             NOW() - INTERVAL '300 days', 'edgar', 'https://example.test/ret-linked-old')
     RETURNING id`
  );
  await db().query(
    `INSERT INTO deal_news_items (deal_id, news_item_id) VALUES ($1, $2)`,
    [dealRow.id, niRow.id]
  );
}

async function main() {
  await seed();
  try {
    // Use a 90-day cutoff: orphan-old (200d) deletes; orphan-recent (1d) stays;
    // linked-old (300d) stays via deal_news_items.
    const r = await runRetention(90);
    console.log(`[1/3] runRetention: deleted=${r.deleted} kept_linked=${r.kept_linked} kept_recent=${r.kept_recent}`);
    assert(r.deleted >= 1, `expected at least one delete, got ${r.deleted}`);

    const { rows } = await db().query<{ external_id: string }>(
      `SELECT external_id FROM news_items WHERE external_id LIKE 'ret-test-%' ORDER BY external_id`
    );
    const ids = rows.map((r) => r.external_id);
    assert(!ids.includes('ret-test-orphan-old'), 'orphan-old should have been deleted');
    assert(ids.includes('ret-test-orphan-recent'), 'orphan-recent should be kept');
    assert(ids.includes('ret-test-linked-old'),    'linked-old should be kept');
    console.log('[2/3] policy: orphan+old deleted, orphan+recent kept, old+linked kept: OK');

    // Validation: bad RETENTION_DAYS throws cleanly.
    let threw = false;
    try { await runRetention(0); }
    catch (err) { threw = (err as Error).message.includes('RETENTION_DAYS'); }
    assert(threw, 'retentionDays=0 should throw');
    console.log('[3/3] validation: invalid retentionDays surfaces as error: OK');
  } finally {
    await cleanup();
  }
  console.log('\nAll retention checks passed.');
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exitCode = 1; }).finally(() => closeDb());
