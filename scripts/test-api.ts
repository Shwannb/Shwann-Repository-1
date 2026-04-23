// End-to-end test for:
//   - Classifier promotion into the deals table (transactional + idempotent)
//   - Filter parser
//   - GET /api/deals and GET /api/news route handlers (called directly)
//
// The route handlers are imported and invoked with synthetic Request objects
// so the test needs no running Next.js server.

import { db, closeDb } from '../lib/db';
import { drainOnce } from '../workers/classifier';
import type { Classifier } from '../lib/classifier';
import { parseFilters } from '../lib/filters';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// Three fixtures, each chosen so they exercise a different filter axis.
const FIXTURES = [
  {
    external_id: 'test-api-1',
    title: 'TechCo to acquire CloudSoft for $4.2B',
    summary: 'All-cash M&A between two U.S. technology firms.',
    stub: { sector: 'technology', geography: 'north_america', deal_type: 'm_and_a', deal_size_usd: 4_200_000_000 },
  },
  {
    external_id: 'test-api-2',
    title: 'Lagos fintech raises $25M Series B',
    summary: 'Nigerian payments startup closes a Series B round.',
    stub: { sector: 'fintech', geography: 'sub_saharan_africa', deal_type: 'vc_round', deal_size_usd: 25_000_000 },
  },
  {
    external_id: 'test-api-3',
    title: 'European renewables IPO prices above range',
    summary: 'Wind developer begins trading on Euronext.',
    stub: { sector: 'energy', geography: 'europe', deal_type: 'ipo', deal_size_usd: null },
  },
  {
    external_id: 'test-api-4',
    title: 'Generic industry commentary, no deal',
    summary: 'Opinion piece about supply chains.',
    // deal_type 'unknown' → should NOT be promoted into deals.
    stub: { sector: 'industrials', geography: 'unknown', deal_type: 'unknown' as const, deal_size_usd: null },
  },
] as const;

async function cleanState() {
  // Also clear test fixtures left behind by the edgar and classifier tests,
  // so drainOnce() sees exactly our four rows when we call it.
  await db().query(
    `DELETE FROM deal_news_items
      WHERE news_item_id IN (
        SELECT id FROM news_items
         WHERE external_id LIKE 'test-api-%'
            OR external_id LIKE 'test-classifier-%'
            OR external_id IN ('0001193125-24-123456','0001193125-24-654321')
      )`
  );
  await db().query(
    `DELETE FROM deals
      WHERE primary_url LIKE 'https://example.test/test-%'`
  );
  await db().query(
    `DELETE FROM news_items
      WHERE external_id LIKE 'test-api-%'
         OR external_id LIKE 'test-classifier-%'
         OR external_id IN ('0001193125-24-123456','0001193125-24-654321')`
  );
}

async function seedFixtures() {
  for (const f of FIXTURES) {
    await db().query(
      `INSERT INTO news_items (source_id, external_id, url, title, summary, published_at)
       VALUES ('edgar', $1, $2, $3, $4, NOW() - INTERVAL '1 hour')`,
      [f.external_id, `https://example.test/${f.external_id}`, f.title, f.summary]
    );
  }
}

