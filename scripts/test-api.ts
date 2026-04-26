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

async function testCsvExport() {
  const { GET: dealsGET } = await import('../app/api/deals/route');
  const { GET: newsGET }  = await import('../app/api/news/route');

  // deals format=csv
  let res = await dealsGET(new Request('http://localhost/api/deals?format=csv'));
  assert(res.status === 200, `deals csv status ${res.status}`);
  assert(res.headers.get('Content-Type')?.startsWith('text/csv'), 'content-type not csv');
  assert(res.headers.get('Content-Disposition')?.includes('attachment'), 'disposition not attachment');
  const csv = await res.text();
  const lines = csv.split('\r\n').filter((l) => l.length > 0);
  assert(lines[0].startsWith('id,announced_at,headline,sector,geography,deal_type'), `bad header: ${lines[0]}`);
  assert(lines.length - 1 >= 3, `expected >= 3 data rows, got ${lines.length - 1}`);

  // Filter applied: sector=fintech only returns 1 row (test-api-2 VC round).
  res = await dealsGET(new Request('http://localhost/api/deals?sector=fintech&format=csv'));
  const fintechCsv = await res.text();
  const fintechLines = fintechCsv.split('\r\n').filter((l) => l.length > 0);
  assert(fintechLines.length - 1 === 1, `fintech rows: expected 1, got ${fintechLines.length - 1}`);
  assert(fintechLines[1].includes('fintech'), 'fintech row missing sector');

  // CSV quoting — headline with a comma must be quoted. Use a row we inserted.
  const { rows: hasComma } = await db().query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM deals WHERE headline LIKE '%,%'`
  );
  if (Number(hasComma[0].total) > 0) {
    // At least one headline has a comma — verify CSV quotes it.
    const sample = lines.find((l) => l.includes('","'));
    assert(sample !== undefined, 'expected quoted field when commas are present');
  }

  // Limit overrun for csv should 400 above CSV_LIMIT_MAX (5000).
  res = await dealsGET(new Request('http://localhost/api/deals?format=csv&limit=9999'));
  assert(res.status === 400, `csv over-limit should 400, got ${res.status}`);

  // news csv — sanity
  res = await newsGET(new Request('http://localhost/api/news?format=csv&sector=fintech'));
  assert(res.status === 200, `news csv status ${res.status}`);
  assert(res.headers.get('Content-Type')?.startsWith('text/csv'), 'news ct not csv');

  console.log('[9/10] CSV export: headers, filter honored, over-limit 400: OK');
}

async function testSourcesEndpoint() {
  const { GET } = await import('../app/api/sources/route');

  // Seed deterministic state on the edgar source: a healthy poll, plus a
  // stale source we mock by setting last_polled_at to 2h ago with an error.
  await db().query(
    `UPDATE sources SET last_polled_at = NOW(), last_error = NULL, last_error_at = NULL WHERE id = 'edgar'`
  );
  await db().query(
    `UPDATE sources SET last_polled_at = NOW() - INTERVAL '2 hours',
                        last_error = 'simulated outage',
                        last_error_at = NOW() - INTERVAL '5 minutes'
       WHERE id = 'gdelt'`
  );

  const res = await GET();
  const json = await res.json() as {
    sources: Array<{
      id: string;
      enabled: boolean;
      last_error: string | null;
      is_stale: boolean;
      items_total: number;
      items_24h: number;
    }>;
    total: number;
  };
  assert(res.status === 200, `sources status ${res.status}`);
  assert(json.sources.length >= 5, `expected >= 5 sources, got ${json.sources.length}`);

  const edgar = json.sources.find((s) => s.id === 'edgar');
  assert(edgar, 'edgar source missing');
  assert(edgar!.is_stale === false, 'edgar should not be stale right after a poll');
  assert(edgar!.last_error === null, 'edgar should have no error');

  const gdelt = json.sources.find((s) => s.id === 'gdelt');
  assert(gdelt, 'gdelt source missing');
  assert(gdelt!.is_stale === true, 'gdelt should be marked stale (2h since poll)');
  assert(gdelt!.last_error === 'simulated outage', `gdelt error wrong: ${gdelt!.last_error}`);

  // items_total / items_24h are non-negative integers for every source.
  for (const s of json.sources) {
    assert(Number.isInteger(s.items_total) && s.items_total >= 0, `bad items_total for ${s.id}`);
    assert(Number.isInteger(s.items_24h)   && s.items_24h   >= 0, `bad items_24h for ${s.id}`);
  }

  // Reset gdelt so other tests start from a clean slate.
  await db().query(
    `UPDATE sources SET last_polled_at = NULL, last_error = NULL, last_error_at = NULL WHERE id = 'gdelt'`
  );
  console.log('[7/10] GET /api/sources: aggregates + stale + error fields: OK');
}

async function testHealthEndpoint() {
  const { GET } = await import('../app/api/health/route');
  const res = await GET();
  const json = await res.json() as { status: string; db: string };
  assert(res.status === 200, `health status ${res.status}`);
  assert(json.status === 'ok' && json.db === 'up', `health body: ${JSON.stringify(json)}`);
  console.log('[8/10] GET /api/health: 200 ok/up: OK');
}

async function testDealDetailEndpoint() {
  const { GET } = await import('../app/api/deals/[id]/route');

  // Find the M&A deal we promoted in testPromotion (test-api-1 → technology/m_and_a).
  const { rows } = await db().query<{ id: string }>(
    `SELECT d.id FROM deals d
       JOIN deal_news_items l ON l.deal_id = d.id
       JOIN news_items n      ON n.id = l.news_item_id
      WHERE n.external_id = 'test-api-1'`
  );
  assert(rows.length === 1, 'expected one deal linked to test-api-1');
  const dealId = rows[0].id;

  // Good id → deal + linked sources.
  let res = await GET(new Request(`http://localhost/api/deals/${dealId}`), { params: Promise.resolve({ id: dealId }) });
  const good = await res.json() as { deal?: { id: string; headline: string }; sources?: Array<{ external_id: string }> };
  assert(res.status === 200, `detail status ${res.status}`);
  assert(good.deal?.id === dealId, 'deal id mismatch');
  assert(good.sources && good.sources.length >= 1, 'no sources returned');
  assert(good.sources!.some((s) => s.external_id === 'test-api-1'), 'source linkage missing');

  // Invalid UUID → 400.
  res = await GET(new Request('http://localhost/api/deals/not-a-uuid'), { params: Promise.resolve({ id: 'not-a-uuid' }) });
  assert(res.status === 400, `invalid id should 400, got ${res.status}`);

  // Valid UUID but no such deal → 404.
  const bogus = '00000000-0000-0000-0000-000000000000';
  res = await GET(new Request(`http://localhost/api/deals/${bogus}`), { params: Promise.resolve({ id: bogus }) });
  assert(res.status === 404, `missing deal should 404, got ${res.status}`);

  console.log('[10/10] GET /api/deals/[id]: detail + sources, 400/404 paths: OK');
}

async function main() {
  await testPromotion();
  await testFilterParser();
  await testDealsEndpoint();
  await testNewsEndpoint();
  await testSourcesEndpoint();
  await testHealthEndpoint();
  await testCsvExport();
  await testDealDetailEndpoint();

  await cleanState();
  console.log('\nAll API checks passed.');
}

main()
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
