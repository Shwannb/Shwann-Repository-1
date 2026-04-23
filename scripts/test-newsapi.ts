// NewsAPI worker test — fixture-driven (sandbox has no outbound HTTPS).

import { db, closeDb } from '../lib/db';
import { pollOnce, type NewsApiFetcher } from '../workers/newsapi';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const FIXTURE_ARTICLES = [
  {
    title: 'MegaCorp to acquire WidgetCo for $2.5B',
    description: 'All-cash deal.',
    url: 'https://example.test/newsapi/1',
    publishedAt: '2026-04-22T14:05:00Z',
    source: { name: 'TestWire' },
  },
  {
    title: 'Berlin fintech closes €40M Series C',
    description: null,
    url: 'https://example.test/newsapi/2',
    publishedAt: '2026-04-22T12:00:00Z',
    source: { name: 'TechDaily' },
  },
];

const fetcher: NewsApiFetcher = async (_query, apiKey) => {
  assert(apiKey === 'test-key', 'key mismatch');
  return { status: 'ok', articles: FIXTURE_ARTICLES };
};

async function cleanup() {
  await db().query(`DELETE FROM news_items WHERE source_id = 'newsapi' AND url LIKE 'https://example.test/newsapi/%'`);
}

async function main() {
  await cleanup();
  try {
    const r1 = await pollOnce(fetcher, 'test-key');
    console.log(`[1/3] first poll: fetched=${r1.fetched} inserted=${r1.inserted}`);
    assert(r1.fetched === 2 && r1.inserted === 2, 'expected 2 inserted');

    const r2 = await pollOnce(fetcher, 'test-key');
    console.log(`[2/3] second poll: inserted=${r2.inserted} skipped=${r2.skipped}`);
    assert(r2.inserted === 0 && r2.skipped === 2, 'dedupe failed');

    const badFetcher: NewsApiFetcher = async () => ({ status: 'error', code: 'apiKeyInvalid', message: 'bad key' });
    let threw = false;
    try {
      await pollOnce(badFetcher, 'test-key');
    } catch (err) {
      threw = true;
      assert((err as Error).message.includes('error'), 'error should propagate');
    }
    assert(threw, 'error response should throw');
    console.log('[3/3] error response surfaces as throw: OK');
  } finally {
    await cleanup();
  }
  console.log('\nAll NewsAPI checks passed.');
}

main().catch((err) => { console.error('TEST FAILED:', err); process.exitCode = 1; }).finally(() => closeDb());