async function testPromotion() {
  await cleanState();
  await seedFixtures();

  const stub: Classifier = async (item) => {
    const f = FIXTURES.find((x) => item.title === x.title);
    if (!f) throw new Error(`no fixture for ${item.title}`);
    return { ...f.stub };
  };

  const r1 = await drainOnce(stub);
  console.log(`[1/5] drain (stub): processed=${r1.processed} failed=${r1.failed}`);
  assert(r1.processed === 4 && r1.failed === 0, `expected 4/0, got ${r1.processed}/${r1.failed}`);

  // Three of four fixtures have promotable deal_types; one is 'unknown'.
  const { rows: dealRows } = await db().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM deals
      WHERE primary_url LIKE 'https://example.test/test-api-%'`
  );
  assert(Number(dealRows[0].count) === 3, `expected 3 deals promoted, got ${dealRows[0].count}`);

  const { rows: linkRows } = await db().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM deal_news_items
       JOIN news_items ON news_items.id = deal_news_items.news_item_id
      WHERE news_items.external_id LIKE 'test-api-%'`
  );
  assert(Number(linkRows[0].count) === 3, `expected 3 links, got ${linkRows[0].count}`);

  console.log('[1/5] promotion: 3/4 fixtures promoted (unknown excluded), links correct: OK');

  // Idempotency: manually re-classify one row (clear classified_at) and re-drain.
  // The link already exists, so no new deal row should be inserted.
  await db().query(
    `UPDATE news_items SET classified_at = NULL WHERE external_id = 'test-api-1'`
  );
  await drainOnce(stub);
  const { rows: recount } = await db().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM deals
      WHERE primary_url LIKE 'https://example.test/test-api-%'`
  );
  assert(Number(recount[0].count) === 3, `re-classify created duplicate — deals=${recount[0].count}`);
  console.log('[2/5] re-classification is idempotent (no duplicate deals): OK');
}

async function testFilterParser() {
  const badSize = parseFilters(new URLSearchParams('min_size=100&max_size=10'));
  assert(!badSize.ok && badSize.message.includes('min_size'), 'min > max should reject');

  const badEnum = parseFilters(new URLSearchParams('sector=banana'));
  assert(!badEnum.ok, 'bad sector should reject');

  const badDate = parseFilters(new URLSearchParams('from=not-a-date'));
  assert(!badDate.ok, 'bad date should reject');

  const ok = parseFilters(new URLSearchParams('sector=fintech&min_size=1000000&limit=10'));
  assert(ok.ok, 'valid filters should parse');
  if (ok.ok) {
    assert(ok.filters.sector === 'fintech', 'sector wrong');
    assert(ok.filters.min_size === 1_000_000, 'min_size wrong');
    assert(ok.limit === 10, 'limit wrong');
  }
  console.log('[3/5] filter parser: OK');
}

async function hitDealsEndpoint(qs: string) {
  const { GET } = await import('../app/api/deals/route');
  const res = await GET(new Request(`http://localhost/api/deals${qs ? '?' + qs : ''}`));
  const json = (await res.json()) as {
    error?: string;
    deals?: Array<{ headline: string; sector: string; geography: string; deal_type: string; deal_size_usd: number | null }>;
    total?: number;
  };
  return { status: res.status, json };
}

async function hitNewsEndpoint(qs: string) {
  const { GET } = await import('../app/api/news/route');
  const res = await GET(new Request(`http://localhost/api/news${qs ? '?' + qs : ''}`));
  const json = (await res.json()) as {
    error?: string;
    news?: Array<{ title: string; sector: string; geography: string; deal_type: string }>;
    total?: number;
  };
  return { status: res.status, json };
}

async function testDealsEndpoint() {
  // Scope the endpoint results to our fixtures by filtering on a test-specific
  // field isn't possible (no arbitrary column filter), but our fixtures use
  // distinct sectors — so we can filter by sector and know exactly what to expect.
  const all = await hitDealsEndpoint('');
  assert(all.status === 200, `status ${all.status}`);
  assert(all.json.deals && all.json.deals.length >= 3, `expected >= 3 deals, got ${all.json.deals?.length}`);

  const fin = await hitDealsEndpoint('sector=fintech&deal_type=vc_round');
  assert(fin.status === 200, `status ${fin.status}`);
  assert(fin.json.deals!.some((d) => d.deal_type === 'vc_round' && d.sector === 'fintech'), 'fintech VC missing');
  assert(fin.json.deals!.every((d) => d.sector === 'fintech' && d.deal_type === 'vc_round'), 'filter leaked');

  const bigTech = await hitDealsEndpoint('sector=technology&min_size=1000000000');
  assert(bigTech.json.deals!.some((d) => d.deal_size_usd !== null && d.deal_size_usd >= 1e9), '>$1B tech deal missing');

  const noneTooBig = await hitDealsEndpoint('min_size=9999999999999');
  assert(noneTooBig.json.deals!.length === 0, 'impossible size should return empty');

  const bad = await hitDealsEndpoint('sector=banana');
  assert(bad.status === 400, `bad filter should 400, got ${bad.status}`);
  assert(typeof bad.json.error === 'string', 'error message missing');

  console.log(`[4/5] GET /api/deals: filters honored, validation 400s: OK (total=${all.json.total})`);
}

async function testNewsEndpoint() {
  // News tab auto-filters to the same sector as the deals tab.
  const bySector = await hitNewsEndpoint('sector=fintech');
  assert(bySector.status === 200, `status ${bySector.status}`);
  assert(bySector.json.news!.every((n) => n.sector === 'fintech'), 'news sector filter leaked');

  // The 'unknown' fixture should appear in /api/news but NOT /api/deals.
  const industrials = await hitNewsEndpoint('sector=industrials');
  assert(industrials.json.news!.length >= 1, 'industrials fixture missing from news');
  const industrialsInDeals = await hitDealsEndpoint('sector=industrials');
  assert(industrialsInDeals.json.deals!.length === 0, 'industrials fixture leaked into deals');

  console.log('[5/5] GET /api/news: sector filter matches Deals filter, unknown-type rows stay out of deals: OK');
}

async function main() {
  await testPromotion();
  await testFilterParser();
  await testDealsEndpoint();
  await testNewsEndpoint();

  await cleanState();
  console.log('\nAll API checks passed.');
}

main()
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
