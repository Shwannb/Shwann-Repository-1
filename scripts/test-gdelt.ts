// GDELT worker test — fixture-driven.

import { db, closeDb } from '../lib/db';
import { pollOnce, parseSeendate, type GdeltFetcher } from '../workers/gdelt';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const fetcher: GdeltFetcher = async () => ({
  articles: [
    { url: 'https://example.test/gdelt/1', title: 'Acquisition announced', seendate: '20260422T140500Z',
      domain: 'example.test', language: 'English', sourcecountry: 'United States' },
    { url: 'https://example.test/gdelt/2', title: 'Series B round closes',  seendate: '20260422T120000Z',
      domain: 'example.test', language: 'English', sourcecountry: 'Nigeria' },
    // Malformed seendate — should be skipped without blowing up the batch.
    { url: 'https://example.test/gdelt/3', title: 'Bad date',               seendate: 'not-a-date' },
  ],
});

async function cleanup() {
  await db().query(`DELETE FROM news_items WHERE source_id='gdelt' AND url LIKE 'https://example.test/gdelt/%'`);
}

async function main() {
  await cleanup();
  try {
    assert(parseSeendate('20260422T140500Z')?.toISOString() === '2026-04-22T14:05:00.000Z', 'seendate parse');
    assert(parseSeendate('bogus') === null, 'bad seendate should return null');
    console.log('[1/3] parseSeendate: OK');

    const r1 = await pollOnce(fetcher);
    console.log(`[2/3] first poll: fetched=${r1.fetched} inserted=${r1.inserted} skipped=${r1.skipped}`);
    assert(r1.fetched === 3 && r1.inserted === 2 && r1.skipped === 1, `insert counts wrong`);

    const r2 = await pollOnce(fetcher);
    assert(r2.inserted === 0, 'dedupe failed');
    console.log(`[3/3] second poll dedupes: OK`);
  } finally {
    await cleanup();
  }
  console.log('\nAll GDELT checks passed.');
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exitCode = 1; }).finally(() => closeDb());
